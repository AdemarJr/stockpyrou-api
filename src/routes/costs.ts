import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';

const costs = new Hono<{ Variables: AppVariables }>();

costs.use('*', requireAuth, requireCompany);

function todayYmdLocal(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function paidAmountFromRow(row: Record<string, unknown>): number {
  const raw = row.paid_amount;
  if (raw != null && raw !== '') {
    const n = parseFloat(String(raw));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function fetchExpenseWithJoins(id: string, companyId: string) {
  const { rows } = await query(
    `SELECT e.*,
      json_build_object('name', et.name, 'category', et.category) AS expense_types,
      json_build_object('name', cc.name, 'code', cc.code) AS cost_centers,
      CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('name', s.name) END AS suppliers
     FROM operational_expenses e
     LEFT JOIN expense_types et ON et.id = e.expense_type_id
     LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
     WHERE e.id = $1 AND e.company_id = $2
     LIMIT 1`,
    [id, companyId],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

function buildExpenseInsert(body: Record<string, unknown>, companyId: string) {
  const paymentTermsType = String(body.paymentTermsType ?? body.payment_terms_type ?? 'avista');
  const row: Record<string, unknown> = {
    company_id: companyId,
    expense_type_id: body.expenseTypeId ?? body.expense_type_id,
    cost_center_id: body.costCenterId ?? body.cost_center_id,
    amount: body.amount,
    description: body.description ?? null,
    reference_number: body.referenceNumber ?? body.reference_number ?? null,
    due_date: body.dueDate ?? body.due_date,
    payment_date: body.paymentDate ?? body.payment_date ?? null,
    payment_status: body.paymentStatus ?? body.payment_status ?? 'pending',
    payment_method: body.paymentMethod ?? body.payment_method ?? null,
    payment_terms_type: paymentTermsType,
    invoice_days:
      paymentTermsType === 'faturado'
        ? body.invoiceDays ?? body.invoice_days ?? null
        : null,
    installment_count:
      paymentTermsType === 'parcelado'
        ? body.installmentCount ?? body.installment_count ?? null
        : null,
    supplier_id: body.supplierId ?? body.supplier_id ?? null,
    stock_entry_id: body.stockEntryId ?? body.stock_entry_id ?? null,
    user_id: body.userId ?? body.user_id,
    attachments: body.attachments ?? null,
    tags: body.tags ?? null,
    notes: body.notes ?? null,
    paid_amount: body.paidAmount ?? body.paid_amount ?? 0,
  };

  const groupId = body.expenseGroupId ?? body.expense_group_id;
  const instIdx = body.installmentIndex ?? body.installment_index;
  const instOf = body.installmentOf ?? body.installment_of;
  if (groupId != null || instIdx != null || instOf != null) {
    row.expense_group_id = groupId ?? null;
    row.installment_index = instIdx ?? null;
    row.installment_of = instOf ?? null;
  }

  return row;
}

// ---------- Cost centers ----------
costs.get('/centers', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT * FROM cost_centers
     WHERE company_id = $1 AND is_active = true
     ORDER BY code ASC`,
    [companyId],
  );
  return c.json({ costCenters: rows });
});

costs.post('/centers', async (c) => {
  const companyId = c.get('companyId');
  const body = (await c.req.json()) as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const code = String(body.code ?? '').trim();
  if (!name || !code) return c.json({ error: 'name and code are required' }, 400);

  const { rows } = await query(
    `INSERT INTO cost_centers (company_id, name, code, description, parent_id, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [
      companyId,
      name,
      code,
      body.description ?? null,
      body.parentId ?? body.parent_id ?? null,
    ],
  );
  return c.json({ costCenter: rows[0] }, 201);
});

costs.get('/centers/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rows } = await query(
    `SELECT * FROM cost_centers WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!rows[0]) return c.json({ error: 'Cost center not found' }, 404);
  return c.json({ costCenter: rows[0] });
});

costs.put('/centers/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as Record<string, unknown>;

  const { rows } = await query(
    `UPDATE cost_centers SET
       name = COALESCE($1, name),
       code = COALESCE($2, code),
       description = $3,
       parent_id = $4,
       is_active = COALESCE($5, is_active),
       updated_at = now()
     WHERE id = $6 AND company_id = $7
     RETURNING *`,
    [
      body.name ?? null,
      body.code ?? null,
      body.description ?? null,
      body.parentId ?? body.parent_id ?? null,
      body.isActive ?? body.is_active ?? null,
      id,
      companyId,
    ],
  );
  if (!rows[0]) return c.json({ error: 'Cost center not found' }, 404);
  return c.json({ costCenter: rows[0] });
});

costs.delete('/centers/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rowCount } = await query(
    `UPDATE cost_centers SET is_active = false, updated_at = now() WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rowCount) return c.json({ error: 'Cost center not found' }, 404);
  return c.json({ ok: true });
});

// ---------- Expense types ----------
costs.get('/types', async (c) => {
  const companyId = c.get('companyId');
  const { rows } = await query(
    `SELECT * FROM expense_types
     WHERE company_id = $1 AND is_active = true
     ORDER BY name ASC`,
    [companyId],
  );
  return c.json({ expenseTypes: rows });
});

costs.post('/types', async (c) => {
  const companyId = c.get('companyId');
  const body = (await c.req.json()) as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  const costCenterId = body.costCenterId ?? body.cost_center_id;
  if (!name || !category || !costCenterId) {
    return c.json({ error: 'name, category and costCenterId are required' }, 400);
  }

  const { rows } = await query(
    `INSERT INTO expense_types
       (company_id, name, category, cost_center_id, is_recurring, recurrence_day, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [
      companyId,
      name,
      category,
      costCenterId,
      Boolean(body.isRecurring ?? body.is_recurring ?? false),
      body.recurrenceDay ?? body.recurrence_day ?? null,
    ],
  );
  return c.json({ expenseType: rows[0] }, 201);
});

costs.put('/types/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as Record<string, unknown>;

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.category !== undefined) patch.category = body.category;
  const costCenterId = body.costCenterId ?? body.cost_center_id;
  if (costCenterId !== undefined) patch.cost_center_id = costCenterId;
  const isRecurring = body.isRecurring ?? body.is_recurring;
  if (isRecurring !== undefined) {
    patch.is_recurring = Boolean(isRecurring);
    patch.recurrence_day = isRecurring
      ? body.recurrenceDay ?? body.recurrence_day ?? null
      : null;
  } else if (body.recurrenceDay !== undefined || body.recurrence_day !== undefined) {
    patch.recurrence_day = body.recurrenceDay ?? body.recurrence_day;
  }
  const isActive = body.isActive ?? body.is_active;
  if (isActive !== undefined) patch.is_active = Boolean(isActive);

  const keys = Object.keys(patch);
  const setClause = keys.length
    ? `${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now()`
    : 'updated_at = now()';
  const values = [...Object.values(patch), id, companyId];
  const { rows } = await query(
    `UPDATE expense_types SET ${setClause}
     WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}
     RETURNING *`,
    values,
  );
  if (!rows[0]) return c.json({ error: 'Expense type not found' }, 404);
  return c.json({ expenseType: rows[0] });
});

costs.delete('/types/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rowCount } = await query(
    `UPDATE expense_types SET is_active = false, updated_at = now() WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rowCount) return c.json({ error: 'Expense type not found' }, 404);
  return c.json({ ok: true });
});

// ---------- Expenses ----------
costs.get('/expenses', async (c) => {
  const companyId = c.get('companyId');
  const dueFrom = c.req.query('dueDateFrom') || c.req.query('from');
  const dueTo = c.req.query('dueDateTo') || c.req.query('to');
  const costCenterId = c.req.query('costCenterId');
  const expenseTypeId = c.req.query('expenseTypeId');
  const supplierId = c.req.query('supplierId');
  const paymentStatus = c.req.query('paymentStatus');

  const params: unknown[] = [companyId];
  const where: string[] = ['e.company_id = $1'];

  if (dueFrom) {
    params.push(dueFrom);
    where.push(`e.due_date >= $${params.length}`);
  }
  if (dueTo) {
    params.push(dueTo);
    where.push(`e.due_date <= $${params.length}`);
  }
  if (costCenterId) {
    params.push(costCenterId);
    where.push(`e.cost_center_id = $${params.length}`);
  }
  if (expenseTypeId) {
    params.push(expenseTypeId);
    where.push(`e.expense_type_id = $${params.length}`);
  }
  if (supplierId) {
    params.push(supplierId);
    where.push(`e.supplier_id = $${params.length}`);
  }
  if (paymentStatus) {
    params.push(paymentStatus);
    where.push(`e.payment_status = $${params.length}`);
  }

  const { rows } = await query(
    `SELECT e.*,
      json_build_object('name', et.name, 'category', et.category) AS expense_types,
      json_build_object('name', cc.name, 'code', cc.code) AS cost_centers,
      CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('name', s.name) END AS suppliers
     FROM operational_expenses e
     LEFT JOIN expense_types et ON et.id = e.expense_type_id
     LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id
     LEFT JOIN suppliers s ON s.id = e.supplier_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.due_date DESC`,
    params,
  );

  return c.json({ expenses: rows });
});

costs.post('/expenses', async (c) => {
  const companyId = c.get('companyId');
  const body = (await c.req.json()) as Record<string, unknown>;

  // Batch: { expenses: [...] }
  if (Array.isArray(body.expenses)) {
    const inserted: Record<string, unknown>[] = [];
    for (const item of body.expenses as Record<string, unknown>[]) {
      const row = buildExpenseInsert(item, companyId);
      if (!row.expense_type_id || !row.cost_center_id || row.amount == null || !row.due_date || !row.user_id) {
        return c.json({ error: 'expenseTypeId, costCenterId, amount, dueDate and userId are required' }, 400);
      }
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await query(
        `INSERT INTO operational_expenses (${columns.join(', ')})
         VALUES (${placeholders})
         RETURNING *`,
        values,
      );
      inserted.push(rows[0] as Record<string, unknown>);
    }
    return c.json({ expenses: inserted }, 201);
  }

  const row = buildExpenseInsert(body, companyId);
  if (!row.expense_type_id || !row.cost_center_id || row.amount == null || !row.due_date || !row.user_id) {
    return c.json({ error: 'expenseTypeId, costCenterId, amount, dueDate and userId are required' }, 400);
  }

  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await query(
    `INSERT INTO operational_expenses (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING *`,
    values,
  );

  const full = await fetchExpenseWithJoins(String((rows[0] as { id: string }).id), companyId);
  return c.json({ expense: full ?? rows[0] }, 201);
});

costs.put('/expenses/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as Record<string, unknown>;

  const existing = await query(
    `SELECT * FROM operational_expenses WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!existing.rows[0]) return c.json({ error: 'Expense not found' }, 404);

  const patch: Record<string, unknown> = {};
  const map: Array<[string, string]> = [
    ['expenseTypeId', 'expense_type_id'],
    ['expense_type_id', 'expense_type_id'],
    ['costCenterId', 'cost_center_id'],
    ['cost_center_id', 'cost_center_id'],
    ['amount', 'amount'],
    ['paidAmount', 'paid_amount'],
    ['paid_amount', 'paid_amount'],
    ['description', 'description'],
    ['referenceNumber', 'reference_number'],
    ['reference_number', 'reference_number'],
    ['dueDate', 'due_date'],
    ['due_date', 'due_date'],
    ['notes', 'notes'],
    ['tags', 'tags'],
    ['attachments', 'attachments'],
    ['supplierId', 'supplier_id'],
    ['supplier_id', 'supplier_id'],
    ['stockEntryId', 'stock_entry_id'],
    ['stock_entry_id', 'stock_entry_id'],
  ];

  for (const [from, to] of map) {
    if (body[from] !== undefined) patch[to] = body[from];
  }

  if (body.paymentStatus !== undefined || body.payment_status !== undefined) {
    const status = String(body.paymentStatus ?? body.payment_status);
    patch.payment_status = status;
    patch.payment_date =
      status === 'paid' ? body.paymentDate ?? body.payment_date ?? null : null;
    if (body.paymentMethod !== undefined || body.payment_method !== undefined) {
      patch.payment_method =
        status === 'paid' ? body.paymentMethod ?? body.payment_method ?? null : null;
    } else if (status !== 'paid') {
      patch.payment_method = null;
    }
  } else {
    if (body.paymentDate !== undefined || body.payment_date !== undefined) {
      patch.payment_date = body.paymentDate ?? body.payment_date;
    }
    if (body.paymentMethod !== undefined || body.payment_method !== undefined) {
      patch.payment_method = body.paymentMethod ?? body.payment_method;
    }
  }

  if (body.paymentTermsType !== undefined || body.payment_terms_type !== undefined) {
    const t = String(body.paymentTermsType ?? body.payment_terms_type);
    patch.payment_terms_type = t;
    patch.invoice_days = t === 'faturado' ? body.invoiceDays ?? body.invoice_days ?? null : null;
    patch.installment_count =
      t === 'parcelado' ? body.installmentCount ?? body.installment_count ?? null : null;
  }

  if (body.expenseGroupId !== undefined || body.expense_group_id !== undefined) {
    patch.expense_group_id = body.expenseGroupId ?? body.expense_group_id;
  }
  if (body.installmentIndex !== undefined || body.installment_index !== undefined) {
    patch.installment_index = body.installmentIndex ?? body.installment_index;
  }
  if (body.installmentOf !== undefined || body.installment_of !== undefined) {
    patch.installment_of = body.installmentOf ?? body.installment_of;
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    const full = await fetchExpenseWithJoins(id, companyId);
    return c.json({ expense: full ?? existing.rows[0] });
  }

  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = [...Object.values(patch), id, companyId];
  await query(
    `UPDATE operational_expenses SET ${setClause}, updated_at = now()
     WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}`,
    values,
  );

  const full = await fetchExpenseWithJoins(id, companyId);
  return c.json({ expense: full });
});

costs.delete('/expenses/group/:groupId', async (c) => {
  const companyId = c.get('companyId');
  const groupId = c.req.param('groupId');
  await query(
    `DELETE FROM operational_expenses WHERE company_id = $1 AND expense_group_id = $2`,
    [companyId, groupId],
  );
  return c.json({ ok: true });
});

costs.delete('/expenses/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rowCount } = await query(
    `DELETE FROM operational_expenses WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rowCount) return c.json({ error: 'Expense not found' }, 404);
  return c.json({ ok: true });
});

