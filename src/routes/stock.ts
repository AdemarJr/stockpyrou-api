import { Hono } from 'hono';
import { fetchAllRows } from '../db/paginate.js';
import { query } from '../db/pool.js';
import { mapMovementRow, mapStockEntryRow } from '../mappers/stock.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';

const stock = new Hono<{ Variables: AppVariables }>();
stock.use('*', requireAuth, requireCompany);

stock.get('/entries', async (c) => {
  const companyId = c.get('companyId');
  const rows = await fetchAllRows<Record<string, unknown>>(
    `SELECT * FROM stock_entries WHERE company_id = $1 ORDER BY entry_date DESC`,
    [companyId],
  );
  return c.json({ entries: rows.map(mapStockEntryRow) });
});

stock.get('/entries/:id', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    'SELECT * FROM stock_entries WHERE id = $1 AND company_id = $2 LIMIT 1',
    [c.req.param('id'), companyId],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ entry: mapStockEntryRow(rows[0] as Record<string, unknown>) });
});

stock.post('/entries', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query(
    `INSERT INTO stock_entries (
      company_id, product_id, supplier_id, quantity, unit_cost, total_cost,
      batch_number, expiry_date, notes, entry_date
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING *`,
    [
      companyId,
      body.productId,
      body.supplierId,
      body.quantity,
      body.unitPrice,
      body.totalPrice,
      body.batchNumber ?? null,
      body.expirationDate ? String(body.expirationDate).split('T')[0] : null,
      body.notes ?? null,
    ],
  );
  return c.json({ entry: mapStockEntryRow(rows[0] as Record<string, unknown>) }, 201);
});

stock.put('/entries/:id', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query(
    `UPDATE stock_entries SET
      quantity = COALESCE($1, quantity),
      unit_cost = COALESCE($2, unit_cost),
      total_cost = COALESCE($3, total_cost),
      batch_number = COALESCE($4, batch_number),
      expiry_date = COALESCE($5, expiry_date),
      notes = COALESCE($6, notes),
      supplier_id = COALESCE($7, supplier_id),
      updated_at = now()
     WHERE id = $8 AND company_id = $9 RETURNING *`,
    [
      body.quantity ?? null,
      body.unitPrice ?? null,
      body.totalPrice ?? null,
      body.batchNumber ?? null,
      body.expirationDate ? String(body.expirationDate).split('T')[0] : null,
      body.notes ?? null,
      body.supplierId ?? null,
      c.req.param('id'),
      companyId,
    ],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ entry: mapStockEntryRow(rows[0] as Record<string, unknown>) });
});

stock.delete('/entries/:id', async (c) => {
  const companyId = c.get('companyId');
  const result = await query(
    'DELETE FROM stock_entries WHERE id = $1 AND company_id = $2',
    [c.req.param('id'), companyId],
  );
  if ((result.rowCount ?? 0) === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

stock.get('/movements', async (c) => {
  const companyId = c.get('companyId');
  const rows = await fetchAllRows<Record<string, unknown>>(
    `SELECT * FROM stock_movements WHERE company_id = $1 ORDER BY movement_date DESC`,
    [companyId],
  );
  return c.json({ movements: rows.map(mapMovementRow) });
});

stock.get('/movements/:id', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    'SELECT * FROM stock_movements WHERE id = $1 AND company_id = $2 LIMIT 1',
    [c.req.param('id'), companyId],
  );
  if (!rows[0]) return c.json({ error: 'Not found' }, 404);
  return c.json({ movement: mapMovementRow(rows[0] as Record<string, unknown>) });
});

stock.post('/movements', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const qty = Number(body.quantity) || 0;
  const cost = Number(body.cost) || 0;
  const unitCost = qty > 0 && cost ? cost / qty : cost;
  const { rows } = await query(
    `INSERT INTO stock_movements (
      company_id, product_id, movement_type, quantity, unit_cost, total_value,
      movement_date, notes, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8) RETURNING *`,
    [
      companyId,
      body.productId,
      body.type,
      qty,
      unitCost,
      cost || null,
      body.notes ?? body.reason ?? null,
      body.userId ?? null,
    ],
  );
  return c.json({ movement: mapMovementRow(rows[0] as Record<string, unknown>) }, 201);
});

stock.post('/deduct', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query<{
    applied: boolean;
    movement_id: string | null;
    new_stock: string | number;
  }>(
    `SELECT * FROM deduct_stock_once($1,$2,$3,$4,$5,$6,$7)`,
    [
      companyId,
      body.productId,
      body.quantity,
      body.source,
      body.notes ?? null,
      body.movementType ?? 'venda',
      body.movementDate ?? new Date().toISOString(),
    ],
  );
  const row = rows[0];
  return c.json({
    applied: row?.applied === true,
    movementId: row?.movement_id ?? null,
    newStock: Number(row?.new_stock ?? 0) || 0,
  });
});

export default stock;
