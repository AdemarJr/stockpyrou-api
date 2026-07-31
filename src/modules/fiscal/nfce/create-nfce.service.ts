import { query } from '../../../db/pool.js';
import { decryptSecret } from '../secrets.js';
import { getFiscalConfigRow } from '../config/fiscal-config.service.js';
import {
  getSefazEndpoints,
  resolveCscForEnvironment,
  type FiscalEnvironment,
} from '../sefaz/sefaz-endpoints.js';
import { loadCompanyCertificate, signXmlEnveloped } from '../certificate/xml-signer.js';
import { SefazAmClient } from '../sefaz/sefaz-client.js';
import { buildAccessKey, onlyDigits, formatNFeDate, escapeXml } from './nfce-utils.js';
import {
  attachInfNFeSupl,
  buildNfceXml,
  buildQrCodeUrl,
  wrapNFeProc,
} from './nfce-xml-builder.js';
import { buildDanfeHtml, buildEmitAddressLines } from './danfe.js';
import { resolveRespTec } from './resp-tec.js';

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

async function reserveNumber(companyId: string, serie: number): Promise<number> {
  const { rows } = await query(
    `UPDATE fiscal_config
     SET numero_nfce = numero_nfce + 1, updated_at = now()
     WHERE company_id = $1 AND serie_nfce = $2
     RETURNING numero_nfce`,
    [companyId, serie],
  );
  if (!rows[0]) {
    const { rows: any } = await query(
      `UPDATE fiscal_config SET numero_nfce = numero_nfce + 1, updated_at = now()
       WHERE company_id = $1 RETURNING numero_nfce, serie_nfce`,
      [companyId],
    );
    if (!any[0]) throw new Error('Configuração fiscal não encontrada');
    return Number(any[0].numero_nfce);
  }
  return Number(rows[0].numero_nfce);
}

function tpAmb(env: FiscalEnvironment): '1' | '2' {
  return env === 'production' ? '1' : '2';
}

function mapNfce(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    saleId: row.sale_id != null ? String(row.sale_id) : null,
    customerId: row.customer_id != null ? String(row.customer_id) : null,
    chaveAcesso: row.chave_acesso != null ? String(row.chave_acesso) : null,
    numero: Number(row.numero),
    serie: Number(row.serie),
    modelo: String(row.modelo || '65'),
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

export async function getNfceById(companyId: string, id: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ? mapNfce(rows[0] as Record<string, unknown>) : null;
}

export async function getNfceRaw(companyId: string, id: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return (rows[0] as Record<string, unknown>) || null;
}

export async function listNfce(
  companyId: string,
  opts: { limit?: number; from?: string | null; to?: string | null; status?: string | null } = {},
) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const params: unknown[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (opts.from) {
    params.push(opts.from);
    where += ` AND COALESCE(data_emissao, created_at) >= $${params.length}::timestamptz`;
  }
  if (opts.to) {
    params.push(opts.to);
    where += ` AND COALESCE(data_emissao, created_at) < $${params.length}::timestamptz`;
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
  return rows.map((r) => mapNfce(r as Record<string, unknown>));
}

export async function getNfceBySale(companyId: string, saleId: string) {
  const { rows } = await query(
    `SELECT * FROM nfce WHERE company_id = $1 AND sale_id = $2 ORDER BY created_at DESC`,
    [companyId, saleId],
  );
  return rows.map((r) => mapNfce(r as Record<string, unknown>));
}

/** Vendas do período sem NFC-e AUTHORIZED (pendentes de emissão / reemissão). */
export async function listPendingNfceSales(
  companyId: string,
  opts: {
    from: string;
    to: string;
    limit?: number;
    /** requested = marcadas para NFC-e ou com tentativa falha; all = qualquer venda sem autorizada */
    mode?: 'requested' | 'all';
  },
) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300);
  const mode = opts.mode === 'all' ? 'all' : 'requested';
  const modeFilter =
    mode === 'all'
      ? 'TRUE'
      : `(
          COALESCE(s.emit_nfce, false) = true
          OR COALESCE((s.payment_details->>'emitNfce')::boolean, false) = true
          OR EXISTS (
            SELECT 1 FROM nfce n
            WHERE n.sale_id = s.id AND n.company_id = s.company_id
              AND n.status <> 'AUTHORIZED' AND n.status <> 'CANCELLED'
          )
        )`;

  const { rows } = await query(
    `SELECT
       s.id,
       s.total,
       s.payment_method,
       s.timestamp,
       s.emit_nfce,
       s.payment_details,
       s.customer_id,
       c.name AS customer_name,
       (
         SELECT n.status FROM nfce n
         WHERE n.sale_id = s.id AND n.company_id = s.company_id
         ORDER BY n.created_at DESC LIMIT 1
       ) AS last_nfce_status,
       (
         SELECT n.id FROM nfce n
         WHERE n.sale_id = s.id AND n.company_id = s.company_id
         ORDER BY n.created_at DESC LIMIT 1
       ) AS last_nfce_id,
       (
         SELECT n.motivo_status FROM nfce n
         WHERE n.sale_id = s.id AND n.company_id = s.company_id
         ORDER BY n.created_at DESC LIMIT 1
       ) AS last_nfce_motivo
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.company_id = $1
       AND s.timestamp >= $2::timestamptz
       AND s.timestamp < $3::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM nfce n
         WHERE n.sale_id = s.id AND n.company_id = s.company_id AND n.status = 'AUTHORIZED'
       )
       AND ${modeFilter}
     ORDER BY s.timestamp DESC
     LIMIT $4`,
    [companyId, opts.from, opts.to, limit],
  );

  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const pd = row.payment_details as Record<string, unknown> | null;
    return {
      saleId: String(row.id),
      total: Number(row.total || 0),
      paymentMethod: row.payment_method != null ? String(row.payment_method) : null,
      timestamp: row.timestamp,
      emitNfce:
        row.emit_nfce === true ||
        pd?.emitNfce === true ||
        String(pd?.emitNfce || '').toLowerCase() === 'true',
      customerId: row.customer_id != null ? String(row.customer_id) : null,
      customerName: row.customer_name != null ? String(row.customer_name) : null,
      lastNfceStatus: row.last_nfce_status != null ? String(row.last_nfce_status) : null,
      lastNfceId: row.last_nfce_id != null ? String(row.last_nfce_id) : null,
      lastNfceMotivo: row.last_nfce_motivo != null ? String(row.last_nfce_motivo) : null,
    };
  });
}

