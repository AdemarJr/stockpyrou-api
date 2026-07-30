import {
  escapeXml,
  formatNFeDate,
  mapPaymentCode,
  money,
  onlyDigits,
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

  const det = input.items
    .map((it) => {
      const desc = isHomolog
        ? `NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL`
        : escapeXml(it.description).slice(0, 120);
      const csosn = it.csosn || '102';
      return (
        `<det nItem="${it.itemNumber}">` +
        `<prod>` +
        `<cProd>${escapeXml(String(it.itemNumber))}</cProd>` +
        `<cEAN>SEM GTIN</cEAN>` +
        `<xProd>${desc}</xProd>` +
        `<NCM>${onlyDigits(it.ncm).padStart(8, '0').slice(0, 8)}</NCM>` +
        `<CFOP>${onlyDigits(it.cfop).padStart(4, '0').slice(0, 4)}</CFOP>` +
        `<uCom>${escapeXml(it.unidade || 'UN')}</uCom>` +
        `<qCom>${money(it.quantity)}</qCom>` +
        `<vUnCom>${money(it.unitPrice)}</vUnCom>` +
        `<vProd>${money(it.total)}</vProd>` +
        `<cEANTrib>SEM GTIN</cEANTrib>` +
        `<uTrib>${escapeXml(it.unidade || 'UN')}</uTrib>` +
        `<qTrib>${money(it.quantity)}</qTrib>` +
        `<vUnTrib>${money(it.unitPrice)}</vUnTrib>` +
        `<indTot>1</indTot>` +
        `</prod>` +
        `<imposto>` +
        `<ICMS>` +
        (input.emit.crt === 1 || input.emit.crt === 2
          ? `<ICMSSN102><orig>${it.origem}</orig><CSOSN>${csosn}</CSOSN></ICMSSN102>`
          : `<ICMS00><orig>${it.origem}</orig><CST>${it.cst || '00'}</CST><modBC>3</modBC><vBC>0.00</vBC><pICMS>0.00</pICMS><vICMS>0.00</vICMS></ICMS00>`) +
        `</ICMS>` +
        `<PIS><PISNT><CST>07</CST></PISNT></PIS>` +
        `<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>` +
        `</imposto>` +
        `</det>`
      );
    })
    .join('');

  const tPag = mapPaymentCode(input.paymentMethod);
  const destBlock = input.dest
    ? `<dest>` +
      (input.dest.documentType === 'cnpj'
        ? `<CNPJ>${input.dest.documentDigits}</CNPJ>`
        : `<CPF>${input.dest.documentDigits}</CPF>`) +
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
    `<cMunFG>${onlyDigits(input.emit.codigoMunicipio)}</cMunFG>` +
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
    `<CNPJ>${onlyDigits(input.emit.cnpj)}</CNPJ>` +
    `<xNome>${escapeXml(input.emit.razaoSocial).slice(0, 60)}</xNome>` +
    (input.emit.nomeFantasia
      ? `<xFant>${escapeXml(input.emit.nomeFantasia).slice(0, 60)}</xFant>`
      : '') +
    `<enderEmit>` +
    `<xLgr>${escapeXml(input.emit.logradouro).slice(0, 60)}</xLgr>` +
    `<nro>${escapeXml(input.emit.numero || 'S/N')}</nro>` +
    (input.emit.complemento
      ? `<xCpl>${escapeXml(input.emit.complemento).slice(0, 60)}</xCpl>`
      : '') +
    `<xBairro>${escapeXml(input.emit.bairro).slice(0, 60)}</xBairro>` +
    `<cMun>${onlyDigits(input.emit.codigoMunicipio)}</cMun>` +
    `<xMun>${escapeXml(input.emit.municipio).slice(0, 60)}</xMun>` +
    `<UF>${input.emit.uf}</UF>` +
    `<CEP>${onlyDigits(input.emit.cep).padStart(8, '0')}</CEP>` +
    `<cPais>1058</cPais>` +
    `<xPais>BRASIL</xPais>` +
    `</enderEmit>` +
    `<IE>${onlyDigits(input.emit.ie)}</IE>` +
    `<CRT>${input.emit.crt}</CRT>` +
    `</emit>`;

  const total =
    `<total><ICMSTot>` +
    `<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>` +
    `<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST>` +
    `<vFCPSTRet>0.00</vFCPSTRet>` +
    `<vProd>${money(input.total)}</vProd>` +
    `<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc>` +
    `<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>` +
    `<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>` +
    `<vNF>${money(input.total)}</vNF>` +
    `</ICMSTot></total>`;

  const pag =
    `<pag><detPag>` +
    `<tPag>${tPag}</tPag>` +
    `<vPag>${money(input.total)}</vPag>` +
    `</detPag></pag>`;

  const infNFe =
    `<infNFe Id="${infId}" versao="4.00">` +
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
export function buildQrCodeUrl(params: {
  accessKey: string;
  ambiente: '1' | '2';
  cscId: string;
  cscToken: string;
  baseUrl: string;
}): string {
  const versao = '2';
  const cscId = onlyDigits(params.cscId).padStart(6, '0');
  const raw = `${params.accessKey}|${versao}|${params.ambiente}|${cscId}|${params.cscToken}`;
  const hash = sha1Hex(raw);
  const base = params.baseUrl.endsWith('?') ? params.baseUrl : `${params.baseUrl}?`;
  return `${base}p=${params.accessKey}|${versao}|${params.ambiente}|${cscId}|${hash}`;
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
