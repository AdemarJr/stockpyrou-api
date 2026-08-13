import { Hono } from 'hono';
import { query } from '../db/pool.js';
import { resolveCompanyId } from '../auth/resolve-company.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { createReceivableFromSale } from './receivables.js';
import { ledgerFromSale } from '../services/ledger.js';

function parseSalePaymentDetails(sale: Record<string, unknown>): Record<string, unknown> {
  const raw = sale.payment_details ?? sale.paymentDetails;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** Valor que entrou na gaveta (dinheiro/pix), alinhado ao POST /cashier/sale. */
function drawerInFromSale(sale: Record<string, unknown>): number {
  const details = parseSalePaymentDetails(sale);
  const split = Array.isArray(details.payments)
    ? (details.payments as Array<{ method?: string; amount?: number }>)
    : null;
  if (split && split.length > 0) {
    return split
      .filter((p) => p.method === 'money' || p.method === 'pix')
      .reduce((s, p) => s + (parseFloat(String(p.amount)) || 0), 0);
  }
  const method = String(sale.payment_method ?? sale.paymentMethod ?? 'money');
  if (method === 'money' || method === 'pix') {
    return parseFloat(String(sale.total)) || 0;
  }
  return 0;
}

function calculatePaymentBreakdown(sales: Array<Record<string, unknown>>) {
  const breakdown: Record<string, { count: number; total: number }> = {
    money: { count: 0, total: 0 },
    pix: { count: 0, total: 0 },
    credit: { count: 0, total: 0 },
    debit: { count: 0, total: 0 },
    fiado: { count: 0, total: 0 },
    boleto: { count: 0, total: 0 },
  };
  for (const sale of sales) {
    const details = parseSalePaymentDetails(sale);
    const split = Array.isArray(details.payments)
      ? (details.payments as Array<{ method?: string; amount?: number }>)
      : null;
    if (split && split.length > 0) {
      for (const part of split) {
        const method = String(part.method || 'money');
        const amount = parseFloat(String(part.amount)) || 0;
        if (!breakdown[method] || amount <= 0) continue;
        breakdown[method].count += 1;
        breakdown[method].total += amount;
      }
      continue;
    }
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
cashier.use('*', requireAuth, requirePermission('canAccessCashier'));

async function withProfile(c: Parameters<typeof requireAuth>[0]) {
  const auth = c.get('auth');
  const companyId = await resolveCompanyId(auth, c.req.header('X-Company-Id'));
  if (!companyId) return { error: c.json({ error: 'Company ID not found' }, 400) };
  return { auth, companyId };
}

cashier.post('/open', async (c) => {
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

cashier.get('/current', async (c) => {
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
  const { rows: movements } = await query(
    `SELECT * FROM cash_movements WHERE register_id = $1 ORDER BY timestamp ASC`,
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

  const mapMov = (m: Record<string, unknown>) => ({
    id: m.id,
    amount: parseFloat(String(m.amount)) || 0,
    reason: m.reason != null ? String(m.reason) : '',
    timestamp: m.timestamp,
    performedBy: m.performed_by_name != null ? String(m.performed_by_name) : '',
  });

  const withdrawals = movements
    .filter((m) => String(m.type) === 'withdrawal')
    .map((m) => mapMov(m as Record<string, unknown>));
  const deposits = movements
    .filter((m) => String(m.type) === 'deposit')
    .map((m) => mapMov(m as Record<string, unknown>));

  return c.json({
    register: {
      ...mapRegister(register),
      salesCount: sales.length,
      sales,
      withdrawals,
      deposits,
    },
  });
});

cashier.post('/sale', async (c) => {
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

  // Aceita só UUID — evita IDs frágeis e garante índice único de idempotência.
  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const clientReqRaw =
    typeof clientRequestId === 'string' && clientRequestId.trim() ? clientRequestId.trim() : null;
  const clientReq = clientReqRaw && uuidRe.test(clientReqRaw) ? clientReqRaw : null;

  const detailsObj =
    paymentDetails && typeof paymentDetails === 'object'
      ? (paymentDetails as Record<string, unknown>)
      : {};
  const emitNfce = detailsObj.emitNfce === true || detailsObj.emit_nfce === true;
  const emitNfe = detailsObj.emitNfe === true || detailsObj.emit_nfe === true;
  const customerIdRaw =
    typeof detailsObj.customerId === 'string'
      ? detailsObj.customerId.trim()
      : typeof detailsObj.customer_id === 'string'
        ? detailsObj.customer_id.trim()
        : '';
  const customerId = customerIdRaw || null;

  const earlySplit = Array.isArray(detailsObj.payments)
    ? (detailsObj.payments as Array<{ method?: string }>)
    : [];
  // Fiado/boleto, NFC-e e NF-e exigem cliente com documento
  const needsCustomer =
    paymentMethod === 'fiado' ||
    paymentMethod === 'boleto' ||
    earlySplit.some((p) => p.method === 'fiado' || p.method === 'boleto') ||
    emitNfce ||
    emitNfe;
  if (needsCustomer) {
    const customerName = String(detailsObj.customerName || detailsObj.customer_name || '').trim();
    const customerDocument = String(
      detailsObj.customerDocument || detailsObj.customer_document || '',
    ).replace(/\D/g, '');
    if (!customerId && (!customerName || (customerDocument.length !== 11 && customerDocument.length !== 14))) {
      return c.json(
        {
          error:
            'Informe o cliente com nome e CPF/CNPJ (obrigatório para fiado/boleto, NFC-e e NF-e)',
        },
        400,
      );
    }
  }

  const mapSaleResponse = (
    row: Record<string, unknown>,
    balance: number,
    opts?: { idempotentReplay?: boolean },
  ) => {
    const sale = {
      id: row.id,
      items: row.items,
      total: parseFloat(String(row.total)),
      paymentMethod: row.payment_method,
      paymentDetails: row.payment_details,
      emitNfce: !!(row.emit_nfce ?? emitNfce),
      emitNfe: !!(row.emit_nfe ?? emitNfe),
      timestamp: row.timestamp,
      cashierId: row.cashier_id,
      cashierName: row.cashier_name,
    };
    return c.json({
      success: true,
      sale,
      idempotentReplay: !!opts?.idempotentReplay,
      register: { ...mapRegister(register), currentBalance: balance },
    });
  };

  // Replay idempotente: não reaplicar saldo / receivable / ledger
  if (clientReq) {
    const { rows: existingEarly } = await query(
      'SELECT * FROM sales WHERE company_id = $1 AND client_request_id = $2 LIMIT 1',
      [companyId, clientReq],
    );
    if (existingEarly[0]) {
      return mapSaleResponse(
        existingEarly[0] as Record<string, unknown>,
        parseFloat(String(register.current_balance)) || 0,
        { idempotentReplay: true },
      );
    }
  }

  let newSale: Record<string, unknown>;
  try {
    const { rows } = await query(
      `INSERT INTO sales (company_id, register_id, cashier_id, cashier_name, total, payment_method, payment_details, items, client_request_id, emit_nfce, emit_nfe, customer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        companyId,
        registerId,
        auth.userId,
        auth.fullName,
        parseFloat(String(total)),
        paymentMethod,
        JSON.stringify({ ...detailsObj, emitNfce, emitNfe, customerId }),
        JSON.stringify(items),
        clientReq,
        emitNfce,
        emitNfe,
        customerId,
      ],
    );
    newSale = rows[0] as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Colunas novas ainda não migradas — grava sem elas
    if (/emit_nfe|emit_nfce|customer_id/i.test(msg)) {
      try {
        const { rows } = await query(
          `INSERT INTO sales (company_id, register_id, cashier_id, cashier_name, total, payment_method, payment_details, items, client_request_id, emit_nfce, customer_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            companyId,
            registerId,
            auth.userId,
            auth.fullName,
            parseFloat(String(total)),
            paymentMethod,
            JSON.stringify({ ...detailsObj, emitNfce, emitNfe, customerId }),
            JSON.stringify(items),
            clientReq,
            emitNfce,
            customerId,
          ],
        );
        newSale = rows[0] as Record<string, unknown>;
      } catch (errMid: unknown) {
        const msgMid = errMid instanceof Error ? errMid.message : String(errMid);
        if (/emit_nfce|customer_id/i.test(msgMid)) {
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
                JSON.stringify({ ...detailsObj, emitNfce, emitNfe, customerId }),
                JSON.stringify(items),
                clientReq,
              ],
            );
            newSale = rows[0] as Record<string, unknown>;
          } catch (err2: unknown) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            if (clientReq && /duplicate key|unique constraint|client_request_id/i.test(msg2)) {
              const { rows: existing } = await query(
                'SELECT * FROM sales WHERE company_id = $1 AND client_request_id = $2 LIMIT 1',
                [companyId, clientReq],
              );
              if (!existing[0]) return c.json({ error: 'Erro ao registrar venda: ' + msg2 }, 500);
              return mapSaleResponse(
                existing[0] as Record<string, unknown>,
                parseFloat(String(register.current_balance)) || 0,
                { idempotentReplay: true },
              );
            }
            return c.json({ error: 'Erro ao registrar venda: ' + msg2 }, 500);
          }
        } else if (clientReq && /duplicate key|unique constraint|client_request_id/i.test(msgMid)) {
          const { rows: existing } = await query(
            'SELECT * FROM sales WHERE company_id = $1 AND client_request_id = $2 LIMIT 1',
            [companyId, clientReq],
          );
          if (!existing[0]) return c.json({ error: 'Erro ao registrar venda: ' + msgMid }, 500);
          return mapSaleResponse(
            existing[0] as Record<string, unknown>,
            parseFloat(String(register.current_balance)) || 0,
            { idempotentReplay: true },
          );
        } else {
          return c.json({ error: 'Erro ao registrar venda: ' + msgMid }, 500);
        }
      }
    } else if (clientReq && /duplicate key|unique constraint|client_request_id/i.test(msg)) {
      const { rows: existing } = await query(
        'SELECT * FROM sales WHERE company_id = $1 AND client_request_id = $2 LIMIT 1',
        [companyId, clientReq],
      );
      if (!existing[0]) return c.json({ error: 'Erro ao registrar venda: ' + msg }, 500);
      return mapSaleResponse(
        existing[0] as Record<string, unknown>,
        parseFloat(String(register.current_balance)) || 0,
        { idempotentReplay: true },
      );
    } else {
      return c.json({ error: 'Erro ao registrar venda: ' + msg }, 500);
    }
  }

  const splitPayments = Array.isArray(detailsObj.payments)
    ? (detailsObj.payments as Array<{ method?: string; amount?: number }>)
    : null;

  let newBalance = parseFloat(String(register.current_balance));
  if (splitPayments && splitPayments.length > 0) {
    const drawerIn = splitPayments
      .filter((p) => p.method === 'money' || p.method === 'pix')
      .reduce((s, p) => s + (parseFloat(String(p.amount)) || 0), 0);
    if (drawerIn > 0) {
      newBalance += drawerIn;
      await query('UPDATE cash_registers SET current_balance = $1 WHERE id = $2', [
        newBalance,
        registerId,
      ]);
    }
  } else if (paymentMethod === 'money' || paymentMethod === 'pix') {
    newBalance += parseFloat(String(total));
    await query('UPDATE cash_registers SET current_balance = $1 WHERE id = $2', [
      newBalance,
      registerId,
    ]);
  }

  // Fiado / boleto → Contas a Receber (único ou parcelas do misto)
  const receivableParts =
    splitPayments && splitPayments.length > 0
      ? splitPayments.filter((p) => p.method === 'fiado' || p.method === 'boleto')
      : paymentMethod === 'fiado' || paymentMethod === 'boleto'
        ? [{ method: String(paymentMethod), amount: parseFloat(String(total)) }]
        : [];

  for (const part of receivableParts) {
    const amount = parseFloat(String(part.amount)) || 0;
    if (amount <= 0) continue;
    try {
      await createReceivableFromSale({
        companyId,
        saleId: String(newSale.id),
        amount,
        paymentMethod: String(part.method || 'fiado'),
        paymentDetails: {
          dueDate:
            typeof detailsObj.dueDate === 'string' ? detailsObj.dueDate : undefined,
          customerName:
            typeof detailsObj.customerName === 'string'
              ? detailsObj.customerName
              : undefined,
        },
        userId: auth.userId,
      });
    } catch (err) {
      console.error('[cashier/sale] accounts_receivable:', err);
    }
  }

  // Ledger financeiro
  try {
    const details =
      paymentDetails && typeof paymentDetails === 'object'
        ? (paymentDetails as { dueDate?: string; customerName?: string })
        : null;
    const saleDay = newSale.timestamp
      ? String(newSale.timestamp).split('T')[0]
      : undefined;
    await ledgerFromSale({
      companyId,
      saleId: String(newSale.id),
      total: parseFloat(String(total)),
      paymentMethod: String(paymentMethod || 'money'),
      paymentDetails: details,
      saleDateYmd: saleDay,
      userId: auth.userId,
    });
  } catch (err) {
    console.error('[cashier/sale] ledger:', err);
  }

  return mapSaleResponse(newSale, newBalance);
});

