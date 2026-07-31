import https from 'node:https';
import { XMLParser } from 'fast-xml-parser';
import { getSefazEndpoints, type FiscalEnvironment } from '../sefaz/sefaz-endpoints.js';
import { getSefazHttpsTlsOptions } from './sefaz-tls.js';

export interface SefazNormalizedResponse {
  success: boolean;
  statusCode: string;
  statusMessage: string;
  accessKey?: string;
  protocol?: string;
  receipt?: string;
  authorizationDate?: string;
  rawXml: string;
  protNFeXml?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

function soapEnvelope(bodyInner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>${bodyInner}</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

async function postSoap(params: {
  companyId: string;
  url: string;
  soapAction: string;
  bodyInner: string;
  timeoutMs?: number;
}): Promise<{ status: number; body: string; durationMs: number }> {
  const tls = await getSefazHttpsTlsOptions(params.companyId);
  const payload = soapEnvelope(params.bodyInner);
  const timeout = params.timeoutMs ?? Number(process.env.SEFAZ_AM_TIMEOUT || 30000);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const url = new URL(params.url);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        key: tls.key,
        cert: tls.cert,
        rejectUnauthorized: tls.rejectUnauthorized,
        checkServerIdentity: tls.checkServerIdentity,
        headers: {
          'Content-Type': `application/soap+xml; charset=utf-8; action="${params.soapAction}"`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: Date.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Timeout SEFAZ'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractDeep(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec) return rec[k];
  }
  for (const v of Object.values(rec)) {
    const found = extractDeep(v, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Localiza o bloco infProt (status da NFC-e), não o cStat do lote. */
function extractInfProt(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if ('infProt' in rec) {
    const inf = rec.infProt;
    if (Array.isArray(inf)) {
      const first = asRecord(inf[0]);
      if (first) return first;
    }
    const single = asRecord(inf);
    if (single) return single;
  }
  for (const v of Object.values(rec)) {
    const found = extractInfProt(v);
    if (found) return found;
  }
  return null;
}

function tagText(rawXml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m = rawXml.match(re);
  return m?.[1]?.trim() || undefined;
}

/**
 * Normaliza retorno de autorização/consulta.
 * Importante: em retEnviNFe síncrono, cStat 104 = "Lote processado" (lote).
 * O status da nota está em protNFe/infProt (100 = autorizada).
 */
export function parseAuthorizationResponse(rawXml: string): SefazNormalizedResponse {
  const parsed = parser.parse(rawXml);
  const protMatch = rawXml.match(/<protNFe[\s\S]*?<\/protNFe>/i);
  const protXml = protMatch?.[0];
  const infProt = extractInfProt(parsed);

  const loteStat = String(extractDeep(parsed, ['cStat']) ?? '');
  const loteMotivo = String(extractDeep(parsed, ['xMotivo']) ?? '');

  // Preferência: status da nota (infProt). Fallback: regex no XML do protocolo.
  let cStat =
    (infProt?.cStat != null ? String(infProt.cStat) : '') ||
    (protXml ? tagText(protXml, 'cStat') : undefined) ||
    '';
  let xMotivo =
    (infProt?.xMotivo != null ? String(infProt.xMotivo) : '') ||
    (protXml ? tagText(protXml, 'xMotivo') : undefined) ||
    '';

  // Sem protNFe: usa status do lote (ex.: 103 recebimento assíncrono, rejeição de lote)
  if (!cStat) {
    cStat = loteStat;
    xMotivo = loteMotivo;
  }

  // 104 no lote sem conseguir ler infProt — não tratar como rejeição da nota
  if ((!infProt && !protXml) && (cStat === '104' || cStat === '103')) {
    xMotivo = xMotivo || (cStat === '104' ? 'Lote processado' : 'Lote recebido');
  }

  const nProt =
    infProt?.nProt ??
    (protXml ? tagText(protXml, 'nProt') : undefined) ??
    extractDeep(parsed, ['nProt']);
  const chNFe =
    infProt?.chNFe ??
    (protXml ? tagText(protXml, 'chNFe') : undefined) ??
    extractDeep(parsed, ['chNFe']);
  const dhRecbto =
    infProt?.dhRecbto ??
    (protXml ? tagText(protXml, 'dhRecbto') : undefined) ??
    extractDeep(parsed, ['dhRecbto']);
  const nRec = extractDeep(parsed, ['nRec']);

  const success = cStat === '100' || cStat === '150';

  return {
    success,
    statusCode: cStat,
    statusMessage: xMotivo || (success ? 'Autorizado' : loteMotivo),
    accessKey: chNFe != null ? String(chNFe) : undefined,
    protocol: nProt != null ? String(nProt) : undefined,
    receipt: nRec != null ? String(nRec) : undefined,
    authorizationDate: dhRecbto != null ? String(dhRecbto) : undefined,
    rawXml,
    protNFeXml: protXml,
  };
}

export class SefazAmClient {
  constructor(
    private companyId: string,
    private environment: FiscalEnvironment,
  ) {}

  private endpoints() {
    return getSefazEndpoints(this.environment);
  }

  async checkStatus(cUF = '13'): Promise<SefazNormalizedResponse> {
    const tpAmb = this.environment === 'production' ? '1' : '2';
    const ep = this.endpoints();
    const inner =
      `<nfeDadosMsg xmlns="${ep.soap.statusNs}">` +
      `<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ>` +
      `</consStatServ></nfeDadosMsg>`;

    const res = await postSoap({
      companyId: this.companyId,
      url: ep.status,
      soapAction: ep.soap.status,
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }

  async authorizeNfce(signedXml: string): Promise<SefazNormalizedResponse> {
    const idLote = String(Date.now()).slice(-15);
    const nfeClean = signedXml.replace(/^<\?xml[^?]*\?>\s*/i, '');
    const envi =
      `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<idLote>${idLote}</idLote><indSinc>1</indSinc>${nfeClean}</enviNFe>`;

    const ep = this.endpoints();
    const inner = `<nfeDadosMsg xmlns="${ep.soap.authorizationNs}">${envi}</nfeDadosMsg>`;

    const res = await postSoap({
      companyId: this.companyId,
      url: ep.authorization,
      soapAction: ep.soap.authorization,
      bodyInner: inner,
    });

    if (!res.body || res.status >= 500) {
      throw new Error(
        `SEFAZ não respondeu (${res.status}). Ambiente=${this.environment}. ` +
          'Verifique certificado, CSC e conectividade.',
      );
    }

    return parseAuthorizationResponse(res.body);
  }

  async consultNfce(accessKey: string): Promise<SefazNormalizedResponse> {
    const tpAmb = this.environment === 'production' ? '1' : '2';
    const ep = this.endpoints();
    const cons =
      `<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>${accessKey}</chNFe></consSitNFe>`;
    const inner = `<nfeDadosMsg xmlns="${ep.soap.consultationNs}">${cons}</nfeDadosMsg>`;

    const res = await postSoap({
      companyId: this.companyId,
      url: ep.consultation,
      soapAction: ep.soap.consultation,
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }

  async sendEvent(signedEventXml: string): Promise<SefazNormalizedResponse> {
    const ep = this.endpoints();
    const envEvento =
      `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
      `<idLote>1</idLote>${signedEventXml.replace(/^<\?xml[^?]*\?>\s*/i, '')}</envEvento>`;
    const inner = `<nfeDadosMsg xmlns="${ep.soap.eventNs}">${envEvento}</nfeDadosMsg>`;

    const res = await postSoap({
      companyId: this.companyId,
      url: ep.event,
      soapAction: ep.soap.event,
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }
}
