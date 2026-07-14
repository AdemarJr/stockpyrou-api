import { Hono } from 'hono';
import { query } from '../db/pool.js';
import { mapProductRow, mapProductToDb, type ProductDto } from '../mappers/product.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';

const products = new Hono<{ Variables: AppVariables }>();

products.use('*', requireAuth, requireCompany);

products.get('/', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT * FROM products
     WHERE company_id = $1
     ORDER BY name ASC`,
    [companyId],
  );
  return c.json({ products: rows.map((r) => mapProductRow(r as Record<string, unknown>)) });
});

products.get('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rows } = await query(
    `SELECT * FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!rows[0]) {
    return c.json({ error: 'Product not found' }, 404);
  }
  return c.json({ product: mapProductRow(rows[0] as Record<string, unknown>) });
});

products.post('/', async (c) => {
  const companyId = c.get('companyId');
  const body = (await c.req.json()) as Partial<ProductDto>;

  if (!body.name?.trim()) {
    return c.json({ error: 'name is required' }, 400);
  }

  const dbRow = {
    ...mapProductToDb(body),
    company_id: companyId,
    name: body.name.trim(),
    unit: body.measurementUnit ?? 'un',
    min_stock: body.minStock ?? 0,
    current_stock: body.currentStock ?? 0,
    cost_price: body.averageCost ?? 0,
    sale_price: body.sellingPrice ?? 0,
    status: 'active',
  };

  const columns = Object.keys(dbRow);
  const values = Object.values(dbRow);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

  const { rows } = await query(
    `INSERT INTO products (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING *`,
    values,
  );

  return c.json({ product: mapProductRow(rows[0] as Record<string, unknown>) }, 201);
});

products.put('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as Partial<ProductDto>;

  const existing = await query(
    `SELECT * FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!existing.rows[0]) {
    return c.json({ error: 'Product not found' }, 404);
  }

  const dbUpdates = mapProductToDb(body);
  if (body.shelfLife !== undefined || body.bundleItems !== undefined) {
    const current = existing.rows[0] as Record<string, unknown>;
    let existingDesc: Record<string, unknown> = {};
    const descStr = current.description != null ? String(current.description) : '';
    if (descStr.startsWith('{')) {
      try {
        existingDesc = JSON.parse(descStr) as Record<string, unknown>;
      } catch {
        existingDesc = {};
      }
    }
    const nextDesc = { ...existingDesc };
    if (body.shelfLife !== undefined) nextDesc.shelfLife = body.shelfLife;
    if (body.bundleItems !== undefined) nextDesc.bundleItems = body.bundleItems;
    dbUpdates.description = JSON.stringify(nextDesc);
  }

  const keys = Object.keys(dbUpdates);
  if (keys.length === 0) {
    return c.json({ product: mapProductRow(existing.rows[0] as Record<string, unknown>) });
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = [...Object.values(dbUpdates), id, companyId];

  const { rows } = await query(
    `UPDATE products SET ${setClause}, updated_at = now()
     WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}
     RETURNING *`,
    values,
  );

  return c.json({ product: mapProductRow(rows[0] as Record<string, unknown>) });
});

products.patch('/:id/stock', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as { quantityToAdd?: number; newAverageCost?: number };

  const quantityToAdd = Number(body.quantityToAdd);
  if (!Number.isFinite(quantityToAdd)) {
    return c.json({ error: 'quantityToAdd is required' }, 400);
  }

  const existing = await query<{ current_stock: string; cost_price: string }>(
    `SELECT current_stock, cost_price FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!existing.rows[0]) {
    return c.json({ error: 'Product not found' }, 404);
  }

  const currentStock = Number(existing.rows[0].current_stock) || 0;
  const newStock = currentStock + quantityToAdd;
  const newAverageCost =
    body.newAverageCost !== undefined ? Number(body.newAverageCost) : undefined;

  const { rows } = await query(
    `UPDATE products
     SET current_stock = $1,
         cost_price = COALESCE($2, cost_price),
         updated_at = now()
     WHERE id = $3 AND company_id = $4
     RETURNING *`,
    [newStock, newAverageCost ?? null, id, companyId],
  );

  return c.json({ product: mapProductRow(rows[0] as Record<string, unknown>) });
});

products.delete('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const result = await query(
    `DELETE FROM products WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if ((result.rowCount ?? 0) === 0) {
    return c.json({ error: 'Product not found' }, 404);
  }
  return c.json({ ok: true });
});

export default products;
