import { query } from './pool.js';

const DEFAULT_PAGE = 1000;

/** Pagina resultados (equivalente ao fetchAllRows do StockRepository). */
export async function fetchAllRows<T extends Record<string, unknown>>(
  baseSql: string,
  params: unknown[],
  pageSize = DEFAULT_PAGE,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const { rows: batch } = await query<T>(
      `${baseSql} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, offset],
    );
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}
