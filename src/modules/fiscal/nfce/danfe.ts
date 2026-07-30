import { escapeXml, money, onlyDigits } from './nfce-utils.js';

function formatCnpj(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length !== 14) return digits;
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

function formatCep(digits: string): string {
  const d = onlyDigits(digits);
  if (d.length !== 8) return digits;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

function formatPhone(raw: string): string {
  const d = onlyDigits(raw);
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return raw;
}

export function buildDanfeHtml(params: {
  accessKey: string;
  numero: number;
  serie: number;
  protocolo: string;
  emitName: string;
  emitFantasia?: string | null;
  emitCnpj: string;
  emitIe?: string | null;
  emitAddressLines?: string[];
  emitPhone?: string | null;
  emitEmail?: string | null;
  emitLogoUrl?: string | null;
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

  const fantasia =
    params.emitFantasia && params.emitFantasia.trim() && params.emitFantasia !== params.emitName
      ? `<div class="trade">${escapeXml(params.emitFantasia.trim())}</div>`
      : '';

  const addressHtml = (params.emitAddressLines || [])
    .filter((l) => l && l.trim())
    .map((l) => `<div class="addr">${escapeXml(l.trim())}</div>`)
    .join('');

  const contactBits: string[] = [];
  if (params.emitPhone?.trim()) contactBits.push(formatPhone(params.emitPhone.trim()));
  if (params.emitEmail?.trim()) contactBits.push(params.emitEmail.trim());
  const contactHtml = contactBits.length
    ? `<div class="contact">${escapeXml(contactBits.join(' · '))}</div>`
    : '';

  const logoHtml = params.emitLogoUrl?.trim()
    ? `<div class="logo"><img src="${escapeXml(params.emitLogoUrl.trim())}" alt="Logo" /></div>`
    : '';

  const ieLine = params.emitIe?.trim()
    ? ` · IE ${escapeXml(params.emitIe.trim())}`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>DANFE NFC-e ${params.numero}</title>
<style>
  body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;max-width:320px;margin:0 auto;padding:12px;color:#111}
  .logo{text-align:center;margin-bottom:8px}
  .logo img{max-width:140px;max-height:64px;object-fit:contain}
  h1{font-size:14px;margin:0 0 2px;text-align:center;line-height:1.25}
  .trade{font-size:12px;font-weight:700;text-align:center;margin-bottom:4px}
  .muted{color:#555;font-size:11px;text-align:center;line-height:1.35}
  .addr,.contact{color:#333;font-size:10px;text-align:center;line-height:1.35}
  .homolog{background:#fef3c7;border:1px solid #f59e0b;padding:6px;margin:8px 0;text-align:center;font-weight:700;font-size:10px}
  hr{border:none;border-top:1px dashed #bbb;margin:10px 0}
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
  ${logoHtml}
  <h1>${escapeXml(params.emitName)}</h1>
  ${fantasia}
  <div class="muted">CNPJ ${escapeXml(formatCnpj(params.emitCnpj))}${ieLine}</div>
  ${addressHtml}
  ${contactHtml}
  <div class="muted" style="margin-top:6px">Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica (NFC-e)</div>
  <hr/>
  <div><strong>Nº ${params.numero}</strong> Série ${params.serie}</div>
  <div class="muted" style="text-align:left">Protocolo: ${escapeXml(params.protocolo || '—')}</div>
  <div class="muted" style="text-align:left">${escapeXml(params.authorizedAt)}</div>
  <div style="margin-top:6px">Consumidor: ${escapeXml(params.destName)}
    ${params.destDoc ? `<br/>Doc: ${escapeXml(params.destDoc)}` : ''}
  </div>
  <table>
    <thead><tr><th>Item</th><th>Qtd</th><th>Un</th><th>Vl</th><th>Tot</th></tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <div class="total"><span>TOTAL</span><span>R$ ${money(params.total)}</span></div>
  <div class="muted" style="text-align:left">Pagamento: ${escapeXml(params.paymentMethod)}</div>
  <div class="key">Chave: ${params.accessKey}</div>
  <div class="qr">
    <strong>Consulta via QR Code / URL SEFAZ:</strong><br/>
    <a href="${escapeXml(params.qrCodeUrl)}">${escapeXml(params.qrCodeUrl)}</a>
  </div>
  <p class="muted noprint" style="margin-top:16px">Use Ctrl/Cmd+P para imprimir</p>
</body>
</html>`;
}

/** Monta linhas de endereço a partir da config fiscal. */
export function buildEmitAddressLines(cfg: {
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  uf?: string | null;
  cep?: string | null;
}): string[] {
  const street = [cfg.logradouro, cfg.numero].filter(Boolean).join(', ');
  const withComp = [street, cfg.complemento].filter(Boolean).join(' — ');
  const city = [cfg.bairro, [cfg.municipio, cfg.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  const cep = cfg.cep ? `CEP ${formatCep(String(cfg.cep))}` : '';
  return [withComp, city, cep].filter((l) => l && String(l).trim());
}
