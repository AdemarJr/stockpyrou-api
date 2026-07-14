import { Hono } from 'hono';
import { kvGet } from '../db/kv.js';
import { query } from '../db/pool.js';
import { resolveCompanyId } from '../auth/resolve-company.js';
import { getUserProfileByToken } from '../auth/login-service.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

function mapCompany(data: Record<string, unknown>) {
  return {
    id: String(data.id),
    name: String(data.name),
    cnpj: data.cnpj != null ? String(data.cnpj) : undefined,
    status: data.status != null ? String(data.status) : 'active',
    createdAt: String(data.created_at ?? data.createdAt),
  };
}

function extractToken(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const custom = c.req.header('X-Custom-Token');
  if (custom?.trim()) return custom.trim();
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

const companies = new Hono<{ Variables: AppVariables }>();

companies.get('/me', async (c) => {
  const token = extractToken(c);
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const profile = await getUserProfileByToken(token);
  if (!profile) return c.json({ error: 'Unauthorized' }, 401);

  const companyId = await resolveCompanyId(
    {
      userId: profile.id,
      email: profile.email,
      fullName: profile.fullName,
      role: profile.role,
      companyId: profile.companyId,
    },
    c.req.header('X-Company-Id'),
  );
  if (!companyId) return c.json({ error: 'Company not found' }, 404);

  const kvCompany = await kvGet(`company:${companyId}`);
  if (kvCompany) {
    return c.json({ company: mapCompany(kvCompany) });
  }

  const { rows } = await query('SELECT * FROM companies WHERE id = $1 LIMIT 1', [companyId]);
  if (!rows[0]) return c.json({ error: 'Company not found' }, 404);
  return c.json({ company: mapCompany(rows[0] as Record<string, unknown>) });
});

companies.get('/superadmin/all', requireAuth, async (c) => {
  const auth = c.get('auth');
  if (auth.role !== 'superadmin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const { rows } = await query('SELECT * FROM companies ORDER BY name ASC');
  return c.json({ companies: rows.map((r) => mapCompany(r as Record<string, unknown>)) });
});

companies.get('/user/:userId', requireAuth, async (c) => {
  const userId = c.req.param('userId');
  const { rows: links } = await query<{ company_id: string }>(
    'SELECT company_id FROM user_companies WHERE user_id = $1',
    [userId],
  );
  if (links.length === 0) return c.json({ companies: [] });
  const ids = links.map((l) => l.company_id);
  const { rows } = await query(
    `SELECT * FROM companies WHERE id = ANY($1::uuid[]) ORDER BY name ASC`,
    [ids],
  );
  return c.json({ companies: rows.map((r) => mapCompany(r as Record<string, unknown>)) });
});

companies.get('/:id', requireAuth, async (c) => {
  const { rows } = await query('SELECT * FROM companies WHERE id = $1 LIMIT 1', [
    c.req.param('id'),
  ]);
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ company: mapCompany(rows[0] as Record<string, unknown>) });
});

companies.post('/', requireAuth, async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json();
  const { rows } = await query(
    'INSERT INTO companies (name, cnpj) VALUES ($1, $2) RETURNING *',
    [body.name, body.cnpj ?? null],
  );
  const company = rows[0] as Record<string, unknown>;
  await query(
    'INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, $3)',
    [auth.userId, company.id, 'admin'],
  );
  return c.json({ company: mapCompany(company) }, 201);
});

companies.get('/:id/status', requireAuth, async (c) => {
  const { rows } = await query(
    'SELECT id, status, is_active FROM companies WHERE id = $1 LIMIT 1',
    [c.req.param('id')],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  const row = rows[0] as Record<string, unknown>;
  return c.json({
    id: row.id,
    status: row.status ?? (row.is_active === false ? 'inactive' : 'active'),
  });
});

export default companies;
