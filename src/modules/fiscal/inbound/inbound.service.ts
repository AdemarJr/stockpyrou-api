import { query } from '../../../db/pool.js';
import { getFiscalConfigRow } from '../config/fiscal-config.service.js';
import { loadCompanyCertificate, signXmlEnveloped } from '../certificate/xml-signer.js';
import { formatNFeDate, onlyDigits, UF_IBGE } from '../nfce/nfce-utils.js';
import {
  normalizeFiscalEnvironment,
  type FiscalEnvironment,
} from '../sefaz/sefaz-endpoints.js';
import { SefazDfeClient } from './dfe-client.js';
import { parseNfeXml, parseResNfeXml, type ParsedNfeItem } from './nfe-xml-parse.js';

function padNsu(v: string | number | null | undefined) {
  return String(v ?? '0').replace(/\D/g, '').padStart(15, '0');
}

function nsuColumnForEnv(env: FiscalEnvironment): string {
  return env === 'production' ? 'ult_nsu_dfe_production' : 'ult_nsu_dfe_homologation';
}

async function getUltNsu(companyId: string, env: FiscalEnvironment): Promise<string> {
  const col = nsuColumnForEnv(env);
  try {
    const { rows } = await query(
      `SELECT ult_nsu_dfe_homologation, ult_nsu_dfe_production, ult_nsu_dfe
       FROM fiscal_config WHERE company_id = $1 LIMIT 1`,
      [companyId],
    );
    const row = (rows[0] || {}) as Record<string, string | undefined>;
    const perEnv = row[col];
    if (perEnv != null && String(perEnv).trim() !== '') return padNsu(perEnv);
    return padNsu(row.ult_nsu_dfe);
  } catch {
    try {
      const { rows } = await query(
        `SELECT ult_nsu_dfe FROM fiscal_config WHERE company_id = $1 LIMIT 1`,
        [companyId],
      );
      return padNsu((rows[0] as { ult_nsu_dfe?: string } | undefined)?.ult_nsu_dfe);
    } catch {
      return '000000000000000';
    }
  }
}

async function setUltNsu(companyId: string, env: FiscalEnvironment, nsu: string) {
  const padded = padNsu(nsu);
  const col = nsuColumnForEnv(env);
  try {
    await query(
      `UPDATE fiscal_config SET ${col} = $1, ult_nsu_dfe = $1, updated_at = now()
       WHERE company_id = $2`,
      [padded, companyId],
    );
  } catch (err) {
    try {
      await query(
        `UPDATE fiscal_config SET ult_nsu_dfe = $1, updated_at = now() WHERE company_id = $2`,
        [padded, companyId],
      );
    } catch (err2) {
      console.warn(
        '[inbound] falha ao gravar NSU — rode scripts/add_nfe_inbound_dfe.sql e add_fiscal_dual_environment.sql',
        err2 || err,
      );
    }
  }
}

