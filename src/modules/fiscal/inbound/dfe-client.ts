import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { getTlsCredentials } from '../certificate/xml-signer.js';
import type { FiscalEnvironment } from '../sefaz/sefaz-endpoints.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

export function getDfeEndpoints(env: FiscalEnvironment) {
  const production = env === 'production';
  return {
    distribuicao: production
      ? 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
      : 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
    evento: production
      ? 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
      : 'https://hom.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  };
}

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
  const tls = await getTlsCredentials(params.companyId);
  const payload = soapEnvelope(params.bodyInner);
  const timeout = params.timeoutMs ?? Number(process.env.SEFAZ_DFE_TIMEOUT || 45000);
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
        rejectUnauthorized: true,
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
    req.on('timeout', () => req.destroy(new Error('Timeout SEFAZ DF-e')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
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

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface DfeDocument {
  nsu: string;
  schema: string;
  xml: string;
}

export interface DfeDistResult {
  cStat: string;
  xMotivo: string;
  ultNSU: string;
  maxNSU: string;
  documents: DfeDocument[];
  rawXml: string;
  durationMs: number;
}

function decodeDocZip(docZip: Record<string, unknown>): DfeDocument | null {
  const nsu = String(docZip['@_NSU'] ?? docZip.NSU ?? '');
  const schema = String(docZip['@_schema'] ?? docZip.schema ?? '');
  const b64 = String(docZip['#text'] ?? docZip.text ?? '').trim();
  if (!b64 || b64.length < 8) return null;
  try {
    const compressed = Buffer.from(b64, 'base64');
    const xml = gunzipSync(compressed).toString('utf8');
    return { nsu, schema, xml };
  } catch {
    return null;
  }
}

function parseDistResponse(rawXml: string, durationMs: number): DfeDistResult {
  const parsed = parser.parse(rawXml);
  const cStat = String(extractDeep(parsed, ['cStat']) ?? '');
  const xMotivo = String(extractDeep(parsed, ['xMotivo']) ?? '');
  const ultNSU = String(extractDeep(parsed, ['ultNSU']) ?? '0').padStart(15, '0');
  const maxNSU = String(extractDeep(parsed, ['maxNSU']) ?? ultNSU).padStart(15, '0');

  const lote = extractDeep(parsed, ['loteDistDFeInt']);
  const docsRaw = asArray(
    lote && typeof lote === 'object'
      ? (lote as Record<string, unknown>).docZip
      : extractDeep(parsed, ['docZip']),
  ) as Record<string, unknown>[];

  const documents: DfeDocument[] = [];
  for (const d of docsRaw) {
    if (!d || typeof d !== 'object') continue;
    const decoded = decodeDocZip(d);
    if (decoded) documents.push(decoded);
  }

  // Fallback: regex nos docZip se o parser falhar na estrutura
  if (documents.length === 0) {
    const re =
      /<docZip[^>]*NSU="(\d+)"[^>]*schema="([^"]+)"[^>]*>([^<]+)<\/docZip>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawXml))) {
      try {
        const xml = gunzipSync(Buffer.from(m[3].trim(), 'base64')).toString('utf8');
        documents.push({ nsu: m[1], schema: m[2], xml });
      } catch {
        /* ignore */
      }
    }
  }

  return { cStat, xMotivo, ultNSU, maxNSU, documents, rawXml, durationMs };
}

export class SefazDfeClient {
  constructor(
    private companyId: string,
    private environment: FiscalEnvironment,
  ) {}

  private tpAmb() {
    return this.environment === 'production' ? '1' : '2';
  }

  async distByUltNsu(cnpj: string, ultNsu: string, cUFAutor = '13'): Promise<DfeDistResult> {
    const nsu = String(ultNsu || '0').replace(/\D/g, '').padStart(15, '0');
    const dist =
      `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
      `<tpAmb>${this.tpAmb()}</tpAmb>` +
      `<cUFAutor>${cUFAutor}</cUFAutor>` +
      `<CNPJ>${cnpj}</CNPJ>` +
      `<distNSU><ultNSU>${nsu}</ultNSU></distNSU>` +
      `</distDFeInt>`;
    const inner =
      `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
      `<nfeDadosMsg>${dist}</nfeDadosMsg></nfeDistDFeInteresse>`;

    const ep = getDfeEndpoints(this.environment);
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.distribuicao,
      soapAction:
        'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse',
      bodyInner: inner,
    });
    return parseDistResponse(res.body, res.durationMs);
  }

  async distByChave(cnpj: string, chave: string): Promise<DfeDistResult> {
    const dist =
      `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
      `<tpAmb>${this.tpAmb()}</tpAmb>` +
      `<CNPJ>${cnpj}</CNPJ>` +
      `<consChNFe><chNFe>${chave}</chNFe></consChNFe>` +
      `</distDFeInt>`;
    const inner =
      `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
      `<nfeDadosMsg>${dist}</nfeDadosMsg></nfeDistDFeInteresse>`;

    const ep = getDfeEndpoints(this.environment);
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.distribuicao,
      soapAction:
        'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse',
      bodyInner: inner,
    });
    return parseDistResponse(res.body, res.durationMs);
  }

  async sendEventAn(signedEventXml: string): Promise<{
    cStat: string;
    xMotivo: string;
    rawXml: string;
    success: boolean;
  }> {
    const envEvento =
      `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
      `<idLote>1</idLote>${signedEventXml.replace(/^<\?xml[^?]*\?>\s*/i, '')}</envEvento>`;
    const inner =
      `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${envEvento}</nfeDadosMsg>`;

    const ep = getDfeEndpoints(this.environment);
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.evento,
      soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
      bodyInner: inner,
    });
    const parsed = parser.parse(res.body);
    const cStat = String(extractDeep(parsed, ['cStat']) ?? '');
    const xMotivo = String(extractDeep(parsed, ['xMotivo']) ?? '');
    return {
      cStat,
      xMotivo,
      rawXml: res.body,
      success: cStat === '135' || cStat === '136' || cStat === '155',
    };
  }
}
