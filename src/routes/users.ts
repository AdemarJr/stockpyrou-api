import { Hono } from 'hono';
import { kvGet, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/login-service.js';
import {
  getPermissionsByRole,
  mapAppUserRole,
} from '../auth/permissions.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

const users = new Hono<{ Variables: AppVariables }>();

users.use('*', requireAuth);

users.get('/', async (c) => {
  const auth = c.get('auth');
  if (auth.role !== 'superadmin' && !auth.permissions?.canManageUsers) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const companyId = c.req.query('companyId');
  const params: unknown[] = [];
  let where = 'WHERE is_active = true';
  if (companyId) {
    params.push(companyId);
    where += ` AND company_id = $${params.length}`;
  }

  const { rows } = await query(
    `SELECT id, email, full_name, role, company_id, is_active, created_at, updated_at
     FROM app_users
     ${where}
     ORDER BY full_name ASC`,
    params,
  );

  const mapped = rows.map((r) => {
    const row = r as Record<string, unknown>;
    const role = mapAppUserRole(String(row.role || 'user'));
    return {
      id: String(row.id),
      email: String(row.email),
      fullName: String(row.full_name),
      role,
      companyId: row.company_id != null ? String(row.company_id) : undefined,
      status: row.is_active === false ? 'inactive' : 'active',
      permissions: getPermissionsByRole(role),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  return c.json({ users: mapped });
});

users.post('/me/change-password', async (c) => {
  const auth = c.get('auth');
  const body = (await c.req.json().catch(() => ({}))) as {
    currentPassword?: string;
    newPassword?: string;
  };
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (!currentPassword) {
    return c.json({ error: 'Informe a senha atual' }, 400);
  }
  if (newPassword.length < 6) {
    return c.json({ error: 'A nova senha deve ter no mínimo 6 caracteres' }, 400);
  }

  const { rows } = await query(
    `SELECT id, password_hash FROM app_users WHERE id = $1 LIMIT 1`,
    [auth.userId],
  );
  const row = rows[0] as { id: string; password_hash: string } | undefined;
  if (!row) return c.json({ error: 'Usuário não encontrado' }, 404);

  const ok = await verifyPassword(currentPassword, String(row.password_hash || ''));
  if (!ok) return c.json({ error: 'Senha atual incorreta' }, 400);

  const passwordHash = hashPassword(newPassword);
  await query(`UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
    passwordHash,
    auth.userId,
  ]);

  const existing = await kvGet(`user:${auth.userId}`);
  if (existing) {
    await kvSet(`user:${auth.userId}`, {
      ...existing,
      passwordHash,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json({ success: true, message: 'Senha alterada com sucesso' });
});

users.post('/:id/reset-password', async (c) => {
  const auth = c.get('auth');
  if (auth.role !== 'superadmin' && !auth.permissions?.canManageUsers) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const userId = c.req.param('id');
  const body = (await c.req.json()) as { newPassword?: string };
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const passwordHash = hashPassword(newPassword);
  const { rowCount } = await query(
    `UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [passwordHash, userId],
  );
  if (!rowCount) return c.json({ error: 'User not found' }, 404);

  const existing = await kvGet(`user:${userId}`);
  if (existing) {
    await kvSet(`user:${userId}`, {
      ...existing,
      passwordHash,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json({ message: 'Password reset successfully' });
});

export default users;