function mapInbound(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    chaveAcesso: String(row.chave_acesso),
    nsu: row.nsu != null ? String(row.nsu) : null,
    schemaType: row.schema_type != null ? String(row.schema_type) : null,
    numero: row.numero != null ? Number(row.numero) : null,
    serie: row.serie != null ? Number(row.serie) : null,
    modelo: row.modelo != null ? String(row.modelo) : '55',
    emitCnpj: row.emit_cnpj != null ? String(row.emit_cnpj) : null,
    emitNome: row.emit_nome != null ? String(row.emit_nome) : null,
    destCnpj: row.dest_cnpj != null ? String(row.dest_cnpj) : null,
    dataEmissao: row.data_emissao,
    valorTotal: Number(row.valor_total || 0),
    status: String(row.status),
    ambiente: normalizeFiscalEnvironment(row.ambiente ?? 'homologation'),
    manifestStatus: row.manifest_status != null ? String(row.manifest_status) : null,
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    hasFullXml: !!row.xml_completo,
    itemCount: Array.isArray(row.items_json) ? row.items_json.length : null,
    importedAt: row.imported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function upsertInbound(params: {
  companyId: string;
  chave: string;
  ambiente: FiscalEnvironment;
  nsu?: string | null;
  schemaType?: string | null;
  xmlResumo?: string | null;
  xmlCompleto?: string | null;
}) {
  const fullParsed = params.xmlCompleto ? parseNfeXml(params.xmlCompleto) : null;
  const resumoParsed =
    !fullParsed && params.xmlResumo ? parseResNfeXml(params.xmlResumo) : null;
  const meta = fullParsed || resumoParsed;
  if (!meta?.chaveAcesso && !params.chave) return null;

  const chave = onlyDigits(params.chave || meta!.chaveAcesso).slice(0, 44);
  const status = fullParsed && fullParsed.items.length > 0 ? 'READY' : 'PENDING';
  const itemsJson = fullParsed?.items ?? null;
  const ambiente = normalizeFiscalEnvironment(params.ambiente);

  const baseParams = [
    params.companyId,
    chave,
    params.nsu ? padNsu(params.nsu) : null,
    params.schemaType ?? null,
    fullParsed?.numero ?? null,
    fullParsed?.serie ?? null,
    fullParsed?.modelo ?? '55',
    fullParsed?.emitCnpj || resumoParsed?.emitCnpj || null,
    fullParsed?.emitNome || resumoParsed?.emitNome || null,
    fullParsed?.destCnpj || null,
    fullParsed?.dataEmissao || resumoParsed?.dataEmissao || null,
    fullParsed?.valorTotal ?? resumoParsed?.valorTotal ?? 0,
    params.xmlResumo ?? null,
    params.xmlCompleto ?? null,
    itemsJson ? JSON.stringify(itemsJson) : null,
    status,
  ];

  try {
    const { rows } = await query(
      `INSERT INTO nfe_inbound (
         company_id, chave_acesso, nsu, schema_type, numero, serie, modelo,
         emit_cnpj, emit_nome, dest_cnpj, data_emissao, valor_total,
         xml_resumo, xml_completo, items_json, status, ambiente, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,now()
       )
       ON CONFLICT (company_id, chave_acesso) DO UPDATE SET
         nsu = COALESCE(EXCLUDED.nsu, nfe_inbound.nsu),
         schema_type = COALESCE(EXCLUDED.schema_type, nfe_inbound.schema_type),
         numero = COALESCE(EXCLUDED.numero, nfe_inbound.numero),
         serie = COALESCE(EXCLUDED.serie, nfe_inbound.serie),
         emit_cnpj = COALESCE(EXCLUDED.emit_cnpj, nfe_inbound.emit_cnpj),
         emit_nome = COALESCE(EXCLUDED.emit_nome, nfe_inbound.emit_nome),
         dest_cnpj = COALESCE(EXCLUDED.dest_cnpj, nfe_inbound.dest_cnpj),
         data_emissao = COALESCE(EXCLUDED.data_emissao, nfe_inbound.data_emissao),
         valor_total = COALESCE(NULLIF(EXCLUDED.valor_total, 0), nfe_inbound.valor_total),
         xml_resumo = COALESCE(EXCLUDED.xml_resumo, nfe_inbound.xml_resumo),
         xml_completo = COALESCE(EXCLUDED.xml_completo, nfe_inbound.xml_completo),
         items_json = COALESCE(EXCLUDED.items_json, nfe_inbound.items_json),
         ambiente = COALESCE(EXCLUDED.ambiente, nfe_inbound.ambiente),
         status = CASE
           WHEN nfe_inbound.status = 'IMPORTED' THEN nfe_inbound.status
           WHEN EXCLUDED.xml_completo IS NOT NULL THEN 'READY'
           ELSE nfe_inbound.status
         END,
         updated_at = now()
       RETURNING *`,
      [...baseParams, ambiente],
    );
    return rows[0] ? mapInbound(rows[0] as Record<string, unknown>) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/ambiente|column/i.test(msg)) throw err;
    // Coluna ambiente ainda não migrada
    const { rows } = await query(
      `INSERT INTO nfe_inbound (
         company_id, chave_acesso, nsu, schema_type, numero, serie, modelo,
         emit_cnpj, emit_nome, dest_cnpj, data_emissao, valor_total,
         xml_resumo, xml_completo, items_json, status, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,now()
       )
       ON CONFLICT (company_id, chave_acesso) DO UPDATE SET
         nsu = COALESCE(EXCLUDED.nsu, nfe_inbound.nsu),
         schema_type = COALESCE(EXCLUDED.schema_type, nfe_inbound.schema_type),
         numero = COALESCE(EXCLUDED.numero, nfe_inbound.numero),
         serie = COALESCE(EXCLUDED.serie, nfe_inbound.serie),
         emit_cnpj = COALESCE(EXCLUDED.emit_cnpj, nfe_inbound.emit_cnpj),
         emit_nome = COALESCE(EXCLUDED.emit_nome, nfe_inbound.emit_nome),
         dest_cnpj = COALESCE(EXCLUDED.dest_cnpj, nfe_inbound.dest_cnpj),
         data_emissao = COALESCE(EXCLUDED.data_emissao, nfe_inbound.data_emissao),
         valor_total = COALESCE(NULLIF(EXCLUDED.valor_total, 0), nfe_inbound.valor_total),
         xml_resumo = COALESCE(EXCLUDED.xml_resumo, nfe_inbound.xml_resumo),
         xml_completo = COALESCE(EXCLUDED.xml_completo, nfe_inbound.xml_completo),
         items_json = COALESCE(EXCLUDED.items_json, nfe_inbound.items_json),
         status = CASE
           WHEN nfe_inbound.status = 'IMPORTED' THEN nfe_inbound.status
           WHEN EXCLUDED.xml_completo IS NOT NULL THEN 'READY'
           ELSE nfe_inbound.status
         END,
         updated_at = now()
       RETURNING *`,
      baseParams,
    );
    return rows[0] ? mapInbound(rows[0] as Record<string, unknown>) : null;
  }
}