// ---------- Payments ----------
costs.get('/expenses/:id/payments', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rows } = await query(
    `SELECT id, amount, payment_date, payment_method, notes, created_at
     FROM operational_expense_payments
     WHERE company_id = $1 AND expense_id = $2
     ORDER BY payment_date DESC, created_at DESC`,
    [companyId, id],
  );
  return c.json({ payments: rows });
});

costs.post('/expenses/:id/payments', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as { amount?: number; paymentMethod?: string };
  const payNow = Number(body.amount);
  if (!Number.isFinite(payNow) || payNow <= 0) {
    return c.json({ error: 'Informe um valor maior que zero' }, 400);
  }

  const { rows } = await query(
    `SELECT * FROM operational_expenses WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return c.json({ error: 'Despesa não encontrada' }, 404);

  const total = parseFloat(String(row.amount)) || 0;
  const prevPaid = paidAmountFromRow(row);
  const remaining = Math.max(0, Math.round((total - prevPaid) * 100) / 100);
  if (remaining <= 0) return c.json({ error: 'Esta despesa já está quitada' }, 400);

  const applied = Math.min(Math.round(payNow * 100) / 100, remaining);
  const newPaid = Math.round((prevPaid + applied) * 100) / 100;
  const today = todayYmdLocal();
  const dueRaw = row.due_date ? String(row.due_date).split('T')[0] : '';
  const st = String(row.payment_status || '');
  const isFullyPaid = newPaid >= total - 0.005;
  let nextStatus = 'pending';
  if (isFullyPaid) nextStatus = 'paid';
  else if (dueRaw && dueRaw < today && (st === 'overdue' || st === 'pending')) nextStatus = 'overdue';

  const paymentMethod = body.paymentMethod ?? null;

  await query(
    `UPDATE operational_expenses SET
       paid_amount = $1,
       payment_date = $2,
       payment_method = $3,
       payment_status = $4,
       updated_at = now()
     WHERE id = $5 AND company_id = $6`,
    [isFullyPaid ? total : newPaid, today, paymentMethod, nextStatus, id, companyId],
  );

  await query(
    `INSERT INTO operational_expense_payments
       (company_id, expense_id, amount, payment_date, payment_method)
     VALUES ($1, $2, $3, $4, $5)`,
    [companyId, id, applied, today, paymentMethod],
  );

  const full = await fetchExpenseWithJoins(id, companyId);
  return c.json({ expense: full });
});

// ---------- Analytics ----------

/** Total de compras (stock_entries.total_cost) desde o início do mês de referência. */
costs.get('/metrics/stock', async (c) => {
  const companyId = c.get('companyId');
  const month = (c.req.query('month') || '').trim();
  const startIso = (() => {
    if (/^\d{4}-\d{2}$/.test(month)) {
      return new Date(`${month}-01T00:00:00.000Z`).toISOString();
    }
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  })();

  const { rows } = await query(
    `SELECT COALESCE(SUM(total_cost), 0) AS total
     FROM stock_entries
     WHERE company_id = $1 AND entry_date >= $2`,
    [companyId, startIso],
  );
  const purchasesMonthTotal = Number((rows[0] as { total?: string })?.total) || 0;
  return c.json({ purchasesMonthTotal });
});

/** Receita, COGS e recebíveis fiado para um mês (YYYY-MM). */
costs.get('/metrics/financial-snapshot', async (c) => {
  const companyId = c.get('companyId');
  const month = (c.req.query('month') || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: 'Mês inválido. Use o formato YYYY-MM.' }, 400);
  }

  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const { rows: salesRows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_method <> 'fiado' THEN total ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN payment_method = 'fiado' THEN total ELSE 0 END), 0) AS fiado_receivable
     FROM sales
     WHERE company_id = $1 AND "timestamp" >= $2 AND "timestamp" < $3`,
    [companyId, startIso, endIso],
  );

  let cogs = 0;
  try {
    const { rows: movRows } = await query(
      `SELECT COALESCE(SUM(
         COALESCE(total_value, quantity * unit_cost)
       ), 0) AS cogs
       FROM stock_movements
       WHERE company_id = $1 AND type = 'venda' AND movement_date >= $2 AND movement_date < $3`,
      [companyId, startIso, endIso],
    );
    cogs = Number((movRows[0] as { cogs?: string })?.cogs) || 0;
  } catch (e) {
    console.warn('[costs] financial-snapshot cogs query failed:', e);
  }

  const revenue = Number((salesRows[0] as { revenue?: string })?.revenue) || 0;
  const fiadoReceivable = Number((salesRows[0] as { fiado_receivable?: string })?.fiado_receivable) || 0;

  return c.json({ month, revenue, cogs, fiadoReceivable });
});

