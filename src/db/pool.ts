import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (see .env.example)');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}
