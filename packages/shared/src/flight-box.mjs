import crypto from 'node:crypto';
import { canonicalJSON } from './mandate.mjs';

function canonicalBytes(value) {
  return Buffer.from(canonicalJSON(value), 'utf8');
}

function makeEd25519PrivateKey(value) {
  const key = value?.type === 'private' ? value : crypto.createPrivateKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('receipt_signing_key_must_be_ed25519');
  return key;
}

function makeEd25519PublicKey(value) {
  const key = value?.type === 'public' ? value : crypto.createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('receipt_verification_key_must_be_ed25519');
  return key;
}

/** Build a signed, canonical Flight-Box receipt. A caller must supply a protected signing key. */
export function buildFlightBoxReceipt({
  runId,
  agentIdentityHash,
  sentinelCode,
  mandate,
  webauthnCredentialId,
  webauthnSignatureB64Url,
  paypalCaptureId,
  status = 'CAPTURED',
  completedAt = new Date().toISOString(),
  signingKeyId,
  privateKey,
}) {
  if (!mandate || typeof mandate !== 'object' || Array.isArray(mandate)) throw new TypeError('receipt_mandate_required');
  const keyId = String(signingKeyId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) throw new TypeError('receipt_signing_key_id_required');
  const key = makeEd25519PrivateKey(privateKey);
  const core = {
    v: 3,
    runId,
    agentIdentityHash,
    sentinelCode,
    orderId: mandate.orderId,
    authorizationId: mandate.authorizationId,
    captureId: paypalCaptureId || null,
    amountCents: mandate.amountCents,
    currency: mandate.currency,
    payee: mandate.payee,
    merchantDomain: mandate.merchantDomain,
    evidenceHash: mandate.evidenceHash,
    webauthnCredentialId: webauthnCredentialId || null,
    webauthnSignatureB64Url: webauthnSignatureB64Url || null,
    status,
    completedAt,
    signingKeyId: keyId,
    signatureAlgorithm: 'Ed25519',
  };
  const bytes = canonicalBytes(core);
  const signature = crypto.sign(null, bytes, key).toString('base64url');
  const receiptHash = crypto.createHash('sha256').update(bytes).digest('hex');
  return { ...core, receiptHash: `rcpt_sha256_${receiptHash}`, signatureB64Url: signature };
}

/** Verify both the receipt digest and its Ed25519 signature using a trusted public key. */
export function verifyFlightBoxReceipt(receipt, { publicKey } = {}) {
  if (!receipt || typeof receipt !== 'object' || !receipt.receiptHash || !receipt.signatureB64Url) {
    return { valid: false, reason: 'missing_receipt_signature_or_hash' };
  }
  if (!publicKey) return { valid: false, reason: 'trusted_public_key_required' };
  if (receipt.signatureAlgorithm !== 'Ed25519'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(receipt.signingKeyId || ''))) {
    return { valid: false, reason: 'unsupported_or_missing_signature_metadata' };
  }
  try {
    const key = makeEd25519PublicKey(publicKey);
    const { receiptHash, signatureB64Url, ...core } = receipt;
    const bytes = canonicalBytes(core);
    const expected = `rcpt_sha256_${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (expected !== receiptHash) return { valid: false, reason: 'receipt_hash_mismatch' };
    const signature = Buffer.from(signatureB64Url, 'base64url');
    if (!signature.length || signature.toString('base64url') !== signatureB64Url
        || !crypto.verify(null, bytes, key, signature)) {
      return { valid: false, reason: 'receipt_signature_invalid' };
    }
    return { valid: true, receiptHash, signingKeyId: core.signingKeyId };
  } catch {
    return { valid: false, reason: 'receipt_verification_failed' };
  }
}
