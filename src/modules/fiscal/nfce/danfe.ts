import { escapeXml, money } from './nfce-utils.js';

export function buildDanfeHtml(params: {
  accessKey: string;
  numero: number;
  serie: number;
  protocolo: string;
  emitName: string;
  emitCnpj: string;
  destName: string;
  destDoc: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    unidade: string;
  }>;
  total: number;
  qrCodeUrl: string;
  ambiente: string;
  paymentMethod: string;
  authorizedAt: string;
}): string {
  const itemsRows = params.items
    .map(
      (it) =>
        `<tr>
          <td>${escapeXml(it.description)}</td>
          <td style="text-align:right">${it.quantity}</td>
          <td>${escapeXml(it.unidade)}</td>
          <td style="text-align:right">${money(it.unitPrice)}</td>
          <td style="text-align:right">${money(it.total)}</td>
        </tr>`,
    )
    .join('');

  const homologBanner =
    params.ambiente !== 'production'
      ? `<div class="homolog">NFCe EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>DANFE NFC-e ${params.numero}</title>
<style>
  body{font-family:ui-monospace,Menlo,monospace;font-size:12px;max-width:320px;margin:0 auto;padding:12px;color:#111}
  h1{font-size:14px;margin:0 0 4px;text-align:center}
  .muted{color:#555;font-size:11px;text-align:center}
  .homolog{background:#fef3c7;border:1px solid #f59e0b;padding:6px;margin:8px 0;text-align:center;font-weight:700;font-size:10px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{padding:3px 0;border-bottom:1px dashed #ccc;vertical-align:top}
  th{text-align:left;font-size:10px}
  .total{font-size:16px;font-weight:800;margin-top:10px;display:flex;justify-content:space-between}
  .qr{margin-top:12px;word-break:break-all;font-size:9px}
  .key{font-size:10px;letter-spacing:0.5px;margin-top:8px;word-break:break-all}
  @media print{body{max-width:none}.noprint{display:none}}
</style>
</head>
<body>
  ${homologBanner}
  <h1>${escapeXml(params.emitName)}</h1>
  <div class="muted">CNPJ ${escapeXml(params.emitCnpj)} · NFC-e</div>
  <div class="muted">Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>
  <hr/>
  <div><strong>Nº ${params.numero}</strong> Série ${params.serie}</div>
  <div class="muted">Protocolo: ${escapeXml(params.protocolo || '—')}</div>
  <div class="muted">${escapeXml(params.authorizedAt)}</div>
  <div style="margin-top:6px">Consumidor: ${escapeXml(params.destName)}
    ${params.destDoc ? `<br/>Doc: ${escapeXml(params.destDoc)}` : ''}
  </div>
  <table>
    <thead><tr><th>Item</th><th>Qtd</th><th>Un</th><th>Vl</th><th>Tot</th></tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div class="total"><span>TOTAL</span><span>R$ ${money(params.total)}</span></div>
  <div class="muted">Pagamento: ${escapeXml(params.paymentMethod)}</div>
  <div class="key">Chave: ${params.accessKey}</div>
  <div class="qr">
    <strong>Consulta via QR Code / URL SEFAZ:</strong><br/>
    <a href="${escapeXml(params.qrCodeUrl)}">${escapeXml(params.qrCodeUrl)}</a>
  </div>
  <p class="muted noprint" style="margin-top:16px">Use Ctrl/Cmd+P para imprimir</p>
</body>
</html>`;
}
