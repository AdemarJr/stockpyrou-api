import type { Context, Next } from 'hono';
import {
  getPermissionsByRole,
  mapAppUserRole,
  type PermissionFlag,
} from '../auth/permissions.js';
import { resolveCompanyId } from '../auth/resolve-company.js';
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

/**
 * Exige empresa no contexto e valida vínculo.
 * Admin da empresa: acesso total só nas empresas vinculadas (user_companies / company_id).
 * SuperAdmin: qualquer empresa.
 */
export async function requireCompany(c: Context<{ Variables: AppVariables }>, next: Next) {
  const auth = c.get('auth');
  const headerCompanyId = c.req.header('X-Company-Id')?.trim();
  const companyId = await resolveCompanyId(auth, headerCompanyId);

  if (!companyId) {
    if (headerCompanyId) {
      return c.json(
        {
          error:
            'Sem acesso a esta empresa. O Admin só opera nas empresas às quais está vinculado.',
        },
        403,
      );
    }
    return c.json({ error: 'X-Company-Id header is required' }, 400);
  }

  c.set('companyId', companyId);
  await next();
}

/** Exige um flag da matriz de permissões (superadmin sempre passa). */
export function requirePermission(flag: PermissionFlag) {
  return async (c: Context<{ Variables: AppVariables }>, next: Next) => {
    const auth = c.get('auth');
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const role = mapAppUserRole(String(auth.role || ''));
    if (role === 'superadmin') {
      await next();
      return;
    }
    const perms = auth.permissions ?? getPermissionsByRole(role);
    if (!perms[flag]) {
      return c.json({ error: 'Sem permissão para esta operação' }, 403);
    }
    await next();
  };
}
