import { createHash } from 'node:crypto';

/** UF code for chave de acesso (AM = 13). */
export const UF_IBGE: Record<string, string> = {
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23', DF: '53',
  ES: '32', GO: '52', MA: '21', MT: '51', MS: '50', MG: '31', PA: '15',
  PB: '25', PR: '41', PE: '26', PI: '22', RJ: '33', RN: '24', RS: '43',
  RO: '11', RR: '14', SC: '42', SP: '35', SE: '28', TO: '17',
};

export function onlyDigits(v: string): string {
  return String(v || '').replace(/\D/g, '');
}

/** Rejeita sequências repetidas (000… / 111…) usadas em CPF/CNPJ inválidos. */
function isRepeatedDigits(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

function mod11CheckDigit(base: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += Number(base[i]) * weights[i];
  }
  const mod = sum % 11;
  return mod < 2 ? 0 : 11 - mod;
}

/** Valida CPF (11 dígitos + DV). Vazio/errado → false. */
export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || isRepeatedDigits(digits)) return false;
  const d1 = mod11CheckDigit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(digits[9])) return false;
  const d2 = mod11CheckDigit(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(digits[10]);
}

/** Valida CNPJ (14 dígitos + DV). Vazio/errado → false. */
export function isValidCnpj(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || isRepeatedDigits(digits)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = mod11CheckDigit(digits.slice(0, 12), w1);
  if (d1 !== Number(digits[12])) return false;
  const d2 = mod11CheckDigit(digits.slice(0, 13), w2);
  return d2 === Number(digits[13]);
}

/**
 * Destinatário NFC-e só entra no XML com CPF/CNPJ válido.
 * Em branco, incompleto ou com DV errado → null (consumidor não identificado).
 */
export function resolveNfceDestDocument(
  rawDigits: string | null | undefined,
  preferredType?: 'cpf' | 'cnpj' | null,
): { documentDigits: string; documentType: 'cpf' | 'cnpj' } | null {
  const digits = onlyDigits(String(rawDigits || ''));
  if (!digits) return null;
  if (preferredType === 'cnpj' || digits.length === 14) {
    return isValidCnpj(digits) ? { documentDigits: digits, documentType: 'cnpj' } : null;
  }
  if (preferredType === 'cpf' || digits.length === 11) {
    return isValidCpf(digits) ? { documentDigits: digits, documentType: 'cpf' } : null;
  }
  return null;
}

export function padLeft(value: string | number, len: number, ch = '0'): string {
  return String(value).padStart(len, ch);
}

/** Fuso de emissão NFC-e/NF-e (Manaus/AM — UTC-4, sem horário de verão). */
export const NFE_EMISSION_OFFSET_HOURS = -4;

/** Data/hora civil de emissão com offset fixo — base única para AAMM (chave) e dhEmi (XML). */
export function emissionPartsWithOffset(
  d: Date,
  offsetHours = NFE_EMISSION_OFFSET_HOURS,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const local = new Date(d.getTime() + offsetHours * 3600 * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
  };
}

/** Dígito verificador módulo 11 da chave NFC-e/NF-e. */
export function accessKeyCheckDigit(key43: string): string {
  const weights = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  let w = 0;
  for (let i = key43.length - 1; i >= 0; i--) {
    sum += Number(key43[i]) * weights[w];
    w = (w + 1) % weights.length;
  }
  const mod = sum % 11;
  const dv = mod === 0 || mod === 1 ? 0 : 11 - mod;
  return String(dv);
}

/**
 * Chave de acesso 44 dígitos:
 * cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1) + cNF(8) + cDV(1)
 */
export function buildAccessKey(params: {
  uf: string;
  emissionDate: Date;
  cnpj: string;
  serie: number;
  numero: number;
  /** Modelo do documento: 65=NFC-e, 55=NF-e. Default 65. */
  modelo?: '55' | '65' | string;
  tipoEmissao?: number;
  cnf?: string;
}): string {
  const cUF = UF_IBGE[params.uf.toUpperCase()] || '13';
  // AAMM deve coincidir com o mês/ano de dhEmi (Manaus). Servidor UTC após 20h AM gerava 502.
  const { year, month } = emissionPartsWithOffset(params.emissionDate);
  const yy = String(year).slice(-2);
  const mm = padLeft(month, 2);
  const cnpj = padLeft(onlyDigits(params.cnpj), 14);
  const mod = String(params.modelo || '65').replace(/\D/g, '').padStart(2, '0').slice(-2) || '65';
  const serie = padLeft(params.serie, 3);
  const nNF = padLeft(params.numero, 9);
  const tpEmis = String(params.tipoEmissao ?? 1);
  const cNF = params.cnf
    ? padLeft(onlyDigits(params.cnf).slice(0, 8), 8)
    : padLeft(Math.floor(Math.random() * 99999999), 8);
  const key43 = `${cUF}${yy}${mm}${cnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
  return key43 + accessKeyCheckDigit(key43);
}

/** dhEmi com offset de Manaus (UTC-4, sem horário de verão). */
export function formatNFeDate(d: Date, offsetHours = NFE_EMISSION_OFFSET_HOURS): string {
  const { year, month, day, hour, minute, second } = emissionPartsWithOffset(d, offsetHours);
  const sign = offsetHours >= 0 ? '+' : '-';
  const abs = padLeft(Math.abs(offsetHours), 2);
  return `${year}-${padLeft(month, 2)}-${padLeft(day, 2)}T${padLeft(hour, 2)}:${padLeft(minute, 2)}:${padLeft(second, 2)}${sign}${abs}:00`;
}

export function money(n: number): string {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

/** Quantidade comercial/tributável (TDec_1104 — até 4 casas). */
export function qty(n: number): string {
  return (Math.round(Number(n) * 10000) / 10000).toFixed(4);
}

/** Unidade de medida NFC-e (1–6 chars). */
export function nfeUnit(raw: string | null | undefined): string {
  const u = String(raw || 'UN')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  return u || 'UN';
}

/** Código IBGE município (7 dígitos). Default Manaus/AM. */
export function nfeCodigoMunicipio(raw: string | null | undefined, fallback = '1302603'): string {
  const d = onlyDigits(String(raw || ''));
  if (d.length === 7) return d;
  return fallback;
}

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** SHA-1 hex uppercase — usado em hash CSC QR Code NFC-e. */
export function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').toUpperCase();
}

/** Mapeia forma de pagamento PDV → tPag NFC-e. */
export function mapPaymentCode(method: string): string {
  switch (String(method || '').toLowerCase()) {
    case 'money':
      return '01';
    case 'cheque':
      return '02';
    case 'credit':
      return '03';
    case 'debit':
      return '04';
    case 'pix':
      return '17';
    case 'fiado':
    case 'boleto':
      return '05';
    default:
      return '99';
  }
}
