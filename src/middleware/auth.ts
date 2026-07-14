import type { Context, Next } from 'hono';
import { verifyRequestToken } from '../auth/verify-token.js';
import type { AuthContext } from '../types/auth.js';

export type AppVariables = {
  auth: AuthContext;
  companyId: string;
};

function extractToken(c: Context): string | null {
  const custom = c.req.header('X-Custom-Token');
  if (custom?.trim()) return custom.trim();

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export async function requireAuth(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = extractToken(c);
  const auth = await verifyRequestToken(token);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  c.set('auth', auth);
  await next();
}

export async function requireCompany(c: Context<{ Variables: AppVariables }>, next: Next) {
  const headerCompanyId = c.req.header('X-Company-Id')?.trim();
  const auth = c.get('auth');

  const companyId = headerCompanyId || auth.companyId;
  if (!companyId) {
    return c.json({ error: 'X-Company-Id header is required' }, 400);
  }

  c.set('companyId', companyId);
  await next();
}
