import { Hono } from 'hono';
import { query } from '../db/pool.js';
import { resolveCompanyId } from '../auth/resolve-company.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';

function calculatePaymentBreakdown(sales: Array<Record<string, unknown>>) {
  const breakdown: Record<string, { count: number; total: number }> = {
    money: { count: 0, total: 0 },
    pix: { count: 0, total: 0 },
    credit: { count: 0, total: 0 },
    debit: { count: 0, total: 0 },
    fiado: { count: 0, total: 0 },
  };
  for (const sale of sales) {
    const method = String(sale.payment_method ?? sale.paymentMethod ?? 'money');
    if (breakdown[method]) {
      breakdown[method].count++;
      breakdown[method].total += parseFloat(String(sale.total)) || 0;
    }
  }
  return breakdown;
}

function mapRegister(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    cashierId: String(row.cashier_id),
    cashierName: String(row.cashier_name),
    initialBalance: parseFloat(String(row.initial_balance)) || 0,
    currentBalance: parseFloat(String(row.current_balance)) || 0,
    openedAt: row.opened_at,
    closedAt: row.closed_at ?? undefined,
    status: String(row.status),
  };
}

const cashier = new Hono<{ Variables: AppVariables }>();

async function withProfile(c: Parameters<typeof requireAuth>[0]) {
  const auth = c.get('auth');
  const companyId = await resolveCompanyId(auth, c.req.header('X-Company-Id'));
  if (!companyId) return { error: c.json({ error: 'Company ID not found' }, 400) };
  return { auth, companyId };
}

cashier.post('/open', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const body = await c.req.json();
  const finalCashierId = body.cashierId || auth.userId;
  const finalCashierName = body.cashierName || auth.fullName;
  const initialBalance = parseFloat(String(body.initialBalance)) || 0;

  const { rows: existing } = await query(
    `SELECT * FROM cash_registers WHERE company_id = $1 AND cashier_id = $2 AND status = 'open'`,
    [companyId, finalCashierId],
  );
  if (existing[0]) {
    return c.json({ success: true, register: mapRegister(existing[0] as Record<string, unknown>) });
  }

  const { rows } = await query(
    `INSERT INTO cash_registers (company_id, cashier_id, cashier_name, initial_balance, current_balance, status)
     VALUES ($1,$2,$3,$4,$4,'open') RETURNING *`,
    [companyId, finalCashierId, finalCashierName, initialBalance],
  );
  return c.json({ success: true, register: mapRegister(rows[0] as Record<string, unknown>) });
});

cashier.get('/current', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;

  const { rows: registers } = await query(
    `SELECT * FROM cash_registers WHERE company_id = $1 AND cashier_id = $2 AND status = 'open'
     ORDER BY opened_at DESC LIMIT 1`,
    [companyId, auth.userId],
  );
  if (!registers[0]) return c.json({ register: null });

  const register = registers[0] as Record<string, unknown>;
  const { rows: salesData } = await query(
    `SELECT * FROM sales WHERE register_id = $1 ORDER BY timestamp ASC`,
    [register.id],
  );

  const sales = salesData.map((sale) => ({
    id: sale.id,
    items: sale.items,
    total: parseFloat(String(sale.total)),
    paymentMethod: sale.payment_method,
    paymentDetails: sale.payment_details,
    timestamp: sale.timestamp,
    cashierId: sale.cashier_id,
    cashierName: sale.cashier_name,
  }));

  return c.json({
    register: {
      ...mapRegister(register),
      salesCount: sales.length,
      sales,
    },
  });
});

