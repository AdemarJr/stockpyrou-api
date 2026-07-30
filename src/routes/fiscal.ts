import { Hono } from 'hono';
import type { AppVariables } from '../middleware/auth.js';
import { requireAuth, requireCompany } from '../middleware/auth.js';
import {
  deleteCertificate,
  getCertificateStatus,
  getFiscalConfig,
  getFiscalReadiness,
  getSefazEndpoints,
  saveFiscalConfig,
  uploadCertificate,
  type FiscalEnvironment,
} from '../modules/fiscal/index.js';

const fiscal = new Hono<{ Variables: AppVariables }>();

fiscal.use('*', requireAuth, requireCompany);

function requireSettings(c: { get: (k: 'auth') => AppVariables['auth'] }) {
  const auth = c.get('auth');
  const ok =
    auth.permissions?.canManageSettings ||
    auth.role === 'admin' ||
    auth.role === 'superadmin' ||
    auth.role === 'super_admin';
  return !!ok;
}

/** Status de prontidão para o PDV (qualquer usuário autenticado da empresa). */
fiscal.get('/readiness', async (c) => {
  const companyId = c.get('companyId');
  try {
    const readiness = await getFiscalReadiness(companyId);
    return c.json({ success: true, ...readiness });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) {
      return c.json({
        success: true,
        moduleEnabled: false,
        configComplete: false,
        ready: false,
        emissionAvailable: false,
        reasons: ['Execute a migration scripts/add_fiscal_config.sql no banco'],
        config: null,
        certificate: { present: false, subjectCn: null, validUntil: null, expired: false },
      });
    }
    console.error('[fiscal/readiness]', err);
    return c.json({ error: message }, 500);
  }
});

fiscal.get('/config', async (c) => {
  const companyId = c.get('companyId');
  try {
    const config = await getFiscalConfig(companyId);
    return c.json({ success: true, config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) {
      return c.json({ success: true, config: null, needsMigration: true });
    }
    return c.json({ error: message }, 500);
  }
});

fiscal.put('/config', async (c) => {
  if (!requireSettings(c)) {
    return c.json({ error: 'Sem permissão para alterar configuração fiscal' }, 403);
  }
  const companyId = c.get('companyId');
  const body = await c.req.json().catch(() => ({}));

  const input = {
    cnpj: String(body.cnpj || ''),
    ie: String(body.ie || ''),
    razaoSocial: String(body.razaoSocial || body.razao_social || ''),
    nomeFantasia: body.nomeFantasia ?? body.nome_fantasia ?? null,
    logradouro: String(body.logradouro || ''),
    numero: String(body.numero || ''),
    complemento: body.complemento ?? null,
    bairro: String(body.bairro || ''),
    municipio: String(body.municipio || ''),
    codigoMunicipio: String(body.codigoMunicipio || body.codigo_municipio || ''),
    uf: String(body.uf || 'AM'),
    cep: String(body.cep || ''),
    crt: body.crt != null ? Number(body.crt) : 1,
    ambiente: (body.ambiente || 'homologation') as FiscalEnvironment,
    serieNfce: body.serieNfce != null ? Number(body.serieNfce) : undefined,
    numeroNfce: body.numeroNfce != null ? Number(body.numeroNfce) : undefined,
    cscId: body.cscId ?? body.csc_id ?? undefined,
    cscToken: body.cscToken ?? body.csc_token ?? undefined,
    enabled: body.enabled != null ? !!body.enabled : undefined,
  };

  if (input.ambiente === 'production') {
    // Não bloqueia salvar, mas avisa — emissão em produção só na etapa 12
  }

  try {
    const config = await saveFiscalConfig(companyId, input);
    const endpoints = getSefazEndpoints(config.ambiente);
    return c.json({
      success: true,
      config,
      endpoints: {
        qrCode: endpoints.qrCode,
        status: endpoints.status,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[fiscal/config PUT]', err);
    const status = /inválido|obrigatór/i.test(message) ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

fiscal.get('/certificate', async (c) => {
  const companyId = c.get('companyId');
  try {
    const certificate = await getCertificateStatus(companyId);
    return c.json({ success: true, certificate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/relation .* does not exist/i.test(message)) {
      return c.json({
        success: true,
        certificate: {
          present: false,
          subjectCn: null,
          serialNumber: null,
          validFrom: null,
          validUntil: null,
          fingerprintSha256: null,
          expired: false,
        },
      });
    }
    return c.json({ error: message }, 500);
  }
});

fiscal.post('/certificate', async (c) => {
  if (!requireSettings(c)) {
    return c.json({ error: 'Sem permissão para alterar certificado' }, 403);
  }
  const companyId = c.get('companyId');
  const body = await c.req.json().catch(() => ({}));
  const fileBase64 = String(body.fileBase64 || body.certificate || '');
  const password = String(body.password || '');

  if (!fileBase64) return c.json({ error: 'Envie o arquivo do certificado (base64)' }, 400);

  try {
    const certificate = await uploadCertificate({
      companyId,
      fileBase64,
      password,
      subjectCn: body.subjectCn ?? null,
      validFrom: body.validFrom ?? null,
      validUntil: body.validUntil ?? null,
    });
    return c.json({ success: true, certificate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[fiscal/certificate POST]', err);
    const status = /obrigatór|inválido|pequeno|maior/i.test(message) ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

fiscal.delete('/certificate', async (c) => {
  if (!requireSettings(c)) {
    return c.json({ error: 'Sem permissão para remover certificado' }, 403);
  }
  const companyId = c.get('companyId');
  try {
    await deleteCertificate(companyId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/** Endpoints SEFAZ do ambiente configurado (sem segredos). */
fiscal.get('/endpoints', async (c) => {
  const companyId = c.get('companyId');
  const config = await getFiscalConfig(companyId);
  const ambiente = (config?.ambiente || 'homologation') as FiscalEnvironment;
  const endpoints = getSefazEndpoints(ambiente);
  return c.json({ success: true, ambiente, endpoints });
});

export default fiscal;
