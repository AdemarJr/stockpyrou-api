import { query } from '../../../db/pool.js';
import { encryptSecret, maskToken, onlyDigits } from '../secrets.js';
import type { FiscalEnvironment } from '../sefaz/sefaz-endpoints.js';

export interface FiscalConfigRow {
  id: string;
  company_id: string;
  cnpj: string;
  ie: string;
  razao_social: string;
  nome_fantasia: string | null;
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  municipio: string;
  codigo_municipio: string;
  uf: string;
  cep: string;
  crt: number;
  ambiente: FiscalEnvironment;
  serie_nfce: number;
  numero_nfce: number;
  csc_id: string | null;
  csc_token_encrypted: string | null;
  enabled: boolean;
  created_at: unknown;
  updated_at: unknown;
}

export interface FiscalConfigPublic {
  id: string;
  companyId: string;
  cnpj: string;
  ie: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  municipio: string;
  codigoMunicipio: string;
  uf: string;
  cep: string;
  crt: number;
  ambiente: FiscalEnvironment;
  serieNfce: number;
  numeroNfce: number;
  cscId: string | null;
  hasCscToken: boolean;
  cscTokenMasked: string | null;
  enabled: boolean;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface UpsertFiscalConfigInput {
  cnpj: string;
  ie: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  logradouro: string;
  numero: string;
  complemento?: string | null;
  bairro: string;
  municipio: string;
  codigoMunicipio: string;
  uf?: string;
  cep: string;
  crt?: number;
  ambiente?: FiscalEnvironment;
  serieNfce?: number;
  /** Só avança número manualmente com cuidado — emissão reserva automaticamente depois. */
  numeroNfce?: number;
  cscId?: string | null;
  /** Se omitido/null/vazio, mantém o CSC já salvo. */
  cscToken?: string | null;
  enabled?: boolean;
}

function mapPublic(row: FiscalConfigRow, cscPlainHint?: string | null): FiscalConfigPublic {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    cnpj: String(row.cnpj),
    ie: String(row.ie),
    razaoSocial: String(row.razao_social),
    nomeFantasia: row.nome_fantasia != null ? String(row.nome_fantasia) : null,
    logradouro: String(row.logradouro || ''),
    numero: String(row.numero || ''),
    complemento: row.complemento != null ? String(row.complemento) : null,
    bairro: String(row.bairro || ''),
    municipio: String(row.municipio || ''),
    codigoMunicipio: String(row.codigo_municipio || ''),
    uf: String(row.uf || 'AM'),
    cep: String(row.cep || ''),
    crt: Number(row.crt) || 1,
    ambiente: (row.ambiente as FiscalEnvironment) || 'homologation',
    serieNfce: Number(row.serie_nfce) || 1,
    numeroNfce: Number(row.numero_nfce) || 0,
    cscId: row.csc_id != null ? String(row.csc_id) : null,
    hasCscToken: !!row.csc_token_encrypted,
    cscTokenMasked: maskToken(cscPlainHint) ?? (row.csc_token_encrypted ? '********' : null),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getFiscalConfig(companyId: string): Promise<FiscalConfigPublic | null> {
  const { rows } = await query(
    `SELECT * FROM fiscal_config WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  if (!rows[0]) return null;
  return mapPublic(rows[0] as FiscalConfigRow);
}

export async function getFiscalConfigRow(companyId: string): Promise<FiscalConfigRow | null> {
  const { rows } = await query(
    `SELECT * FROM fiscal_config WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  return (rows[0] as FiscalConfigRow) ?? null;
}

export async function saveFiscalConfig(
  companyId: string,
  input: UpsertFiscalConfigInput,
): Promise<FiscalConfigPublic> {
  const existing = await getFiscalConfigRow(companyId);
  const cnpj = onlyDigits(input.cnpj);
  if (cnpj.length !== 14) throw new Error('CNPJ inválido (14 dígitos)');
  const ie = String(input.ie || '').trim();
  if (!ie) throw new Error('Inscrição Estadual é obrigatória');
  const razaoSocial = String(input.razaoSocial || '').trim();
  if (!razaoSocial) throw new Error('Razão social é obrigatória');

  const ambiente: FiscalEnvironment =
    input.ambiente === 'production' ||
    input.ambiente === 'development' ||
    input.ambiente === 'homologation'
      ? input.ambiente
      : 'homologation';

  const crt = [1, 2, 3].includes(Number(input.crt)) ? Number(input.crt) : 1;
  const serie = Math.max(1, Number(input.serieNfce) || 1);
  const numero = Math.max(0, Number(input.numeroNfce) || 0);
  const uf = (input.uf || 'AM').toUpperCase().slice(0, 2);

  let cscEncrypted = existing?.csc_token_encrypted ?? null;
  let cscPlainHint: string | null = null;
  if (input.cscToken != null && String(input.cscToken).trim() !== '') {
    cscPlainHint = String(input.cscToken).trim();
    cscEncrypted = encryptSecret(cscPlainHint);
  }

  const cscId =
    input.cscId !== undefined ? input.cscId?.trim() || null : existing?.csc_id ?? null;
  const enabled = input.enabled !== undefined ? !!input.enabled : existing?.enabled ?? false;

  const params = [
    cnpj,
    ie,
    razaoSocial,
    input.nomeFantasia?.trim() || null,
    String(input.logradouro || '').trim(),
    String(input.numero || '').trim(),
    input.complemento?.trim() || null,
    String(input.bairro || '').trim(),
    String(input.municipio || '').trim(),
    onlyDigits(input.codigoMunicipio || ''),
    uf,
    onlyDigits(input.cep || ''),
    crt,
    ambiente,
    serie,
    numero,
    cscId,
    cscEncrypted,
    enabled,
    companyId,
  ];

  if (existing) {
    const { rows } = await query(
      `UPDATE fiscal_config SET
         cnpj=$1, ie=$2, razao_social=$3, nome_fantasia=$4,
         logradouro=$5, numero=$6, complemento=$7, bairro=$8, municipio=$9,
         codigo_municipio=$10, uf=$11, cep=$12, crt=$13, ambiente=$14,
         serie_nfce=$15, numero_nfce=$16, csc_id=$17,
         csc_token_encrypted=COALESCE($18, csc_token_encrypted),
         enabled=$19, updated_at=now()
       WHERE company_id=$20
       RETURNING *`,
      params,
    );
    return mapPublic(rows[0] as FiscalConfigRow, cscPlainHint);
  }

  const { rows } = await query(
    `INSERT INTO fiscal_config (
       company_id, cnpj, ie, razao_social, nome_fantasia,
       logradouro, numero, complemento, bairro, municipio, codigo_municipio,
       uf, cep, crt, ambiente, serie_nfce, numero_nfce,
       csc_id, csc_token_encrypted, enabled
     ) VALUES (
       $20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     ) RETURNING *`,
    params,
  );
  return mapPublic(rows[0] as FiscalConfigRow, cscPlainHint);
}

export interface FiscalReadiness {
  ready: boolean;
  emissionAvailable: boolean;
  reasons: string[];
  config: FiscalConfigPublic | null;
  certificate: {
    present: boolean;
    subjectCn: string | null;
    validUntil: string | null;
    expired: boolean;
  };
}

export async function getFiscalReadiness(companyId: string): Promise<FiscalReadiness> {
  const config = await getFiscalConfig(companyId);
  const { rows: certRows } = await query(
    `SELECT subject_cn, valid_until FROM fiscal_certificate WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const cert = certRows[0] as
    | { subject_cn: string | null; valid_until: Date | string | null }
    | undefined;

  const reasons: string[] = [];
  if (!config) {
    reasons.push('Configure os dados fiscais da empresa');
  } else {
    if (!config.enabled) reasons.push('Módulo fiscal desabilitado');
    if (!config.cnpj || config.cnpj.length !== 14) reasons.push('CNPJ inválido');
    if (!config.ie) reasons.push('Inscrição Estadual ausente');
    if (!config.razaoSocial) reasons.push('Razão social ausente');
    if (!config.logradouro || !config.municipio || !config.codigoMunicipio) {
      reasons.push('Endereço fiscal incompleto');
    }
    if (!config.cscId || !config.hasCscToken) {
      reasons.push('CSC (token NFC-e) não configurado');
    }
  }

  const validUntil = cert?.valid_until ? new Date(cert.valid_until) : null;
  const expired = validUntil ? validUntil.getTime() < Date.now() : false;
  if (!cert) {
    reasons.push('Certificado digital A1 não cadastrado');
  } else if (expired) {
    reasons.push('Certificado digital expirado');
  }

  /** Config + certificado OK — PDV pode marcar “Emitir NFC-e”. */
  const ready = reasons.length === 0;
  /**
   * SOAP/autorização SEFAZ ainda não liberado (etapas 4–6).
   * Produção permanece bloqueada até homologação.
   */
  const emissionAvailable = false;

  return {
    ready,
    emissionAvailable,
    reasons,
    config,
    certificate: {
      present: !!cert,
      subjectCn: cert?.subject_cn != null ? String(cert.subject_cn) : null,
      validUntil: validUntil ? validUntil.toISOString() : null,
      expired,
    },
  };
}
