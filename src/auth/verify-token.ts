import { query } from '../db/pool.js';
import type { AuthContext } from '../types/auth.js';
import { mapAppUserRole } from '../auth/permissions.js';

type KvRow = { value: Record<string, unknown> };

function parseJsonValue(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function kvGet(key: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<KvRow>(
    'SELECT value FROM kv_store_8a20b27d WHERE key = $1 LIMIT 1',
    [key],
  );
  return parseJsonValue(rows[0]?.value);
}

function sessionExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return false;
  const exp = new Date(String(expiresAt));
  return Number.isNaN(exp.getTime()) ? false : new Date() > exp;
}

async function profileFromAppUser(userId: string): Promise<AuthContext | null> {
  const { rows } = await query<{
    id: string;
    email: string;
    full_name: string;
    role: string;
    company_id: string | null;
  }>(
    `SELECT id, email, full_name, role, company_id
     FROM app_users
     WHERE id = $1 AND is_active = true
     LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.id,
    email: row.email,
    fullName: row.full_name,
    role: mapAppUserRole(row.role),
    companyId: row.company_id ?? undefined,
  };
}

async function profileFromKvUser(userId: string): Promise<AuthContext | null> {
  const profile = await kvGet(`user:${userId}`);
  if (!profile) return null;
  return {
    userId: String(profile.id ?? userId),
    email: String(profile.email ?? ''),
    fullName: String(profile.fullName ?? profile.full_name ?? 'Usuário'),
    role: String(profile.role ?? 'user'),
    companyId: profile.companyId != null ? String(profile.companyId) : profile.company_id != null ? String(profile.company_id) : undefined,
  };
}

async function profileFromCompanyUser(userId: string): Promise<AuthContext | null> {
  const companyId = userId.replace(/^company_/, '');
  const company = await kvGet(`company:${companyId}`);
  if (!company) {
    const { rows } = await query<{ id: string; name: string }>(
      'SELECT id, name FROM companies WHERE id = $1 LIMIT 1',
      [companyId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId,
      email: '',
      fullName: `Admin - ${row.name}`,
      role: 'admin',
      companyId: row.id,
    };
  }
  return {
    userId,
    email: String(company.email ?? ''),
    fullName: `Admin - ${String(company.name ?? 'Empresa')}`,
    role: 'admin',
    companyId: String(company.id ?? companyId),
  };
}

/**
 * Verifica token custom_ (mesmo formato da Edge Function / AuthContext).
 * Permite usar a API nova com login existente, sem mudar o fluxo de auth.
 */
export async function verifyRequestToken(token: string | null | undefined): Promise<AuthContext | null> {
  if (!token?.trim()) return null;
  const trimmed = token.trim().replace(/^Bearer\s+/i, '');

  if (!trimmed.startsWith('custom_')) {
    return null;
  }

  const session = await kvGet(`session:${trimmed}`);
  if (!session) return null;

  if (sessionExpired(session.expiresAt)) {
    return null;
  }

  const userId = String(session.userId ?? '');
  if (!userId) return null;

  if (userId.startsWith('company_')) {
    return profileFromCompanyUser(userId);
  }

  const fromKv = await profileFromKvUser(userId);
  if (fromKv) return fromKv;

  return profileFromAppUser(userId);
}