async function realizedBalanceUntil(companyId: string, ymd: string): Promise<number> {
  try {
    const { rows } = await query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS balance
       FROM financial_movements
       WHERE company_id = $1 AND status = 'realizado' AND cash_date <= $2`,
      [companyId, ymd],
    );
    return Number((rows[0] as { balance?: string })?.balance) || 0;
  } catch (e) {
    console.warn('[costs] realizedBalanceUntil ledger unavailable, falling back:', e);
  }

  const endIso = new Date(`${ymd}T23:59:59.999Z`).toISOString();
  const [{ rows: salesRows }, { rows: expRows }] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(total), 0) AS total
       FROM sales
       WHERE company_id = $1 AND payment_method <> 'fiado' AND "timestamp" <= $2`,
      [companyId, endIso],
    ),
    query(
      `SELECT COALESCE(SUM(COALESCE(NULLIF(paid_amount, 0), amount)), 0) AS total
       FROM operational_expenses
       WHERE company_id = $1 AND payment_status = 'paid' AND payment_date <= $2`,
      [companyId, ymd],
    ),
  ]);
  const totalIn = Number((salesRows[0] as { total?: string })?.total) || 0;
  const totalOut = Number((expRows[0] as { total?: string })?.total) || 0;
  return totalIn - totalOut;
}

