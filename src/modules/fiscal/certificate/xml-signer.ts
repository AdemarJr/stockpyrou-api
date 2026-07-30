import forge from 'node-forge';
import { decryptBytes, decryptSecret } from '../secrets.js';
import { query } from '../../../db/pool.js';

export interface LoadedCertificate {
  privateKeyPem: string;
  certificatePem: string;
  privateKey: forge.pki.PrivateKey;
  certificate: forge.pki.Certificate;
  subjectCn: string;
}

export async function loadCompanyCertificate(companyId: string): Promise<LoadedCertificate> {
  const { rows } = await query(
    `SELECT certificate_encrypted, password_encrypted, subject_cn
     FROM fiscal_certificate WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const row = rows[0] as
    | {
        certificate_encrypted: Buffer;
        password_encrypted: string;
        subject_cn: string | null;
      }
    | undefined;
  if (!row) throw new Error('Certificado A1 não cadastrado');

  const pfxBuf = decryptBytes(Buffer.from(row.certificate_encrypted));
  const password = decryptSecret(row.password_encrypted);

  const pfxDer = forge.util.createBuffer(pfxBuf.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(pfxDer);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });

  const keyBag =
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certBag = certBags[forge.pki.oids.certBag]?.[0];

  if (!keyBag?.key || !certBag?.cert) {
    throw new Error('Não foi possível extrair chave/certificado do A1');
  }

  const privateKey = keyBag.key as forge.pki.PrivateKey;
  const certificate = certBag.cert as forge.pki.Certificate;

  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKey,
    certificate,
    subjectCn: row.subject_cn || certificate.subject.getField('CN')?.value || 'A1',
  };
}

/**
 * Assinatura XMLDSig enveloped (RSA-SHA1) no elemento informado (ex.: infNFe).
 * Compatível com o padrão NF-e/NFC-e.
 */
export function signXmlEnveloped(
  xml: string,
  elementId: string,
  cert: LoadedCertificate,
): string {
  // Canonicalização simplificada: remove declaração XML duplicada e normaliza
  let working = xml.replace(/\r\n/g, '\n').trim();
  if (working.startsWith('<?xml')) {
    working = working.replace(/^<\?xml[^?]*\?>\s*/i, '');
  }

  const idAttr = `Id="${elementId}"`;
  if (!working.includes(idAttr) && !working.includes(`Id='${elementId}'`)) {
    throw new Error(`Elemento com Id=${elementId} não encontrado no XML`);
  }

  // Extrai o nó a assinar (infNFe ou infEvento)
  const tagMatch = working.match(
    new RegExp(`<(?:\\w+:)?(infNFe|infEvento|infInut)[^>]*Id=["']${elementId}["'][^>]*>[\\s\\S]*?<\\/(?:\\w+:)?\\1>`),
  );
  if (!tagMatch) throw new Error('Não foi possível localizar o bloco a assinar');

  const referenceUri = `#${elementId}`;
  const digestValue = forge.md.sha1
    .create()
    .update(forge.util.encodeUtf8(tagMatch[0]))
    .digest()
    .toHex();
  // Base64 do digest SHA1
  const digestB64 = forge.util.encode64(forge.util.hexToBytes(digestValue));

  const signedInfo =
    `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<Reference URI="${referenceUri}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const md = forge.md.sha1.create();
  md.update(forge.util.encodeUtf8(signedInfo), 'utf8');
  const signatureBytes = (cert.privateKey as forge.pki.rsa.PrivateKey).sign(md);
  const signatureB64 = forge.util.encode64(signatureBytes);

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert.certificate)).getBytes();
  const certB64 = forge.util.encode64(certDer);

  const signatureXml =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    signedInfo +
    `<SignatureValue>${signatureB64}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  // Insere Signature antes do fechamento de NFe / evento / inut
  if (working.includes('</NFe>')) {
    return working.replace('</NFe>', `${signatureXml}</NFe>`);
  }
  if (working.includes('</evento>')) {
    return working.replace('</evento>', `${signatureXml}</evento>`);
  }
  if (working.includes('</inutNFe>')) {
    return working.replace('</inutNFe>', `${signatureXml}</inutNFe>`);
  }
  return working + signatureXml;
}

export function getPfxBufferForTls(companyId: string): Promise<{ pfx: Buffer; passphrase: string }> {
  return (async () => {
    const { rows } = await query(
      `SELECT certificate_encrypted, password_encrypted FROM fiscal_certificate WHERE company_id = $1 LIMIT 1`,
      [companyId],
    );
    const row = rows[0] as
      | { certificate_encrypted: Buffer; password_encrypted: string }
      | undefined;
    if (!row) throw new Error('Certificado A1 não cadastrado');
    return {
      pfx: decryptBytes(Buffer.from(row.certificate_encrypted)),
      passphrase: decryptSecret(row.password_encrypted),
    };
  })();
}
