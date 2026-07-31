import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { decryptBytes, decryptSecret } from '../secrets.js';
import { query } from '../../../db/pool.js';

export interface LoadedCertificate {
  privateKeyPem: string;
  certificatePem: string;
  privateKey: forge.pki.PrivateKey;
  certificate: forge.pki.Certificate;
  subjectCn: string;
  pfx: Buffer;
  passphrase: string;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    // pg às vezes devolve bytea como hex `\x...`
    if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
    return Buffer.from(value, 'binary');
  }
  throw new Error('Certificado A1 em formato inesperado no banco');
}

function pfxToAsn1(pfxBuf: Buffer) {
  // latin1 preserva bytes 0-255 (evita corrupção UTF-8)
  return forge.asn1.fromDer(pfxBuf.toString('latin1'));
}

function extractFromP12(p12: forge.pkcs12.Pkcs12Pfx): {
  privateKey: forge.pki.PrivateKey;
  certificate: forge.pki.Certificate;
} {
  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ||
    [];

  // Alguns A1 ICP-Brasil trazem cadeia — usa o leaf com private key correspondente
  let privateKey: forge.pki.PrivateKey | null = null;
  for (const bag of keyBags) {
    if (bag.key) {
      privateKey = bag.key as forge.pki.PrivateKey;
      break;
    }
  }

  let certificate: forge.pki.Certificate | null = null;
  for (const bag of certBags) {
    if (!bag.cert) continue;
    const cert = bag.cert as forge.pki.Certificate;
    // Prefer leaf (not CA): has digitalSignature / nonRepudiation typically
    if (!certificate) certificate = cert;
    try {
      const ku = cert.getExtension('keyUsage') as { digitalSignature?: boolean } | null;
      if (ku?.digitalSignature) {
        certificate = cert;
        break;
      }
    } catch {
      /* ignore */
    }
  }

  if (!privateKey || !certificate) {
    throw new Error('Não foi possível extrair chave/certificado do A1');
  }
  return { privateKey, certificate };
}

function loadWithForge(pfxBuf: Buffer, password: string) {
  const asn1 = pfxToAsn1(pfxBuf);
  // strict=false: necessário para PFX brasileiros (RC2 / bags antigos)
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  return extractFromP12(p12);
}

/**
 * Fallback OpenSSL 3 — algoritmos legados (RC2-40) exigem -legacy.
 */
