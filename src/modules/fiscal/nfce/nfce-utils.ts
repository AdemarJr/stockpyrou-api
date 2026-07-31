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

export function padLeft(value: string | number, len: number, ch = '0'): string {
  return String(value).padStart(len, ch);
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
  tipoEmissao?: number;
  cnf?: string;
}): string {
  const cUF = UF_IBGE[params.uf.toUpperCase()] || '13';
  const yy = String(params.emissionDate.getFullYear()).slice(-2);
  const mm = padLeft(params.emissionDate.getMonth() + 1, 2);
  const cnpj = padLeft(onlyDigits(params.cnpj), 14);
  const mod = '65';
  const serie = padLeft(params.serie, 3);
  const nNF = padLeft(params.numero, 9);
  const tpEmis = String(params.tipoEmissao ?? 1);
  const cNF = params.cnf
    ? padLeft(onlyDigits(params.cnf).slice(0, 8), 8)
    : padLeft(Math.floor(Math.random() * 99999999), 8);
  const key43 = `${cUF}${yy}${mm}${cnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
  return key43 + accessKeyCheckDigit(key43);
}

export function formatNFeDate(d: Date): string {
  const offset = -3; // America/Manaus approx for AM; ISO with offset
  const local = new Date(d.getTime() + offset * 3600 * 1000);
  const y = local.getUTCFullYear();
  const m = padLeft(local.getUTCMonth() + 1, 2);
  const day = padLeft(local.getUTCDate(), 2);
  const h = padLeft(local.getUTCHours(), 2);
  const min = padLeft(local.getUTCMinutes(), 2);
  const s = padLeft(local.getUTCSeconds(), 2);
  return `${y}-${m}-${day}T${h}:${min}:${s}-03:00`;
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
