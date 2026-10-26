import crypto from 'node:crypto';

/**
 * Deterministic Canonical JSON serializer (sorted keys recursively, no whitespace, UTF-8).
 * Ensures client and server produce the exact same byte sequence for WebAuthn challenge hashing.
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  const sortedKeys = Object.keys(value).sort();
  const pairs = sortedKeys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes the WebAuthn challenge string: base64url(SHA-256(canonicalJSON(payload))).
 */
export function computeMandateChallenge(payload) {
  const canonical = canonicalJSON(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * Computes "sha256:<hex>" evidence digest from raw screenshot bytes.
 */
export function computeEvidenceHash(screenshotBytes) {
  const hex = crypto.createHash('sha256').update(screenshotBytes).digest('hex');
  return `sha256:${hex}`;
}
