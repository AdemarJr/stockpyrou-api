import type { AgentOptions } from 'node:https';
import { getTlsCredentials } from '../certificate/xml-signer.js';

/**
 * Opções TLS para SOAP SEFAZ (NFC-e AM + DF-e nacional).
 *
 * - Cliente: PEM key + cadeia completa do A1 (leaf + intermediárias).
 * - Servidor: por padrão NÃO exige cadeia no trust store do Node
 *   (`rejectUnauthorized: false`), porque muitos hosts SEFAZ usam ICP-Brasil
 *   e o Node/Railway não traz essas CAs → "self-signed certificate in certificate chain".
 *
 * Para forçar verificação estrita: SEFAZ_TLS_STRICT=true
 */
export async function getSefazHttpsTlsOptions(companyId: string): Promise<{
  key: string;
  cert: string;
  rejectUnauthorized: boolean;
  checkServerIdentity?: AgentOptions['checkServerIdentity'];
}> {
  const tls = await getTlsCredentials(companyId);
  const strict = String(process.env.SEFAZ_TLS_STRICT || '').toLowerCase() === 'true';

  if (strict) {
    return {
      key: tls.key,
      cert: tls.cert,
      rejectUnauthorized: true,
    };
  }

  return {
    key: tls.key,
    cert: tls.cert,
    rejectUnauthorized: false,
    // Evita falhas extras de hostname em alguns endpoints SEFAZ
    checkServerIdentity: () => undefined,
  };
}
