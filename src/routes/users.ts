import { Hono } from 'hono';
import { kvGet, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { hashPassword } from '../auth/login-service.js';
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
