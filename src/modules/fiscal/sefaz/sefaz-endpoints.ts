/**
 * Endpoints oficiais NFC-e SEFAZ-AM (modelo 65, XML 4.00).
 * Nunca misturar URLs entre ambientes.
 */

export type FiscalEnvironment = 'development' | 'homologation' | 'production';

export interface SefazEndpointSet {
  authorization: string;
  authorizationReturn: string;
  consultation: string;
  status: string;
  inutilization: string;
  event: string;
  qrCode: string;
}

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
};

/**
 * Ambiente experimental SEFAZ-AM (desenvolvedores).
 * NÃO confundir com homologação oficial.
 * CSC de teste: 0123456789 / ID 000001 — só neste ambiente.
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
