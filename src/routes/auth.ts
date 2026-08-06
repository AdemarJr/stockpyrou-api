import { Hono } from 'hono';
import { kvGet, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { hashPassword, getUserProfileByToken, loginWithPassword } from '../auth/login-service.js';
import { verifyRequestToken } from '../auth/verify-token.js';
import { sendPasswordChangedEmail, sendPasswordResetEmail } from '../services/mail/notify.js';
import {
  allowPasswordResetRequest,
  consumePasswordResetToken,
  generatePasswordResetToken,
  storePasswordResetToken,
} from '../services/mail/passwordResetStore.js';

const authRoutes = new Hono();

const NEUTRAL_FORGOT_MSG =
  'Se existir uma conta com este e-mail, enviaremos instruções para redefinir a senha.';

function extractToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const custom = c.req.header('X-Custom-Token');
  if (custom?.trim()) return custom.trim();
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();
  return null;
}

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const { email, password } = body;
  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }
  try {
    const result = await loginWithPassword(email, password);
    if (!result.success) {
      return c.json({ error: result.error || 'Invalid email or password' }, 401);
    }
    return c.json({ user: result.user, token: result.token });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[auth/login]', message);
    if (/timeout|ECONNREFUSED|ENOTFOUND|ECONNRESET|Connection terminated|connect/i.test(message)) {
      return c.json(
        {
          error:
            'Banco de dados inacessível a partir da API (Railway → EasyPanel). Verifique DATABASE_URL e o firewall do Postgres.',
          detail: message,
        },
        503,
      );
    }
    return c.json({ error: 'Erro interno no login', detail: message }, 500);
  }
});

authRoutes.post('/forgot-password', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = String(body.email || '')
    .trim()
    .toLowerCase();

  // Sempre resposta neutra (não vaza se o e-mail existe)
  if (!email || !email.includes('@')) {
    return c.json({ success: true, message: NEUTRAL_FORGOT_MSG });
  }

  try {
    const allowed = await allowPasswordResetRequest(email);
    if (!allowed) {
      return c.json({ success: true, message: NEUTRAL_FORGOT_MSG });
    }

    const { rows } = await query(
      `SELECT id, email, full_name, is_active
       FROM app_users
       WHERE lower(email) = $1
       LIMIT 1`,
      [email],
    );
    const row = rows[0] as
      | { id: string; email: string; full_name: string; is_active: boolean }
      | undefined;

    if (row && row.is_active !== false) {
      const token = generatePasswordResetToken();
      await storePasswordResetToken({
        token,
        userId: String(row.id),
        email: String(row.email),
      });
      void sendPasswordResetEmail({
        to: String(row.email),
        fullName: String(row.full_name || ''),
        token,
      });
    }
  } catch (err) {
    console.warn('[auth/forgot-password]', err);
  }

  return c.json({ success: true, message: NEUTRAL_FORGOT_MSG });
});

authRoutes.post('/reset-password', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    token?: string;
    newPassword?: string;
  };
  const token = String(body.token || '').trim();
  const newPassword = String(body.newPassword || '');

  if (!token) {
    return c.json({ error: 'Token inválido ou expirado' }, 400);
  }
  if (newPassword.length < 6) {
    return c.json({ error: 'A nova senha deve ter no mínimo 6 caracteres' }, 400);
  }

  const record = await consumePasswordResetToken(token);
  if (!record) {
    return c.json({ error: 'Token inválido ou expirado' }, 400);
  }

  const passwordHash = hashPassword(newPassword);
  const { rowCount, rows } = await query(
    `UPDATE app_users
     SET password_hash = $1, updated_at = now()
     WHERE id = $2 AND is_active = true
     RETURNING id, email, full_name`,
    [passwordHash, record.userId],
  );
  if (!rowCount) {
    return c.json({ error: 'Usuário não encontrado ou inativo' }, 404);
  }

  const user = rows[0] as { id: string; email: string; full_name: string };
  const existing = await kvGet(`user:${user.id}`);
  if (existing && typeof existing === 'object') {
    await kvSet(`user:${user.id}`, {
      ...(existing as Record<string, unknown>),
      passwordHash,
      updatedAt: new Date().toISOString(),
    });
  }

  void sendPasswordChangedEmail({
    to: String(user.email),
    fullName: String(user.full_name || ''),
  });

  return c.json({ success: true, message: 'Senha redefinida com sucesso. Faça login.' });
});

authRoutes.post('/init', async (c) => {
  const existing = await kvGet('user:email:admin@stockwise.com');
  if (existing) {
    return c.json({ success: true, message: 'System already initialized', adminExists: true });
  }
  const result = await loginWithPassword('admin@stockwise.com', 'Admin@123456');
  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }
  return c.json({
    success: true,
    message: 'System initialized successfully with superadmin!',
    adminCreated: true,
  });
});

authRoutes.get('/me', async (c) => {
  const token = extractToken(c);
  if (!token?.startsWith('custom_')) {
    const auth = await verifyRequestToken(token);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ user: auth });
  }
  const profile = await getUserProfileByToken(token);
  if (!profile) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ user: profile });
});

authRoutes.post('/logout', async (c) => {
  return c.json({ message: 'Logged out successfully' });
});

export default authRoutes;