async function sendCienciaOperacao(companyId: string, chave: string, env: FiscalEnvironment) {
  const config = await getFiscalConfigRow(companyId);
  if (!config) throw new Error('Configuração fiscal ausente');
  const tpA = env === 'production' ? '1' : '2';
  const nSeq = 1;
  const dhEvento = formatNFeDate(new Date());
  const id = `ID210210${chave}${String(nSeq).padStart(2, '0')}`;

  const infEvento =
    `<infEvento Id="${id}">` +
    `<cOrgao>91</cOrgao>` +
    `<tpAmb>${tpA}</tpAmb>` +
    `<CNPJ>${onlyDigits(config.cnpj)}</CNPJ>` +
    `<chNFe>${chave}</chNFe>` +
    `<dhEvento>${dhEvento}</dhEvento>` +
    `<tpEvento>210210</tpEvento>` +
    `<nSeqEvento>${nSeq}</nSeqEvento>` +
    `<verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00">` +
    `<descEvento>Ciencia da Operacao</descEvento>` +
    `</detEvento></infEvento>`;

  const eventoXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${infEvento}</evento>`;

  const cert = await loadCompanyCertificate(companyId);
  const signed = signXmlEnveloped(eventoXml, id, cert);
  const client = new SefazDfeClient(companyId, env);
  const res = await client.sendEventAn(signed);
  await query(
    `UPDATE nfe_inbound SET manifest_status = $1, updated_at = now()
     WHERE company_id = $2 AND chave_acesso = $3`,
    [`${res.cStat}:${res.xMotivo}`.slice(0, 240), companyId, chave],
  );
  return res;
}

async function downloadFullXml(companyId: string, chave: string, env: FiscalEnvironment) {
  const config = await getFiscalConfigRow(companyId);
  if (!config) return null;
  const client = new SefazDfeClient(companyId, env);
  const dist = await client.distByChave(onlyDigits(config.cnpj), chave);
  for (const doc of dist.documents) {
    if (/procNFe|nfeProc|NFe/i.test(doc.schema) || doc.xml.includes('<infNFe')) {
      await upsertInbound({
        companyId,
        chave,
        ambiente: env,
        nsu: doc.nsu,
        schemaType: doc.schema,
        xmlCompleto: doc.xml,
      });
      return true;
    }
  }
  return false;
}

/**
 * Sincroniza NF-e destinadas à empresa via NFeDistribuicaoDFe.
 * Mantém o NSU e tenta baixar XML completo (ciência + consChNFe) quando só há resumo.
 */
export async function syncInboundNfe(companyId: string, opts?: { maxLoops?: number }) {
  const config = await getFiscalConfigRow(companyId);
  if (!config) {
    throw new Error('Configure os dados fiscais (CNPJ) em Configurações → Empresa');
  }
  const cnpj = onlyDigits(config.cnpj);
  if (cnpj.length !== 14) throw new Error('CNPJ fiscal inválido');

  // Certificado obrigatório
  await loadCompanyCertificate(companyId);

  const env = normalizeFiscalEnvironment(config.ambiente);
  const client = new SefazDfeClient(companyId, env);
  const maxLoops = Math.min(opts?.maxLoops ?? 8, 20);

  let ult = await getUltNsu(companyId, env);
  let newDocs = 0;
  let loops = 0;
  const messages: string[] = [];
  const cUF = UF_IBGE[(config.uf || 'AM').toUpperCase()] || '13';
  const envLabel = env === 'production' ? 'Produção' : 'Homologação';
  messages.push(
    `Ambiente ativo: ${envLabel} · CNPJ ${cnpj} · UF ${config.uf || 'AM'} (${cUF}) · NSU ${ult}`,
  );
  messages.push(
    env === 'production'
      ? 'DF-e em Produção (Ambiente Nacional): notas reais destinadas ao CNPJ.'
      : 'DF-e em Homologação (Ambiente Nacional): documentos de teste da SEFAZ hom. Notas reais de fornecedores exigem Produção.',
  );

  while (loops < maxLoops) {
    loops += 1;
    const dist = await client.distByUltNsu(cnpj, ult, cUF);
    messages.push(
      `${dist.cStat} — ${dist.xMotivo} (ultNSU ${dist.ultNSU} / max ${dist.maxNSU}, ${dist.documents.length} docZip)`,
    );

    if (dist.cStat === '656') {
      throw new Error(
        'SEFAZ: consumo indevido (656). Aguarde cerca de 1 hora antes de sincronizar novamente.',
      );
    }

    // 137 = nenhum documento localizado (fim normal)
    if (dist.cStat === '137') {
      break;
    }

    // Qualquer outro código que não seja 138 é rejeição — não engolir em silêncio
    if (dist.cStat !== '138') {
      throw new Error(`SEFAZ DF-e: ${dist.cStat} — ${dist.xMotivo || 'rejeição'}`);
    }

    let upsertedThisLoop = 0;
    for (const doc of dist.documents) {
      const isFull = /procNFe|nfeProc/i.test(doc.schema) || doc.xml.includes('<infNFe');
      const isResumo = /resNFe/i.test(doc.schema) || doc.xml.includes('<resNFe');
      let chave = '';
      if (isFull) {
        const p = parseNfeXml(doc.xml);
        chave = p?.chaveAcesso || '';
        if (chave) {
          await upsertInbound({
            companyId,
            chave,
            ambiente: env,
            nsu: doc.nsu,
            schemaType: doc.schema,
            xmlCompleto: doc.xml,
          });
          newDocs += 1;
          upsertedThisLoop += 1;
        }
      } else if (isResumo) {
        const p = parseResNfeXml(doc.xml);
        chave = p?.chaveAcesso || '';
        if (chave) {
          await upsertInbound({
            companyId,
            chave,
            ambiente: env,
            nsu: doc.nsu,
            schemaType: doc.schema,
            xmlResumo: doc.xml,
          });
          newDocs += 1;
          upsertedThisLoop += 1;
        }
      } else {
        // Outros schemas (eventos etc.) — ignora para estoque
        const m = doc.xml.match(/<chNFe>(\d{44})<\/chNFe>/i);
        if (m) {
          await upsertInbound({
            companyId,
            chave: m[1],
            ambiente: env,
            nsu: doc.nsu,
            schemaType: doc.schema,
            xmlResumo: doc.xml,
          });
          upsertedThisLoop += 1;
        }
      }
    }

    if (dist.documents.length > 0 && upsertedThisLoop === 0) {
      messages.push(
        `Aviso: ${dist.documents.length} docZip recebidos mas nenhum XML de NF-e foi gravado (schema/parse).`,
      );
    }

    const nextUlt = padNsu(dist.ultNSU);
    if (nextUlt !== ult) {
      ult = nextUlt;
      await setUltNsu(companyId, env, ult);
    }

    if (padNsu(dist.ultNSU) >= padNsu(dist.maxNSU)) break;
    // Pausa leve entre loops
    await new Promise((r) => setTimeout(r, 400));
  }

  // Para notas só com resumo: ciência + download XML (mesmo ambiente)
  let pending: { rows: unknown[] };
  try {
    pending = await query(
      `SELECT id, chave_acesso FROM nfe_inbound
       WHERE company_id = $1 AND status = 'PENDING' AND xml_completo IS NULL
         AND ambiente = $2
       ORDER BY created_at DESC LIMIT 15`,
      [companyId, env],
    );
  } catch {
    pending = await query(
      `SELECT id, chave_acesso FROM nfe_inbound
       WHERE company_id = $1 AND status = 'PENDING' AND xml_completo IS NULL
       ORDER BY created_at DESC LIMIT 15`,
      [companyId],
    );
  }
  const pendingRows = pending.rows;

  let downloaded = 0;
  for (const row of pendingRows) {
    const chave = String((row as { chave_acesso: string }).chave_acesso);
    try {
      await sendCienciaOperacao(companyId, chave, env);
      await new Promise((r) => setTimeout(r, 500));
      const ok = await downloadFullXml(companyId, chave, env);
      if (ok) downloaded += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE nfe_inbound SET error_message = $1, updated_at = now()
         WHERE company_id = $2 AND chave_acesso = $3`,
        [msg.slice(0, 500), companyId, chave],
      );
    }
  }

  const list = await listInboundNfe(companyId, { limit: 50, ambiente: env });
  return {
    ultNsu: ult,
    newDocuments: newDocs,
    downloadedFullXml: downloaded,
    messages,
    notes: list,
    environment: env,
    cnpj,
    uf: config.uf || 'AM',
  };
}

