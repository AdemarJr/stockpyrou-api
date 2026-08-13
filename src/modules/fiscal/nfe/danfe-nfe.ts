import { escapeXml, money, onlyDigits } from '../nfce/nfce-utils.js';
import { formatAccessKey } from '../nfce/danfe.js';

function formatCnpj(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length !== 14) return digits;
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

/** DANFE NF-e simplificado (A4 retrato) para visualização/impressão. */
export async function buildNfeDanfeHtml(params: {
  accessKey: string;
  numero: number;
  serie: number;
  protocolo: string;
  emitName: string;
  emitFantasia?: string | null;
  emitCnpj: string;
  emitIe?: string | null;
  emitAddressLines?: string[];
  destName: string;
  destDoc: string;
  destAddressLines?: string[];
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    unidade: string;
    ncm?: string;
    cfop?: string;
  }>;
  total: number;
  ambiente: string;
  paymentMethod: string;
  authorizedAt: string;
}): Promise<string> {
  const itemsRows = params.items
    .map(
      (it, idx) =>
        `<tr>
          <td>${idx + 1}</td>
          <td>${escapeXml(it.description)}</td>
          <td>${escapeXml(it.ncm || '')}</td>
          <td>${escapeXml(it.cfop || '')}</td>
          <td class="r">${it.quantity}</td>
          <td>${escapeXml(it.unidade)}</td>
          <td class="r">${money(it.unitPrice)}</td>
          <td class="r">${money(it.total)}</td>
        </tr>`,
    )
    .join('');

  const homolog =
    params.ambiente !== 'production'
      ? `<div class="homolog">NF-e EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>`
      : '';

  const fantasia =
    params.emitFantasia && params.emitFantasia.trim() && params.emitFantasia !== params.emitName
      ? `<div class="trade">${escapeXml(params.emitFantasia.trim())}</div>`
      : '';

  const emitAddr = (params.emitAddressLines || [])
    .filter(Boolean)
    .map((l) => `<div class="addr">${escapeXml(l)}</div>`)
    .join('');

  const destAddr = (params.destAddressLines || [])
    .filter(Boolean)
    .map((l) => `<div class="addr">${escapeXml(l)}</div>`)
    .join('');

  const ieLine = params.emitIe?.trim() ? ` · IE ${escapeXml(params.emitIe.trim())}` : '';
  const chave = formatAccessKey(params.accessKey);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DANFE NF-e ${params.numero}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;background:#fff;margin:0;padding:16px;max-width:800px}
  h1{font-size:16px;margin:0 0 2px}
  .trade{font-size:12px;font-weight:700;margin-bottom:4px}
  .muted{color:#333;font-size:10px;line-height:1.35}
  .addr{font-size:10px;line-height:1.3}
  .title{text-align:center;font-weight:800;font-size:13px;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.04em}
  .homolog{background:#fef3c7;border:1px solid #000;padding:8px;margin:8px 0;text-align:center;font-weight:800;font-size:11px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}
  .box{border:1px solid #000;padding:8px}
  .box h2{font-size:10px;margin:0 0 4px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid #333;padding:4px 6px;font-size:10px;vertical-align:top}
  th{background:#f3f4f6;text-align:left;text-transform:uppercase;font-size:9px}
  td.r,th.r{text-align:right}
  .total{font-size:14px;font-weight:800;margin-top:10px;display:flex;justify-content:space-between}
  .key{margin-top:12px;text-align:center;font-size:11px;letter-spacing:.5px;word-break:break-word}
  .footer{margin-top:14px;text-align:center;font-size:9px;color:#444}
  @media print{body{padding:0;max-width:none}.noprint{display:none!important}}
</style>
</head>
<body>
  ${homolog}
  <div class="title">Documento Auxiliar da Nota Fiscal Eletrônica — DANFE</div>
  <h1>${escapeXml(params.emitName)}</h1>
  ${fantasia}
  <div class="muted">CNPJ ${escapeXml(formatCnpj(params.emitCnpj))}${ieLine}</div>
  ${emitAddr}
  <div class="grid">
    <div class="box">
      <h2>NF-e</h2>
      <div><strong>Nº ${params.numero}</strong> · Série ${params.serie}</div>
      <div class="muted">Protocolo: ${escapeXml(params.protocolo || '—')}</div>
      <div class="muted">${escapeXml(params.authorizedAt)}</div>
      <div class="muted">Pagamento: ${escapeXml(params.paymentMethod)}</div>
    </div>
    <div class="box">
      <h2>Destinatário</h2>
      <div><strong>${escapeXml(params.destName)}</strong></div>
      ${params.destDoc ? `<div class="muted">Doc: ${escapeXml(params.destDoc)}</div>` : ''}
      ${destAddr}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Produto</th><th>NCM</th><th>CFOP</th>
        <th class="r">Qtd</th><th>Un</th><th class="r">Vl unit</th><th class="r">Total</th>
      </tr>
    </thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div class="total"><span>TOTAL DA NOTA</span><span>R$ ${money(params.total)}</span></div>
  <div class="key"><strong>Chave de acesso</strong><br/>${escapeXml(chave)}</div>
  <div class="footer">Consulte a autenticidade no portal da SEFAZ do seu Estado</div>
  <p class="muted noprint" style="margin-top:16px;text-align:center">Use Ctrl/Cmd+P para imprimir</p>
</body>
</html>`;
}
