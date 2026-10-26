import crypto from 'node:crypto';

export interface MandatePayload {
  v: 1;
  runId: string;
  orderId: string;
  authorizationId: string;
  amountCents: number;
  currency: string;
  payee: string;
  merchantDomain: string;
  evidenceHash: string; // "sha256:<hex>" of pre-checkout screenshot bytes
  policyCeilingCents: number;
  issuedAt: string;     // ISO-8601 UTC timestamp
  nonce: string;        // base64url random nonce
}

/**
 * Deterministic Canonical JSON serializer (sorted keys recursively, no whitespace, UTF-8).
 * Ensures client and server produce the exact same byte sequence for WebAuthn challenge hashing.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes the WebAuthn challenge string: base64url(SHA-256(canonicalJSON(payload))).
 */
export function computeMandateChallenge(payload: MandatePayload): string {
  const canonical = canonicalJSON(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * Computes "sha256:<hex>" evidence digest from raw screenshot bytes.
 */
export function computeEvidenceHash(screenshotBytes: Buffer | Uint8Array): string {
  const hex = crypto.createHash('sha256').update(screenshotBytes).digest('hex');
  return `sha256:${hex}`;
}
