import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany, requirePermission } from '../middleware/auth.js';

const reports = new Hono<{ Variables: AppVariables }>();
reports.use('*', requireAuth, requireCompany, requirePermission('canViewReports'));

reports.get('/sales', async (c) => {
  const companyId = c.get('companyId');
  const limit = parseInt(c.req.query('limit') || '500', 10);
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  const params: unknown[] = [companyId];
  let sql = `SELECT * FROM sales WHERE company_id = $1`;
  // Datas civis inclusive em America/Sao_Paulo (evita `<= YYYY-MM-DD` = meia-noite UTC).
  if (startDate) {
    params.push(startDate);
    sql += ` AND timestamp >= ($${params.length}::date AT TIME ZONE 'America/Sao_Paulo')`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND timestamp < (($${params.length}::date + 1) AT TIME ZONE 'America/Sao_Paulo')`;
  }
  params.push(limit);
  sql += ` ORDER BY timestamp DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  const sales = rows.map((sale) => {
    const details =
      sale.payment_details && typeof sale.payment_details === 'object'
        ? (sale.payment_details as Record<string, unknown>)
        : typeof sale.payment_details === 'string'
          ? (() => {
              try {
                return JSON.parse(String(sale.payment_details)) as Record<string, unknown>;
              } catch {
                return {};
              }
            })()
          : {};
    const discount =
      parseFloat(String(details.cartDiscount ?? details.discount ?? 0)) || 0;
    return {
      id: sale.id,
      registerId: sale.register_id,
      items: sale.items,
      total: parseFloat(String(sale.total)),
      discount,
      paymentMethod: sale.payment_method,
      customerName:
        typeof details.customerName === 'string' ? details.customerName : null,
      customerPhone: null,
      saleDate: sale.timestamp,
      cashierName: sale.cashier_name,
      companyId: sale.company_id,
    };
  });
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
    sql += ` AND closed_at >= ($${params.length}::date AT TIME ZONE 'America/Sao_Paulo')`;
  }
  if (endDate) {
    params.push(endDate);
    sql += ` AND closed_at < (($${params.length}::date + 1) AT TIME ZONE 'America/Sao_Paulo')`;
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