/**
 * Cria e autoriza NFC-e a partir de uma venda (idempotente por saleId).
 */
export async function createAndAuthorizeFromSale(params: {
  companyId: string;
  saleId: string;
}): Promise<{ nfce: ReturnType<typeof mapNfce>; message: string }> {
  const companyId = params.companyId;
  const saleId = params.saleId;
  const idempotencyKey = `${companyId}:${saleId}`;

  // Já autorizada?
  const { rows: existingAuth } = await query(
    `SELECT * FROM nfce WHERE company_id = $1 AND sale_id = $2 AND status = 'AUTHORIZED' LIMIT 1`,
    [companyId, saleId],
  );
  if (existingAuth[0]) {
    return {
      nfce: mapNfce(existingAuth[0] as Record<string, unknown>),
      message: 'NFC-e já autorizada para esta venda',
    };
  }

  const { rows: saleRows } = await query(
    `SELECT * FROM sales WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [saleId, companyId],
  );
  const sale = saleRows[0] as Record<string, unknown> | undefined;
  if (!sale) throw new Error('Venda não encontrada');

  const config = await getFiscalConfigRow(companyId);
  if (!config || !config.enabled) throw new Error('Módulo fiscal desabilitado');
  if (config.ambiente === 'production') {
    // Permitir produção apenas se env explicitamente liberar
    if (process.env.FISCAL_ALLOW_PRODUCTION !== 'true') {
      throw new Error(
        'Emissão em produção bloqueada. Defina FISCAL_ALLOW_PRODUCTION=true após testes de homologação.',
      );
    }
  }

  const env = config.ambiente as FiscalEnvironment;
  const endpoints = getSefazEndpoints(env);
  // Development SEFAZ-AM: CSC experimental fixo (ignora CSC salvo — evita rejeição 464)
  const configuredToken =
    config.csc_token_encrypted != null ? decryptSecret(config.csc_token_encrypted) : '';
  const { cscId, cscToken } = resolveCscForEnvironment(env, {
    cscId: config.csc_id,
    cscToken: configuredToken,
  });

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

  // Destinatário
  let dest: {
    documentDigits: string;
    documentType: 'cpf' | 'cnpj';
    name: string;
  } | null = null;
  const customerId =
    sale.customer_id != null
      ? String(sale.customer_id)
      : details.customerId
        ? String(details.customerId)
        : null;
  if (customerId) {
    const { rows: custRows } = await query(
      `SELECT * FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [customerId, companyId],
    );
    const c = custRows[0] as Record<string, unknown> | undefined;
    if (c) {
      dest = {
        documentDigits: String(c.document_digits),
        documentType: c.document_type === 'cnpj' ? 'cnpj' : 'cpf',
        name: String(c.name),
      };
    }
  } else if (details.customerDocument && details.customerName) {
    const digits = onlyDigits(String(details.customerDocument));
    dest = {
      documentDigits: digits,
      documentType: digits.length === 14 ? 'cnpj' : 'cpf',
      name: String(details.customerName),
    };
  }

  const serie = Number(config.serie_nfce) || 1;
  const numero = await reserveNumber(companyId, serie);
  const emissionDate = new Date();
  const accessKey = buildAccessKey({
    uf: config.uf || 'AM',
    emissionDate,
    cnpj: config.cnpj,
    serie,
    numero,
  });

  // Enriquecer itens com NCM/CFOP do produto
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

  const xmlOriginal = buildNfceXml({
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
    cscId,
    cscToken,
    qrCodeBaseUrl: endpoints.qrCode,
    respTec,
  });

  const cert = await loadCompanyCertificate(companyId);
  const signedInner = signXmlEnveloped(xmlOriginal, `NFe${accessKey}`, cert);
  let signedXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    (signedInner.startsWith('<NFe')
      ? signedInner
      : `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${signedInner}</NFe>`);

  const qrCodeUrl = buildQrCodeUrl({
    accessKey,
    ambiente: tpAmb(env),
    cscId,
    cscToken,
    baseUrl: endpoints.qrCode,
  });

  // NFC-e (mod 65): infNFeSupl com qrCode/urlChave é obrigatório no schema
  signedXml = attachInfNFeSupl(signedXml, qrCodeUrl, endpoints.urlChave);

  // Insert draft (idempotente por company_id + idempotency_key)
  let nfceRow: Record<string, unknown> | undefined;
  let isNew = false;
  try {
    const { rows: nfceRows } = await query(
      `INSERT INTO nfce (
         company_id, sale_id, customer_id, chave_acesso, numero, serie, modelo,
         ambiente, tipo_emissao, status, xml_original, xml_assinado, qr_code_url,
         idempotency_key, data_emissao
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'65',$7,1,'SIGNED',$8,$9,$10,$11,$12
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
        qrCodeUrl,
        idempotencyKey,
        emissionDate.toISOString(),
      ],
    );
    nfceRow = nfceRows[0] as Record<string, unknown>;
    isNew = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique|duplicate/i.test(msg)) throw err;
    const { rows } = await query(
      `SELECT * FROM nfce WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [companyId, idempotencyKey],
    );
    nfceRow = rows[0] as Record<string, unknown>;
    if (nfceRow && String(nfceRow.status) === 'AUTHORIZED') {
      return {
        nfce: mapNfce(nfceRow),
        message: 'NFC-e já autorizada para esta venda',
      };
    }
  }
  if (!nfceRow) throw new Error('Falha ao persistir NFC-e');

  const nfceId = String(nfceRow.id);
  const prevStatus = String(nfceRow.status || '');
  // Reemissão após REJECTED/ERROR: usa XML novo (corrige schema). Senão reusa o assinado.
  const reuseXml =
    !isNew &&
    prevStatus !== 'REJECTED' &&
    prevStatus !== 'ERROR' &&
    prevStatus !== 'DRAFT' &&
    nfceRow.xml_assinado != null;
  let signedXmlToSend = reuseXml ? String(nfceRow.xml_assinado) : signedXml;
  const accessKeyToUse =
    (nfceRow.chave_acesso != null ? String(nfceRow.chave_acesso) : null) || accessKey;
  const qrCodeUrlToUse =
    (nfceRow.qr_code_url != null ? String(nfceRow.qr_code_url) : null) || qrCodeUrl;

  // Garante infNFeSupl mesmo em XML antigo persistido sem o bloco
  signedXmlToSend = attachInfNFeSupl(signedXmlToSend, qrCodeUrlToUse, endpoints.urlChave);

  if (!isNew && !reuseXml) {
    await query(
      `UPDATE nfce SET
         xml_original = $1, xml_assinado = $2, qr_code_url = $3,
         chave_acesso = $4, numero = $5, serie = $6,
         status = 'SIGNED', motivo_status = NULL, codigo_status = NULL,
         updated_at = now()
       WHERE id = $7`,
      [xmlOriginal, signedXmlToSend, qrCodeUrlToUse, accessKey, numero, serie, nfceId],
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
          nfceId,
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

    await query(
      `INSERT INTO nfce_payment (nfce_id, company_id, t_pag, v_pag, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [nfceId, companyId, paymentMethod, total, paymentMethod],
    );
  }

  // Envio SEFAZ
  const client = new SefazAmClient(companyId, env);
  const started = Date.now();
  try {
    await query(`UPDATE nfce SET status = 'SENT', updated_at = now() WHERE id = $1`, [nfceId]);
    const sefazRes = await client.authorizeNfce(signedXmlToSend);
    await writeFiscalLog({
      companyId,
      nfceId,
      operation: 'AUTHORIZATION',
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
      const danfe = buildDanfeHtml({
        accessKey: accessKeyToUse,
        numero: Number(nfceRow.numero) || numero,
        serie: Number(nfceRow.serie) || serie,
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
        emitPhone: (config as { telefone?: string | null }).telefone ?? null,
        emitEmail: (config as { email?: string | null }).email ?? null,
        emitLogoUrl: (config as { logo_url?: string | null }).logo_url ?? null,
        destName: dest?.name || 'CONSUMIDOR NÃO IDENTIFICADO',
        destDoc: dest?.documentDigits || '',
        items: builtItems,
        total,
        qrCodeUrl: qrCodeUrlToUse,
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
          nfceId,
        ],
      );

      // Marca venda
      try {
        await query(`UPDATE sales SET emit_nfce = true WHERE id = $1 AND company_id = $2`, [
          saleId,
          companyId,
        ]);
      } catch {
        /* coluna opcional */
      }

      const updated = await getNfceById(companyId, nfceId);
      return { nfce: updated!, message: 'NFC-e autorizada' };
    }

    await query(
      `UPDATE nfce SET
         status = 'REJECTED',
         codigo_status = $1,
         motivo_status = $2,
         xml_resposta = $3,
         updated_at = now()
       WHERE id = $4`,
      [sefazRes.statusCode, sefazRes.statusMessage, sefazRes.rawXml, nfceId],
    );

    const updated = await getNfceById(companyId, nfceId);
    let message = `NFC-e rejeitada: ${sefazRes.statusCode} — ${sefazRes.statusMessage}`;
    // 464: hash do QR ≠ SEFAZ — quase sempre CSC/ID de homologação incorreto
    if (
      sefazRes.statusCode === '464' ||
      /hash no qr-?code|hash.*qr/i.test(sefazRes.statusMessage || '')
    ) {
      message +=
        '. Confira em Configurações → Fiscal o ID do CSC e o Token CSC de HOMOLOGAÇÃO do portal SEFAZ-AM (não use o CSC experimental 0123456789). Salve de novo o token e reemita.';
    }
    return {
      nfce: updated!,
      message,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFiscalLog({
      companyId,
      nfceId,
      operation: 'AUTHORIZATION',
      errorMessage: message,
      durationMs: Date.now() - started,
    });
    await query(
      `UPDATE nfce SET status = 'ERROR', motivo_status = $1, updated_at = now() WHERE id = $2`,
      [message.slice(0, 500), nfceId],
    );

    // Timeout → consultar
    if (/timeout|ECONNRESET|ENOTFOUND|socket/i.test(message)) {
      try {
        const consult = await client.consultNfce(accessKeyToUse);
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
              nfceId,
            ],
          );
          const updated = await getNfceById(companyId, nfceId);
          return { nfce: updated!, message: 'NFC-e autorizada (após consulta)' };
        }
      } catch {
        /* ignore */
      }
    }

    const updated = await getNfceById(companyId, nfceId);
    return { nfce: updated!, message: `Erro na emissão: ${message}` };
  }
}

export async function cancelNfce(params: {
  companyId: string;
  nfceId: string;
  justification: string;
}) {
  const justification = params.justification.trim();
  if (justification.length < 15) {
    throw new Error('Justificativa deve ter no mínimo 15 caracteres');
  }
  const raw = await getNfceRaw(params.companyId, params.nfceId);
  if (!raw) throw new Error('NFC-e não encontrada');
  if (String(raw.status) !== 'AUTHORIZED') {
    throw new Error('Somente NFC-e autorizada pode ser cancelada');
  }
  const accessKey = String(raw.chave_acesso);
  const config = await getFiscalConfigRow(params.companyId);
  if (!config) throw new Error('Config fiscal ausente');
  const env = config.ambiente as FiscalEnvironment;
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
    (signed.includes('<evento') ? signed : `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${signed}</evento>`);

  await query(
    `UPDATE nfce SET status = 'CANCEL_REQUESTED', updated_at = now() WHERE id = $1`,
    [params.nfceId],
  );

  const client = new SefazAmClient(params.companyId, env);
  const started = Date.now();
  const res = await client.sendEvent(signedFull);
  await writeFiscalLog({
    companyId: params.companyId,
    nfceId: params.nfceId,
    operation: 'CANCELLATION',
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
      params.nfceId,
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
      [res.statusCode, res.statusMessage, params.nfceId],
    );
  } else {
    await query(
      `UPDATE nfce SET status = 'AUTHORIZED', codigo_status = $1, motivo_status = $2, updated_at = now()
       WHERE id = $3`,
      [res.statusCode, res.statusMessage, params.nfceId],
    );
  }

  return getNfceById(params.companyId, params.nfceId);
}
