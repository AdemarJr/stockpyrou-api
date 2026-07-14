export function mapStockEntryRow(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    companyId: String(item.company_id),
    productId: String(item.product_id),
    supplierId: item.supplier_id != null ? String(item.supplier_id) : '',
    quantity: Number(item.quantity) || 0,
    unitPrice: Number(item.unit_cost) || 0,
    totalPrice: Number(item.total_cost) || 0,
    batchNumber: item.batch_number != null ? String(item.batch_number) : undefined,
    expirationDate: item.expiry_date ? String(item.expiry_date) : undefined,
    notes: item.notes != null ? String(item.notes) : undefined,
    entryDate: String(item.entry_date),
    userId: item.created_by != null ? String(item.created_by) : undefined,
  };
}

export function mapMovementRow(item: Record<string, unknown>) {
  const qty = Number(item.quantity) || 0;
  const unitCost = Number(item.unit_cost) || 0;
  const totalValRaw = item.total_value;
  const totalVal =
    totalValRaw != null && totalValRaw !== '' ? Number(totalValRaw) : NaN;
  const lineCost =
    Number.isFinite(totalVal) && totalVal > 0 ? totalVal : qty * unitCost;
  const rawDate = item.movement_date ?? item.date ?? item.created_at;
  const typeRaw = String(item.movement_type ?? item.type ?? 'ajuste').toLowerCase().trim();

  return {
    id: String(item.id),
    companyId: String(item.company_id),
    productId: String(item.product_id),
    type: typeRaw,
    quantity: qty,
    reason: String(item.reason ?? item.notes ?? ''),
    cost: lineCost > 0 ? lineCost : undefined,
    batchNumber: item.batch_number != null ? String(item.batch_number) : undefined,
    date: rawDate ? String(rawDate) : new Date().toISOString(),
    userId:
      item.created_by != null
        ? String(item.created_by)
        : item.user_id != null
          ? String(item.user_id)
          : undefined,
    notes: item.notes != null ? String(item.notes) : undefined,
  };
}
