import { query } from '../../../db/pool.js';
import { decryptSecret } from '../secrets.js';
import { getFiscalConfigRow } from '../config/fiscal-config.service.js';
import { normalizeFiscalEnvironment, type FiscalEnvironment } from '../sefaz/sefaz-endpoints.js';
import { loadCompanyCertificate, signXmlEnveloped } from '../certificate/xml-signer.js';
import { SefazAmClient } from '../sefaz/sefaz-client.js';
import { buildAccessKey, onlyDigits, formatNFeDate, escapeXml } from '../nfce/nfce-utils.js';
import { buildNfeXml, wrapNFeProc } from './nfe-xml-builder.js';
import { buildNfeDanfeHtml } from './danfe-nfe.js';
import { buildEmitAddressLines } from '../nfce/danfe.js';
import { resolveRespTec } from '../nfce/resp-tec.js';

async function writeFiscalLog(params: {
  companyId: string;
  nfceId?: string | null;
  operation: string;
  requestXml?: string | null;
  responseXml?: string | null;
  httpStatus?: number | null;
  sefazStatusCode?: string | null;
  sefazMessage?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}) {
  try {
    await query(
      `INSERT INTO fiscal_logs (
         company_id, nfce_id, operation, request_xml, response_xml,
         http_status, sefaz_status_code, sefaz_message, error_message, duration_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        params.companyId,
        params.nfceId ?? null,
        params.operation,
        params.requestXml ?? null,
        params.responseXml ?? null,
        params.httpStatus ?? null,
        params.sefazStatusCode ?? null,
        params.sefazMessage ?? null,
        params.errorMessage ?? null,
        params.durationMs ?? null,
      ],
    );
  } catch (err) {
    console.error('[fiscal_logs]', err);
  }
}

async function ensureNfeNumberColumns(): Promise<void> {
  try {
    await query(`
      ALTER TABLE public.fiscal_config
        ADD COLUMN IF NOT EXISTS serie_nfe integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS numero_nfe integer NOT NULL DEFAULT 0
    `);
  } catch (err) {
    console.warn('[nfe] serie/numero_nfe:', err instanceof Error ? err.message : err);
  }
}

async function reserveNfeNumber(companyId: string, serie: number): Promise<number> {
  await ensureNfeNumberColumns();
  const { rows } = await query(
    `UPDATE fiscal_config
     SET numero_nfe = numero_nfe + 1, updated_at = now()
     WHERE company_id = $1 AND COALESCE(serie_nfe, 1) = $2
     RETURNING numero_nfe`,
    [companyId, serie],
  );
  if (!rows[0]) {
    const { rows: any } = await query(
      `UPDATE fiscal_config SET numero_nfe = COALESCE(numero_nfe, 0) + 1, updated_at = now()
       WHERE company_id = $1 RETURNING numero_nfe`,
      [companyId],
    );
    if (!any[0]) throw new Error('Configuração fiscal não encontrada');
    return Number(any[0].numero_nfe);
  }
  return Number(rows[0].numero_nfe);
}

function tpAmb(env: FiscalEnvironment): '1' | '2' {
  return env === 'production' ? '1' : '2';
}

function mapNfe(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    saleId: row.sale_id != null ? String(row.sale_id) : null,
    customerId: row.customer_id != null ? String(row.customer_id) : null,
    chaveAcesso: row.chave_acesso != null ? String(row.chave_acesso) : null,
    numero: Number(row.numero),
    serie: Number(row.serie),
    modelo: String(row.modelo || '55'),
    ambiente: String(row.ambiente),
    status: String(row.status),
    protocolo: row.protocolo != null ? String(row.protocolo) : null,
    codigoStatus: row.codigo_status != null ? String(row.codigo_status) : null,
    motivoStatus: row.motivo_status != null ? String(row.motivo_status) : null,
    qrCodeUrl: row.qr_code_url != null ? String(row.qr_code_url) : null,
    dataEmissao: row.data_emissao,
    dataAutorizacao: row.data_autorizacao,
    hasAuthorizedXml: !!row.xml_autorizado,
    hasDanfe: !!row.danfe_html,
  };
}

export async function getNfeById(companyId: string, id: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE id = $1 AND company_id = $2 AND modelo = '55' LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ? mapNfe(rows[0] as Record<string, unknown>) : null;
}

export async function getNfeRaw(companyId: string, id: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE id = $1 AND company_id = $2 AND modelo = '55' LIMIT 1`,
    [id, companyId],
  );
  return (rows[0] as Record<string, unknown>) || null;
}

export async function getNfeBySale(companyId: string, saleId: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE company_id = $1 AND sale_id = $2 AND modelo = '55'
     ORDER BY created_at DESC`,
    [companyId, saleId],
  );
  return rows.map((r) => mapNfe(r as Record<string, unknown>));
}

export async function getNfeDanfeHtml(
  companyId: string,
  id: string,
): Promise<{ html: string; status: string; chaveAcesso: string | null } | null> {
  const raw = await getNfeRaw(companyId, id);
  if (!raw) return null;
  const stored = raw.danfe_html != null ? String(raw.danfe_html) : null;
  if (!stored) return null;
  return {
    html: stored,
    status: String(raw.status || ''),
    chaveAcesso: raw.chave_acesso != null ? String(raw.chave_acesso) : null,
  };
}

export async function listNfe(
  companyId: string,
  opts: { limit?: number; from?: string | null; to?: string | null; status?: string | null } = {},
) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const params: unknown[] = [companyId];
  let where = `WHERE company_id = $1 AND modelo = '55'`;
  if (opts.from) {
    params.push(opts.from);
    where += ` AND COALESCE(data_emissao, created_at) >= $${params.length}::timestamptz`;
  }
  if (opts.to) {
    params.push(opts.to);
    where += ` AND COALESCE(data_emissao, created_at) <= $${params.length}::timestamptz`;
  }
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT * FROM nfce ${where} ORDER BY COALESCE(data_emissao, created_at) DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => mapNfe(r as Record<string, unknown>));
}

export async function createAndAuthorizeNfeFromSale(params: {
  companyId: string;
  saleId: string;
}): Promise<{ nfe: ReturnType<typeof mapNfe>; message: string }> {
  const { companyId, saleId } = params;
  const idempotencyKey = `${companyId}:${saleId}:nfe55`;

  const { rows: existingAuth } = await query(
    `SELECT * FROM nfce WHERE company_id = $1 AND sale_id = $2 AND status = 'AUTHORIZED' LIMIT 1`,
    [companyId, saleId],
  );
  if (existingAuth[0]) {
    const row = existingAuth[0] as Record<string, unknown>;
    if (String(row.modelo) === '55') {
      return { nfe: mapNfe(row), message: 'NF-e já autorizada para esta venda' };
    }
    throw new Error('Esta venda já possui NFC-e autorizada. Cancele-a antes de emitir NF-e.');
  }

  const { rows: saleRows } = await query(
    `SELECT * FROM sales WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [saleId, companyId],
  );
  const sale = saleRows[0] as Record<string, unknown> | undefined;
  if (!sale) throw new Error('Venda não encontrada');

  const config = await getFiscalConfigRow(companyId);
  if (!config || !config.enabled) throw new Error('Módulo fiscal desabilitado');
  if (config.ambiente === 'production' && process.env.FISCAL_ALLOW_PRODUCTION !== 'true') {
    throw new Error(
      'Emissão em produção bloqueada. Defina FISCAL_ALLOW_PRODUCTION=true após testes de homologação.',
    );
  }

  const env = normalizeFiscalEnvironment(config.ambiente);

  let details: Record<string, unknown> = {};
  try {
    details =
      typeof sale.payment_details === 'string'
        ? JSON.parse(sale.payment_details)
        : ((sale.payment_details as Record<string, unknown>) ?? {});
  } catch {
    details = {};
  }

  let items: Array<Record<string, unknown>> = [];
  try {
    items =
      typeof sale.items === 'string'
        ? JSON.parse(String(sale.items))
        : Array.isArray(sale.items)
          ? (sale.items as Array<Record<string, unknown>>)
          : [];
  } catch {
    items = [];
  }
  if (items.length === 0) throw new Error('Venda sem itens');

  const customerId =
    sale.customer_id != null
      ? String(sale.customer_id)
      : details.customerId
        ? String(details.customerId)
        : null;

  let dest: {
    documentDigits: string;
    documentType: 'cpf' | 'cnpj';
    name: string;
    address: {
      logradouro: string;
      numero: string;
      complemento?: string | null;
      bairro: string;
      municipio: string;
      codigoMunicipio: string;
      uf: string;
      cep: string;
    };
  } | null = null;

  if (customerId) {
    const { rows: custRows } = await query(
      `SELECT * FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [customerId, companyId],
    );
    const c = custRows[0] as Record<string, unknown> | undefined;
    if (c) {
      const logradouro = String(c.logradouro || '').trim();
      const municipio = String(c.municipio || '').trim();
      const uf = String(c.uf || config.uf || 'AM').trim();
      const cep = onlyDigits(String(c.cep || ''));
      if (!logradouro || !municipio || cep.length !== 8) {
        throw new Error(
          'Cliente sem endereço completo (logradouro, município e CEP). Obrigatório para NF-e.',
        );
      }
      dest = {
        documentDigits: String(c.document_digits),
        documentType: c.document_type === 'cnpj' ? 'cnpj' : 'cpf',
        name: String(c.name),
        address: {
          logradouro,
          numero: String(c.numero || 'S/N').trim() || 'S/N',
          complemento: c.complemento != null ? String(c.complemento) : null,
          bairro: String(c.bairro || 'CENTRO').trim() || 'CENTRO',
          municipio,
          codigoMunicipio:
            onlyDigits(String(c.codigo_municipio || '')) ||
            onlyDigits(String(config.codigo_municipio || '')) ||
            '1302603',
          uf: uf.slice(0, 2).toUpperCase(),
          cep,
        },
      };
    }
  }

  if (!dest) {
    throw new Error('NF-e exige cliente cadastrado com CPF/CNPJ e endereço completo');
  }

  await ensureNfeNumberColumns();
  const serie =
    Number((config as { serie_nfe?: number }).serie_nfe) ||
    Number((config as { serieNfe?: number }).serieNfe) ||
    1;
  const numero = await reserveNfeNumber(companyId, serie);
  const emissionDate = new Date();
  const accessKey = buildAccessKey({
    uf: config.uf || 'AM',
    emissionDate,
    cnpj: config.cnpj,
    serie,
    numero,
    modelo: '55',
  });

  const builtItems = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const productId = it.productId || it.product_id || it.id;
    let ncm = '21069090';
    let cfop = '5102';
    let csosn = config.crt === 1 || config.crt === 2 ? '102' : null;
    let origem = 0;
    let unidade = 'UN';
    if (productId) {
      const { rows: pRows } = await query(
        `SELECT ncm, cfop, csosn, cst, origem, unit, name
         FROM products WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [String(productId), companyId],
      );
      const p = pRows[0] as Record<string, unknown> | undefined;
      if (p) {
        if (p.ncm) {
          const digits = onlyDigits(String(p.ncm));
          if (digits && !/^0+$/.test(digits)) ncm = digits;
        }
        if (p.cfop) cfop = onlyDigits(String(p.cfop));
        if (p.csosn) csosn = String(p.csosn);
        if (p.origem != null) origem = Number(p.origem) || 0;
        if (p.unit) unidade = String(p.unit).slice(0, 6);
      }
    }
    const qty = Number(it.quantity) || 1;
    const price = Number(it.price ?? it.unitPrice ?? it.unit_price) || 0;
    builtItems.push({
      itemNumber: i + 1,
      description: String(it.name || `Item ${i + 1}`),
      ncm: ncm || '21069090',
      cfop: cfop || '5102',
      csosn,
      cst: null as string | null,
      origem,
      unidade,
      quantity: qty,
      unitPrice: price,
      total: Math.round(qty * price * 100) / 100,
    });
  }

  const total = Number(sale.total) || builtItems.reduce((s, i) => s + i.total, 0);
  const paymentMethod = String(sale.payment_method || 'money');

  let respTecCsrt: string | null = null;
  if (config.resp_tec_csrt_encrypted) {
    try {
      respTecCsrt = decryptSecret(config.resp_tec_csrt_encrypted);
    } catch {
      respTecCsrt = null;
    }
  }
  const respTec = resolveRespTec({
    cnpj: config.resp_tec_cnpj ?? null,
    xContato: config.resp_tec_contato ?? null,
    email: config.resp_tec_email ?? null,
    fone: config.resp_tec_fone ?? null,
    idCsrt: config.resp_tec_id_csrt ?? null,
    csrt: respTecCsrt,
  });

  const xmlOriginal = buildNfeXml({
    accessKey,
    numero,
    serie,
    ambiente: tpAmb(env),
    tipoEmissao: 1,
    emissionDate,
    emit: {
      cnpj: config.cnpj,
      ie: config.ie,
      razaoSocial: config.razao_social,
      nomeFantasia: config.nome_fantasia,
      logradouro: config.logradouro,
      numero: config.numero,
      complemento: config.complemento,
      bairro: config.bairro,
      municipio: config.municipio,
      codigoMunicipio: config.codigo_municipio,
      uf: config.uf,
      cep: config.cep,
      crt: Number(config.crt) || 1,
    },
    dest,
    items: builtItems,
    paymentMethod,
    total,
    respTec,
  });

  const cert = await loadCompanyCertificate(companyId);
  const signedInner = signXmlEnveloped(xmlOriginal, `NFe${accessKey}`, cert);
  const signedXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    (signedInner.startsWith('<NFe')
      ? signedInner
      : `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${signedInner}</NFe>`);

  let nfeRow: Record<string, unknown> | undefined;
  let isNew = false;
  try {
    const { rows: nfeRows } = await query(
      `INSERT INTO nfce (
         company_id, sale_id, customer_id, chave_acesso, numero, serie, modelo,
         ambiente, tipo_emissao, status, xml_original, xml_assinado, qr_code_url,
         idempotency_key, data_emissao
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'55',$7,1,'SIGNED',$8,$9,NULL,$10,$11
       )
       RETURNING *`,
      [
        companyId,
        saleId,
        customerId,
        accessKey,
        numero,
        serie,
        env,
        xmlOriginal,
        signedXml,
        idempotencyKey,
        emissionDate.toISOString(),
      ],
    );
    nfeRow = nfeRows[0] as Record<string, unknown>;
    isNew = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique|duplicate/i.test(msg)) throw err;
    const { rows } = await query(
      `SELECT * FROM nfce WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [companyId, idempotencyKey],
    );
    nfeRow = rows[0] as Record<string, unknown>;
    if (nfeRow && String(nfeRow.status) === 'AUTHORIZED') {
      return { nfe: mapNfe(nfeRow), message: 'NF-e já autorizada para esta venda' };
    }
  }
  if (!nfeRow) throw new Error('Falha ao persistir NF-e');

  const nfeId = String(nfeRow.id);
  const prevStatus = String(nfeRow.status || '');
  const reuseXml =
    !isNew &&
    prevStatus !== 'REJECTED' &&
    prevStatus !== 'ERROR' &&
    prevStatus !== 'DRAFT' &&
    nfeRow.xml_assinado != null;
  let signedXmlToSend = reuseXml ? String(nfeRow.xml_assinado) : signedXml;
  const accessKeyToUse =
    (nfeRow.chave_acesso != null ? String(nfeRow.chave_acesso) : null) || accessKey;

  if (!isNew && !reuseXml) {
    await query(
      `UPDATE nfce SET
         xml_original = $1, xml_assinado = $2,
         chave_acesso = $3, numero = $4, serie = $5, modelo = '55',
         status = 'SIGNED', motivo_status = NULL, codigo_status = NULL,
         updated_at = now()
       WHERE id = $6`,
      [xmlOriginal, signedXmlToSend, accessKey, numero, serie, nfeId],
    );
  }

  if (isNew) {
    for (const it of builtItems) {
      await query(
        `INSERT INTO nfce_item (
           nfce_id, company_id, item_number, description, ncm, cfop, csosn, origem,
           unidade, quantity, unit_price, total
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          nfeId,
          companyId,
          it.itemNumber,
          it.description,
          it.ncm,
          it.cfop,
          it.csosn,
          it.origem,
          it.unidade,
          it.quantity,
          it.unitPrice,
          it.total,
        ],
      );
    }
  }

  const client = new SefazAmClient(companyId, env, '55');
  const started = Date.now();
  try {
    await query(`UPDATE nfce SET status = 'SENT', updated_at = now() WHERE id = $1`, [nfeId]);
    const sefazRes = await client.authorizeNfe(signedXmlToSend);
    await writeFiscalLog({
      companyId,
      nfceId: nfeId,
      operation: 'NFE_AUTHORIZATION',
      requestXml: signedXmlToSend.slice(0, 50000),
      responseXml: sefazRes.rawXml.slice(0, 50000),
      sefazStatusCode: sefazRes.statusCode,
      sefazMessage: sefazRes.statusMessage,
      durationMs: Date.now() - started,
    });

    if (sefazRes.success) {
      const authorizedXml = sefazRes.protNFeXml
        ? wrapNFeProc(signedXmlToSend, sefazRes.protNFeXml)
        : signedXmlToSend;
      const danfe = await buildNfeDanfeHtml({
        accessKey: accessKeyToUse,
        numero: Number(nfeRow.numero) || numero,
        serie: Number(nfeRow.serie) || serie,
        protocolo: sefazRes.protocol || '',
        emitName: config.razao_social,
        emitFantasia: config.nome_fantasia,
        emitCnpj: config.cnpj,
        emitIe: config.ie,
        emitAddressLines: buildEmitAddressLines({
          logradouro: config.logradouro,
          numero: config.numero,
          complemento: config.complemento,
          bairro: config.bairro,
          municipio: config.municipio,
          uf: config.uf,
          cep: config.cep,
        }),
        destName: dest.name,
        destDoc: dest.documentDigits,
        destAddressLines: buildEmitAddressLines(dest.address),
        items: builtItems,
        total,
        ambiente: env,
        paymentMethod,
        authorizedAt: sefazRes.authorizationDate || new Date().toISOString(),
      });

      await query(
        `UPDATE nfce SET
           status = 'AUTHORIZED',
           protocolo = $1,
           codigo_status = $2,
           motivo_status = $3,
           xml_autorizado = $4,
           xml_resposta = $5,
           danfe_html = $6,
           data_autorizacao = now(),
           updated_at = now()
         WHERE id = $7`,
        [
          sefazRes.protocol || null,
          sefazRes.statusCode,
          sefazRes.statusMessage,
          authorizedXml,
          sefazRes.rawXml,
          danfe,
          nfeId,
        ],
      );

      try {
        await query(
          `UPDATE sales SET emit_nfe = true WHERE id = $1 AND company_id = $2`,
          [saleId, companyId],
        );
      } catch {
        /* coluna opcional até a migration */
      }

      const updated = await getNfeById(companyId, nfeId);
      return { nfe: updated!, message: 'NF-e autorizada' };
    }

    await query(
      `UPDATE nfce SET
         status = 'REJECTED',
         codigo_status = $1,
         motivo_status = $2,
         xml_resposta = $3,
         updated_at = now()
       WHERE id = $4`,
      [sefazRes.statusCode, sefazRes.statusMessage, sefazRes.rawXml, nfeId],
    );
    const updated = await getNfeById(companyId, nfeId);
    return {
      nfe: updated!,
      message: `NF-e rejeitada: ${sefazRes.statusCode} — ${sefazRes.statusMessage}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFiscalLog({
      companyId,
      nfceId: nfeId,
      operation: 'NFE_AUTHORIZATION',
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    await query(
      `UPDATE nfce SET status = 'ERROR', motivo_status = $1, updated_at = now() WHERE id = $2`,
      [message.slice(0, 500), nfeId],
    );

    if (/timeout|ECONNRESET|ENOTFOUND|socket/i.test(message)) {
      try {
        const consult = await client.consultNfe(accessKeyToUse);
        if (consult.success) {
          await query(
            `UPDATE nfce SET status = 'AUTHORIZED', protocolo = $1, codigo_status = $2,
               motivo_status = $3, xml_resposta = $4, data_autorizacao = now(), updated_at = now()
             WHERE id = $5`,
            [
              consult.protocol || null,
              consult.statusCode,
              consult.statusMessage,
              consult.rawXml,
              nfeId,
            ],
          );
          const updated = await getNfeById(companyId, nfeId);
          return { nfe: updated!, message: 'NF-e autorizada (após consulta)' };
        }
      } catch {
        /* ignore */
      }
    }

    const updated = await getNfeById(companyId, nfeId);
    return { nfe: updated!, message: `Erro na emissão: ${message}` };
  }
}

export async function cancelNfe(params: {
  companyId: string;
  nfeId: string;
  justification: string;
}) {
  const justification = params.justification.trim();
  if (justification.length < 15) {
    throw new Error('Justificativa deve ter no mínimo 15 caracteres');
  }
  const raw = await getNfeRaw(params.companyId, params.nfeId);
  if (!raw) throw new Error('NF-e não encontrada');
  if (String(raw.status) !== 'AUTHORIZED') {
    throw new Error('Somente NF-e autorizada pode ser cancelada');
  }
  const accessKey = String(raw.chave_acesso);
  const config = await getFiscalConfigRow(params.companyId);
  if (!config) throw new Error('Config fiscal ausente');
  const env = normalizeFiscalEnvironment(config.ambiente);
  const tpA = tpAmb(env);
  const nSeq = 1;
  const dhEvento = formatNFeDate(new Date());
  const id = `ID110111${accessKey}${String(nSeq).padStart(2, '0')}`;

  const infEvento =
    `<infEvento Id="${id}">` +
    `<cOrgao>13</cOrgao>` +
    `<tpAmb>${tpA}</tpAmb>` +
    `<CNPJ>${onlyDigits(config.cnpj)}</CNPJ>` +
    `<chNFe>${accessKey}</chNFe>` +
    `<dhEvento>${dhEvento}</dhEvento>` +
    `<tpEvento>110111</tpEvento>` +
    `<nSeqEvento>${nSeq}</nSeqEvento>` +
    `<verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00">` +
    `<descEvento>Cancelamento</descEvento>` +
    `<nProt>${escapeXml(String(raw.protocolo || ''))}</nProt>` +
    `<xJust>${escapeXml(justification)}</xJust>` +
    `</detEvento></infEvento>`;

  const eventoXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${infEvento}</evento>`;

  const cert = await loadCompanyCertificate(params.companyId);
  const signed = signXmlEnveloped(eventoXml, id, cert);
  const signedFull =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    (signed.includes('<evento')
      ? signed
      : `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${signed}</evento>`);

  await query(
    `UPDATE nfce SET status = 'CANCEL_REQUESTED', updated_at = now() WHERE id = $1`,
    [params.nfeId],
  );

  const client = new SefazAmClient(params.companyId, env, '55');
  const started = Date.now();
  const res = await client.sendEvent(signedFull);
  await writeFiscalLog({
    companyId: params.companyId,
    nfceId: params.nfeId,
    operation: 'NFE_CANCELLATION',
    requestXml: signedFull.slice(0, 50000),
    responseXml: res.rawXml.slice(0, 50000),
    sefazStatusCode: res.statusCode,
    sefazMessage: res.statusMessage,
    durationMs: Date.now() - started,
  });

  await query(
    `INSERT INTO nfce_event (
       nfce_id, company_id, tipo_evento, sequencia, xml_evento, xml_retorno, protocolo, status, justification
     ) VALUES ($1,$2,'110111',$3,$4,$5,$6,$7,$8)`,
    [
      params.nfeId,
      params.companyId,
      nSeq,
      signedFull,
      res.rawXml,
      res.protocol || null,
      res.success || res.statusCode === '135' || res.statusCode === '155' ? 'CANCELLED' : 'REJECTED',
      justification,
    ],
  );

  if (res.success || res.statusCode === '135' || res.statusCode === '155') {
    await query(
      `UPDATE nfce SET status = 'CANCELLED', codigo_status = $1, motivo_status = $2, updated_at = now()
       WHERE id = $3`,
      [res.statusCode, res.statusMessage, params.nfeId],
    );
  } else {
    await query(
      `UPDATE nfce SET status = 'AUTHORIZED', codigo_status = $1, motivo_status = $2, updated_at = now()
       WHERE id = $3`,
      [res.statusCode, res.statusMessage, params.nfeId],
    );
  }

  return getNfeById(params.companyId, params.nfeId);
}
