import { Hono } from 'hono';
import { query } from '../db/pool.js';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';
import {
  adjustOpenCashRegister,
  ledgerReceivablePayment,
  upsertLedgerMovement,
  todayYmdLocal as ledgerTodayYmd,
} from '../services/ledger.js';

const receivables = new Hono<{ Variables: AppVariables }>();

receivables.use('*', requireAuth, requireCompany);

function todayYmdLocal(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

function receivedFromRow(row: Record<string, unknown>): number {
  const raw = row.received_amount;
  if (raw != null && raw !== '') {
    const n = parseFloat(String(raw));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function mapReceivable(row: Record<string, unknown>) {
  const amount = parseFloat(String(row.amount)) || 0;
  const received = receivedFromRow(row);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    saleId: row.sale_id != null ? String(row.sale_id) : null,
    amount,
    receivedAmount: received,
    remainingAmount: Math.max(0, Math.round((amount - received) * 100) / 100),
    customerName: row.customer_name != null ? String(row.customer_name) : null,
    description: row.description != null ? String(row.description) : null,
    referenceNumber: row.reference_number != null ? String(row.reference_number) : null,
    notes: row.notes != null ? String(row.notes) : null,
    dueDate: row.due_date ? String(row.due_date).split('T')[0] : null,
    receivedDate: row.received_date ? String(row.received_date).split('T')[0] : null,
    paymentStatus: String(row.payment_status || 'pending'),
    paymentMethod: row.payment_method != null ? String(row.payment_method) : null,
    source: String(row.source || 'manual'),
    receivableGroupId: row.receivable_group_id != null ? String(row.receivable_group_id) : null,
    installmentIndex: row.installment_index != null ? Number(row.installment_index) : null,
    installmentOf: row.installment_of != null ? Number(row.installment_of) : null,
    userId: row.user_id != null ? String(row.user_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Cria título a partir de venda fiado/boleto (idempotente por sale_id). */
export async function createReceivableFromSale(params: {
  companyId: string;
  saleId: string;
  amount: number;
  paymentMethod: string;
  paymentDetails?: { dueDate?: string; customerName?: string } | null;
  userId?: string;
}): Promise<Record<string, unknown> | null> {
  const method = String(params.paymentMethod || '');
  if (method !== 'fiado' && method !== 'boleto') return null;

  const { rows: existing } = await query(
    `SELECT * FROM accounts_receivable WHERE sale_id = $1 LIMIT 1`,
    [params.saleId],
  );
  if (existing[0]) return existing[0] as Record<string, unknown>;

  const details = params.paymentDetails ?? {};
  let dueDate =
    details.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(details.dueDate) ? details.dueDate : null;
  if (!dueDate) {
    const parts = todayYmdLocal().split('-').map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2] + 30);
    const pad = (n: number) => String(n).padStart(2, '0');
    dueDate = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  const customerName = details.customerName?.trim() || null;
  const source = method === 'boleto' ? 'sale_boleto' : 'sale_fiado';
  const description = `Venda PDV #${String(params.saleId).slice(0, 8)}`;

  const { rows } = await query(
    `INSERT INTO accounts_receivable (
       company_id, sale_id, amount, received_amount, customer_name, description,
       due_date, payment_status, source, user_id
     ) VALUES ($1,$2,$3,0,$4,$5,$6,'pending',$7,$8)
     RETURNING *`,
    [
      params.companyId,
      params.saleId,
      params.amount,
      customerName,
      description,
      dueDate,
      source,
      params.userId ?? null,
    ],
  );
  return (rows[0] as Record<string, unknown>) ?? null;
}

receivables.get('/', async (c) => {
  const companyId = c.get('companyId');
  const status = c.req.query('paymentStatus');
  const dueFrom = c.req.query('dueDateFrom');
  const dueTo = c.req.query('dueDateTo');
  const q = (c.req.query('q') || '').trim();

  const params: unknown[] = [companyId];
  let where = 'WHERE company_id = $1';

  if (status && status !== 'all') {
    params.push(status);
    where += ` AND payment_status = $${params.length}`;
  }
  if (dueFrom) {
    params.push(dueFrom);
    where += ` AND due_date >= $${params.length}`;
  }
  if (dueTo) {
    params.push(dueTo);
    where += ` AND due_date <= $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (
      COALESCE(customer_name,'') ILIKE $${params.length}
      OR COALESCE(description,'') ILIKE $${params.length}
      OR COALESCE(reference_number,'') ILIKE $${params.length}
    )`;
  }

  const { rows } = await query(
    `SELECT * FROM accounts_receivable ${where} ORDER BY due_date ASC, created_at DESC`,
    params,
  );

  const today = todayYmdLocal();
  const mapped = rows.map((r) => {
    const row = r as Record<string, unknown>;
    const m = mapReceivable(row);
    // Expor overdue visual se pending e vencido
    if (m.paymentStatus === 'pending' && m.dueDate && m.dueDate < today) {
      m.paymentStatus = 'overdue';
    }
    return m;
  });

  return c.json({ receivables: mapped });
});

receivables.get('/summary', async (c) => {
  const companyId = c.get('companyId');
  const today = todayYmdLocal();
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_status IN ('pending','overdue') THEN amount - received_amount ELSE 0 END), 0) AS open_total,
       COALESCE(SUM(CASE WHEN payment_status IN ('pending','overdue') AND due_date < $2 THEN amount - received_amount ELSE 0 END), 0) AS overdue_total,
       COALESCE(SUM(CASE WHEN payment_status IN ('pending','overdue') AND due_date >= $2 AND due_date <= ($2::date + 7) THEN amount - received_amount ELSE 0 END), 0) AS next7_total
     FROM accounts_receivable
     WHERE company_id = $1 AND payment_status <> 'cancelled'`,
    [companyId, today],
  );
  const r = rows[0] as Record<string, unknown>;
  return c.json({
    openTotal: Number(r?.open_total) || 0,
    overdueTotal: Number(r?.overdue_total) || 0,
    next7Total: Number(r?.next7_total) || 0,
  });
});

receivables.post('/', async (c) => {
  const companyId = c.get('companyId');
  const auth = c.get('auth');
  const body = (await c.req.json()) as {
    amount?: number;
    dueDate?: string;
    customerName?: string;
    description?: string;
    referenceNumber?: string;
    notes?: string;
    installmentCount?: number;
  };

  const amount = Number(body.amount);
  const dueDate = String(body.dueDate || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: 'Informe um valor válido' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return c.json({ error: 'Informe a data de vencimento' }, 400);
  }

  const installmentCount = Math.max(1, Math.min(36, Number(body.installmentCount) || 1));
  const customerName = body.customerName?.trim() || null;
  const description = body.description?.trim() || 'Lançamento manual';
  const referenceNumber = body.referenceNumber?.trim() || null;
  const notes = body.notes?.trim() || null;

  if (installmentCount === 1) {
    const { rows } = await query(
      `INSERT INTO accounts_receivable (
         company_id, amount, customer_name, description, reference_number, notes,
         due_date, payment_status, source, user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','manual',$8)
       RETURNING *`,
      [companyId, amount, customerName, description, referenceNumber, notes, dueDate, auth.userId],
    );
    const created = rows[0] as Record<string, unknown>;
    try {
      await upsertLedgerMovement({
        companyId,
        source: `ar:${String(created.id)}`,
        direction: 'in',
        status: 'previsto',
        amount,
        competencyDate: ledgerTodayYmd(),
        dueDate,
        paymentMethod: 'fiado',
        description: customerName ? `A receber — ${customerName}` : description,
        categoryCode: 'RECEBER',
        createdBy: auth.userId,
      });
    } catch (err) {
      console.warn('[receivables] ledger create:', err);
    }
    return c.json({ receivable: mapReceivable(created) });
  }

  // Parcelado: divide o valor
  const groupId = crypto.randomUUID();
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / installmentCount);
  const parts: number[] = [];
  let allocated = 0;
  for (let i = 0; i < installmentCount; i++) {
    const p = i === installmentCount - 1 ? cents - allocated : base;
    parts.push(p);
    allocated += p;
  }

  const [y, m, d] = dueDate.split('-').map(Number);
  const created: Record<string, unknown>[] = [];
  for (let i = 0; i < installmentCount; i++) {
    const dt = new Date(y, m - 1, d);
    dt.setMonth(dt.getMonth() + i);
    const pad = (n: number) => String(n).padStart(2, '0');
    const due = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const partAmount = parts[i] / 100;
    const { rows } = await query(
      `INSERT INTO accounts_receivable (
         company_id, amount, customer_name, description, reference_number, notes,
         due_date, payment_status, source, user_id,
         receivable_group_id, installment_index, installment_of
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','installment',$8,$9,$10,$11)
       RETURNING *`,
      [
        companyId,
        partAmount,
        customerName,
        `${description} (${i + 1}/${installmentCount})`,
        referenceNumber,
        notes,
        due,
        auth.userId,
        groupId,
        i + 1,
        installmentCount,
      ],
    );
    created.push(rows[0] as Record<string, unknown>);
    try {
      const row = rows[0] as Record<string, unknown>;
      await upsertLedgerMovement({
        companyId,
        source: `ar:${String(row.id)}`,
        direction: 'in',
        status: 'previsto',
        amount: partAmount,
        competencyDate: ledgerTodayYmd(),
        dueDate: due,
        paymentMethod: 'fiado',
        description: customerName
          ? `A receber — ${customerName} (${i + 1}/${installmentCount})`
          : `${description} (${i + 1}/${installmentCount})`,
        categoryCode: 'RECEBER',
        createdBy: auth.userId,
      });
    } catch (err) {
      console.warn('[receivables] ledger installment:', err);
    }
  }

  return c.json({
    receivables: created.map((r) => mapReceivable(r)),
    receivable: mapReceivable(created[0]),
  });
});

receivables.put('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    customerName?: string;
    description?: string;
    referenceNumber?: string;
    notes?: string;
    dueDate?: string;
    paymentStatus?: string;
  };

  const { rows: cur } = await query(
    `SELECT * FROM accounts_receivable WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  if (!cur[0]) return c.json({ error: 'Título não encontrado' }, 404);

  const row = cur[0] as Record<string, unknown>;
  const next = {
    customer_name: body.customerName !== undefined ? body.customerName : row.customer_name,
    description: body.description !== undefined ? body.description : row.description,
    reference_number:
      body.referenceNumber !== undefined ? body.referenceNumber : row.reference_number,
    notes: body.notes !== undefined ? body.notes : row.notes,
    due_date: body.dueDate !== undefined ? body.dueDate : row.due_date,
    payment_status: body.paymentStatus !== undefined ? body.paymentStatus : row.payment_status,
  };

  const { rows } = await query(
    `UPDATE accounts_receivable SET
       customer_name = $1, description = $2, reference_number = $3, notes = $4,
       due_date = $5, payment_status = $6, updated_at = now()
     WHERE id = $7 AND company_id = $8
     RETURNING *`,
    [
      next.customer_name,
      next.description,
      next.reference_number,
      next.notes,
      next.due_date,
      next.payment_status,
      id,
      companyId,
    ],
  );
  return c.json({ receivable: mapReceivable(rows[0] as Record<string, unknown>) });
});

receivables.delete('/:id', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rowCount } = await query(
    `DELETE FROM accounts_receivable WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rowCount) return c.json({ error: 'Título não encontrado' }, 404);
  return c.json({ ok: true });
});

receivables.get('/:id/payments', async (c) => {
  const companyId = c.get('companyId');
  const id = c.req.param('id');
  const { rows } = await query(
    `SELECT id, amount, payment_date, payment_method, notes, created_at
     FROM accounts_receivable_payments
     WHERE company_id = $1 AND receivable_id = $2
     ORDER BY payment_date DESC, created_at DESC`,
    [companyId, id],
  );
  return c.json({
    payments: rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        amount: parseFloat(String(row.amount)) || 0,
        paymentDate: String(row.payment_date).split('T')[0],
        paymentMethod: row.payment_method != null ? String(row.payment_method) : null,
        notes: row.notes != null ? String(row.notes) : null,
        createdAt: row.created_at,
      };
    }),
  });
});

receivables.post('/:id/payments', async (c) => {
  const companyId = c.get('companyId');
  const auth = c.get('auth');
  const id = c.req.param('id');
  const body = (await c.req.json()) as {
    amount?: number;
    paymentMethod?: string;
    notes?: string;
    registerId?: string;
  };

  const payNow = Number(body.amount);
  if (!Number.isFinite(payNow) || payNow <= 0) {
    return c.json({ error: 'Informe um valor maior que zero' }, 400);
  }

  const { rows } = await query(
    `SELECT * FROM accounts_receivable WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return c.json({ error: 'Título não encontrado' }, 404);
  if (String(row.payment_status) === 'cancelled') {
    return c.json({ error: 'Título cancelado' }, 400);
  }

  const total = parseFloat(String(row.amount)) || 0;
  const prev = receivedFromRow(row);
  const remaining = Math.max(0, Math.round((total - prev) * 100) / 100);
  if (remaining <= 0) return c.json({ error: 'Este título já está quitado' }, 400);

  const applied = Math.min(Math.round(payNow * 100) / 100, remaining);
  const newReceived = Math.round((prev + applied) * 100) / 100;
  const today = todayYmdLocal();
  const dueRaw = row.due_date ? String(row.due_date).split('T')[0] : '';
  const isFullyPaid = newReceived >= total - 0.005;
  let nextStatus = 'pending';
  if (isFullyPaid) nextStatus = 'paid';
  else if (dueRaw && dueRaw < today) nextStatus = 'overdue';

  const paymentMethod = body.paymentMethod ?? null;

  await query(
    `UPDATE accounts_receivable SET
       received_amount = $1,
       received_date = $2,
       payment_method = $3,
       payment_status = $4,
       updated_at = now()
     WHERE id = $5 AND company_id = $6`,
    [isFullyPaid ? total : newReceived, today, paymentMethod, nextStatus, id, companyId],
  );

  const { rows: payIns } = await query(
    `INSERT INTO accounts_receivable_payments
       (company_id, receivable_id, amount, payment_date, payment_method, notes, register_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      companyId,
      id,
      applied,
      today,
      paymentMethod,
      body.notes ?? null,
      body.registerId ?? null,
      auth.userId,
    ],
  );
  const paymentId = String((payIns[0] as { id: string }).id);
  const remainingAfter = Math.max(0, Math.round((total - (isFullyPaid ? total : newReceived)) * 100) / 100);

  try {
    await ledgerReceivablePayment({
      companyId,
      receivableId: id,
      paymentId,
      amount: applied,
      remainingAfter,
      saleId: row.sale_id != null ? String(row.sale_id) : null,
      paymentMethod,
      description: row.customer_name
        ? `Recebimento — ${String(row.customer_name)}`
        : 'Recebimento de título',
      userId: auth.userId,
    });
  } catch (err) {
    console.warn('[receivables] ledger:', err);
  }

  // Se dinheiro/PIX e houver caixa aberto, credita o caixa
  if (paymentMethod === 'money' || paymentMethod === 'pix') {
    try {
      await adjustOpenCashRegister({
        companyId,
        amount: applied,
        type: 'deposit',
        reason: `Recebimento título #${id.slice(0, 8)}`,
        userId: auth.userId,
        fullName: auth.fullName,
        registerId: body.registerId,
      });
    } catch (err) {
      console.warn('[receivables] cash deposit:', err);
    }
  }

  const { rows: updated } = await query(
    `SELECT * FROM accounts_receivable WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return c.json({ receivable: mapReceivable(updated[0] as Record<string, unknown>) });
});

export default receivables;
