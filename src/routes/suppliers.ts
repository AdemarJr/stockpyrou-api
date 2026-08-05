import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany, requirePermission } from '../middleware/auth.js';

function mapSupplier(data: Record<string, unknown>) {
  return {
    id: String(data.id),
    companyId: String(data.company_id),
    name: String(data.name),
    contact: data.contact != null ? String(data.contact) : undefined,
    email: data.email != null ? String(data.email) : undefined,
    phone: data.phone != null ? String(data.phone) : undefined,
    rating: data.rating != null ? Number(data.rating) : undefined,
    reliability: data.reliability != null ? Number(data.reliability) : undefined,
    createdAt: String(data.created_at),
    updatedAt: String(data.updated_at ?? data.created_at),
  };
}

const suppliers = new Hono<{ Variables: AppVariables }>();
suppliers.use('*', requireAuth, requireCompany);
suppliers.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  return requirePermission('canManageStock')(c, next);
});

suppliers.get('/', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    'SELECT * FROM suppliers WHERE company_id = $1 ORDER BY name ASC',
    [companyId],
  );
  return c.json({ suppliers: rows.map((r) => mapSupplier(r as Record<string, unknown>)) });
});

suppliers.get('/:id', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    'SELECT * FROM suppliers WHERE id = $1 AND company_id = $2 LIMIT 1',
    [c.req.param('id'), companyId],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ supplier: mapSupplier(rows[0] as Record<string, unknown>) });
});

suppliers.post('/', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query(
    `INSERT INTO suppliers (company_id, name, contact, email, phone, rating, reliability)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      companyId,
      body.name,
      body.contact ?? null,
      body.email ?? null,
      body.phone ?? null,
      body.rating ?? null,
      body.reliability ?? null,
    ],
  );
  return c.json({ supplier: mapSupplier(rows[0] as Record<string, unknown>) }, 201);
});

suppliers.put('/:id', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query(
    `UPDATE suppliers SET
      name = COALESCE($1, name),
      contact = COALESCE($2, contact),
      email = COALESCE($3, email),
      phone = COALESCE($4, phone),
      rating = COALESCE($5, rating),
      reliability = COALESCE($6, reliability),
      updated_at = now()
     WHERE id = $7 AND company_id = $8 RETURNING *`,
    [
      body.name ?? null,
      body.contact ?? null,
      body.email ?? null,
      body.phone ?? null,
      body.rating ?? null,
      body.reliability ?? null,
      c.req.param('id'),
      companyId,
    ],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ supplier: mapSupplier(rows[0] as Record<string, unknown>) });
});

suppliers.delete('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');

  const existing = await query(
    `SELECT id FROM suppliers WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!existing.rowCount) return c.json({ error: 'Not found' }, 404);

  const deps = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM stock_entries WHERE company_id = $1 AND supplier_id = $2) AS entries,
       (SELECT COUNT(*)::int FROM products WHERE company_id = $1 AND supplier_id = $2) AS products,
       (SELECT COUNT(*)::int FROM operational_expenses WHERE company_id = $1 AND supplier_id = $2) AS expenses`,
    [companyId, id],
  );
  const row = deps.rows[0] as { entries: number; products: number; expenses: number };
  const total =
    (Number(row?.entries) || 0) + (Number(row?.products) || 0) + (Number(row?.expenses) || 0);
  if (total > 0) {
    return c.json(
      {
        error:
          'Não é possível excluir este fornecedor: há entradas, produtos ou despesas vinculados. Remova os vínculos antes.',
        dependencies: {
          stockEntries: Number(row?.entries) || 0,
          products: Number(row?.products) || 0,
          expenses: Number(row?.expenses) || 0,
        },
      },
      409,
    );
  }

  try {
    const result = await query('DELETE FROM suppliers WHERE id = $1 AND company_id = $2', [
      id,
      companyId,
    ]);
    if ((result.rowCount ?? 0) === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  } catch (err) {
    console.warn('[suppliers.delete]', err);
    return c.json(
      {
        error:
          'Não é possível excluir este fornecedor porque há registros vinculados no sistema.',
      },
      409,
    );
  }
});

export default suppliers;