function loadWithOpenssl(pfxBuf: Buffer, password: string): {
  privateKey: forge.pki.PrivateKey;
  certificate: forge.pki.Certificate;
  privateKeyPem: string;
  certificatePem: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'stockpyrou-a1-'));
  const pfxPath = join(dir, 'cert.pfx');
  const pemPath = join(dir, 'out.pem');
  try {
    writeFileSync(pfxPath, pfxBuf);
    const attempts: string[][] = [
      ['pkcs12', '-in', pfxPath, '-nodes', '-passin', `pass:${password}`, '-out', pemPath, '-legacy'],
      [
        'pkcs12',
        '-in',
        pfxPath,
        '-nodes',
        '-passin',
        `pass:${password}`,
        '-out',
        pemPath,
        '-provider',
        'legacy',
        '-provider',
        'default',
      ],
      ['pkcs12', '-in', pfxPath, '-nodes', '-passin', `pass:${password}`, '-out', pemPath],
    ];

    let lastErr = '';
    let ok = false;
    for (const args of attempts) {
      try {
        execFileSync('openssl', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20000,
        });
        ok = true;
        break;
      } catch (err) {
        lastErr =
          err && typeof err === 'object' && 'stderr' in err
            ? String((err as { stderr?: Buffer | string }).stderr || '')
            : err instanceof Error
              ? err.message
              : String(err);
      }
    }
    if (!ok) {
      throw new Error(
        `OpenSSL não conseguiu abrir o PFX (${lastErr.slice(0, 180) || 'erro desconhecido'}). ` +
          'Confirme a senha e o arquivo .pfx/.p12.',
      );
    }

    const pem = readFileSync(pemPath, 'utf8');
    const keyMatch = pem.match(/-----BEGIN(?: ENCRYPTED)? PRIVATE KEY-----[\s\S]+?-----END(?: ENCRYPTED)? PRIVATE KEY-----/);
    const rsaMatch = pem.match(/-----BEGIN RSA PRIVATE KEY-----[\s\S]+?-----END RSA PRIVATE KEY-----/);
    const certMatches = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)];

    const privateKeyPem = keyMatch?.[0] || rsaMatch?.[0];
    if (!privateKeyPem) throw new Error('OpenSSL não retornou a chave privada do A1');
    if (certMatches.length === 0) throw new Error('OpenSSL não retornou o certificado do A1');

    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    // Prefer o certificado cujo public key casa com a chave privada
    let certificate = forge.pki.certificateFromPem(certMatches[0][0]);
    const priv = privateKey as forge.pki.rsa.PrivateKey;
    for (const m of certMatches) {
      const c = forge.pki.certificateFromPem(m[0]);
      const pub = c.publicKey as forge.pki.rsa.PublicKey;
      try {
        if (pub.n && priv.n && pub.n.compareTo(priv.n) === 0) {
          certificate = c;
          break;
        }
      } catch {
        /* tenta próximo */
      }
    }

    return {
      privateKey,
      certificate,
      privateKeyPem: forge.pki.privateKeyToPem(privateKey),
      certificatePem: forge.pki.certificateToPem(certificate),
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function parsePfx(pfxBuf: Buffer, password: string): {
  privateKey: forge.pki.PrivateKey;
  certificate: forge.pki.Certificate;
  privateKeyPem: string;
  certificatePem: string;
  subjectCn: string;
} {
  if (!password) throw new Error('Senha do certificado é obrigatória');
  if (!pfxBuf?.length) throw new Error('Arquivo do certificado vazio');

  let privateKey: forge.pki.PrivateKey;
  let certificate: forge.pki.Certificate;
  let privateKeyPem: string;
  let certificatePem: string;

  try {
    const extracted = loadWithForge(pfxBuf, password);
    privateKey = extracted.privateKey;
    certificate = extracted.certificate;
    privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    certificatePem = forge.pki.certificateToPem(certificate);
  } catch (forgeErr) {
    const forgeMsg = forgeErr instanceof Error ? forgeErr.message : String(forgeErr);
    try {
      const extracted = loadWithOpenssl(pfxBuf, password);
      privateKey = extracted.privateKey;
      certificate = extracted.certificate;
      privateKeyPem = extracted.privateKeyPem;
      certificatePem = extracted.certificatePem;
    } catch (opensslErr) {
      const opensslMsg = opensslErr instanceof Error ? opensslErr.message : String(opensslErr);
      throw new Error(
        `Certificado A1 inválido ou senha incorreta. Forge: ${forgeMsg}. ${opensslMsg}`,
      );
    }
  }

  const subjectCn =
    certificate.subject.getField('CN')?.value ||
    certificate.subject.getField('O')?.value ||
    'Certificado A1';

  return { privateKey, certificate, privateKeyPem, certificatePem, subjectCn };
}

export async function loadCompanyCertificate(companyId: string): Promise<LoadedCertificate> {
  const { rows } = await query(
    `SELECT certificate_encrypted, password_encrypted, subject_cn
     FROM fiscal_certificate WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const row = rows[0] as
    | {
        certificate_encrypted: unknown;
        password_encrypted: string;
        subject_cn: string | null;
      }
    | undefined;
  if (!row) throw new Error('Certificado A1 não cadastrado');

  const pfxBuf = decryptBytes(asBuffer(row.certificate_encrypted));
  const password = decryptSecret(row.password_encrypted);
  const parsed = parsePfx(pfxBuf, password);

  return {
    privateKeyPem: parsed.privateKeyPem,
    certificatePem: parsed.certificatePem,
    privateKey: parsed.privateKey,
    certificate: parsed.certificate,
    subjectCn: row.subject_cn || parsed.subjectCn,
    pfx: pfxBuf,
    passphrase: password,
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
  let working = xml.replace(/\r\n/g, '\n').trim();
  if (working.startsWith('<?xml')) {
    working = working.replace(/^<\?xml[^?]*\?>\s*/i, '');
  }

  const idAttr = `Id="${elementId}"`;
  if (!working.includes(idAttr) && !working.includes(`Id='${elementId}'`)) {
    throw new Error(`Elemento com Id=${elementId} não encontrado no XML`);
  }

  const tagMatch = working.match(
    new RegExp(
      `<(?:\\w+:)?(infNFe|infEvento|infInut)[^>]*Id=["']${elementId}["'][^>]*>[\\s\\S]*?<\\/(?:\\w+:)?\\1>`,
    ),
  );
  if (!tagMatch) throw new Error('Não foi possível localizar o bloco a assinar');

  const referenceUri = `#${elementId}`;
  const digestValue = forge.md.sha1
    .create()
    .update(forge.util.encodeUtf8(tagMatch[0]))
    .digest()
    .toHex();
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

/**
 * Credenciais TLS para mTLS com a SEFAZ.
 * Usa PEM (key+cert) em vez do PFX bruto — OpenSSL 3 do Node rejeita muitos A1
 * brasileiros com "Unsupported PKCS12 PFX data" (RC2/legado).
 */
export async function getTlsCredentials(
  companyId: string,
): Promise<{ key: string; cert: string }> {
  const cert = await loadCompanyCertificate(companyId);
  return { key: cert.privateKeyPem, cert: cert.certificatePem };
}

/** @deprecated Prefira getTlsCredentials — PFX legado falha no Node/OpenSSL 3. */
export async function getPfxBufferForTls(
  companyId: string,
): Promise<{ pfx: Buffer; passphrase: string } | { key: string; cert: string }> {
  return getTlsCredentials(companyId);
}
