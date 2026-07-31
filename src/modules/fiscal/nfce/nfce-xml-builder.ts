import {
  escapeXml,
  formatNFeDate,
  mapPaymentCode,
  money,
  nfeCodigoMunicipio,
  nfeUnit,
  onlyDigits,
  qty,
  sha1Hex,
} from './nfce-utils.js';

export interface NfceBuildInput {
  accessKey: string;
  numero: number;
  serie: number;
  ambiente: '1' | '2'; // 1=prod 2=homolog
  tipoEmissao: number;
  emissionDate: Date;
  emit: {
    cnpj: string;
    ie: string;
    razaoSocial: string;
    nomeFantasia?: string | null;
    logradouro: string;
    numero: string;
    complemento?: string | null;
    bairro: string;
    municipio: string;
    codigoMunicipio: string;
    uf: string;
    cep: string;
    crt: number;
  };
  dest?: {
    documentDigits: string;
    documentType: 'cpf' | 'cnpj';
    name: string;
  } | null;
  items: Array<{
    itemNumber: number;
    description: string;
    ncm: string;
    cfop: string;
    csosn?: string | null;
    cst?: string | null;
    origem: number;
    unidade: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  paymentMethod: string;
  total: number;
  cscId: string;
  cscToken: string;
  qrCodeBaseUrl: string;
}

export function buildNfceXml(input: NfceBuildInput): string {
  const infId = `NFe${input.accessKey}`;
  const dhEmi = formatNFeDate(input.emissionDate);
  const cUF = input.accessKey.slice(0, 2);
  const cNF = input.accessKey.slice(35, 43);
  const cDV = input.accessKey.slice(43, 44);
  const natOp = 'VENDA';
  const isHomolog = input.ambiente === '2';
  const cMun = nfeCodigoMunicipio(input.emit.codigoMunicipio);
  const cep = onlyDigits(input.emit.cep).padStart(8, '0').slice(0, 8);

  const det = input.items
    .map((it) => {
      const desc = isHomolog
        ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
        : escapeXml(it.description).slice(0, 120);
      const csosn = onlyDigits(it.csosn || '102').padStart(3, '0').slice(0, 3);
      const ncmRaw = onlyDigits(it.ncm).padStart(8, '0').slice(0, 8);
      // 00000000 falha em várias SEFAZ; fallback genérico de alimentos
      const ncm = !ncmRaw || /^0+$/.test(ncmRaw) ? '21069090' : ncmRaw;
      const cfop = onlyDigits(it.cfop).padStart(4, '0').slice(0, 4) || '5102';
      const unidade = nfeUnit(it.unidade);
      const q = qty(it.quantity);
      const vUn = money(it.unitPrice);
      const vProd = money(it.total);
      return (
        `<det nItem="${it.itemNumber}">` +
        `<prod>` +
        `<cProd>${escapeXml(String(it.itemNumber))}</cProd>` +
        `<cEAN>SEM GTIN</cEAN>` +
        `<xProd>${desc}</xProd>` +
        `<NCM>${ncm}</NCM>` +
        `<CFOP>${cfop}</CFOP>` +
        `<uCom>${unidade}</uCom>` +
        `<qCom>${q}</qCom>` +
        `<vUnCom>${vUn}</vUnCom>` +
        `<vProd>${vProd}</vProd>` +
        `<cEANTrib>SEM GTIN</cEANTrib>` +
        `<uTrib>${unidade}</uTrib>` +
        `<qTrib>${q}</qTrib>` +
        `<vUnTrib>${vUn}</vUnTrib>` +
        `<indTot>1</indTot>` +
        `</prod>` +
        `<imposto>` +
        `<ICMS>` +
        (input.emit.crt === 1 || input.emit.crt === 2
          ? `<ICMSSN102><orig>${Number(it.origem) || 0}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`
          : `<ICMS00><orig>${Number(it.origem) || 0}</orig><CST>${onlyDigits(it.cst || '00').padStart(2, '0').slice(0, 2)}</CST><modBC>3</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`) +
        `</ICMS>` +
        `<PIS><PISNT><CST>07</CST></PISNT></PIS>` +
        `<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>` +
        `</imposto>` +
        // NT 2025.002 — valor do item (participação no total)
        `<vItem>${vProd}</vItem>` +
        `</det>`
      );
    })
    .join('');

  const tPag = mapPaymentCode(input.paymentMethod);
  // tPag=99 exige xPag no schema
  const xPag = tPag === '99' ? `<xPag>Outros</xPag>` : '';
  const destBlock = input.dest
    ? `<dest>` +
      (input.dest.documentType === 'cnpj'
        ? `<CNPJ>${onlyDigits(input.dest.documentDigits).padStart(14, '0').slice(0, 14)}</CNPJ>`
        : `<CPF>${onlyDigits(input.dest.documentDigits).padStart(11, '0').slice(0, 11)}</CPF>`) +
      `<xNome>${escapeXml(isHomolog ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : input.dest.name).slice(0, 60)}</xNome>` +
      `<indIEDest>9</indIEDest>` +
      `</dest>`
    : '';

  const ide =
    `<ide>` +
    `<cUF>${cUF}</cUF>` +
    `<cNF>${cNF}</cNF>` +
    `<natOp>${natOp}</natOp>` +
    `<mod>65</mod>` +
    `<serie>${input.serie}</serie>` +
    `<nNF>${input.numero}</nNF>` +
    `<dhEmi>${dhEmi}</dhEmi>` +
    `<tpNF>1</tpNF>` +
    `<idDest>1</idDest>` +
    `<cMunFG>${cMun}</cMunFG>` +
    `<tpImp>4</tpImp>` +
    `<tpEmis>${input.tipoEmissao}</tpEmis>` +
    `<cDV>${cDV}</cDV>` +
    `<tpAmb>${input.ambiente}</tpAmb>` +
    `<finNFe>1</finNFe>` +
    `<indFinal>1</indFinal>` +
    `<indPres>1</indPres>` +
    `<procEmi>0</procEmi>` +
    `<verProc>StockPyrou1.0</verProc>` +
    `</ide>`;

  const emit =
    `<emit>` +
    `<CNPJ>${onlyDigits(input.emit.cnpj).padStart(14, '0').slice(0, 14)}</CNPJ>` +
    `<xNome>${escapeXml(input.emit.razaoSocial).slice(0, 60)}</xNome>` +
    (input.emit.nomeFantasia
      ? `<xFant>${escapeXml(input.emit.nomeFantasia).slice(0, 60)}</xFant>`
      : '') +
    `<enderEmit>` +
    `<xLgr>${escapeXml(input.emit.logradouro || 'NAO INFORMADO').slice(0, 60)}</xLgr>` +
    `<nro>${escapeXml(input.emit.numero || 'S/N').slice(0, 60)}</nro>` +
    (input.emit.complemento
      ? `<xCpl>${escapeXml(input.emit.complemento).slice(0, 60)}</xCpl>`
      : '') +
    `<xBairro>${escapeXml(input.emit.bairro || 'CENTRO').slice(0, 60)}</xBairro>` +
    `<cMun>${cMun}</cMun>` +
    `<xMun>${escapeXml(input.emit.municipio || 'Manaus').slice(0, 60)}</xMun>` +
    `<UF>${(input.emit.uf || 'AM').toUpperCase().slice(0, 2)}</UF>` +
    `<CEP>${cep}</CEP>` +
    `<cPais>1058</cPais>` +
    `<xPais>Brasil</xPais>` +
    `</enderEmit>` +
    `<IE>${onlyDigits(input.emit.ie)}</IE>` +
    `<CRT>${[1, 2, 3].includes(Number(input.emit.crt)) ? Number(input.emit.crt) : 1}</CRT>` +
    `</emit>`;

  const vNF = money(input.total);
  const total =
    `<total><ICMSTot>` +
    `<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>` +
    `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST>` +
    `<vFCPSTRet>0.00</vFCPSTRet>` +
    `<vProd>${vNF}</vProd>` +
    `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc>` +
    `<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>` +
    `<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>` +
    `<vNF>${vNF}</vNF>` +
    `</ICMSTot>` +
    // NT 2025.002 — total com IBS/CBS/IS (em 2026, igual a vNF quando IBS/CBS=0)
    `<vNFTot>${vNF}</vNFTot>` +
    `</total>`;

  const pag =
    `<pag><detPag>` +
    `<tPag>${tPag}</tPag>` +
    xPag +
    `<vPag>${money(input.total)}</vPag>` +
    `</detPag></pag>`;

  const infNFe =
    `<infNFe versao="4.00" Id="${infId}">` +
    ide +
    emit +
    destBlock +
    det +
    total +
    `<transp><modFrete>9</modFrete></transp>` +
    pag +
    `</infNFe>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`
  );
}

