import { Hono } from 'hono';
import { kvGet, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/login-service.js';
import {
  canAssignRole,
  canManageTargetUser,
  getPermissionsByRole,
  mapAppRoleToDb,
  mapAppUserRole,
  type UserRole,
} from '../auth/permissions.js';
import {
  listUserCompanyIds,
  resolveCompanyId,
  userHasCompanyAccess,
} from '../auth/resolve-company.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

const users = new Hono<{ Variables: AppVariables }>();

users.use('*', requireAuth);

function canManageUsers(auth: AppVariables['auth']): boolean {
  return (
    auth.role === 'superadmin' ||
    mapAppUserRole(String(auth.role || '')) === 'admin' ||
    !!auth.permissions?.canManageUsers
  );
}

async function resolveActorCompany(
  c: {
    req: { header: (n: string) => string | undefined };
    get: (k: 'auth') => AppVariables['auth'];
  },
): Promise<string> {
  const auth = c.get('auth');
  return (
    (await resolveCompanyId(auth, c.req.header('X-Company-Id'))) ||
    ''
  );
}

function mapUserRow(row: Record<string, unknown>) {
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
}

async function syncUserKv(params: {
  userId: string;
  email: string;
  fullName: string;
  role: UserRole;
  companyId?: string | null;
  status: 'active' | 'inactive';
}): Promise<void> {
  const profile = {
    id: params.userId,
    email: params.email,
    fullName: params.fullName,
    companyId: params.companyId || undefined,
    role: params.role,
    permissions: getPermissionsByRole(params.role),
    status: params.status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kvSet(`user:${params.userId}`, profile as unknown as Record<string, unknown>);
  await kvSet(`user:email:${params.email}`, { userId: params.userId });
}

users.get('/', async (c) => {
  const auth = c.get('auth');
  if (!canManageUsers(auth)) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const requestedCompanyId = c.req.query('companyId')?.trim();
  const params: unknown[] = [];
  let where = 'WHERE is_active = true';

  if (auth.role === 'superadmin') {
    if (requestedCompanyId) {
      params.push(requestedCompanyId);
      where += ` AND company_id = $${params.length}`;
    }
  } else {
    const linked = await listUserCompanyIds(auth);
    if (linked.length === 0) {
      return c.json({ users: [] });
    }
    let scopeId = requestedCompanyId || (await resolveActorCompany(c));
    if (scopeId) {
      const ok = await userHasCompanyAccess(auth, scopeId);
      if (!ok) {
        return c.json({ error: 'Sem acesso a esta empresa' }, 403);
      }
      params.push(scopeId);
      where += ` AND company_id = $${params.length}`;
    } else {
      params.push(linked);
      where += ` AND company_id = ANY($${params.length}::uuid[])`;
    }
  }

  const { rows } = await query(
    `SELECT id, email, full_name, role, company_id, is_active, created_at, updated_at
     FROM app_users
     ${where}
     ORDER BY full_name ASC`,
    params,
  );

  return c.json({ users: rows.map((r) => mapUserRow(r as Record<string, unknown>)) });
});

/** Cria usuário na empresa (Admin / Superadmin). */
users.post('/', async (c) => {
  const auth = c.get('auth');
  if (!canManageUsers(auth)) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    fullName?: string;
    role?: string;
    companyId?: string;
  };

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.fullName || '').trim();
  const requestedRole = mapAppUserRole(String(body.role || 'visualizacao'));
  const companyId = String(
    body.companyId || c.req.header('X-Company-Id') || auth.companyId || '',
  ).trim();

  if (!email || !password || !fullName || !companyId) {
    return c.json({ error: 'email, password, fullName e companyId são obrigatórios' }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: 'A senha deve ter no mínimo 6 caracteres' }, 400);
  }

  const actorCompany = await resolveActorCompany(c);
  if (auth.role !== 'superadmin') {
    const ok = await userHasCompanyAccess(auth, companyId);
    if (!ok) {
      return c.json(
        {
          error:
            'Sem permissão para criar usuário nesta empresa. Use apenas empresas vinculadas.',
        },
        403,
      );
    }
  } else if (!companyId && !actorCompany) {
    return c.json({ error: 'Empresa não identificada para criar usuário' }, 400);
  }

  if (!canAssignRole(auth.role, requestedRole)) {
    return c.json(
      { error: 'Você não pode atribuir este perfil. Escolha um perfil abaixo do seu.' },
      403,
    );
  }

  const existing = await query(`SELECT id FROM app_users WHERE email = $1 LIMIT 1`, [email]);
  if (existing.rows[0]) {
    return c.json({ error: 'Já existe um usuário com este e-mail' }, 409);
  }

  const dbRole = mapAppRoleToDb(requestedRole);
  const passwordHash = hashPassword(password);
  const { rows } = await query(
    `INSERT INTO app_users (email, password_hash, full_name, role, company_id, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, email, full_name, role, company_id, is_active, created_at, updated_at`,
    [email, passwordHash, fullName, dbRole, companyId],
  );
  const created = rows[0] as Record<string, unknown>;
  const userId = String(created.id);

  const link = await query(
    `SELECT id FROM user_companies WHERE user_id = $1 AND company_id = $2 LIMIT 1`,
    [userId, companyId],
  );
  if (!link.rows[0]) {
    await query(
      `INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, $3)`,
      [userId, companyId, requestedRole === 'superadmin' ? 'admin' : requestedRole],
    );
  }

  await syncUserKv({
    userId,
    email,
    fullName,
    role: requestedRole,
    companyId,
    status: 'active',
  });

  return c.json({ success: true, user: mapUserRow(created) }, 201);
});

