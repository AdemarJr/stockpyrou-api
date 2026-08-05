import { Hono } from 'hono';
import { fetchAllRows } from '../db/paginate.js';
import { query } from '../db/pool.js';
import { mapMovementRow, mapStockEntryRow } from '../mappers/stock.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany, requirePermission } from '../middleware/auth.js';
import {
  deleteLedgerForExpense,
  ledgerFromExpense,
  todayYmdLocal,
} from '../services/ledger.js';

const stock = new Hono<{ Variables: AppVariables }>();
stock.use('*', requireAuth, requireCompany);
stock.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  return requirePermission('canManageStock')(c, next);
});

async function resolvePurchaseExpenseDefaults(companyId: string): Promise<{
  expenseTypeId: string | null;
  costCenterId: string | null;
}> {
  const [{ rows: types }, { rows: centers }] = await Promise.all([
    query(
      `SELECT id FROM expense_types
       WHERE company_id = $1 AND is_active = true
         AND (name ILIKE '%insumo%' OR name ILIKE '%mercadoria%' OR name ILIKE '%food%' OR name ILIKE '%compra%')
       ORDER BY name ASC LIMIT 1`,
      [companyId],
    ),
    query(
      `SELECT id FROM cost_centers
       WHERE company_id = $1 AND is_active = true
         AND (name ILIKE '%cmv%' OR name ILIKE '%variáv%' OR name ILIKE '%variav%' OR name ILIKE '%compra%')
       ORDER BY name ASC LIMIT 1`,
      [companyId],
    ),
  ]);
  let expenseTypeId = types[0] ? String((types[0] as { id: string }).id) : null;
  let costCenterId = centers[0] ? String((centers[0] as { id: string }).id) : null;
  if (!expenseTypeId) {
    const { rows } = await query(
      `SELECT id FROM expense_types WHERE company_id = $1 AND is_active = true ORDER BY name ASC LIMIT 1`,
      [companyId],
    );
    expenseTypeId = rows[0] ? String((rows[0] as { id: string }).id) : null;
  }
  if (!costCenterId) {
    const { rows } = await query(
      `SELECT id FROM cost_centers WHERE company_id = $1 AND is_active = true ORDER BY name ASC LIMIT 1`,
      [companyId],
    );
    costCenterId = rows[0] ? String((rows[0] as { id: string }).id) : null;
  }
  return { expenseTypeId, costCenterId };
}

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
  const auth = c.get('auth');
  const body = await c.req.json();
  const createPayable = body.createPayable !== false && body.create_payable !== false;

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
  const entry = rows[0] as Record<string, unknown>;
  let payableId: string | null = null;

  const totalCost = parseFloat(String(body.totalPrice ?? entry.total_cost ?? 0)) || 0;
  if (createPayable && totalCost > 0) {
    try {
      const { expenseTypeId, costCenterId } = await resolvePurchaseExpenseDefaults(companyId);
      if (expenseTypeId && costCenterId) {
        const due =
          typeof body.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)
            ? body.dueDate
            : todayYmdLocal();
        const { rows: expRows } = await query(
          `INSERT INTO operational_expenses (
             company_id, expense_type_id, cost_center_id, amount, description,
             due_date, payment_status, paid_amount, supplier_id, stock_entry_id, user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'pending',0,$7,$8,$9)
           RETURNING *`,
          [
            companyId,
            expenseTypeId,
            costCenterId,
            totalCost,
            body.notes || `Compra estoque #${String(entry.id).slice(0, 8)}`,
            due,
            body.supplierId ?? entry.supplier_id ?? null,
            entry.id,
            auth.userId,
          ],
        );
        const exp = expRows[0] as Record<string, unknown>;
        payableId = String(exp.id);
        await ledgerFromExpense({
          companyId,
          expenseId: payableId,
          amount: totalCost,
          dueDate: due,
          paymentStatus: 'pending',
          description: String(exp.description || 'Compra estoque'),
          costCenterId,
          supplierId: body.supplierId ?? null,
          stockEntryId: String(entry.id),
          userId: auth.userId,
        });
      }
    } catch (err) {
      console.warn('[stock/entries] auto AP:', err);
    }
  }

  return c.json(
    {
      entry: mapStockEntryRow(entry),
      payableId,
    },
    201,
  );
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
  const entryId = c.req.param('id');

  const existing = await query(
    `SELECT id FROM stock_entries WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [entryId, companyId],
  );
  if (!existing.rowCount) return c.json({ error: 'Not found' }, 404);

  // Despesas/ledger criados na entrada (FK stock_entry_id / operational_expense_id)
  const { rows: expenseRows } = await query(
    `SELECT id FROM operational_expenses WHERE company_id = $1 AND stock_entry_id = $2`,
    [companyId, entryId],
  );
  for (const row of expenseRows) {
    const expenseId = String((row as { id: string }).id);
    await deleteLedgerForExpense(companyId, expenseId);
  }
  await query(
    `DELETE FROM operational_expense_payments
     WHERE company_id = $1
       AND expense_id IN (
         SELECT id FROM operational_expenses WHERE company_id = $1 AND stock_entry_id = $2
       )`,
    [companyId, entryId],
  );
  await query(
    `DELETE FROM operational_expenses WHERE company_id = $1 AND stock_entry_id = $2`,
    [companyId, entryId],
  );
  // Ledger órfão que só referencia a entrada
  await query(
    `DELETE FROM financial_movements WHERE company_id = $1 AND stock_entry_id = $2`,
    [companyId, entryId],
  );

  const result = await query(
    'DELETE FROM stock_entries WHERE id = $1 AND company_id = $2',
    [entryId, companyId],
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
  try {
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stock/deduct]', msg);
    return c.json({ error: msg }, 500);
  }
});

export default stock;