/** Reinicia o ponteiro NSU do ambiente fiscal ativo (homologação ou produção). */
export async function resetInboundNsu(companyId: string) {
  const config = await getFiscalConfigRow(companyId);
  const env = normalizeFiscalEnvironment(config?.ambiente);
  await setUltNsu(companyId, env, '0');
  return {
    ultNsu: padNsu('0'),
    environment: env,
  };
}

export async function listInboundNfe(
  companyId: string,
  opts?: { status?: string; limit?: number; ambiente?: FiscalEnvironment },
) {
  const limit = Math.min(opts?.limit ?? 50, 200);
  let ambiente = opts?.ambiente;
  if (!ambiente) {
    const config = await getFiscalConfigRow(companyId);
    ambiente = normalizeFiscalEnvironment(config?.ambiente);
  }

  const params: unknown[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (opts?.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }

  try {
    params.push(ambiente);
    where += ` AND ambiente = $${params.length}`;
    params.push(limit);
    const { rows } = await query(
      `SELECT * FROM nfe_inbound ${where}
       ORDER BY COALESCE(data_emissao, created_at) DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => mapInbound(r as Record<string, unknown>));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/ambiente|column/i.test(msg)) throw err;
    // Sem coluna ambiente — lista tudo (legado)
    const legacyParams: unknown[] = [companyId];
    let legacyWhere = 'WHERE company_id = $1';
    if (opts?.status) {
      legacyParams.push(opts.status);
      legacyWhere += ` AND status = $${legacyParams.length}`;
    }
    legacyParams.push(limit);
    const { rows } = await query(
      `SELECT * FROM nfe_inbound ${legacyWhere}
       ORDER BY COALESCE(data_emissao, created_at) DESC
       LIMIT $${legacyParams.length}`,
      legacyParams,
    );
    return rows.map((r) => mapInbound(r as Record<string, unknown>));
  }
}

export interface InboundPreviewItem extends ParsedNfeItem {
  productId: string | null;
  productName: string | null;
  matchType: 'barcode' | 'code' | 'name' | 'none';
}

export async function getInboundPreview(companyId: string, inboundId: string) {
  const { rows } = await query(
    `SELECT * FROM nfe_inbound WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [inboundId, companyId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  let items = (row.items_json as ParsedNfeItem[] | null) || [];
  if ((!items || items.length === 0) && row.xml_completo) {
    const parsed = parseNfeXml(String(row.xml_completo));
    items = parsed?.items || [];
    if (items.length) {
      await query(`UPDATE nfe_inbound SET items_json = $1::jsonb, status = 'READY', updated_at = now() WHERE id = $2`, [
        JSON.stringify(items),
        inboundId,
      ]);
    }
  }

  let products: Record<string, unknown>[] = [];
  try {
    const { rows } = await query(
      `SELECT id, name, barcode FROM products WHERE company_id = $1`,
      [companyId],
    );
    products = rows as Record<string, unknown>[];
  } catch (err) {
    console.warn('[inbound/preview] products:', err);
  }

  const previewItems: InboundPreviewItem[] = items.map((it) => {
    const barcode = (it.cEAN || '').trim();
    const code = (it.cProd || '').trim();
    let productId: string | null = null;
    let productName: string | null = null;
    let matchType: InboundPreviewItem['matchType'] = 'none';

    const byBarcode = barcode
      ? products.find((p) => String(p.barcode || '') === barcode)
      : null;
    if (byBarcode) {
      productId = String(byBarcode.id);
      productName = String(byBarcode.name);
      matchType = 'barcode';
    } else {
      const byCode = code
        ? products.find((p) => String(p.barcode || '') === code)
        : null;
      if (byCode) {
        productId = String(byCode.id);
        productName = String(byCode.name);
        matchType = 'code';
      } else {
        const byName = products.find(
          (p) => String(p.name || '').toLowerCase() === String(it.xProd || '').toLowerCase(),
        );
        if (byName) {
          productId = String(byName.id);
          productName = String(byName.name);
          matchType = 'name';
        }
      }
    }

    return { ...it, productId, productName, matchType };
  });

  // Fornecedor sugerido
  let supplierId: string | null = null;
  const emitNome = row.emit_nome != null ? String(row.emit_nome) : null;
  if (emitNome) {
    const { rows: sups } = await query(
      `SELECT id FROM suppliers WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [companyId, emitNome],
    );
    if (sups[0]) supplierId = String((sups[0] as { id: string }).id);
  }

  return {
    note: mapInbound(row),
    items: previewItems,
    suggestedSupplierId: supplierId,
    suggestedSupplierName: emitNome,
  };
}

async function ensureSupplier(
  companyId: string,
  name: string,
  emitCnpj?: string | null,
): Promise<string> {
  const { rows: existing } = await query(
    `SELECT id FROM suppliers WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [companyId, name],
  );
  if (existing[0]) return String((existing[0] as { id: string }).id);

  const contact = emitCnpj ? `CNPJ ${emitCnpj}` : null;
  const { rows } = await query(
    `INSERT INTO suppliers (company_id, name, contact, rating, reliability)
     VALUES ($1,$2,$3,5,100) RETURNING id`,
    [companyId, name.slice(0, 200), contact],
  );
  return String((rows[0] as { id: string }).id);
}

/** Garante fornecedor (cria se necessário) e devolve o id para o front dar entrada. */
export async function resolveInboundSupplier(
  companyId: string,
  inboundId: string,
  supplierId?: string | null,
) {
  const { rows } = await query(
    `SELECT * FROM nfe_inbound WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [inboundId, companyId],
  );
  const note = rows[0] as Record<string, unknown> | undefined;
  if (!note) throw new Error('Nota não encontrada');

  if (supplierId) return { supplierId, note: mapInbound(note) };

  const name = String(note.emit_nome || 'Fornecedor SEFAZ');
  const id = await ensureSupplier(
    companyId,
    name,
    note.emit_cnpj != null ? String(note.emit_cnpj) : null,
  );
  return { supplierId: id, note: mapInbound(note) };
}

/** Marca a NF-e como importada após o Recebimento processar as entradas. */
export async function markInboundImported(companyId: string, inboundId: string) {
  const { rows } = await query(
    `UPDATE nfe_inbound SET status = 'IMPORTED', imported_at = now(), updated_at = now(),
       error_message = NULL
     WHERE id = $1 AND company_id = $2 AND status <> 'IMPORTED'
     RETURNING *`,
    [inboundId, companyId],
  );
  if (!rows[0]) {
    const { rows: existing } = await query(
      `SELECT * FROM nfe_inbound WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [inboundId, companyId],
    );
    if (!existing[0]) throw new Error('Nota não encontrada');
    return mapInbound(existing[0] as Record<string, unknown>);
  }
  return mapInbound(rows[0] as Record<string, unknown>);
}

export async function ignoreInboundNfe(companyId: string, inboundId: string) {
  const { rows } = await query(
    `UPDATE nfe_inbound SET status = 'IGNORED', updated_at = now()
     WHERE id = $1 AND company_id = $2 RETURNING *`,
    [inboundId, companyId],
  );
  if (!rows[0]) throw new Error('Nota não encontrada');
  return mapInbound(rows[0] as Record<string, unknown>);
}
