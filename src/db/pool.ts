import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function buildPoolConfig(): pg.PoolConfig {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (see .env.example)');
  }

  // Timeout curto evita login/ready “pendurados” quando o Postgres (EasyPanel)
  // está inacessível a partir do Railway (firewall / URL errada).
  const connectionTimeoutMillis = Number(process.env.PG_CONNECTION_TIMEOUT_MS || 8000);
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30000);
  const query_timeout = Number(process.env.PG_QUERY_TIMEOUT_MS || 20000);

  const cfg: pg.PoolConfig = {
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis,
    idleTimeoutMillis,
    // node-pg: cancela query no client após N ms (não é statement_timeout do PG)
    query_timeout,
    allowExitOnIdle: false,
  };

  // sslmode=disable na URL → força SSL off (comum no EasyPanel)
  if (/sslmode=disable/i.test(connectionString)) {
    cfg.ssl = false;
  } else if (/sslmode=require|sslmode=no-verify/i.test(connectionString)) {
    cfg.ssl = { rejectUnauthorized: false };
  }

  return cfg;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (err) => {
      console.error('[pg pool] idle client error:', err.message);
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

/** Teste rápido de conectividade (para /api/ready). */
export async function pingDatabase(timeoutMs = 8000): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new pg.Client({
    ...buildPoolConfig(),
    connectionTimeoutMillis: timeoutMs,
  } as pg.ClientConfig);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}
