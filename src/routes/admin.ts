import { Hono } from 'hono';
import { kvDel, kvGet, kvRecord, kvSet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { hashPassword } from '../auth/login-service.js';
import {
  getPermissionsByRole,
  mapAppRoleToDb,
  mapDbRoleToApp,
} from '../auth/permissions.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { clearCompanyData } from '../modules/admin/clear-company-data.js';
import { sendWelcomeEmail } from '../services/mail/notify.js';

const admin = new Hono<{ Variables: AppVariables }>();

function requireSuperAdmin(c: { get: (k: 'auth') => AppVariables['auth'] }) {
  const auth = c.get('auth');
  return auth.role === 'superadmin';
}

async function companyStatus(companyId: string, rowStatus?: unknown, isActive?: unknown): Promise<string> {
  const kv = kvRecord(await kvGet(`company_status:${companyId}`));
  if (kv?.status != null) return String(kv.status);
  if (kv?.value != null) return String(kv.value);
  if (rowStatus != null) return String(rowStatus);
  if (isActive === false) return 'inactive';
  return 'active';
}

// ---------- Companies ----------
admin.get('/companies', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const { rows } = await query(
    `SELECT id, name, cnpj, created_at, updated_at, status, is_active
     FROM companies
     ORDER BY name ASC`,
  );

  const companies = await Promise.all(
    rows.map(async (r) => {
      const row = r as Record<string, unknown>;
      const id = String(row.id);
      const status = await companyStatus(id, row.status, row.is_active);
      return {
        ...row,
        id,
        status,
        created_at: row.created_at,
      };
    }),
  );

  return c.json({ companies });
});

admin.post('/companies/sync', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const { rows } = await query(`SELECT id, name, cnpj, status, is_active FROM companies`);
  let synced = 0;
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const id = String(row.id);
    const status = await companyStatus(id, row.status, row.is_active);
    await kvSet(`company:${id}`, {
      id,
      name: String(row.name ?? ''),
      cnpj: row.cnpj != null ? String(row.cnpj) : '',
      status,
    });
    await kvSet(`company_status:${id}`, { status });
    synced += 1;
  }

  return c.json({
    success: true,
    message: `Synced ${synced} companies`,
    synced,
    passwordsSet: 0,
  });
});

admin.post('/companies/:id/status', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const companyId = c.req.param('id');
  const body = (await c.req.json()) as { status?: string };
  const status = String(body.status || '');
  if (!['active', 'inactive'].includes(status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const { rowCount } = await query(
    `UPDATE companies
     SET status = $1,
         is_active = $2,
         updated_at = now()
     WHERE id = $3`,
    [status, status === 'active', companyId],
  );
  if (!rowCount) return c.json({ error: 'Company not found' }, 404);

  await kvSet(`company_status:${companyId}`, { status });

  return c.json({ success: true, status });
});

admin.post('/create-company', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const body = (await c.req.json()) as { name?: string; cnpj?: string; email?: string };
  const name = String(body.name || '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);

  const { rows } = await query(
    `INSERT INTO companies (name, cnpj, status, is_active)
     VALUES ($1, $2, 'active', true)
     RETURNING *`,
    [name, body.cnpj?.trim() || null],
  );
  const company = rows[0] as Record<string, unknown>;
  const id = String(company.id);

  await kvSet(`company_status:${id}`, { status: 'active' });
  await kvSet(`company:${id}`, {
    id,
    name: String(company.name),
    cnpj: company.cnpj != null ? String(company.cnpj) : '',
    status: 'active',
    email: body.email || '',
  });

  return c.json({
    success: true,
    company: { ...company, email: body.email || null, status: 'active' },
  });
});

admin.post('/create-user', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const body = (await c.req.json()) as {
    email?: string;
    password?: string;
    fullName?: string;
    role?: string;
    companyId?: string;
  };

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.fullName || '').trim();
  const role = String(body.role || 'admin');
  const companyId = String(body.companyId || '').trim();

  if (!email || !password || !fullName || !companyId) {
    return c.json({ error: 'email, password, fullName and companyId are required' }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const dbRole = mapAppRoleToDb(role);
  const passwordHash = hashPassword(password);

  const existing = await query<{ id: string }>(
    `SELECT id FROM app_users WHERE email = $1 LIMIT 1`,
    [email],
  );

  let userId: string;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await query(
      `UPDATE app_users
       SET password_hash = $1, full_name = $2, role = $3, company_id = $4, is_active = true, updated_at = now()
       WHERE id = $5`,
      [passwordHash, fullName, dbRole, companyId, userId],
    );
  } else {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, full_name, role, company_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      [email, passwordHash, fullName, dbRole, companyId],
    );
    userId = rows[0].id;
  }

  const { rows: links } = await query(
    `SELECT id FROM user_companies WHERE user_id = $1 AND company_id = $2 LIMIT 1`,
    [userId, companyId],
  );
  if (!links[0]) {
    await query(
      `INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, $3)`,
      [userId, companyId, role === 'superadmin' ? 'admin' : role],
    );
  }

  const appRole = mapDbRoleToApp(dbRole);
  const profile = {
    id: userId,
    email,
    fullName,
    companyId,
    role: appRole,
    permissions: getPermissionsByRole(appRole),
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kvSet(`user:${userId}`, profile as unknown as Record<string, unknown>);
  await kvSet(`user:email:${email}`, { userId });

  void sendWelcomeEmail({ to: email, fullName });

  return c.json({
    success: true,
    user: { id: userId, email, fullName, role: appRole },
  });
});

