import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function getMasterKey(): Buffer {
  const raw =
    process.env.FISCAL_SECRETS_KEY?.trim() ||
    process.env.SECRETS_ENCRYPTION_KEY?.trim() ||
    '';
  if (!raw) {
    // Dev fallback — produção DEVE definir FISCAL_SECRETS_KEY
    const fallback = process.env.DATABASE_URL || 'stockpyrou-fiscal-dev-key';
    return createHash('sha256').update(`fiscal:${fallback}`).digest();
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw).digest();
}

/** Criptografa texto sensível (CSC, senha A1). Formato: iv:tag:ciphertext (base64). */
export function encryptSecret(plain: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted secret format');
  }
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Criptografa binário (certificado A1). */
export function encryptBytes(data: Buffer): Buffer {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, enc]);
}

export function decryptBytes(payload: Buffer): Buffer {
  if (payload.length < IV_LEN + 16 + 1) {
    throw new Error('Invalid encrypted bytes');
  }
  const key = getMasterKey();
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + 16);
  const data = payload.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function maskToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}

export function onlyDigits(value: string): string {
  return String(value || '').replace(/\D/g, '');
}
