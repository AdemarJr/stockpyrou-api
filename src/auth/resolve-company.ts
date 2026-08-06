import { query } from '../db/pool.js';
import { mapAppUserRole } from './permissions.js';
import type { AuthContext } from '../types/auth.js';

/**
 * SuperAdmin: qualquer empresa.
 * Admin (e demais): só empresas vinculadas (app_users.company_id, user_companies
 * ou login legado company_<uuid>).
 */
export async function userHasCompanyAccess(
  auth: AuthContext,
  companyId: string,
): Promise<boolean> {
  const id = String(companyId || '').trim();
  if (!id) return false;

  const role = mapAppUserRole(String(auth.role || ''));
  if (role === 'superadmin') return true;

  if (auth.userId.startsWith('company_')) {
    const own = auth.userId.replace(/^company_/, '');
    return own === id || auth.companyId === id;
  }

  if (auth.companyId && auth.companyId === id) return true;

  // UUID em app_users / user_companies
  try {
    const { rows } = await query(
      `SELECT 1 AS ok
       FROM user_companies
       WHERE user_id = $1::uuid AND company_id = $2::uuid
       LIMIT 1`,
      [auth.userId, id],
    );
    if (rows[0]) return true;
  } catch {
    // userId pode não ser uuid (legado)
  }

  return false;
}

/** Empresas às quais o usuário está vinculado (exceto superadmin = todas via outro fluxo). */
export async function listUserCompanyIds(auth: AuthContext): Promise<string[]> {
  const role = mapAppUserRole(String(auth.role || ''));
  if (role === 'superadmin') return [];

  if (auth.userId.startsWith('company_')) {
    const own = auth.userId.replace(/^company_/, '');
    return own ? [own] : [];
  }

  const ids = new Set<string>();
  if (auth.companyId?.trim()) ids.add(auth.companyId.trim());

  try {
    const { rows } = await query<{ company_id: string }>(
      `SELECT company_id FROM user_companies WHERE user_id = $1::uuid`,
      [auth.userId],
    );
    for (const r of rows) {
      if (r.company_id) ids.add(String(r.company_id));
    }
  } catch {
    /* ignore */
  }

  return [...ids];
}

/**
 * Resolve companyId efetivo (header ou perfil), validando vínculo.
 * Superadmin: aceita header/perfil sem checar user_companies.
 */
export async function resolveCompanyId(
  auth: AuthContext,
  headerCompanyId?: string | null,
): Promise<string | null> {
  const candidate =
    headerCompanyId?.trim() ||
    auth.companyId?.trim() ||
    (auth.userId.startsWith('company_') ? auth.userId.replace(/^company_/, '') : '') ||
    null;

  const role = mapAppUserRole(String(auth.role || ''));
  if (role === 'superadmin') {
    if (candidate) return candidate;
    return null;
  }

  if (candidate) {
    const ok = await userHasCompanyAccess(auth, candidate);
    return ok ? candidate : null;
  }

  const linked = await listUserCompanyIds(auth);
  return linked[0] ?? null;
}
