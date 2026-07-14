import { query } from '../db/pool.js';
import type { AuthContext } from '../types/auth.js';

export async function resolveCompanyId(
  auth: AuthContext,
  headerCompanyId?: string | null,
): Promise<string | null> {
  if (headerCompanyId?.trim()) return headerCompanyId.trim();
  if (auth.companyId?.trim()) return auth.companyId.trim();

  if (auth.userId.startsWith('company_')) {
    return auth.userId.replace(/^company_/, '');
  }

  const { rows } = await query<{ company_id: string }>(
    'SELECT company_id FROM user_companies WHERE user_id = $1 LIMIT 1',
    [auth.userId],
  );
  return rows[0]?.company_id ?? null;
}
