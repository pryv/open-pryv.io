/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Tiny PEM helpers used by the ACME engine.
 */

const { X509Certificate } = require('node:crypto');

const LEAF_END_MARKER = '-----END CERTIFICATE-----';

/**
 * Split a PEM bundle (leaf + issuer chain concatenated, as Let's Encrypt
 * returns from `client.auto()`) into the leaf cert on its own and the
 * issuer chain (possibly empty if there's only one cert).
 *
 */
function splitCertChain (bundlePem: string): { leafPem: string; chainPem: string } {
  if (typeof bundlePem !== 'string' || !bundlePem.includes(LEAF_END_MARKER)) {
    throw new Error('splitCertChain: input is not a PEM certificate bundle');
  }
  const firstEnd = bundlePem.indexOf(LEAF_END_MARKER);
  const cutoff = firstEnd + LEAF_END_MARKER.length;
  const leafPem = bundlePem.slice(0, cutoff).trimEnd() + '\n';
  const rest = bundlePem.slice(cutoff).replace(/^\s+/, '');
  const chainPem = rest.includes('BEGIN CERTIFICATE') ? rest : '';
  return { leafPem, chainPem };
}

/**
 * Parse a single PEM cert and return its validity dates as Unix ms.
 */
function parseValidity (pem: string): { issuedAt: number; expiresAt: number; subject: string } {
  if (typeof pem !== 'string') throw new Error('parseValidity: pem is required');
  const cert = new X509Certificate(pem);
  return {
    issuedAt: Date.parse(cert.validFrom),
    expiresAt: Date.parse(cert.validTo),
    subject: cert.subject
  };
}

type ValidityVerdict =
  | { ok: true; notBefore?: number; notAfter?: number }
  | {
    ok: false;
    reason: 'not-yet-valid' | 'expired' | 'unparseable';
    notBefore?: number;
    notAfter?: number;
    nowMs: number;
    detail: string;
  };

/**
 * Check that the local clock falls inside a certificate's validity window.
 * A bundle is judged on its leaf. `skewMs` tolerates a certificate whose
 * notBefore is slightly ahead of the local clock (issuers backdate it, but a
 * few seconds of lead must not refuse a good certificate); an expired
 * certificate is refused strictly.
 */
function checkValidityWindow (pem: string, { nowMs = Date.now(), skewMs = 30_000 }: { nowMs?: number; skewMs?: number } = {}): ValidityVerdict {
  let notBefore: number;
  let notAfter: number;
  try {
    const leafPem = splitCertChain(pem).leafPem;
    const validity = parseValidity(leafPem);
    notBefore = validity.issuedAt;
    notAfter = validity.expiresAt;
  } catch (err) {
    return { ok: false, reason: 'unparseable', nowMs, detail: 'certificate cannot be parsed: ' + (err as Error).message };
  }
  let reason: 'not-yet-valid' | 'expired' | null = null;
  if (notBefore > nowMs + skewMs) reason = 'not-yet-valid';
  else if (notAfter < nowMs) reason = 'expired';
  if (reason == null) return { ok: true, notBefore, notAfter };
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    ok: false,
    reason,
    notBefore,
    notAfter,
    nowMs,
    detail: `local clock ${iso(nowMs)} is outside the certificate validity window [${iso(notBefore)}, ${iso(notAfter)}]: either this host's clock is wrong or the stored certificate is stale`
  };
}

/**
 * Derive a filesystem-safe directory name for a hostname. Wildcards
 * ('*.domain.com') become 'wildcard.domain.com' — matches the letsEncrypt
 * tlsDir/<hostname>/… layout on disk.
 *
 */
function hostnameToDirName (hostname: string): string {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error('hostnameToDirName: hostname is required');
  }
  if (hostname.startsWith('*.')) return 'wildcard.' + hostname.slice(2);
  return hostname;
}

export { splitCertChain, parseValidity, checkValidityWindow, hostnameToDirName };
export type { ValidityVerdict };