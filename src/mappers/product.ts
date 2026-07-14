export interface ProductDto {
  id: string;
  companyId: string;
  name: string;
  category: string;
  isPerishable: boolean;
  measurementUnit: string;
  minStock: number;
  safetyStock: number;
  currentStock: number;
  averageCost: number;
  supplierId?: string;
  shelfLife?: number;
  bundleItems?: Array<{ productId: string; quantity: number }>;
  barcode?: string;
  sellingPrice?: number;
  image?: string;
  createdAt: string;
  updatedAt: string;
}

function tryParseDescription(desc: string): Record<string, unknown> | null {
  try {
    if (desc && desc.startsWith('{')) {
      return JSON.parse(desc) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function mapProductRow(data: Record<string, unknown>): ProductDto {
  const description = data.description != null ? String(data.description) : '';
  const parsedDesc = description ? tryParseDescription(description) : null;
  const bundleRaw = parsedDesc?.bundleItems;
  const bundleItems = Array.isArray(bundleRaw)
    ? bundleRaw
        .filter((x): x is { productId: string; quantity: number } =>
          x != null && typeof x === 'object' && 'productId' in x,
        )
        .map((x) => ({
          productId: String((x as { productId: unknown }).productId),
          quantity: Number((x as { quantity: unknown }).quantity) || 0,
        }))
    : undefined;

  return {
    id: String(data.id),
    companyId: String(data.company_id),
    name: String(data.name),
    category: String(data.category ?? 'outro'),
    isPerishable: false,
    measurementUnit: String(data.unit ?? 'un'),
    minStock: Number(data.min_stock) || 0,
    safetyStock: Number(data.safety_stock ?? data.min_stock) || 0,
    currentStock: Number(data.current_stock) || 0,
    averageCost: Number(data.cost_price) || 0,
    supplierId: data.supplier_id != null ? String(data.supplier_id) : undefined,
    shelfLife:
      parsedDesc?.shelfLife != null ? Number(parsedDesc.shelfLife) : undefined,
    bundleItems,
    barcode: data.barcode != null ? String(data.barcode) : undefined,
    sellingPrice: Number(data.sale_price) || 0,
    image: data.image_url != null ? String(data.image_url) : undefined,
    createdAt: String(data.created_at),
    updatedAt: String(data.updated_at ?? data.created_at),
  };
}

export function mapProductToDb(
  product: Partial<ProductDto>,
): Record<string, unknown> {
  const desc: Record<string, unknown> = {};
  if (product.shelfLife != null) desc.shelfLife = product.shelfLife;
  if (product.bundleItems != null) desc.bundleItems = product.bundleItems;

  const row: Record<string, unknown> = {};
  if (product.name != null) row.name = product.name;
  if (product.category != null) row.category = product.category;
  if (product.measurementUnit != null) row.unit = product.measurementUnit;
  if (product.minStock != null) row.min_stock = product.minStock;
  if (product.currentStock != null) row.current_stock = product.currentStock;
  if (product.averageCost != null) row.cost_price = product.averageCost;
  if (product.sellingPrice != null) row.sale_price = product.sellingPrice;
  if (product.supplierId !== undefined) row.supplier_id = product.supplierId || null;
  if (product.barcode !== undefined) row.barcode = product.barcode || null;
  if (product.image !== undefined) row.image_url = product.image || null;
  if (product.shelfLife != null || product.bundleItems != null) {
    row.description = Object.keys(desc).length > 0 ? JSON.stringify(desc) : null;
  }
  return row;
}

export function dtoToFrontendProduct(dto: ProductDto) {
  return {
    ...dto,
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
  };
}
