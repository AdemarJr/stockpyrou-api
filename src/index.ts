import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getPool } from './db/pool.js';
import authRoutes from './routes/auth.js';
import cashierRoutes from './routes/cashier.js';
import companiesRoutes from './routes/companies.js';
import priceHistoryRoutes from './routes/price-history.js';
import productsRoutes from './routes/products.js';
import reportsRoutes from './routes/reports.js';
import stockRoutes from './routes/stock.js';
import suppliersRoutes from './routes/suppliers.js';

const app = new Hono();

function parseAllowedOrigins(): string[] {
  const fromList = (process.env.FRONTEND_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const single = process.env.FRONTEND_URL?.trim();
  const defaults = [
    'https://stockpyrou.com.br',
    'https://www.stockpyrou.com.br',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  return [...new Set([...(single ? [single] : []), ...fromList, ...defaults])];
}

const allowedOrigins = parseAllowedOrigins();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.startsWith('http://localhost:')) return origin;
      return null;
    },
    allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Custom-Token',
      'X-Company-Id',
    ],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: true,
  }),
);

app.get('/api/health', (c) => {
  // Liveness para Railway: não depende do banco (senão o deploy falha com 503).
  return c.json({ status: 'ok', version: '0.2.0' });
});

app.get('/api/ready', async (c) => {
  try {
    await getPool().query('SELECT 1');
    return c.json({ status: 'ok', database: 'connected', version: '0.2.0' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return c.json({ status: 'degraded', database: 'disconnected', error: message }, 503);
  }
});

app.route('/api/auth', authRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/suppliers', suppliersRoutes);
app.route('/api/stock', stockRoutes);
app.route('/api/price-history', priceHistoryRoutes);
app.route('/api/companies', companiesRoutes);
app.route('/api/cashier', cashierRoutes);
app.route('/api/reports', reportsRoutes);

const port = Number(process.env.PORT) || 3001;
const hostname = process.env.HOST?.trim() || '0.0.0.0';

console.log(`[stockpyrou-api] listening on http://${hostname}:${port}`);

serve({ fetch: app.fetch, port, hostname });
