import { query } from '../../../db/pool.js';
import { encryptSecret, maskToken, onlyDigits } from '../secrets.js';
import {
  normalizeFiscalEnvironment,
  type FiscalEnvironment,
} from '../sefaz/sefaz-endpoints.js';

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
  telefone: string | null;
  email: string | null;
  logo_url: string | null;
  crt: number;
  ambiente: FiscalEnvironment;
  serie_nfce: number;
  numero_nfce: number;
  csc_id: string | null;
  csc_token_encrypted: string | null;
  resp_tec_cnpj?: string | null;
  resp_tec_contato?: string | null;
  resp_tec_email?: string | null;
  resp_tec_fone?: string | null;
  resp_tec_id_csrt?: string | null;
  resp_tec_csrt_encrypted?: string | null;
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
  telefone: string | null;
  email: string | null;
  logoUrl: string | null;
  crt: number;
  ambiente: FiscalEnvironment;
  serieNfce: number;
  numeroNfce: number;
  cscId: string | null;
  hasCscToken: boolean;
  cscTokenMasked: string | null;
  respTecCnpj: string | null;
  respTecContato: string | null;
  respTecEmail: string | null;
  respTecFone: string | null;
  respTecIdCsrt: string | null;
  hasRespTecCsrt: boolean;
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
  telefone?: string | null;
  email?: string | null;
  logoUrl?: string | null;
  crt?: number;
  ambiente?: FiscalEnvironment;
  serieNfce?: number;
  /** Só avança número manualmente com cuidado — emissão reserva automaticamente depois. */
  numeroNfce?: number;
  cscId?: string | null;
  /** Se omitido/null/vazio, mantém o CSC já salvo. */
  cscToken?: string | null;
  /** Responsável técnico (software house) — NT 2018.005 / rejeição 972. */
  respTecCnpj?: string | null;
  respTecContato?: string | null;
  respTecEmail?: string | null;
  respTecFone?: string | null;
  respTecIdCsrt?: string | null;
  /** Se omitido/vazio, mantém o CSRT já salvo. */
  respTecCsrt?: string | null;
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
    telefone: row.telefone != null ? String(row.telefone) : null,
    email: row.email != null ? String(row.email) : null,
    logoUrl: row.logo_url != null ? String(row.logo_url) : null,
    crt: Number(row.crt) || 1,
    ambiente: normalizeFiscalEnvironment(row.ambiente),
    serieNfce: Number(row.serie_nfce) || 1,
    numeroNfce: Number(row.numero_nfce) || 0,
    cscId: row.csc_id != null ? String(row.csc_id) : null,
    hasCscToken: !!row.csc_token_encrypted,
    cscTokenMasked: maskToken(cscPlainHint) ?? (row.csc_token_encrypted ? '********' : null),
    respTecCnpj: row.resp_tec_cnpj != null ? String(row.resp_tec_cnpj) : null,
    respTecContato: row.resp_tec_contato != null ? String(row.resp_tec_contato) : null,
    respTecEmail: row.resp_tec_email != null ? String(row.resp_tec_email) : null,
    respTecFone: row.resp_tec_fone != null ? String(row.resp_tec_fone) : null,
    respTecIdCsrt: row.resp_tec_id_csrt != null ? String(row.resp_tec_id_csrt) : null,
    hasRespTecCsrt: !!row.resp_tec_csrt_encrypted,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

let respTecColumnsReady: boolean | null = null;

