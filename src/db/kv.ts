import { query } from './pool.js';

export async function kvGet(key: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<{ value: unknown }>(
    'SELECT value FROM kv_store_8a20b27d WHERE key = $1 LIMIT 1',
    [key],
  );
  const raw = rows[0]?.value;
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

export async function kvSet(key: string, value: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO kv_store_8a20b27d (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function kvDel(key: string): Promise<void> {
  await query('DELETE FROM kv_store_8a20b27d WHERE key = $1', [key]);
}
