import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { pingDatabase } from './db/pool.js';
import authRoutes from './routes/auth.js';
import cashierRoutes from './routes/cashier.js';
import companiesRoutes from './routes/companies.js';
import priceHistoryRoutes from './routes/price-history.js';
import productsRoutes from './routes/products.js';
import reportsRoutes from './routes/reports.js';
import stockRoutes from './routes/stock.js';
import suppliersRoutes from './routes/suppliers.js';
import costsRoutes from './routes/costs.js';
import adminRoutes from './routes/admin.js';
import usersRoutes from './routes/users.js';
import zigRoutes from './routes/zig.js';
import receivablesRoutes from './routes/receivables.js';
import fiscalRoutes from './routes/fiscal.js';
import customersRoutes from './routes/customers.js';

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
      'X-ZIG-TOKEN',
      'X-ZIG-CRON-SECRET',
    ],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
    credentials: true,
  }),
);

app.get('/api/health', (c) => {
  // Liveness para Railway: não depende do banco (senão o deploy falha com 503).
  return c.json({
    status: 'ok',
    version: '0.2.8',
    routes: ['customers', 'fiscal', 'nfce', 'inbound-dfe', 'receivables'],
  });
});

app.get('/api/ready', async (c) => {
  const ping = await pingDatabase(Number(process.env.PG_CONNECTION_TIMEOUT_MS || 8000));
  if (ping.ok) {
    return c.json({ status: 'ok', database: 'connected', version: '0.2.8' });
  }
  return c.json(
    {
      status: 'degraded',
      database: 'disconnected',
      version: '0.2.8',
      error: ping.error,
      hint:
        'Railway não alcançou o Postgres. Confira DATABASE_URL e o firewall/rede do EasyPanel (porta 5432).',
    },
    503,
  );
});

app.route('/api/auth', authRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/suppliers', suppliersRoutes);
app.route('/api/stock', stockRoutes);
app.route('/api/price-history', priceHistoryRoutes);
app.route('/api/companies', companiesRoutes);
app.route('/api/cashier', cashierRoutes);
app.route('/api/reports', reportsRoutes);
app.route('/api/costs', costsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/zig', zigRoutes);
app.route('/api/receivables', receivablesRoutes);
app.route('/api/fiscal', fiscalRoutes);
app.route('/api/customers', customersRoutes);

const port = Number(process.env.PORT) || 3001;
const hostname = process.env.HOST?.trim() || '0.0.0.0';

console.log(`[stockpyrou-api] listening on http://${hostname}:${port}`);

serve({ fetch: app.fetch, port, hostname });
