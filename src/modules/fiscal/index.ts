import { getCertificateStatus } from './certificate/certificate.service.js';
import {
  getFiscalConfig,
  getFiscalReadiness,
  saveFiscalConfig,
  type UpsertFiscalConfigInput,
} from './config/fiscal-config.service.js';
import {
  deleteCertificate,
  uploadCertificate,
} from './certificate/certificate.service.js';
import { getSefazEndpoints, type FiscalEnvironment } from './sefaz/sefaz-endpoints.js';
import {
  cancelNfce,
  createAndAuthorizeFromSale,
  getNfceById,
  getNfceBySale,
  getNfceRaw,
  getDanfeHtml,
  listNfce,
  listPendingNfceSales,
} from './nfce/create-nfce.service.js';
import {
  cancelNfe,
  createAndAuthorizeNfeFromSale,
  getNfeById,
  getNfeBySale,
  getNfeRaw,
  getNfeDanfeHtml,
  listNfe,
} from './nfe/create-nfe.service.js';
import {
  getInboundPreview,
  ignoreInboundNfe,
  listInboundNfe,
  markInboundImported,
  resetInboundNsu,
  resolveInboundSupplier,
  syncInboundNfe,
} from './inbound/inbound.service.js';

export {
  getCertificateStatus,
  getFiscalConfig,
  getFiscalReadiness,
  saveFiscalConfig,
  deleteCertificate,
  uploadCertificate,
  getSefazEndpoints,
  cancelNfce,
  createAndAuthorizeFromSale,
  getNfceById,
  getNfceBySale,
  getNfceRaw,
  getDanfeHtml,
  listNfce,
  listPendingNfceSales,
  cancelNfe,
  createAndAuthorizeNfeFromSale,
  getNfeById,
  getNfeBySale,
  getNfeRaw,
  getNfeDanfeHtml,
  listNfe,
  syncInboundNfe,
  listInboundNfe,
  getInboundPreview,
  resolveInboundSupplier,
  markInboundImported,
  ignoreInboundNfe,
  resetInboundNsu,
};

export type { UpsertFiscalConfigInput, FiscalEnvironment };