async function ensureRespTecColumns(): Promise<boolean> {
  if (respTecColumnsReady === true) return true;
  if (respTecColumnsReady === false) return false;
  try {
    await query(`
      ALTER TABLE public.fiscal_config
        ADD COLUMN IF NOT EXISTS resp_tec_cnpj text NULL,
        ADD COLUMN IF NOT EXISTS resp_tec_contato text NULL,
        ADD COLUMN IF NOT EXISTS resp_tec_email text NULL,
        ADD COLUMN IF NOT EXISTS resp_tec_fone text NULL,
        ADD COLUMN IF NOT EXISTS resp_tec_id_csrt text NULL,
        ADD COLUMN IF NOT EXISTS resp_tec_csrt_encrypted text NULL
    `);
    respTecColumnsReady = true;
    return true;
  } catch (err) {
    respTecColumnsReady = false;
    console.warn(
      '[fiscal] Não foi possível criar colunas resp_tec_*:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function persistRespTec(
  companyId: string,
  input: UpsertFiscalConfigInput,
): Promise<FiscalConfigRow | null> {
  const hasAny =
    input.respTecCnpj !== undefined ||
    input.respTecContato !== undefined ||
    input.respTecEmail !== undefined ||
    input.respTecFone !== undefined ||
    input.respTecIdCsrt !== undefined ||
    (input.respTecCsrt != null && String(input.respTecCsrt).trim() !== '');
  if (!hasAny) return null;

  const csrtEncrypted =
    input.respTecCsrt != null && String(input.respTecCsrt).trim() !== ''
      ? encryptSecret(String(input.respTecCsrt).replace(/\s+/g, '').trim())
      : null;

  const ok = await ensureRespTecColumns();
  if (!ok) {
    throw new Error(
      'Não foi possível gravar o responsável técnico (colunas ausentes no banco). Rode scripts/add_fiscal_resp_tec.sql.',
    );
  }

  const { rows } = await query(
    `UPDATE fiscal_config SET
       resp_tec_cnpj = CASE WHEN $1::boolean THEN $2 ELSE resp_tec_cnpj END,
       resp_tec_contato = CASE WHEN $3::boolean THEN $4 ELSE resp_tec_contato END,
       resp_tec_email = CASE WHEN $5::boolean THEN $6 ELSE resp_tec_email END,
       resp_tec_fone = CASE WHEN $7::boolean THEN $8 ELSE resp_tec_fone END,
       resp_tec_id_csrt = CASE WHEN $9::boolean THEN $10 ELSE resp_tec_id_csrt END,
       resp_tec_csrt_encrypted = COALESCE($11, resp_tec_csrt_encrypted),
       updated_at = now()
     WHERE company_id = $12
     RETURNING *`,
    [
      input.respTecCnpj !== undefined,
      input.respTecCnpj !== undefined
        ? onlyDigits(input.respTecCnpj || '') || null
        : null,
      input.respTecContato !== undefined,
      input.respTecContato !== undefined
        ? String(input.respTecContato || '').trim() || null
        : null,
      input.respTecEmail !== undefined,
      input.respTecEmail !== undefined
        ? String(input.respTecEmail || '').trim() || null
        : null,
      input.respTecFone !== undefined,
      input.respTecFone !== undefined
        ? onlyDigits(input.respTecFone || '') || null
        : null,
      input.respTecIdCsrt !== undefined,
      input.respTecIdCsrt !== undefined
        ? onlyDigits(input.respTecIdCsrt || '').slice(0, 2) || null
        : null,
      csrtEncrypted,
      companyId,
    ],
  );
  return (rows[0] as FiscalConfigRow) ?? null;
}

export async function getFiscalConfig(companyId: string): Promise<FiscalConfigPublic | null> {
  await ensureRespTecColumns();
  const { rows } = await query(
    `SELECT * FROM fiscal_config WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  if (!rows[0]) return null;
  return mapPublic(rows[0] as FiscalConfigRow);
}

export async function getFiscalConfigRow(companyId: string): Promise<FiscalConfigRow | null> {
  await ensureRespTecColumns();
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

  const ambiente = normalizeFiscalEnvironment(input.ambiente);

  const crt = [1, 2, 3].includes(Number(input.crt)) ? Number(input.crt) : 1;
  const serie = Math.max(1, Number(input.serieNfce) || 1);
  const numero = Math.max(0, Number(input.numeroNfce) || 0);
  const uf = (input.uf || 'AM').toUpperCase().slice(0, 2);

  let cscEncrypted = existing?.csc_token_encrypted ?? null;
  let cscPlainHint: string | null = null;
  if (input.cscToken != null && String(input.cscToken).trim() !== '') {
    // Remove espaços/quebras colados do portal (causa comum da rejeição 464)
    cscPlainHint = String(input.cscToken).replace(/\s+/g, '').trim();
    cscEncrypted = encryptSecret(cscPlainHint);
  }

  const cscId =
    input.cscId !== undefined
      ? input.cscId?.replace(/\D/g, '') || null
      : existing?.csc_id ?? null;
  const enabled = input.enabled !== undefined ? !!input.enabled : existing?.enabled ?? false;

  const telefone =
    input.telefone !== undefined
      ? input.telefone?.trim() || null
      : existing?.telefone ?? null;
  const email =
    input.email !== undefined ? input.email?.trim() || null : existing?.email ?? null;
  const logoUrl =
    input.logoUrl !== undefined
      ? input.logoUrl?.trim() || null
      : existing?.logo_url ?? null;

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
    telefone,
    email,
    logoUrl,
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
    try {
      const { rows } = await query(
        `UPDATE fiscal_config SET
           cnpj=$1, ie=$2, razao_social=$3, nome_fantasia=$4,
           logradouro=$5, numero=$6, complemento=$7, bairro=$8, municipio=$9,
           codigo_municipio=$10, uf=$11, cep=$12,
           telefone=$13, email=$14, logo_url=$15,
           crt=$16, ambiente=$17,
           serie_nfce=$18, numero_nfce=$19, csc_id=$20,
           csc_token_encrypted=COALESCE($21, csc_token_encrypted),
           enabled=$22, updated_at=now()
         WHERE company_id=$23
         RETURNING *`,
        params,
      );
      const updated = await persistRespTec(companyId, input);
      return mapPublic((updated ?? rows[0]) as FiscalConfigRow, cscPlainHint);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/telefone|logo_url|column/i.test(msg)) throw err;
      // Colunas novas ainda não migradas
      const legacy = [
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
        legacy,
      );
      const updated = await persistRespTec(companyId, input);
      return mapPublic((updated ?? rows[0]) as FiscalConfigRow, cscPlainHint);
    }
  }

  try {
    const { rows } = await query(
      `INSERT INTO fiscal_config (
         company_id, cnpj, ie, razao_social, nome_fantasia,
         logradouro, numero, complemento, bairro, municipio, codigo_municipio,
         uf, cep, telefone, email, logo_url, crt, ambiente, serie_nfce, numero_nfce,
         csc_id, csc_token_encrypted, enabled
       ) VALUES (
         $23,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
       ) RETURNING *`,
      params,
    );
    const updated = await persistRespTec(companyId, input);
    return mapPublic((updated ?? rows[0]) as FiscalConfigRow, cscPlainHint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/telefone|logo_url|column/i.test(msg)) throw err;
    const legacy = [
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
    const { rows } = await query(
      `INSERT INTO fiscal_config (
         company_id, cnpj, ie, razao_social, nome_fantasia,
         logradouro, numero, complemento, bairro, municipio, codigo_municipio,
         uf, cep, crt, ambiente, serie_nfce, numero_nfce,
         csc_id, csc_token_encrypted, enabled
       ) VALUES (
         $20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       ) RETURNING *`,
      legacy,
    );
    const updated = await persistRespTec(companyId, input);
    return mapPublic((updated ?? rows[0]) as FiscalConfigRow, cscPlainHint);
  }
}

export interface FiscalReadiness {
  /** Módulo ligado em Integrações — libera opção NFC-e no PDV. */
  moduleEnabled: boolean;
  /** Dados + CSC + certificado completos (para emissão real). */
  configComplete: boolean;
  /** Alias UX: pode selecionar NFC-e no checkout (= moduleEnabled). */
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
  const moduleEnabled = !!config?.enabled;

  if (!config) {
    reasons.push('Configure os dados fiscais da empresa');
  } else {
    if (!config.enabled) reasons.push('Módulo fiscal desabilitado — ative em Integrações → Fiscal');
    if (!config.cnpj || config.cnpj.length !== 14) reasons.push('CNPJ inválido');
    if (!config.ie) reasons.push('Inscrição Estadual ausente');
    if (!config.razaoSocial) reasons.push('Razão social ausente');
    if (!config.logradouro || !config.municipio || !config.codigoMunicipio) {
      reasons.push('Endereço fiscal incompleto');
    }
    if (!config.cscId || !config.hasCscToken) {
      reasons.push('CSC (token NFC-e) não configurado');
    }
    const respTecCnpj =
      onlyDigits(config.respTecCnpj || process.env.RESP_TEC_CNPJ || '');
    const respTecOk =
      respTecCnpj.length === 14 &&
      !!(config.respTecContato || process.env.RESP_TEC_CONTATO) &&
      !!(config.respTecEmail || process.env.RESP_TEC_EMAIL) &&
      onlyDigits(config.respTecFone || process.env.RESP_TEC_FONE || '').length >= 6;
    if (!respTecOk) {
      reasons.push('Responsável técnico incompleto (obrigatório na SEFAZ-AM — rejeição 972)');
    }
  }

  const validUntil = cert?.valid_until ? new Date(cert.valid_until) : null;
  const expired = validUntil ? validUntil.getTime() < Date.now() : false;
  if (!cert) {
    reasons.push('Certificado digital A1 não cadastrado');
  } else if (expired) {
    reasons.push('Certificado digital expirado');
  }

  /** Completo = sem pendências além do próprio “desabilitado”. */
  const configComplete =
    !!config &&
    reasons.every((r) => r.startsWith('Módulo fiscal desabilitado'));

  /**
   * PDV: com o módulo ativado o operador já pode escolher NFC-e.
   * Pendências de cadastro aparecem como aviso (configComplete).
   */
  const ready = moduleEnabled;
  /** Pronto para autorizar na SEFAZ (cert + CSC + dados cadastrais). */
  const emissionAvailable = configComplete && moduleEnabled && !!cert && !expired;

  return {
    moduleEnabled,
    configComplete: configComplete && moduleEnabled,
    ready,
    emissionAvailable,
    reasons: moduleEnabled
      ? reasons.filter((r) => !r.startsWith('Módulo fiscal desabilitado'))
      : reasons,
    config,
    certificate: {
      present: !!cert,
      subjectCn: cert?.subject_cn != null ? String(cert.subject_cn) : null,
      validUntil: validUntil ? validUntil.toISOString() : null,
      expired,
    },
  };
}
