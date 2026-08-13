import QRCode from 'qrcode';
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

/** Chave de acesso em blocos de 4 dígitos (padrão DANFE). */
export function formatAccessKey(key: string): string {
  const d = onlyDigits(key);
  if (!d) return key;
  return d.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

export async function qrCodeDataUrl(content: string): Promise<string> {
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 200,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

function danfeStyles(): string {
  return `
  *{box-sizing:border-box}
  body{
    font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace;
    font-size:11px;
    max-width:300px;
    margin:0 auto;
    padding:10px 12px;
    color:#000;
    background:#fff;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .logo{text-align:center;margin-bottom:6px}
  .logo img{max-width:120px;max-height:56px;object-fit:contain}
  h1{font-size:13px;margin:0 0 2px;text-align:center;line-height:1.25;font-weight:800}
  .trade{font-size:11px;font-weight:700;text-align:center;margin-bottom:4px}
  .muted{color:#333;font-size:10px;text-align:center;line-height:1.35}
  .addr,.contact{color:#222;font-size:9px;text-align:center;line-height:1.35}
  .title-doc{font-size:9px;text-align:center;margin-top:6px;font-weight:700;text-transform:uppercase}
  .homolog{
    background:#fef3c7;border:1px solid #000;padding:6px;margin:8px 0;
    text-align:center;font-weight:800;font-size:9px
  }
  hr{border:none;border-top:1px dashed #000;margin:8px 0}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th,td{padding:2px 0;border-bottom:1px dashed #999;vertical-align:top;font-size:10px}
  th{text-align:left;font-size:9px;text-transform:uppercase}
  .total{
    font-size:14px;font-weight:800;margin-top:8px;
    display:flex;justify-content:space-between;align-items:baseline
  }
  .pay{font-size:10px;margin-top:4px}
  .key-block{margin-top:10px;text-align:center}
  .key-label{font-size:9px;font-weight:700;text-transform:uppercase;margin-bottom:4px}
  .key{font-size:9px;letter-spacing:0.4px;word-break:break-word;line-height:1.4}
  .qr-block{
    margin-top:12px;text-align:center;page-break-inside:avoid;break-inside:avoid
  }
  .qr-block strong{display:block;font-size:9px;margin-bottom:6px;text-transform:uppercase}
  .qr-img{
    display:block;margin:0 auto;width:140px;height:140px;
    image-rendering:pixelated;-webkit-print-color-adjust:exact;print-color-adjust:exact
  }
  .qr-url{margin-top:6px;font-size:7px;word-break:break-all;color:#444;line-height:1.3}
  .footer{margin-top:10px;text-align:center;font-size:8px;color:#333}
  @media print{
    body{max-width:none;padding:0;margin:0}
    .noprint{display:none!important}
    .qr-img{width:140px!important;height:140px!important}
    a{color:#000;text-decoration:none}
  }
`;
}

function qrBlockHtml(qrDataUrl: string | null, qrCodeUrl: string): string {
  const img = qrDataUrl
    ? `<img class="qr-img" src="${qrDataUrl}" width="140" height="140" alt="QR Code NFC-e" />`
    : '';
  return `<div class="qr-block">
    <strong>Consulte pela chave de acesso em</strong>
    ${img}
    <div class="qr-url"><a href="${escapeXml(qrCodeUrl)}">${escapeXml(qrCodeUrl)}</a></div>
  </div>`;
}

/**
 * Injeta/atualiza QR embutido em DANFEs antigos (só URL em texto).
 * Persiste melhor se o caller gravar o HTML de volta no banco.
 */
export async function ensureDanfeQrEmbedded(
  html: string,
  qrCodeUrl: string | null | undefined,
): Promise<{ html: string; updated: boolean }> {
  if (!qrCodeUrl?.trim()) return { html, updated: false };
  if (html.includes('class="qr-img"') && html.includes('data:image/')) {
    return { html, updated: false };
  }

  const dataUrl = await qrCodeDataUrl(qrCodeUrl.trim());
  const block = qrBlockHtml(dataUrl, qrCodeUrl.trim());

  let next = html;

  // Garante CSS do QR na impressão em DANFEs legados
  if (!next.includes('.qr-img')) {
    const printCss = `
.qr-block{margin-top:12px;text-align:center;page-break-inside:avoid;break-inside:avoid}
.qr-block strong{display:block;font-size:9px;margin-bottom:6px;text-transform:uppercase}
.qr-img{display:block;margin:0 auto;width:140px;height:140px;image-rendering:pixelated;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.qr-url{margin-top:6px;font-size:7px;word-break:break-all;color:#444;line-height:1.3}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.qr-img{width:140px!important;height:140px!important}.noprint{display:none!important}}
`;
    if (/<\/style>/i.test(next)) {
      next = next.replace(/<\/style>/i, `${printCss}</style>`);
    } else if (/<\/head>/i.test(next)) {
      next = next.replace(/<\/head>/i, `<style>${printCss}</style></head>`);
    }
  }

  // Bloco novo (com .qr-url interno) ou legado (.qr só com link)
  const newBlockRe =
    /<div class="qr-block">[\s\S]*?<div class="qr-url">[\s\S]*?<\/div>\s*<\/div>/i;
  const legacyBlockRe = /<div class="qr"[^>]*>[\s\S]*?<\/div>/i;

  if (newBlockRe.test(next)) {
    return { html: next.replace(newBlockRe, block), updated: true };
  }
  if (legacyBlockRe.test(next)) {
    return { html: next.replace(legacyBlockRe, block), updated: true };
  }

  if (/<div class="footer"/i.test(next)) {
    return {
      html: next.replace(/<div class="footer"/i, `${block}\n  <div class="footer"`),
      updated: true,
    };
  }
  if (/<p class="muted noprint"/i.test(next)) {
    return {
      html: next.replace(/<p class="muted noprint"/i, `${block}\n  <p class="muted noprint"`),
      updated: true,
    };
  }
  return {
    html: next.replace(/<\/body>/i, `${block}\n</body>`),
    updated: true,
  };
}

export async function buildDanfeHtml(params: {
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
}): Promise<string> {
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
      ? `<div class="homolog">NFC-e EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>`
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

  let qrDataUrl: string | null = null;
  try {
    if (params.qrCodeUrl?.trim()) {
      qrDataUrl = await qrCodeDataUrl(params.qrCodeUrl.trim());
    }
  } catch (err) {
    console.error('[danfe] falha ao gerar QR Code:', err);
  }

  const chaveFormatada = formatAccessKey(params.accessKey);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DANFE NFC-e ${params.numero}</title>
<style>${danfeStyles()}</style>
</head>
<body>
  ${homologBanner}
  ${logoHtml}
  <h1>${escapeXml(params.emitName)}</h1>
  ${fantasia}
  <div class="muted">CNPJ ${escapeXml(formatCnpj(params.emitCnpj))}${ieLine}</div>
  ${addressHtml}
  ${contactHtml}
  <div class="title-doc">Documento Auxiliar da NFC-e</div>
  <hr/>
  <div><strong>Nº ${params.numero}</strong> &nbsp; Série ${params.serie}</div>
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
  <div class="pay">Pagamento: ${escapeXml(params.paymentMethod)}</div>
  <div class="key-block">
    <div class="key-label">Chave de acesso</div>
    <div class="key">${escapeXml(chaveFormatada)}</div>
  </div>
  ${qrBlockHtml(qrDataUrl, params.qrCodeUrl)}
  <div class="footer">Consulte a autenticidade no portal da SEFAZ do seu Estado</div>
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
