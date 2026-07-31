/**
 * Endpoints oficiais NFC-e SEFAZ-AM (modelo 65, XML 4.00).
 * Ambientes suportados: homologação e produção.
 */

export type FiscalEnvironment = 'homologation' | 'production';

/** Normaliza valor legado (ex.: development) para homologação ou produção. */
export function normalizeFiscalEnvironment(raw: unknown): FiscalEnvironment {
  return raw === 'production' ? 'production' : 'homologation';
}

export interface SefazSoapActions {
  authorization: string;
  authorizationNs: string;
  consultation: string;
  consultationNs: string;
  status: string;
  statusNs: string;
  event: string;
  eventNs: string;
}

export interface SefazEndpointSet {
  authorization: string;
  authorizationReturn: string;
  consultation: string;
  status: string;
  inutilization: string;
  event: string;
  /** URL base do QR Code (com `?` final). */
  qrCode: string;
  /** URL de consulta chave (tag urlChave do infNFeSupl), sem query. */
  urlChave: string;
  soap: SefazSoapActions;
}

/** SOAP NFe 4.00 (homologação oficial / produção). */
const soapV4: SefazSoapActions = {
  authorization: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
  authorizationNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
  consultation: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF',
  consultationNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4',
  status: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF',
  statusNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4',
  event: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
  eventNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4',
};

/** Homologação oficial de contribuintes */
export const sefazHomologation: SefazEndpointSet = {
  authorization:
    'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeAutorizacao4',
  authorizationReturn:
    'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeRetAutorizacao4',
  consultation:
    'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeConsulta4',
  status:
    'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeStatusServico4',
  inutilization:
    'https://homnfce.sefaz.am.gov.br/nfce-services/services/NfeInutilizacao4',
  event: 'https://homnfce.sefaz.am.gov.br/nfce-services/services/RecepcaoEvento4',
  qrCode: 'https://sistemas.sefaz.am.gov.br/nfceweb-hom/consultarNFCe.jsp?',
  urlChave: 'https://sistemas.sefaz.am.gov.br/nfceweb-hom/consultarNFCe.jsp',
  soap: soapV4,
};

/** Produção */
export const sefazProduction: SefazEndpointSet = {
  authorization: 'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeAutorizacao4',
  authorizationReturn:
    'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeRetAutorizacao4',
  consultation: 'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeConsulta4',
  status: 'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeStatusServico4',
  inutilization:
    'https://nfce.sefaz.am.gov.br/nfce-services/services/NfeInutilizacao4',
  event: 'https://nfce.sefaz.am.gov.br/nfce-services/services/RecepcaoEvento4',
  qrCode: 'https://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp?',
  urlChave: 'https://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp',
  soap: soapV4,
};

export const sefazEnvironmentConfig = {
  homologation: sefazHomologation,
  production: sefazProduction,
} as const;

export function getSefazEndpoints(env: FiscalEnvironment | string): SefazEndpointSet {
  return sefazEnvironmentConfig[normalizeFiscalEnvironment(env)];
}

/** CSC experimental do sandbox antigo — não usar em homologação/produção. */
export const EXPERIMENTAL_CSC = {
  id: '000001',
  token: '0123456789',
} as const;

/** Normaliza token CSC (remove espaços/quebras; mantém hífens e caixa). */
export function normalizeCscToken(raw: string): string {
  return String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width
    .replace(/\s+/g, '')
    .trim();
}

export function isExperimentalCsc(cscId: string, cscToken: string): boolean {
  const id = String(Number(String(cscId).replace(/\D/g, '') || '0'));
  const token = normalizeCscToken(cscToken);
  return id === '1' && token === EXPERIMENTAL_CSC.token;
}

/** Resolve CSC cadastrado da empresa (homologação ou produção). */
export function resolveCscForEnvironment(
  env: FiscalEnvironment | string,
  configured: { cscId?: string | null; cscToken?: string | null },
): { cscId: string; cscToken: string; forcedExperimental: boolean } {
  const ambiente = normalizeFiscalEnvironment(env);
  const cscId = String(configured.cscId || '').replace(/\D/g, '');
  const cscToken = normalizeCscToken(String(configured.cscToken || ''));
  if (!cscId || !cscToken) {
    throw new Error(
      ambiente === 'production'
        ? 'CSC de produção não configurado'
        : 'CSC de homologação não configurado',
    );
  }
  if (isExperimentalCsc(cscId, cscToken)) {
    throw new Error(
      'CSC experimental (000001 / 0123456789) não é válido. ' +
        'Cadastre o CSC da sua empresa no portal SEFAZ-AM (homologação ou produção).',
    );
  }
  if (cscToken.length < 8 || cscToken.length > 48) {
    throw new Error(
      `Token CSC com tamanho inválido (${cscToken.length}). Confira no portal SEFAZ-AM.`,
    );
  }
  return { cscId, cscToken, forcedExperimental: false };
}