cashier.post('/sale', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const body = await c.req.json();
  const { registerId, items, total, paymentMethod, paymentDetails, clientRequestId } = body;

  const { rows: regRows } = await query(
    'SELECT * FROM cash_registers WHERE id = $1 AND company_id = $2 LIMIT 1',
    [registerId, companyId],
  );
  const register = regRows[0] as Record<string, unknown> | undefined;
  if (!register) return c.json({ error: 'Caixa não encontrado' }, 404);
  if (register.status !== 'open') return c.json({ error: 'Caixa não está aberto' }, 400);

  const clientReq =
    typeof clientRequestId === 'string' && clientRequestId.trim() ? clientRequestId.trim() : null;

  let newSale: Record<string, unknown>;
  try {
    const { rows } = await query(
      `INSERT INTO sales (company_id, register_id, cashier_id, cashier_name, total, payment_method, payment_details, items, client_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        companyId,
        registerId,
        auth.userId,
        auth.fullName,
        parseFloat(String(total)),
        paymentMethod,
        JSON.stringify(paymentDetails ?? {}),
        JSON.stringify(items),
        clientReq,
      ],
    );
    newSale = rows[0] as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (clientReq && /duplicate key|unique constraint|client_request_id/i.test(msg)) {
      const { rows: existing } = await query(
        'SELECT * FROM sales WHERE company_id = $1 AND client_request_id = $2 LIMIT 1',
        [companyId, clientReq],
      );
      if (!existing[0]) return c.json({ error: 'Erro ao registrar venda: ' + msg }, 500);
      newSale = existing[0] as Record<string, unknown>;
    } else {
      return c.json({ error: 'Erro ao registrar venda: ' + msg }, 500);
    }
  }

  let newBalance = parseFloat(String(register.current_balance));
  if (paymentMethod === 'money' || paymentMethod === 'pix') {
    newBalance += parseFloat(String(total));
    await query('UPDATE cash_registers SET current_balance = $1 WHERE id = $2', [
      newBalance,
      registerId,
    ]);
  }

  const sale = {
    id: newSale.id,
    items: newSale.items,
    total: parseFloat(String(newSale.total)),
    paymentMethod: newSale.payment_method,
    paymentDetails: newSale.payment_details,
    timestamp: newSale.timestamp,
    cashierId: newSale.cashier_id,
    cashierName: newSale.cashier_name,
  };

  return c.json({
    success: true,
    sale,
    register: { ...mapRegister(register), currentBalance: newBalance },
  });
});

cashier.post('/withdrawal', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const { registerId, amount, reason } = await c.req.json();

  const { rows: regRows } = await query(
    'SELECT * FROM cash_registers WHERE id = $1 AND company_id = $2 LIMIT 1',
    [registerId, companyId],
  );
  const register = regRows[0] as Record<string, unknown> | undefined;
  if (!register || register.status !== 'open') {
    return c.json({ error: 'Caixa não encontrado ou fechado' }, 400);
  }

  const { rows: movRows } = await query(
    `INSERT INTO cash_movements (company_id, register_id, type, amount, reason, performed_by_id, performed_by_name)
     VALUES ($1,$2,'withdrawal',$3,$4,$5,$6) RETURNING *`,
    [companyId, registerId, parseFloat(String(amount)), reason, auth.userId, auth.fullName],
  );

  const newBalance = parseFloat(String(register.current_balance)) - parseFloat(String(amount));
  await query('UPDATE cash_registers SET current_balance = $1 WHERE id = $2', [newBalance, registerId]);

  const mov = movRows[0] as Record<string, unknown>;
  return c.json({
    success: true,
    withdrawal: {
      id: mov.id,
      amount: parseFloat(String(mov.amount)),
      reason: mov.reason,
      timestamp: mov.timestamp,
      performedBy: mov.performed_by_name,
    },
    register: { ...mapRegister(register), currentBalance: newBalance },
  });
});

cashier.post('/deposit', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const { registerId, amount, reason } = await c.req.json();

  const { rows: regRows } = await query(
    'SELECT * FROM cash_registers WHERE id = $1 AND company_id = $2 LIMIT 1',
    [registerId, companyId],
  );
  const register = regRows[0] as Record<string, unknown> | undefined;
  if (!register || register.status !== 'open') {
    return c.json({ error: 'Caixa não encontrado ou fechado' }, 400);
  }

  const { rows: movRows } = await query(
    `INSERT INTO cash_movements (company_id, register_id, type, amount, reason, performed_by_id, performed_by_name)
     VALUES ($1,$2,'deposit',$3,$4,$5,$6) RETURNING *`,
    [companyId, registerId, parseFloat(String(amount)), reason, auth.userId, auth.fullName],
  );

  const newBalance = parseFloat(String(register.current_balance)) + parseFloat(String(amount));
  await query('UPDATE cash_registers SET current_balance = $1 WHERE id = $2', [newBalance, registerId]);

  const mov = movRows[0] as Record<string, unknown>;
  return c.json({
    success: true,
    deposit: {
      id: mov.id,
      amount: parseFloat(String(mov.amount)),
      reason: mov.reason,
      timestamp: mov.timestamp,
      performedBy: mov.performed_by_name,
    },
    register: { ...mapRegister(register), currentBalance: newBalance },
  });
});

cashier.post('/close', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const { registerId, finalBalance, notes } = await c.req.json();

  const { rows: regRows } = await query(
    'SELECT * FROM cash_registers WHERE id = $1 AND company_id = $2 LIMIT 1',
    [registerId, companyId],
  );
  const register = regRows[0] as Record<string, unknown> | undefined;
  if (!register) return c.json({ error: 'Caixa não encontrado' }, 404);
  if (register.status !== 'open') return c.json({ error: 'Caixa já está fechado' }, 400);

  const { rows: sales } = await query('SELECT * FROM sales WHERE register_id = $1', [registerId]);
  const { rows: movements } = await query('SELECT * FROM cash_movements WHERE register_id = $1', [
    registerId,
  ]);

  const totalSales = sales.reduce((s, r) => s + (parseFloat(String(r.total)) || 0), 0);
  const totalWithdrawals = movements
    .filter((m) => m.type === 'withdrawal')
    .reduce((s, m) => s + (parseFloat(String(m.amount)) || 0), 0);
  const totalDeposits = movements
    .filter((m) => m.type === 'deposit')
    .reduce((s, m) => s + (parseFloat(String(m.amount)) || 0), 0);
  const expectedBalance =
    parseFloat(String(register.initial_balance)) + totalSales + totalDeposits - totalWithdrawals;
  const difference = parseFloat(String(finalBalance)) - expectedBalance;

  const { rows: closed } = await query(
    `UPDATE cash_registers SET status = 'closed', closed_at = now(), closing_notes = $1
     WHERE id = $2 RETURNING *`,
    [notes ?? null, registerId],
  );

  return c.json({
    success: true,
    register: {
      ...mapRegister(closed[0] as Record<string, unknown>),
      closedBy: auth.fullName,
      finalBalance: parseFloat(String(finalBalance)),
      expectedBalance,
      difference,
      notes,
      summary: {
        totalSales,
        totalWithdrawals,
        totalDeposits,
        salesCount: sales.length,
        paymentBreakdown: calculatePaymentBreakdown(sales as Record<string, unknown>[]),
      },
    },
  });
});

cashier.get('/history', requireAuth, async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { companyId } = ctx;
  const limit = parseInt(c.req.query('limit') || '30', 10);

  const { rows } = await query(
    `SELECT * FROM cash_registers WHERE company_id = $1 AND status = 'closed'
     ORDER BY closed_at DESC NULLS LAST LIMIT $2`,
    [companyId, limit],
  );

  return c.json({
    history: rows.map((r) => mapRegister(r as Record<string, unknown>)),
  });
});

export default cashier;