cashier.post('/withdrawal', async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const { registerId, amount, reason } = await c.req.json();
  const reasonText = String(reason || '').trim();
  const value = parseFloat(String(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return c.json({ error: 'Informe um valor válido para a sangria' }, 400);
  }
  if (reasonText.length < 3) {
    return c.json({ error: 'Informe o motivo da sangria (mín. 3 caracteres)' }, 400);
  }

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
    [companyId, registerId, value, reasonText, auth.userId, auth.fullName],
  );

  const newBalance = parseFloat(String(register.current_balance)) - value;
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

cashier.post('/deposit', async (c) => {
  const ctx = await withProfile(c);
  if ('error' in ctx) return ctx.error;
  const { auth, companyId } = ctx;
  const { registerId, amount, reason } = await c.req.json();
  const reasonText = String(reason || '').trim();
  const value = parseFloat(String(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return c.json({ error: 'Informe um valor válido para o suprimento' }, 400);
  }
  if (reasonText.length < 3) {
    return c.json({ error: 'Informe o motivo do suprimento (ex.: troco)' }, 400);
  }

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
    [companyId, registerId, value, reasonText, auth.userId, auth.fullName],
  );

  const newBalance = parseFloat(String(register.current_balance)) + value;
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

cashier.post('/close', async (c) => {
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
  // Gaveta: dinheiro + pix (inclui fatias de pagamento misto) — espelha POST /sale
  const cashSales = sales.reduce(
    (s, r) => s + drawerInFromSale(r as Record<string, unknown>),
    0,
  );
  const totalWithdrawals = movements
    .filter((m) => m.type === 'withdrawal')
    .reduce((s, m) => s + (parseFloat(String(m.amount)) || 0), 0);
  const totalDeposits = movements
    .filter((m) => m.type === 'deposit')
    .reduce((s, m) => s + (parseFloat(String(m.amount)) || 0), 0);
  const expectedBalance =
    parseFloat(String(register.initial_balance)) + cashSales + totalDeposits - totalWithdrawals;
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

cashier.get('/history', async (c) => {
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
