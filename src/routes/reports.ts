import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';

const reports = new Hono<{ Variables: AppVariables }>();
reports.use('*', requireAuth, requireCompany);

reports.get('/sales', async (c) => {
  const companyId = c.get('companyId');
  const limit = parseInt(c.req.query('limit') || '500', 10);
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  const params: unknown[] = [companyId];
  let sql = `SELECT * FROM sales WHERE company_id = $1`;
  if (startDate) {
    params.push(startDate);
    sql += ` AND timestamp >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND timestamp <= $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY timestamp DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  const sales = rows.map((sale) => ({
    id: sale.id,
    registerId: sale.register_id,
    items: sale.items,
    total: parseFloat(String(sale.total)),
    discount: 0,
    paymentMethod: sale.payment_method,
    customerName: null,
    customerPhone: null,
    saleDate: sale.timestamp,
    cashierName: sale.cashier_name,
    companyId: sale.company_id,
  }));
  return c.json({ sales });
});

reports.get('/closures', async (c) => {
  const companyId = c.get('companyId');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  const params: unknown[] = [companyId];
  let sql = `SELECT * FROM cash_registers WHERE company_id = $1 AND status = 'closed'`;
  if (startDate) {
    params.push(startDate);
    sql += ` AND closed_at >= $${params.length}`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND closed_at <= $${params.length}`;
  }
  sql += ' ORDER BY closed_at DESC';

  const { rows } = await query(sql, params);
  return c.json({
    closures: rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      cashierId: r.cashier_id,
      cashierName: r.cashier_name,
      initialBalance: parseFloat(String(r.initial_balance)),
      currentBalance: parseFloat(String(r.current_balance)),
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      status: r.status,
      notes: r.closing_notes,
    })),
  });
});

export default reports;
