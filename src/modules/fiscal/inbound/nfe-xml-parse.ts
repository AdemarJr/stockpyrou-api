import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) => name === 'det' || name === 'dup' || name === 'rastro',
});

function onlyDigits(v: string) {
  return String(v || '').replace(/\D/g, '');
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v !== null && '#text' in (v as object)) {
    return String((v as { '#text': unknown })['#text'] ?? '');
  }
  return '';
}

export interface ParsedNfeItem {
  line: number;
  cProd: string;
  cEAN: string;
  xProd: string;
  ncm: string;
  uCom: string;
  qCom: number;
  vUnCom: number;
  vProd: number;
  batchNumber?: string;
  expirationDate?: string;
}

export interface ParsedNfe {
  chaveAcesso: string;
  numero: number;
  serie: number;
  modelo: string;
  emitCnpj: string;
  emitNome: string;
  destCnpj: string;
  dataEmissao: string | null;
  valorTotal: number;
  items: ParsedNfeItem[];
}

function extractInfNFe(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const walk = (obj: unknown): Record<string, unknown> | null => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (rec.infNFe && typeof rec.infNFe === 'object') {
      return rec.infNFe as Record<string, unknown>;
    }
    for (const v of Object.values(rec)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  };
  return walk(parsed);
}

export function parseNfeXml(xml: string): ParsedNfe | null {
  if (!xml || !xml.includes('infNFe')) return null;
  const parsed = parser.parse(xml);
  const inf = extractInfNFe(parsed);
  if (!inf) return null;

  const ide = (inf.ide || {}) as Record<string, unknown>;
  const emit = (inf.emit || {}) as Record<string, unknown>;
  const dest = (inf.dest || {}) as Record<string, unknown>;
  const total = (inf.total || {}) as Record<string, unknown>;
  const icmsTot = (total.ICMSTot || {}) as Record<string, unknown>;

  let chave = String(inf['@_Id'] || '').replace(/^NFe/i, '');
  if (!chave || chave.length < 44) {
    const m = xml.match(/Id=["']NFe(\d{44})["']/i);
    if (m) chave = m[1];
  }

  const emitCnpj = onlyDigits(textOf(emit.CNPJ) || textOf(emit.CPF));
  const emitNome = textOf(emit.xNome) || textOf(emit.xFant) || 'Fornecedor';
  const destCnpj = onlyDigits(textOf(dest.CNPJ) || textOf(dest.CPF));

  const items: ParsedNfeItem[] = [];
  for (const detRaw of asArray(inf.det)) {
    if (!detRaw || typeof detRaw !== 'object') continue;
    const det = detRaw as Record<string, unknown>;
    const prod = (det.prod && typeof det.prod === 'object'
      ? det.prod
      : {}) as Record<string, unknown>;
    const nItem = Number(det['@_nItem'] ?? items.length + 1);
    let batchNumber: string | undefined;
    let expirationDate: string | undefined;
    const rastroRaw = asArray(prod.rastro)[0];
    const rastro =
      rastroRaw && typeof rastroRaw === 'object'
        ? (rastroRaw as Record<string, unknown>)
        : null;
    if (rastro) {
      batchNumber = textOf(rastro.nLote) || undefined;
      expirationDate = textOf(rastro.dVal) || undefined;
    }

    let cEAN = textOf(prod.cEAN) || textOf(prod.cEANTrib);
    if (!cEAN || cEAN.toUpperCase() === 'SEM GTIN' || cEAN.length < 8) cEAN = '';

    items.push({
      line: nItem,
      cProd: textOf(prod.cProd),
      cEAN,
      xProd: textOf(prod.xProd),
      ncm: textOf(prod.NCM),
      uCom: textOf(prod.uCom) || 'UN',
      qCom: Number(String(textOf(prod.qCom) || '0').replace(',', '.')) || 0,
      vUnCom: Number(String(textOf(prod.vUnCom) || '0').replace(',', '.')) || 0,
      vProd: Number(String(textOf(prod.vProd) || '0').replace(',', '.')) || 0,
      batchNumber,
      expirationDate,
    });
  }

  return {
    chaveAcesso: chave,
    numero: Number(textOf(ide.nNF)) || 0,
    serie: Number(textOf(ide.serie)) || 1,
    modelo: textOf(ide.mod) || '55',
    emitCnpj,
    emitNome,
    destCnpj,
    dataEmissao: textOf(ide.dhEmi) || textOf(ide.dEmi) || null,
    valorTotal: Number(String(textOf(icmsTot.vNF) || '0').replace(',', '.')) || 0,
    items,
  };
}

/** Resumo resNFe (antes do XML completo). */
export function parseResNfeXml(xml: string): Partial<ParsedNfe> & { chaveAcesso: string } | null {
  if (!xml) return null;
  const parsed = parser.parse(xml);
  const walk = (obj: unknown): Record<string, unknown> | null => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (rec.resNFe) return rec.resNFe as Record<string, unknown>;
    if (rec.chNFe && (rec.CNPJ || rec.xNome)) return rec;
    for (const v of Object.values(rec)) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  };
  const res = walk(parsed);
  if (!res) {
    const m = xml.match(/<chNFe>(\d{44})<\/chNFe>/i);
    if (!m) return null;
    return { chaveAcesso: m[1] };
  }
  const chave = textOf(res.chNFe);
  if (!chave) return null;
  return {
    chaveAcesso: chave,
    emitCnpj: onlyDigits(textOf(res.CNPJ) || textOf(res.CPF)),
    emitNome: textOf(res.xNome),
    dataEmissao: textOf(res.dhEmi) || null,
    valorTotal: Number(String(textOf(res.vNF) || '0').replace(',', '.')) || 0,
    items: [],
  };
}
