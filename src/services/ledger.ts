import { query } from '../db/pool.js';

export type LedgerDirection = 'in' | 'out';
export type LedgerStatus = 'realizado' | 'previsto';

export type UpsertLedgerInput = {
  companyId: string;
  source: string;
  direction: LedgerDirection;
  status: LedgerStatus;
  amount: number;
  competencyDate: string; // YYYY-MM-DD
  cashDate?: string | null;
  dueDate?: string | null;
  paymentMethod?: string | null;
  description?: string | null;
  categoryCode?: string | null;
  costCenterId?: string | null;
  saleId?: string | null;
  operationalExpenseId?: string | null;
  stockEntryId?: string | null;
  supplierId?: string | null;
  createdBy?: string | null;
};

function todayYmdLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export { todayYmdLocal };

/** Normaliza payment_method para o CHECK do ledger (fiado permitido após migration). */
function normalizePaymentMethod(method?: string | null): string | null {
  if (!method) return null;
  const m = String(method).trim().toLowerCase();
  const allowed = new Set([
    'money',
    'pix',
    'credit',
    'debit',
    'boleto',
    'bank_transfer',
    'transfer',
    'other',
    'fiado',
  ]);
  if (allowed.has(m)) return m;
  if (m === 'transferencia') return 'bank_transfer';
  return 'other';
}

/**
 * Upsert idempotente no ledger (chave company_id + source).
 * Compatível com o schema EasyPanel (category_code, FKs, source).
 */