/** Atualiza nome/perfil do usuário. */
users.put('/:id', async (c) => {
  const auth = c.get('auth');
  if (!canManageUsers(auth)) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const userId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    fullName?: string;
    role?: string;
  };

  const { rows: existingRows } = await query(
    `SELECT id, email, full_name, role, company_id, is_active
     FROM app_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const existing = existingRows[0] as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Usuário não encontrado' }, 404);

  const currentRole = mapAppUserRole(String(existing.role || 'user'));
  if (!canManageTargetUser(auth.role, currentRole)) {
    return c.json({ error: 'Sem permissão para editar este usuário' }, 403);
  }

  const targetCompanyId =
    existing.company_id != null ? String(existing.company_id) : null;
  if (auth.role !== 'superadmin') {
    if (!targetCompanyId || !(await userHasCompanyAccess(auth, targetCompanyId))) {
      return c.json({ error: 'Sem permissão para editar usuário de outra empresa' }, 403);
    }
  }

  const fullName =
    body.fullName != null ? String(body.fullName).trim() : String(existing.full_name || '');
  if (!fullName) return c.json({ error: 'Nome é obrigatório' }, 400);

  let nextRole = currentRole;
  if (body.role != null) {
    const requested = mapAppUserRole(String(body.role));
    if (!canAssignRole(auth.role, requested)) {
      return c.json(
        { error: 'Você não pode atribuir este perfil. Escolha um perfil abaixo do seu.' },
        403,
      );
    }
    nextRole = requested;
  }

  await query(
    `UPDATE app_users
     SET full_name = $1, role = $2, updated_at = now()
     WHERE id = $3`,
    [fullName, mapAppRoleToDb(nextRole), userId],
  );

  if (targetCompanyId) {
    await query(
      `UPDATE user_companies SET role = $1 WHERE user_id = $2 AND company_id = $3`,
      [nextRole === 'superadmin' ? 'admin' : nextRole, userId, targetCompanyId],
    );
  }

  const email = String(existing.email);
  await syncUserKv({
    userId,
    email,
    fullName,
    role: nextRole,
    companyId: targetCompanyId,
    status: existing.is_active === false ? 'inactive' : 'active',
  });

  const { rows } = await query(
    `SELECT id, email, full_name, role, company_id, is_active, created_at, updated_at
     FROM app_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return c.json({ success: true, user: mapUserRow(rows[0] as Record<string, unknown>) });
});

