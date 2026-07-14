import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';

function mapPriceHistory(data: Record<string, unknown>) {
  return {
    id: String(data.id),
    companyId: data.company_id != null ? String(data.company_id) : '',
    productId: String(data.product_id),
    supplierId: data.supplier_id != null ? String(data.supplier_id) : '',
    price: Number(data.price) || 0,
    quantity: 0,
    date: String(data.effective_date ?? data.created_at),
    supplierName: data.supplier_name != null ? String(data.supplier_name) : undefined,
  };
}

const priceHistory = new Hono<{ Variables: AppVariables }>();
priceHistory.use('*', requireAuth, requireCompany);

priceHistory.get('/', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT ph.*, s.name AS supplier_name
     FROM price_history ph
     LEFT JOIN suppliers s ON s.id = ph.supplier_id
     WHERE ph.company_id = $1
     ORDER BY ph.effective_date DESC`,
    [companyId],
  );
  return c.json({ history: rows.map((r) => mapPriceHistory(r as Record<string, unknown>)) });
});

priceHistory.get('/product/:productId', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT * FROM price_history WHERE product_id = $1 AND company_id = $2 ORDER BY effective_date DESC`,
    [c.req.param('productId'), companyId],
  );
  return c.json({ history: rows.map((r) => mapPriceHistory(r as Record<string, unknown>)) });
});

priceHistory.get('/product/:productId/best', async (c) => {
  const companyId = c.get('companyId');
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const { rows } = await query(
    `SELECT * FROM price_history
     WHERE product_id = $1 AND company_id = $2 AND effective_date >= $3
     ORDER BY price ASC LIMIT 1`,
    [c.req.param('productId'), companyId, sixMonthsAgo.toISOString()],
  );
  if (!rows[0]) return c.json({ best: null });
  return c.json({ best: mapPriceHistory(rows[0] as Record<string, unknown>) });
});

priceHistory.post('/', async (c) => {
  const companyId = c.get('companyId');
  const body = await c.req.json();
  const { rows } = await query(
    `INSERT INTO price_history (company_id, product_id, supplier_id, price, price_type, effective_date)
     VALUES ($1,$2,$3,$4,'cost',now()) RETURNING *`,
    [companyId, body.productId, body.supplierId, body.price],
  );
  return c.json({ history: mapPriceHistory(rows[0] as Record<string, unknown>) }, 201);
});

export default priceHistory;