export async function upsertLedgerMovement(input: UpsertLedgerInput): Promise<void> {
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) return;
  if (!input.source?.trim()) return;

  try {
    await query(
      `INSERT INTO financial_movements (
         company_id, source, direction, status, amount,
         competency_date, cash_date, due_date,
         payment_method, description, category_code, cost_center_id,
         sale_id, operational_expense_id, stock_entry_id, supplier_id, created_by,
         updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,
         $9,$10,$11,$12,
         $13,$14,$15,$16,$17,
         now()
       )
       ON CONFLICT (company_id, source) WHERE (source IS NOT NULL) DO UPDATE SET
         direction = EXCLUDED.direction,
         status = EXCLUDED.status,
         amount = EXCLUDED.amount,
         competency_date = EXCLUDED.competency_date,
         cash_date = EXCLUDED.cash_date,
         due_date = EXCLUDED.due_date,
         payment_method = EXCLUDED.payment_method,
         description = EXCLUDED.description,
         category_code = COALESCE(EXCLUDED.category_code, financial_movements.category_code),
         cost_center_id = COALESCE(EXCLUDED.cost_center_id, financial_movements.cost_center_id),
         sale_id = COALESCE(EXCLUDED.sale_id, financial_movements.sale_id),
         operational_expense_id = COALESCE(EXCLUDED.operational_expense_id, financial_movements.operational_expense_id),
         stock_entry_id = COALESCE(EXCLUDED.stock_entry_id, financial_movements.stock_entry_id),
         supplier_id = COALESCE(EXCLUDED.supplier_id, financial_movements.supplier_id),
         updated_at = now()`,
      [
        input.companyId,
        input.source.trim(),
        input.direction,
        input.status,
        amount,
        input.competencyDate,
        input.cashDate ?? null,
        input.dueDate ?? null,
        normalizePaymentMethod(input.paymentMethod),
        input.description ?? null,
        input.categoryCode ?? null,
        input.costCenterId ?? null,
        input.saleId ?? null,
        input.operationalExpenseId ?? null,
        input.stockEntryId ?? null,
        input.supplierId ?? null,
        input.createdBy ?? null,
      ],
    );
  } catch (err) {
    // Fallback sem partial unique index (ambientes antigos): delete+insert
    console.warn('[ledger] upsert failed, trying replace:', err);
    try {
      await query(`DELETE FROM financial_movements WHERE company_id = $1 AND source = $2`, [
        input.companyId,
        input.source.trim(),
      ]);
      await query(
        `INSERT INTO financial_movements (
           company_id, source, direction, status, amount,
           competency_date, cash_date, due_date,
           payment_method, description, category_code, cost_center_id,
           sale_id, operational_expense_id, stock_entry_id, supplier_id, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          input.companyId,
          input.source.trim(),
          input.direction,
          input.status,
          amount,
          input.competencyDate,
          input.cashDate ?? null,
          input.dueDate ?? null,
          normalizePaymentMethod(input.paymentMethod),
          input.description ?? null,
          input.categoryCode ?? null,
          input.costCenterId ?? null,
          input.saleId ?? null,
          input.operationalExpenseId ?? null,
          input.stockEntryId ?? null,
          input.supplierId ?? null,
          input.createdBy ?? null,
        ],
      );
    } catch (err2) {
      console.error('[ledger] replace failed:', err2);
    }
  }
}

export async function deleteLedgerBySource(companyId: string, source: string): Promise<void> {
  try {
    await query(`DELETE FROM financial_movements WHERE company_id = $1 AND source = $2`, [
      companyId,
      source,
    ]);
  } catch (err) {
    console.warn('[ledger] deleteBySource:', err);
  }
}

/** Credita/debita caixa aberto (money/pix). type: deposit | withdrawal */
export async function adjustOpenCashRegister(params: {
  companyId: string;
  amount: number;
  type: 'deposit' | 'withdrawal';
  reason: string;
  userId: string;
  fullName: string;
  registerId?: string | null;
}): Promise<string | null> {
  const amount = Math.round(Number(params.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let registerId = params.registerId?.trim() || null;
  if (!registerId) {
    const { rows } = await query(
      `SELECT id FROM cash_registers
       WHERE company_id = $1 AND status = 'open'
       ORDER BY opened_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [params.companyId],
    );
    registerId = rows[0] ? String((rows[0] as { id: string }).id) : null;
  }
  if (!registerId) return null;

  const delta = params.type === 'deposit' ? amount : -amount;
  await query(
    `UPDATE cash_registers SET current_balance = current_balance + $1 WHERE id = $2 AND company_id = $3`,
    [delta, registerId, params.companyId],
  );
  try {
    await query(
      `INSERT INTO cash_movements (company_id, register_id, type, amount, reason, performed_by_id, performed_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.companyId,
        registerId,
        params.type,
        amount,
        params.reason,
        params.userId,
        params.fullName,
      ],
    );
  } catch (err) {
    console.warn('[ledger] cash_movements insert:', err);
  }
  return registerId;
}

export async function ledgerFromSale(params: {
  companyId: string;
  saleId: string;
  total: number;
  paymentMethod: string;
  paymentDetails?: { dueDate?: string; customerName?: string } | null;
  saleDateYmd?: string;
  userId?: string;
}): Promise<void> {
  const method = String(params.paymentMethod || 'money');
  const day = params.saleDateYmd || todayYmdLocal();
  const source = `sale:${params.saleId}`;

  if (method === 'money' || method === 'pix') {
    await upsertLedgerMovement({
      companyId: params.companyId,
      source,
      direction: 'in',
      status: 'realizado',
      amount: params.total,
      competencyDate: day,
      cashDate: day,
      paymentMethod: method,
      description: 'Venda PDV',
      categoryCode: 'VENDA',
      saleId: params.saleId,
      createdBy: params.userId,
    });
    return;
  }

  if (method === 'fiado' || method === 'boleto') {
    let due = params.paymentDetails?.dueDate;
    if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      const [y, m, d] = day.split('-').map(Number);
      const dt = new Date(y, m - 1, d + 30);
      const pad = (n: number) => String(n).padStart(2, '0');
      due = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }
    const cust = params.paymentDetails?.customerName?.trim();
    await upsertLedgerMovement({
      companyId: params.companyId,
      source,
      direction: 'in',
      status: 'previsto',
      amount: params.total,
      competencyDate: day,
      dueDate: due,
      paymentMethod: method,
      description: cust ? `A receber — ${cust}` : `Venda ${method} (a receber)`,
      categoryCode: 'RECEBER',
      saleId: params.saleId,
      createdBy: params.userId,
    });
  }
  // credit/debit: competência via sales/views; sem caixa imediato
}

export async function ledgerFromExpense(params: {
  companyId: string;
  expenseId: string;
  amount: number;
  dueDate: string;
  paymentStatus?: string;
  paymentMethod?: string | null;
  description?: string | null;
  costCenterId?: string | null;
  supplierId?: string | null;
  stockEntryId?: string | null;
  userId?: string;
}): Promise<void> {
  const status = String(params.paymentStatus || 'pending');
  if (status === 'cancelled') {
    await deleteLedgerBySource(params.companyId, `expense:${params.expenseId}`);
    return;
  }
  if (status === 'paid') {
    await upsertLedgerMovement({
      companyId: params.companyId,
      source: `expense:${params.expenseId}`,
      direction: 'out',
      status: 'realizado',
      amount: params.amount,
      competencyDate: params.dueDate,
      cashDate: todayYmdLocal(),
      dueDate: params.dueDate,
      paymentMethod: params.paymentMethod,
      description: params.description || 'Despesa operacional',
      categoryCode: 'DESPESA',
      costCenterId: params.costCenterId,
      operationalExpenseId: params.expenseId,
      supplierId: params.supplierId,
      stockEntryId: params.stockEntryId,
      createdBy: params.userId,
    });
    return;
  }
  await upsertLedgerMovement({
    companyId: params.companyId,
    source: `expense:${params.expenseId}`,
    direction: 'out',
    status: 'previsto',
    amount: params.amount,
    competencyDate: params.dueDate,
    dueDate: params.dueDate,
    paymentMethod: params.paymentMethod,
    description: params.description || 'Despesa operacional',
    categoryCode: 'DESPESA',
    costCenterId: params.costCenterId,
    operationalExpenseId: params.expenseId,
    supplierId: params.supplierId,
    stockEntryId: params.stockEntryId,
    createdBy: params.userId,
  });
}

export async function ledgerExpensePayment(params: {
  companyId: string;
  expenseId: string;
  paymentId: string;
  amount: number;
  remainingAfter: number;
  dueDate: string;
  paymentMethod?: string | null;
  description?: string | null;
  costCenterId?: string | null;
  supplierId?: string | null;
  userId?: string;
}): Promise<void> {
  const today = todayYmdLocal();
  await upsertLedgerMovement({
    companyId: params.companyId,
    source: `expense_pay:${params.expenseId}:${params.paymentId}`,
    direction: 'out',
    status: 'realizado',
    amount: params.amount,
    competencyDate: today,
    cashDate: today,
    paymentMethod: params.paymentMethod,
    description: params.description || 'Pagamento de despesa',
    categoryCode: 'DESPESA',
    costCenterId: params.costCenterId,
    operationalExpenseId: params.expenseId,
    supplierId: params.supplierId,
    createdBy: params.userId,
  });

  if (params.remainingAfter <= 0.005) {
    await deleteLedgerBySource(params.companyId, `expense:${params.expenseId}`);
  } else {
    await upsertLedgerMovement({
      companyId: params.companyId,
      source: `expense:${params.expenseId}`,
      direction: 'out',
      status: 'previsto',
      amount: params.remainingAfter,
      competencyDate: params.dueDate,
      dueDate: params.dueDate,
      paymentMethod: params.paymentMethod,
      description: params.description || 'Despesa operacional (saldo)',
      categoryCode: 'DESPESA',
      costCenterId: params.costCenterId,
      operationalExpenseId: params.expenseId,
      supplierId: params.supplierId,
      createdBy: params.userId,
    });
  }
}

export async function ledgerReceivablePayment(params: {
  companyId: string;
  receivableId: string;
  paymentId: string;
  amount: number;
  remainingAfter: number;
  saleId?: string | null;
  paymentMethod?: string | null;
  description?: string | null;
  userId?: string;
}): Promise<void> {
  const today = todayYmdLocal();
  await upsertLedgerMovement({
    companyId: params.companyId,
    source: `ar_pay:${params.receivableId}:${params.paymentId}`,
    direction: 'in',
    status: 'realizado',
    amount: params.amount,
    competencyDate: today,
    cashDate: today,
    paymentMethod: params.paymentMethod,
    description: params.description || 'Recebimento de título',
    categoryCode: 'RECEBER',
    saleId: params.saleId ?? null,
    createdBy: params.userId,
  });

  // Atualiza previsto da venda vinculada (ou do próprio título)
  const previstoSource = params.saleId
    ? `sale:${params.saleId}`
    : `ar:${params.receivableId}`;
  if (params.remainingAfter <= 0.005) {
    await deleteLedgerBySource(params.companyId, previstoSource);
  } else {
    await upsertLedgerMovement({
      companyId: params.companyId,
      source: previstoSource,
      direction: 'in',
      status: 'previsto',
      amount: params.remainingAfter,
      competencyDate: today,
      dueDate: today,
      paymentMethod: params.paymentMethod === 'boleto' ? 'boleto' : 'fiado',
      description: params.description || 'A receber (saldo)',
      categoryCode: 'RECEBER',
      saleId: params.saleId ?? null,
      createdBy: params.userId,
    });
  }
}