/** Projeção de fluxo de caixa por dia (start..end, YYYY-MM-DD). */
costs.get('/analytics/cash-flow', async (c) => {
  const companyId = c.get('companyId');
  const start = (c.req.query('start') || '').trim();
  const end = (c.req.query('end') || '').trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start > end
  ) {
    return c.json({ error: 'Intervalo inválido. Use YYYY-MM-DD (início <= fim).' }, 400);
  }

  const prevDay = (ymd: string) => {
    const d = new Date(`${ymd}T00:00:00.000Z`);
    return new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  };

  const openingBalance = await realizedBalanceUntil(companyId, prevDay(start));

  type Row = { date: string; inRealized: number; inExpected: number; outRealized: number; outExpected: number; net: number; projectedBalance: number };
  const days: string[] = [];
  {
    const s = new Date(`${start}T00:00:00.000Z`);
    const e = new Date(`${end}T00:00:00.000Z`);
    for (let d = new Date(s); d <= e; d = new Date(d.getTime() + 86400000)) {
      days.push(d.toISOString().slice(0, 10));
    }
  }
  const byDay = new Map<string, Row>(
    days.map((d) => [d, { date: d, inRealized: 0, inExpected: 0, outRealized: 0, outExpected: 0, net: 0, projectedBalance: 0 }]),
  );

  let usedLedger = false;
  try {
    const [{ rows: realized }, { rows: expectedOut }] = await Promise.all([
      query(
        `SELECT direction, amount, cash_date FROM financial_movements
         WHERE company_id = $1 AND status = 'realizado' AND cash_date >= $2 AND cash_date <= $3`,
        [companyId, start, end],
      ),
      query(
        `SELECT amount, due_date FROM financial_movements
         WHERE company_id = $1 AND status = 'previsto' AND direction = 'out' AND due_date >= $2 AND due_date <= $3`,
        [companyId, start, end],
      ),
    ]);
    usedLedger = true;
    for (const r of realized as Array<{ direction: string; amount: string; cash_date: string }>) {
      const day = String(r.cash_date).split('T')[0];
      const row = byDay.get(day);
      if (!row) continue;
      const amt = Number(r.amount) || 0;
      if (r.direction === 'in') row.inRealized += amt;
      if (r.direction === 'out') row.outRealized += amt;
    }
    for (const r of expectedOut as Array<{ amount: string; due_date: string }>) {
      const day = String(r.due_date).split('T')[0];
      const row = byDay.get(day);
      if (!row) continue;
      row.outExpected += Number(r.amount) || 0;
    }
  } catch (e) {
    console.warn('[costs] cash-flow ledger unavailable, falling back:', e);
  }

  if (!usedLedger) {
    const startIso = new Date(`${start}T00:00:00.000Z`).toISOString();
    const endIso = new Date(`${end}T23:59:59.999Z`).toISOString();

    const [{ rows: sales }, { rows: paidExp }, { rows: openExp }] = await Promise.all([
      query(
        `SELECT total, payment_method, "timestamp", payment_details
         FROM sales WHERE company_id = $1 AND "timestamp" >= $2 AND "timestamp" <= $3`,
        [companyId, startIso, endIso],
      ),
      query(
        `SELECT amount, paid_amount, payment_date FROM operational_expenses
         WHERE company_id = $1 AND payment_date >= $2 AND payment_date <= $3 AND payment_status <> 'cancelled'`,
        [companyId, start, end],
      ),
      query(
        `SELECT amount, paid_amount, due_date FROM operational_expenses
         WHERE company_id = $1 AND due_date >= $2 AND due_date <= $3 AND payment_status IN ('pending', 'overdue')`,
        [companyId, start, end],
      ),
    ]);

    for (const s of sales as Array<{ total: string; payment_method: string; timestamp: string; payment_details: unknown }>) {
      const method = String(s.payment_method || '');
      const day = String(s.timestamp).split('T')[0];
      if (method === 'fiado') {
        const details = s.payment_details as { dueDate?: string } | null;
        const due = details?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(details.dueDate)
          ? details.dueDate
          : (() => {
              const d = new Date(`${day}T00:00:00.000Z`);
              d.setUTCDate(d.getUTCDate() + 30);
              return d.toISOString().slice(0, 10);
            })();
        const row = byDay.get(due);
        if (row) row.inExpected += Number(s.total) || 0;
        continue;
      }
      const row = byDay.get(day);
      if (row) row.inRealized += Number(s.total) || 0;
    }

    for (const e of paidExp as Array<{ amount: string; paid_amount: string; payment_date: string }>) {
      const day = String(e.payment_date).split('T')[0];
      const row = byDay.get(day);
      if (!row) continue;
      const paid = Number(e.paid_amount);
      const amt = Number(e.amount);
      row.outRealized += Number.isFinite(paid) && paid > 0 ? paid : Number.isFinite(amt) ? amt : 0;
    }

    for (const e of openExp as Array<{ amount: string; paid_amount: string; due_date: string }>) {
      const day = String(e.due_date).split('T')[0];
      const row = byDay.get(day);
      if (!row) continue;
      const amt = Number(e.amount) || 0;
      const paid = Number(e.paid_amount) || 0;
      row.outExpected += Math.max(0, Math.round((amt - paid) * 100) / 100);
    }
  }

  let running = openingBalance;
  for (const d of days) {
    const row = byDay.get(d)!;
    row.net = row.inRealized + row.inExpected - row.outRealized - row.outExpected;
    running += row.net;
    row.projectedBalance = running;
  }

  return c.json({ days: days.map((d) => byDay.get(d)!) });
});

