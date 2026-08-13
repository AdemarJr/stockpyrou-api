import {
  escapeXml,
  formatNFeDate,
  mapPaymentCode,
  money,
  nfeCodigoMunicipio,
  nfeUnit,
  onlyDigits,
  qty,
} from '../nfce/nfce-utils.js';
import { buildInfRespTecXml, type RespTecConfig } from '../nfce/resp-tec.js';

/** Alíquotas de transição 2026 (NT 2025.002) — tributação integral. */
const IBS_UF_RATE = 0.1;
const IBS_MUN_RATE = 0;
const CBS_RATE = 0.9;

function rateXml(ratePercent: number): string {
  return ratePercent === 0 ? '0.00' : ratePercent.toFixed(2);
}

function taxFromBase(vBC: number, ratePercent: number): number {
  return Math.round(((vBC * ratePercent) / 100) * 100) / 100;
}

function buildIbsCbsItemXml(vBC: number): {
  xml: string;
  vBC: number;
  vIBSUF: number;
  vIBSMun: number;
  vIBS: number;
  vCBS: number;
} {
  const vIBSUF = taxFromBase(vBC, IBS_UF_RATE);
  const vIBSMun = taxFromBase(vBC, IBS_MUN_RATE);
  const vIBS = Math.round((vIBSUF + vIBSMun) * 100) / 100;
  const vCBS = taxFromBase(vBC, CBS_RATE);
  const xml =
    `<IBSCBS>` +
    `<CST>000</CST>` +
    `<cClassTrib>000001</cClassTrib>` +
    `<gIBSCBS>` +
    `<vBC>${money(vBC)}</vBC>` +
    `<gIBSUF>` +
    `<pIBSUF>${rateXml(IBS_UF_RATE)}</pIBSUF>` +
    `<vIBSUF>${money(vIBSUF)}</vIBSUF>` +
    `</gIBSUF>` +
    `<gIBSMun>` +
    `<pIBSMun>${rateXml(IBS_MUN_RATE)}</pIBSMun>` +
    `<vIBSMun>${money(vIBSMun)}</vIBSMun>` +
    `</gIBSMun>` +
    `<vIBS>${money(vIBS)}</vIBS>` +
    `<gCBS>` +
    `<pCBS>${rateXml(CBS_RATE)}</pCBS>` +
    `<vCBS>${money(vCBS)}</vCBS>` +
    `</gCBS>` +
    `</gIBSCBS>` +
    `</IBSCBS>`;
  return { xml, vBC, vIBSUF, vIBSMun, vIBS, vCBS };
}

function buildIbsCbsTotXml(sums: {
  vBC: number;
  vIBSUF: number;
  vIBSMun: number;
  vIBS: number;
  vCBS: number;
}): string {
  return (
    `<IBSCBSTot>` +
    `<vBCIBSCBS>${money(sums.vBC)}</vBCIBSCBS>` +
    `<gIBS>` +
    `<gIBSUF>` +
    `<vDif>0.00</vDif><vDevTrib>0.00</vDevTrib>` +
    `<vIBSUF>${money(sums.vIBSUF)}</vIBSUF>` +
    `</gIBSUF>` +
    `<gIBSMun>` +
    `<vDif>0.00</vDif><vDevTrib>0.00</vDevTrib>` +
    `<vIBSMun>${money(sums.vIBSMun)}</vIBSMun>` +
    `</gIBSMun>` +
    `<vIBS>${money(sums.vIBS)}</vIBS>` +
    `<vCredPres>0.00</vCredPres>` +
    `<vCredPresCondSus>0.00</vCredPresCondSus>` +
    `</gIBS>` +
    `<gCBS>` +
    `<vDif>0.00</vDif><vDevTrib>0.00</vDevTrib>` +
    `<vCBS>${money(sums.vCBS)}</vCBS>` +
    `<vCredPres>0.00</vCredPres>` +
    `<vCredPresCondSus>0.00</vCredPresCondSus>` +
    `</gCBS>` +
    `</IBSCBSTot>`
  );
}

export interface NfeDestAddress {
  logradouro: string;
  numero: string;
  complemento?: string | null;
  bairro: string;
  municipio: string;
  codigoMunicipio: string;
  uf: string;
  cep: string;
}

export interface NfeBuildInput {
  accessKey: string;
  numero: number;
  serie: number;
  ambiente: '1' | '2';
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
  dest: {
    documentDigits: string;
    documentType: 'cpf' | 'cnpj';
    name: string;
    address: NfeDestAddress;
    indIEDest?: '1' | '2' | '9';
  };
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
  respTec: RespTecConfig;
}

/**
 * XML NF-e modelo 55 (venda interna, consumidor final / B2B simples).
 * Sem infNFeSupl/CSC (obrigatório só na NFC-e).
 */
