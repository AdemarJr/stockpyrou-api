import { createHash } from 'node:crypto';
import { escapeXml, onlyDigits } from './nfce-utils.js';

export interface RespTecConfig {
  cnpj: string;
  xContato: string;
  email: string;
  fone: string;
  /** Identificador CSRT (1–99); opcional até a SEFAZ exigir 975. */
  idCsrt?: string | null;
  /** Código CSRT secreto (para hashCSRT). */
  csrt?: string | null;
}

/**
 * Responsável técnico = software house (não a loja).
 * Ordem: override da empresa → variáveis de ambiente RESP_TEC_*.
 */
export function resolveRespTec(
  override?: Partial<Record<keyof RespTecConfig, string | null | undefined>> | null,
): RespTecConfig {
  const pick = (a?: string | null, b?: string, c?: string) =>
    String(a || b || c || '').trim();

  const cnpj = onlyDigits(
    pick(override?.cnpj, process.env.RESP_TEC_CNPJ, process.env.RESPONSAVEL_TECNICO_CNPJ),
  );
  const xContato = pick(
    override?.xContato,
    process.env.RESP_TEC_CONTATO,
    process.env.RESPONSAVEL_TECNICO_CONTATO,
  );
  const email = pick(
    override?.email,
    process.env.RESP_TEC_EMAIL,
    process.env.RESPONSAVEL_TECNICO_EMAIL,
  );
  const fone = onlyDigits(
    pick(override?.fone, process.env.RESP_TEC_FONE, process.env.RESPONSAVEL_TECNICO_FONE),
  );
  const idCsrt = pick(
    override?.idCsrt,
    process.env.RESP_TEC_ID_CSRT,
    process.env.RESPONSAVEL_TECNICO_ID_CSRT,
  );
  const csrt = pick(
    override?.csrt,
    process.env.RESP_TEC_CSRT,
    process.env.RESPONSAVEL_TECNICO_CSRT,
  );

  if (cnpj.length !== 14) {
    throw new Error(
      'Responsável técnico: informe CNPJ (14 dígitos) em Configurações fiscais ou RESP_TEC_CNPJ no servidor.',
    );
  }
  if (xContato.length < 2) {
    throw new Error('Responsável técnico: informe o nome de contato (RESP_TEC_CONTATO).');
  }
  if (email.length < 6 || !email.includes('@')) {
    throw new Error('Responsável técnico: informe e-mail válido (RESP_TEC_EMAIL).');
  }
  if (fone.length < 6 || fone.length > 14) {
    throw new Error('Responsável técnico: informe telefone com DDD (RESP_TEC_FONE).');
  }

  return {
    cnpj,
    xContato: xContato.slice(0, 60),
    email: email.slice(0, 60),
    fone,
    idCsrt: idCsrt || null,
    csrt: csrt || null,
  };
}

/** hashCSRT = Base64(SHA-1(CSRT + chaveAcesso)) — NT 2018.005 / XSD. */
export function buildHashCsrt(csrt: string, accessKey: string): string {
  return createHash('sha1').update(`${csrt}${accessKey}`, 'utf8').digest('base64');
}

/** Grupo ZD — infRespTec (obrigatório na SEFAZ-AM — rejeição 972). */
export function buildInfRespTecXml(accessKey: string, cfg: RespTecConfig): string {
  let xml =
    `<infRespTec>` +
    `<CNPJ>${cfg.cnpj}</CNPJ>` +
    `<xContato>${escapeXml(cfg.xContato)}</xContato>` +
    `<email>${escapeXml(cfg.email)}</email>` +
    `<fone>${cfg.fone}</fone>`;

  const idRaw = onlyDigits(String(cfg.idCsrt || ''));
  const csrt = String(cfg.csrt || '').trim();
  if (idRaw && csrt) {
    const idCSRT = idRaw.padStart(2, '0').slice(-2);
    const hashCSRT = buildHashCsrt(csrt, accessKey);
    xml += `<idCSRT>${idCSRT}</idCSRT><hashCSRT>${hashCSRT}</hashCSRT>`;
  }

  xml += `</infRespTec>`;
  return xml;
}
