/**
 * Endpoints oficiais NFC-e SEFAZ-AM (modelo 65, XML 4.00).
 * Nunca misturar URLs entre ambientes.
 */

export type FiscalEnvironment = 'development' | 'homologation' | 'production';

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

/**
 * SOAP do ambiente experimental (nfce-services-nac).
 * Endpoints sem sufixo "4", mas aceitam layout 4.00.
 */
const soapDevNac: SefazSoapActions = {
  authorization: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeAutorizacao/nfeAutorizacaoLote',
  authorizationNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeAutorizacao',
  consultation: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeConsulta2/nfeConsultaNF2',
  consultationNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeConsulta2',
  status: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeStatusServico2/nfeStatusServicoNF2',
  statusNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeStatusServico2',
  event: 'http://www.portalfiscal.inf.br/nfe/wsdl/RecepcaoEvento/nfeRecepcaoEvento',
  eventNs: 'http://www.portalfiscal.inf.br/nfe/wsdl/RecepcaoEvento',
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

/**
 * Ambiente experimental SEFAZ-AM (desenvolvedores / software house).
 * NÃO confundir com homologação oficial do contribuinte.
 * CSC obrigatório neste ambiente: ID 000001 / token 0123456789.
 * @see https://portalnfce.sefaz.am.gov.br/desenvolvedor/ambiente-de-homologacao-para-desenvolvedores/
 */
export const sefazDevelopment: SefazEndpointSet = {
  authorization:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/NfeAutorizacao',
  authorizationReturn:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/NfeRetAutorizacao',
  consultation:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/NfeConsulta2',
  status:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/NfeStatusServico2',
  inutilization:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/NfeInutilizacao2',
  event:
    'https://homnfce.sefaz.am.gov.br/nfce-services-nac/services/RecepcaoEvento',
  qrCode: 'https://sistemas.sefaz.am.gov.br/nfceweb-hom/consultarNFCe.jsp?',
  urlChave: 'https://sistemas.sefaz.am.gov.br/nfceweb-hom/consultarNFCe.jsp',
  soap: soapDevNac,
};

export const sefazEnvironmentConfig = {
  development: sefazDevelopment,
  homologation: sefazHomologation,
  production: sefazProduction,
} as const;

export function getSefazEndpoints(env: FiscalEnvironment): SefazEndpointSet {
  return sefazEnvironmentConfig[env];
}

/** CSC exclusivo do ambiente experimental (nunca usar em produção/homologação oficial). */
export const EXPERIMENTAL_CSC = {
  id: '000001',
  token: '0123456789',
} as const;

/** Resolve CSC: no ambiente development SEFAZ-AM exige o CSC experimental fixo. */
export function resolveCscForEnvironment(
  env: FiscalEnvironment,
  configured: { cscId?: string | null; cscToken?: string | null },
): { cscId: string; cscToken: string; forcedExperimental: boolean } {
  if (env === 'development') {
    return {
      cscId: EXPERIMENTAL_CSC.id,
      cscToken: EXPERIMENTAL_CSC.token,
      forcedExperimental: true,
    };
  }
  const cscId = String(configured.cscId || '').trim();
  const cscToken = String(configured.cscToken || '').trim();
  if (!cscId || !cscToken) {
    throw new Error('CSC não configurado');
  }
  return { cscId, cscToken, forcedExperimental: false };
}