admin.delete('/companies/:id', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const companyId = String(c.req.param('id') || '').trim();
  if (!companyId) return c.json({ error: 'Company id is required' }, 400);
  const { rows: existing } = await query(`SELECT id FROM companies WHERE id = $1 LIMIT 1`, [
    companyId,
  ]);
  if (!existing[0]) return c.json({ error: 'Company not found' }, 404);

  // FKs para companies sem CASCADE na maioria das tabelas — limpa dados operacionais antes.
  try {
    await clearCompanyData(companyId, {
      stockQuantities: false,
      stockEntries: true,
      movements: true,
      priceHistory: true,
      products: true,
      suppliers: true,
      sales: true,
      customers: true,
      costs: true,
      inboundNfe: true,
      zigCache: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin/delete-company] clear-data', err);
    return c.json(
      {
        error: `Não foi possível limpar os dados da empresa antes de excluir: ${message}`,
      },
      500,
    );
  }

  await query(`DELETE FROM user_companies WHERE company_id = $1`, [companyId]);
  await query(`UPDATE app_users SET company_id = NULL WHERE company_id = $1`, [companyId]);

  // Cadastros fiscais / estruturais que clear-data não remove
  const residualDeletes = [
    `DELETE FROM fiscal_certificate WHERE company_id = $1`,
    `DELETE FROM company_credentials WHERE company_id = $1`,
    `DELETE FROM cost_targets WHERE company_id = $1`,
    `DELETE FROM budget_items WHERE budget_id IN (SELECT id FROM budgets WHERE company_id = $1)`,
    `DELETE FROM budgets WHERE company_id = $1`,
    `DELETE FROM alerts WHERE company_id = $1`,
    `DELETE FROM zig_processed_transactions WHERE company_id = $1`,
    `DELETE FROM zig_configurations WHERE company_id = $1`,
    // expense_types referencia cost_centers
    `DELETE FROM expense_types WHERE company_id = $1`,
    `DELETE FROM cost_centers WHERE company_id = $1`,
  ];
  for (const sql of residualDeletes) {
    try {
      await query(sql, [companyId]);
    } catch {
      /* tabela/coluna pode não existir */
    }
  }

  let rowCount = 0;
  try {
    const deleted = await query(`DELETE FROM companies WHERE id = $1`, [companyId]);
    rowCount = deleted.rowCount ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin/delete-company]', err);
    return c.json(
      {
        error: `Falha ao excluir empresa (possível vínculo residual): ${message}`,
      },
      409,
    );
  }
  if (!rowCount) return c.json({ error: 'Company not found' }, 404);

  await kvDel(`company_status:${companyId}`);
  await kvDel(`company:${companyId}`);
  await kvDel(`company_password:${companyId}`);

  return c.json({ success: true, message: 'Company deleted successfully' });
});

admin.post('/companies/:id/change-password', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const companyId = c.req.param('id');
  const body = (await c.req.json()) as { newPassword?: string };
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const { rows } = await query(`SELECT id FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
  if (!rows[0]) return c.json({ error: 'Company not found' }, 404);

  await kvSet(`company_password:${companyId}`, { hash: hashPassword(newPassword) });
  return c.json({ success: true, message: 'Password updated successfully' });
});

admin.post('/clear-data', requireAuth, async (c) => {
  if (!requireSuperAdmin(c)) return c.json({ error: 'Unauthorized - Admin access required' }, 401);

  const body = (await c.req.json()) as {
    companyId?: string;
    confirmationCode?: string;
    options?: Record<string, boolean>;
  };

  if (body.confirmationCode !== 'LIMPAR') {
    return c.json({ error: 'Código de confirmação inválido. Digite LIMPAR.' }, 400);
  }
  const companyId = String(body.companyId || '');
  if (!companyId) return c.json({ error: 'companyId is required' }, 400);

  const { rows: companyRows } = await query(
    `SELECT id, name FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  if (!companyRows[0]) return c.json({ error: 'Empresa não encontrada' }, 404);

  try {
    const result = await clearCompanyData(companyId, body.options || {});
    console.info('[admin/clear-data]', {
      companyId,
      companyName: (companyRows[0] as { name?: string }).name,
      deletions: result.deletions,
      warnings: result.warnings,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[admin/clear-data]', err);
    return c.json({ error: message }, 500);
  }
});

export default admin;
