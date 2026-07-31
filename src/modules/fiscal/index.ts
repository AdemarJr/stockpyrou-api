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
  listNfce,
  listPendingNfceSales,
} from './nfce/create-nfce.service.js';
import {
  getInboundPreview,
  ignoreInboundNfe,
  listInboundNfe,
  markInboundImported,
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
  listNfce,
  listPendingNfceSales,
  syncInboundNfe,
  listInboundNfe,
  getInboundPreview,
  resolveInboundSupplier,
  markInboundImported,
  ignoreInboundNfe,
};

export type { UpsertFiscalConfigInput, FiscalEnvironment };