/** Desativa usuário (soft-delete). */
users.delete('/:id', async (c) => {
  const auth = c.get('auth');
  if (!canManageUsers(auth)) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const userId = c.req.param('id');
  if (userId === auth.userId) {
    return c.json({ error: 'Você não pode desativar o próprio usuário' }, 400);
  }

  const { rows: existingRows } = await query(
    `SELECT id, email, full_name, role, company_id, is_active
     FROM app_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const existing = existingRows[0] as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Usuário não encontrado' }, 404);

  const targetRole = mapAppUserRole(String(existing.role || 'user'));
  if (!canManageTargetUser(auth.role, targetRole)) {
    return c.json({ error: 'Sem permissão para desativar este usuário' }, 403);
  }

  const targetCompanyId =
    existing.company_id != null ? String(existing.company_id) : null;
  const actorCompany = await resolveActorCompany(c);
  if (auth.role !== 'superadmin') {
    if (!targetCompanyId || !(await userHasCompanyAccess(auth, targetCompanyId))) {
      return c.json({ error: 'Sem permissão para desativar usuário de outra empresa' }, 403);
    }
  }

  const { rowCount } = await query(
    `UPDATE app_users SET is_active = false, updated_at = now() WHERE id = $1`,
    [userId],
  );
  if (!rowCount) return c.json({ error: 'Usuário não encontrado' }, 404);

  // Remove vínculos da empresa (ou todos se superadmin desativar globalmente)
  if (auth.role === 'superadmin') {
    await query(`DELETE FROM user_companies WHERE user_id = $1`, [userId]);
  } else if (actorCompany) {
    await query(`DELETE FROM user_companies WHERE user_id = $1 AND company_id = $2`, [
      userId,
      actorCompany,
    ]);
  }

  const email = String(existing.email);
  const fullName = String(existing.full_name || '');
  await syncUserKv({
    userId,
    email,
    fullName,
    role: targetRole,
    companyId: targetCompanyId,
    status: 'inactive',
  });

  return c.json({ success: true, message: 'Usuário desativado com sucesso' });
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
  if (existing && typeof existing === 'object') {
    await kvSet(`user:${auth.userId}`, {
      ...(existing as Record<string, unknown>),
      passwordHash,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json({ success: true, message: 'Senha alterada com sucesso' });
});

users.post('/:id/reset-password', async (c) => {
  const auth = c.get('auth');
  if (!canManageUsers(auth)) {
    return c.json({ error: 'Unauthorized - Admin access required' }, 401);
  }

  const userId = c.req.param('id');
  const body = (await c.req.json()) as { newPassword?: string };
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const { rows: existingRows } = await query(
    `SELECT id, email, role, company_id FROM app_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const existing = existingRows[0] as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'User not found' }, 404);

  const targetRole = mapAppUserRole(String(existing.role || 'user'));
  if (!canManageTargetUser(auth.role, targetRole)) {
    return c.json({ error: 'Sem permissão para redefinir a senha deste usuário' }, 403);
  }

  const targetCompanyId =
    existing.company_id != null ? String(existing.company_id) : null;
  if (auth.role !== 'superadmin') {
    if (!targetCompanyId || !(await userHasCompanyAccess(auth, targetCompanyId))) {
      return c.json(
        { error: 'Sem permissão para redefinir senha de usuário de outra empresa' },
        403,
      );
    }
  }

  const passwordHash = hashPassword(newPassword);
  const { rowCount } = await query(
    `UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [passwordHash, userId],
  );
  if (!rowCount) return c.json({ error: 'User not found' }, 404);

  const kvExisting = await kvGet(`user:${userId}`);
  if (kvExisting && typeof kvExisting === 'object') {
    await kvSet(`user:${userId}`, {
      ...(kvExisting as Record<string, unknown>),
      passwordHash,
      updatedAt: new Date().toISOString(),
    });
  }

  return c.json({ message: 'Password reset successfully' });
});

export default users;
