import { Hono } from 'hono';
import { kvGet } from '../db/kv.js';
import { getUserProfileByToken, loginWithPassword } from '../auth/login-service.js';
import { verifyRequestToken } from '../auth/verify-token.js';

const authRoutes = new Hono();

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
  const result = await loginWithPassword(email, password);
  if (!result.success) {
    return c.json({ error: result.error || 'Invalid email or password' }, 401);
  }
  return c.json({ user: result.user, token: result.token });
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
