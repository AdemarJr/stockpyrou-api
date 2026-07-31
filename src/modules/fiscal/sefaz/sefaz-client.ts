import https from 'node:https';
import { XMLParser } from 'fast-xml-parser';
import { getSefazEndpoints, type FiscalEnvironment } from '../sefaz/sefaz-endpoints.js';
import { getTlsCredentials } from '../certificate/xml-signer.js';

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
  const tls = await getTlsCredentials(params.companyId);
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
    req.on('timeout', () => {
      req.destroy(new Error('Timeout SEFAZ'));
    });
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

export function parseAuthorizationResponse(rawXml: string): SefazNormalizedResponse {
  const parsed = parser.parse(rawXml);
  const cStat = String(extractDeep(parsed, ['cStat']) ?? '');
  const xMotivo = String(extractDeep(parsed, ['xMotivo']) ?? '');
  const nProt = extractDeep(parsed, ['nProt']);
  const nRec = extractDeep(parsed, ['nRec']);
  const chNFe = extractDeep(parsed, ['chNFe']);
  const dhRecbto = extractDeep(parsed, ['dhRecbto']);

  // Extrai protNFe bruto se houver
  const protMatch = rawXml.match(/<protNFe[\s\S]*?<\/protNFe>/i);

  return {
    success: cStat === '100' || cStat === '150',
    statusCode: cStat,
    statusMessage: xMotivo,
    accessKey: chNFe != null ? String(chNFe) : undefined,
    protocol: nProt != null ? String(nProt) : undefined,
    receipt: nRec != null ? String(nRec) : undefined,
    authorizationDate: dhRecbto != null ? String(dhRecbto) : undefined,
    rawXml,
    protNFeXml: protMatch?.[0],
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
    const inner =
      `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">` +
      `<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ>` +
      `</consStatServ></nfeDadosMsg>`;

    const ep = this.endpoints();
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.status,
      soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
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

    const inner =
      `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">${envi}</nfeDadosMsg>`;

    const ep = this.endpoints();
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.authorization,
      soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }

  async consultNfce(accessKey: string): Promise<SefazNormalizedResponse> {
    const tpAmb = this.environment === 'production' ? '1' : '2';
    const cons =
      `<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
      `<tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ>` +
      `<chNFe>${accessKey}</chNFe></consSitNFe>`;
    const inner =
      `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">${cons}</nfeDadosMsg>`;

    const ep = this.endpoints();
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.consultation,
      soapAction:
        'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF',
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }

  async sendEvent(signedEventXml: string): Promise<SefazNormalizedResponse> {
    const envEvento =
      `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">` +
      `<idLote>1</idLote>${signedEventXml.replace(/^<\?xml[^?]*\?>\s*/i, '')}</envEvento>`;
    const inner =
      `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">${envEvento}</nfeDadosMsg>`;

    const ep = this.endpoints();
    const res = await postSoap({
      companyId: this.companyId,
      url: ep.event,
      soapAction: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
      bodyInner: inner,
    });
    return parseAuthorizationResponse(res.body);
  }
}
