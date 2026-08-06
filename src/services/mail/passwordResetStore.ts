import { createHash, randomBytes } from 'node:crypto';
import { kvDel, kvGet, kvSet } from '../../db/kv.js';
import { passwordResetTtlMinutes } from './notify.js';

export type PasswordResetRecord = {
  userId: string;
  email: string;
  expiresAt: string;
  createdAt: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function resetKey(tokenHash: string): string {
  return `password_reset:${tokenHash}`;
}

function rateKey(email: string): string {
  return `password_reset_rate:${email.trim().toLowerCase()}`;
}

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('hex');
}

export async function storePasswordResetToken(params: {
  token: string;
  userId: string;
  email: string;
}): Promise<void> {
  const ttlMin = passwordResetTtlMinutes();
  const now = Date.now();
  const record: PasswordResetRecord = {
    userId: params.userId,
    email: params.email.trim().toLowerCase(),
    expiresAt: new Date(now + ttlMin * 60_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  };
  await kvSet(resetKey(hashToken(params.token)), record);
}

export async function consumePasswordResetToken(
  token: string,
): Promise<PasswordResetRecord | null> {
  const key = resetKey(hashToken(token));
  const raw = await kvGet(key);
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as PasswordResetRecord;
  await kvDel(key);
  if (!record.userId || !record.email || !record.expiresAt) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  return record;
}

/** Rate limit: 1 pedido por e-mail por minuto. true = permitido. */
export async function allowPasswordResetRequest(email: string): Promise<boolean> {
  const key = rateKey(email);
  const existing = await kvGet(key);
  if (existing) {
    const ts =
      typeof existing === 'object' && existing != null && 'at' in existing
        ? Number((existing as { at?: unknown }).at)
        : Number(existing);
    if (Number.isFinite(ts) && Date.now() - ts < 60_000) return false;
  }
  await kvSet(key, { at: Date.now() });
  return true;
}