export function buildNfeXml(input: NfeBuildInput): string {
  const infId = `NFe${input.accessKey}`;
  const dhEmi = formatNFeDate(input.emissionDate);
  const cUF = input.accessKey.slice(0, 2);
  const cNF = input.accessKey.slice(35, 43);
  const cDV = input.accessKey.slice(43, 44);
  const natOp = 'VENDA';
  const isHomolog = input.ambiente === '2';
  const cMun = nfeCodigoMunicipio(input.emit.codigoMunicipio);
  const cep = onlyDigits(input.emit.cep).padStart(8, '0').slice(0, 8);

  const emitUf = (input.emit.uf || 'AM').toUpperCase().slice(0, 2);
  const destUf = (input.dest.address.uf || emitUf).toUpperCase().slice(0, 2);
  const idDest = emitUf === destUf ? '1' : '2';
  const indIEDest = input.dest.indIEDest || '9';
  const indFinal = input.dest.documentType === 'cpf' || indIEDest === '9' ? '1' : '0';

  const ibsSums = { vBC: 0, vIBSUF: 0, vIBSMun: 0, vIBS: 0, vCBS: 0 };

  const det = input.items
    .map((it) => {
      const desc = isHomolog
        ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
        : escapeXml(it.description).slice(0, 120);
      const csosn = onlyDigits(it.csosn || '102').padStart(3, '0').slice(0, 3);
      const ncmRaw = onlyDigits(it.ncm).padStart(8, '0').slice(0, 8);
      const ncm = !ncmRaw || /^0+$/.test(ncmRaw) ? '21069090' : ncmRaw;
      const cfop = onlyDigits(it.cfop).padStart(4, '0').slice(0, 4) || '5102';
      const unidade = nfeUnit(it.unidade);
      const q = qty(it.quantity);
      const vUn = money(it.unitPrice);
      const vProdNum = Math.round(Number(it.total) * 100) / 100;
      const vProd = money(vProdNum);
      const ibs = buildIbsCbsItemXml(vProdNum);
      ibsSums.vBC += ibs.vBC;
      ibsSums.vIBSUF += ibs.vIBSUF;
      ibsSums.vIBSMun += ibs.vIBSMun;
      ibsSums.vIBS += ibs.vIBS;
      ibsSums.vCBS += ibs.vCBS;
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
        ibs.xml +
        `</imposto>` +
        `<vItem>${vProd}</vItem>` +
        `</det>`
      );
    })
    .join('');

  ibsSums.vBC = Math.round(ibsSums.vBC * 100) / 100;
  ibsSums.vIBSUF = Math.round(ibsSums.vIBSUF * 100) / 100;
  ibsSums.vIBSMun = Math.round(ibsSums.vIBSMun * 100) / 100;
  ibsSums.vIBS = Math.round(ibsSums.vIBS * 100) / 100;
  ibsSums.vCBS = Math.round(ibsSums.vCBS * 100) / 100;

  const tPag = mapPaymentCode(input.paymentMethod);
  const xPag = tPag === '99' ? `<xPag>Outros</xPag>` : '';

  const destAddr = input.dest.address;
  const destCMun = nfeCodigoMunicipio(destAddr.codigoMunicipio, cMun);
  const destCep = onlyDigits(destAddr.cep).padStart(8, '0').slice(0, 8);

  const destBlock =
    `<dest>` +
    (input.dest.documentType === 'cnpj'
      ? `<CNPJ>${onlyDigits(input.dest.documentDigits).padStart(14, '0').slice(0, 14)}</CNPJ>`
      : `<CPF>${onlyDigits(input.dest.documentDigits).padStart(11, '0').slice(0, 11)}</CPF>`) +
    `<xNome>${escapeXml(
      isHomolog
        ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
        : input.dest.name,
    ).slice(0, 60)}</xNome>` +
    `<enderDest>` +
    `<xLgr>${escapeXml(destAddr.logradouro || 'NAO INFORMADO').slice(0, 60)}</xLgr>` +
    `<nro>${escapeXml(destAddr.numero || 'S/N').slice(0, 60)}</nro>` +
    (destAddr.complemento
      ? `<xCpl>${escapeXml(destAddr.complemento).slice(0, 60)}</xCpl>`
      : '') +
    `<xBairro>${escapeXml(destAddr.bairro || 'CENTRO').slice(0, 60)}</xBairro>` +
    `<cMun>${destCMun}</cMun>` +
    `<xMun>${escapeXml(destAddr.municipio || 'Manaus').slice(0, 60)}</xMun>` +
    `<UF>${destUf}</UF>` +
    `<CEP>${destCep}</CEP>` +
    `<cPais>1058</cPais>` +
    `<xPais>Brasil</xPais>` +
    `</enderDest>` +
    `<indIEDest>${indIEDest}</indIEDest>` +
    `</dest>`;

  const ide =
    `<ide>` +
    `<cUF>${cUF}</cUF>` +
    `<cNF>${cNF}</cNF>` +
    `<natOp>${natOp}</natOp>` +
    `<mod>55</mod>` +
    `<serie>${input.serie}</serie>` +
    `<nNF>${input.numero}</nNF>` +
    `<dhEmi>${dhEmi}</dhEmi>` +
    `<tpNF>1</tpNF>` +
    `<idDest>${idDest}</idDest>` +
    `<cMunFG>${cMun}</cMunFG>` +
    `<tpImp>1</tpImp>` +
    `<tpEmis>${input.tipoEmissao}</tpEmis>` +
    `<cDV>${cDV}</cDV>` +
    `<tpAmb>${input.ambiente}</tpAmb>` +
    `<finNFe>1</finNFe>` +
    `<indFinal>${indFinal}</indFinal>` +
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
    `<UF>${emitUf}</UF>` +
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
    buildIbsCbsTotXml(ibsSums) +
    `<vNFTot>${vNF}</vNFTot>` +
    `</total>`;

  const pag =
    `<pag><detPag>` +
    `<tPag>${tPag}</tPag>` +
    xPag +
    `<vPag>${money(input.total)}</vPag>` +
    `</detPag></pag>`;

  const infRespTec = buildInfRespTecXml(input.accessKey, input.respTec);

  const infNFe =
    `<infNFe versao="4.00" Id="${infId}">` +
    ide +
    emit +
    destBlock +
    det +
    total +
    `<transp><modFrete>9</modFrete></transp>` +
    pag +
    infRespTec +
    `</infNFe>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}</NFe>`
  );
}

export { wrapNFeProc } from '../nfce/nfce-xml-builder.js';