/** DRE simplificado por mês (receita, COGS, despesas, lucro bruto e líquido). */
costs.get('/analytics/dre', async (c) => {
  const companyId = c.get('companyId');
  const sm = (c.req.query('startMonth') || '').trim();
  const em = (c.req.query('endMonth') || '').trim();
  if (!/^\d{4}-\d{2}$/.test(sm) || !/^\d{4}-\d{2}$/.test(em) || sm > em) {
    return c.json({ error: 'Intervalo inválido. Use YYYY-MM (início <= fim).' }, 400);
  }

  const fromYmd = `${sm}-01`;
  const endStart = new Date(`${em}-01T00:00:00.000Z`);
  const toYmd = new Date(Date.UTC(endStart.getUTCFullYear(), endStart.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);

  let dreRows: Array<{ month: string; revenue: string; cogs: string; gross_profit: string }> = [];
  try {
    const { rows } = await query(
      `SELECT month, revenue, cogs, gross_profit FROM v_gross_profit_month
       WHERE company_id = $1 AND month >= $2 AND month <= $3
       ORDER BY month ASC`,
      [companyId, sm, em],
    );
    dreRows = rows as typeof dreRows;
  } catch (e) {
    console.warn('[costs] dre v_gross_profit_month unavailable:', e);
  }

  const expensesByMonth = new Map<string, number>();
  let gotFromLedger = false;
  try {
    const { rows } = await query(
      `SELECT competency_date, amount FROM financial_movements
       WHERE company_id = $1 AND direction = 'out' AND status = 'realizado'
         AND competency_date >= $2 AND competency_date < $3`,
      [companyId, fromYmd, toYmd],
    );
    gotFromLedger = true;
    for (const r of rows as Array<{ competency_date: string; amount: string }>) {
      const m = String(r.competency_date).slice(0, 7);
      expensesByMonth.set(m, (expensesByMonth.get(m) ?? 0) + (Number(r.amount) || 0));
    }
  } catch (e) {
    console.warn('[costs] dre expenses ledger unavailable, falling back:', e);
  }

  if (!gotFromLedger) {
    const { rows } = await query(
      `SELECT payment_date, amount, paid_amount FROM operational_expenses
       WHERE company_id = $1 AND payment_status = 'paid'
         AND payment_date >= $2 AND payment_date < $3`,
      [companyId, fromYmd, toYmd],
    );
    for (const r of rows as Array<{ payment_date: string; amount: string; paid_amount: string }>) {
      const m = String(r.payment_date).slice(0, 7);
      const paid = Number(r.paid_amount);
      const amt = Number(r.amount);
      const use = Number.isFinite(paid) && paid > 0 ? paid : Number.isFinite(amt) ? amt : 0;
      expensesByMonth.set(m, (expensesByMonth.get(m) ?? 0) + use);
    }
  }

  const base = dreRows.map((r) => {
    const month = String(r.month);
    const revenue = Number(r.revenue) || 0;
    const cogs = Number(r.cogs) || 0;
    const grossProfit = Number(r.gross_profit) || revenue - cogs;
    const expenses = expensesByMonth.get(month) ?? 0;
    return { month, revenue, cogs, expenses, grossProfit, net: grossProfit - expenses };
  });

  const months: string[] = [];
  {
    const s = new Date(`${sm}-01T00:00:00.000Z`);
    const e = new Date(`${em}-01T00:00:00.000Z`);
    for (let d = new Date(s); d <= e; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
  }

  const map = new Map(base.map((r) => [r.month, r]));
  const dre = months.map((m) => {
    const r = map.get(m);
    if (r) return r;
    const expenses = expensesByMonth.get(m) ?? 0;
    return { month: m, revenue: 0, cogs: 0, expenses, grossProfit: 0, net: -expenses };
  });

  return c.json({ dre });
});

costs.get('/analytics/cost-centers-summary', async (c) => {
  const companyId = c.get('companyId');
  try {
    const { rows } = await query(
      `SELECT * FROM v_cost_center_summary WHERE company_id = $1`,
      [companyId],
    );
    return c.json({ summary: rows });
  } catch (e) {
    console.warn('[costs] cost-centers-summary unavailable:', e);
    return c.json({ summary: [] });
  }
});

costs.get('/analytics/product-costs', async (c) => {
  const companyId = c.get('companyId');
  try {
    const { rows } = await query(
      `SELECT * FROM v_product_cost_analysis WHERE company_id = $1`,
      [companyId],
    );
    return c.json({ products: rows });
  } catch (e) {
    console.warn('[costs] product-costs unavailable:', e);
    return c.json({ products: [] });
  }
});

costs.get('/analytics/waste', async (c) => {
  const companyId = c.get('companyId');
  try {
    const { rows } = await query(
      `SELECT * FROM v_waste_analysis WHERE company_id = $1`,
      [companyId],
    );
    return c.json({ waste: rows });
  } catch (e) {
    console.warn('[costs] waste analysis unavailable:', e);
    return c.json({ waste: [] });
  }
});

export default costs;
