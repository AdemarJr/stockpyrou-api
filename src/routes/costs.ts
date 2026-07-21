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

export default costs;
