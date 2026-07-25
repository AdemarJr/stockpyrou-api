import { query } from './pool.js';

/** Raw JSON value from kv_store (objects, arrays, booleans, strings, numbers). */
export async function kvGet(key: string): Promise<unknown> {
  const { rows } = await query<{ value: unknown }>(
    'SELECT value FROM kv_store_8a20b27d WHERE key = $1 LIMIT 1',
    [key],
  );
  const raw = rows[0]?.value;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO kv_store_8a20b27d (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function kvDel(key: string): Promise<void> {
  await query('DELETE FROM kv_store_8a20b27d WHERE key = $1', [key]);
}

/** Object-shaped KV values (sessions, company profiles, config blobs). */
export function kvRecord(raw: unknown): Record<string, unknown> | null {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}