/**
 * QR Code NFC-e (versão 2) — URL + hash CSC.
 * cHashQRCode = SHA-1(chave|versao|tpAmb|cscId|cscToken) hex upper
 */
/**
 * cIdToken no QR Code v2 — XSD exige `(0|[1-9][0-9]{0,5})` (sem zeros à esquerda).
 * Ex.: CSC cadastrado como "000001" deve ir como "1" na URL e no hash.
 */
export function formatCscIdForQr(cscId: string): string {
  const digits = onlyDigits(cscId);
  if (!digits) return '0';
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return '0';
  return String(Math.trunc(n)).slice(0, 6);
}

export function buildQrCodeUrl(params: {
  accessKey: string;
  ambiente: '1' | '2';
  cscId: string;
  cscToken: string;
  baseUrl: string;
}): string {
  const versao = '2';
  const cscId = formatCscIdForQr(params.cscId);
  const raw = `${params.accessKey}|${versao}|${params.ambiente}|${cscId}|${params.cscToken}`;
  const hash = sha1Hex(raw);
  const base = params.baseUrl.endsWith('?') ? params.baseUrl : `${params.baseUrl}?`;
  return `${base}p=${params.accessKey}|${versao}|${params.ambiente}|${cscId}|${hash}`;
}

/** Grupo obrigatório da NFC-e (mod 65): qrCode + urlChave. */
export function buildInfNFeSupl(qrCodeUrl: string, urlChave: string): string {
  // Sem CDATA: conteúdo escapado; evita rejeição 215 em validadores estritos
  return (
    `<infNFeSupl>` +
    `<qrCode>${escapeXml(qrCodeUrl)}</qrCode>` +
    `<urlChave>${escapeXml(urlChave)}</urlChave>` +
    `</infNFeSupl>`
  );
}

/**
 * Insere infNFeSupl entre </infNFe> e <Signature> (ordem exigida pelo schema).
 */
export function attachInfNFeSupl(
  signedNfeXml: string,
  qrCodeUrl: string,
  urlChave: string,
): string {
  if (signedNfeXml.includes('<infNFeSupl')) return signedNfeXml;
  const supl = buildInfNFeSupl(qrCodeUrl, urlChave);
  if (/<Signature[\s>]/i.test(signedNfeXml)) {
    return signedNfeXml.replace(/<Signature[\s>]/i, (m) => `${supl}${m}`);
  }
  return signedNfeXml.replace(/<\/NFe>/i, `${supl}</NFe>`);
}

export function wrapNFeProc(signedNfeXml: string, protocolXml: string): string {
  const nfe = signedNfeXml.replace(/^<\?xml[^?]*\?>\s*/i, '');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
    nfe +
    protocolXml +
    `</nfeProc>`
  );
}
