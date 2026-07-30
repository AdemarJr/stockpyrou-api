import { createHash } from 'node:crypto';
import { query } from '../../../db/pool.js';
import { encryptBytes, encryptSecret } from '../secrets.js';

export interface CertificateStatus {
  present: boolean;
  subjectCn: string | null;
  serialNumber: string | null;
  validFrom: string | null;
  validUntil: string | null;
  fingerprintSha256: string | null;
  expired: boolean;
}

export async function getCertificateStatus(companyId: string): Promise<CertificateStatus> {
  const { rows } = await query(
    `SELECT subject_cn, serial_number, valid_from, valid_until, fingerprint_sha256
     FROM fiscal_certificate WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const row = rows[0] as
    | {
        subject_cn: string | null;
        serial_number: string | null;
        valid_from: Date | string | null;
        valid_until: Date | string | null;
        fingerprint_sha256: string | null;
      }
    | undefined;

  if (!row) {
    return {
      present: false,
      subjectCn: null,
      serialNumber: null,
      validFrom: null,
      validUntil: null,
      fingerprintSha256: null,
      expired: false,
    };
  }

  const validUntil = row.valid_until ? new Date(row.valid_until) : null;
  return {
    present: true,
    subjectCn: row.subject_cn != null ? String(row.subject_cn) : null,
    serialNumber: row.serial_number != null ? String(row.serial_number) : null,
    validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : null,
    validUntil: validUntil ? validUntil.toISOString() : null,
    fingerprintSha256: row.fingerprint_sha256 != null ? String(row.fingerprint_sha256) : null,
    expired: validUntil ? validUntil.getTime() < Date.now() : false,
  };
}

/**
 * Upload A1 (.pfx/.p12) em base64.
 * Metadados de validade são preenchidos quando disponíveis; validação PKCS#12 completa
 * entra na Etapa 2 (node-forge / openssl).
 */
export async function uploadCertificate(params: {
  companyId: string;
  fileBase64: string;
  password: string;
  subjectCn?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}): Promise<CertificateStatus> {
  const password = String(params.password || '');
  if (!password) throw new Error('Senha do certificado é obrigatória');

  const raw = params.fileBase64.includes(',')
    ? params.fileBase64.split(',')[1]
    : params.fileBase64;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('Arquivo do certificado inválido');
  }
  if (buffer.length < 100) throw new Error('Arquivo do certificado muito pequeno');
  if (buffer.length > 5 * 1024 * 1024) throw new Error('Certificado maior que 5MB');

  const encryptedCert = encryptBytes(buffer);
  const encryptedPassword = encryptSecret(password);
  const fingerprint = createHash('sha256').update(buffer).digest('hex');

  const subjectCn = params.subjectCn?.trim() || 'Certificado A1';
  const validFrom = params.validFrom ? new Date(params.validFrom) : null;
  const validUntil = params.validUntil ? new Date(params.validUntil) : null;

  const existing = await getCertificateStatus(params.companyId);

  if (existing.present) {
    await query(
      `UPDATE fiscal_certificate SET
         certificate_encrypted=$1,
         password_encrypted=$2,
         subject_cn=$3,
         serial_number=NULL,
         valid_from=$4,
         valid_until=$5,
         fingerprint_sha256=$6,
         updated_at=now()
       WHERE company_id=$7`,
      [
        encryptedCert,
        encryptedPassword,
        subjectCn,
        validFrom,
        validUntil,
        fingerprint,
        params.companyId,
      ],
    );
  } else {
    await query(
      `INSERT INTO fiscal_certificate (
         company_id, certificate_encrypted, password_encrypted,
         subject_cn, valid_from, valid_until, fingerprint_sha256
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        params.companyId,
        encryptedCert,
        encryptedPassword,
        subjectCn,
        validFrom,
        validUntil,
        fingerprint,
      ],
    );
  }

  return getCertificateStatus(params.companyId);
}

export async function deleteCertificate(companyId: string): Promise<void> {
  await query(`DELETE FROM fiscal_certificate WHERE company_id = $1`, [companyId]);
}
