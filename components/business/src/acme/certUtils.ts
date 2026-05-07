/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Plan 35 Phase 3 — tiny PEM helpers used by the ACME engine.
 */

const { X509Certificate } = require('node:crypto');

const LEAF_END_MARKER = '-----END CERTIFICATE-----';

/**
 * Split a PEM bundle (leaf + issuer chain concatenated, as Let's Encrypt
 * returns from `client.auto()`) into the leaf cert on its own and the
 * issuer chain (possibly empty if there's only one cert).
 *
 * @param bundlePem
 */
function splitCertChain (bundlePem) {
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
 * @param pem
 */
function parseValidity (pem) {
  if (typeof pem !== 'string') throw new Error('parseValidity: pem is required');
  const cert = new X509Certificate(pem);
  return {
    issuedAt: Date.parse(cert.validFrom),
    expiresAt: Date.parse(cert.validTo),
    subject: cert.subject
  };
}

/**
 * Derive a filesystem-safe directory name for a hostname. Wildcards
 * ('*.domain.com') become 'wildcard.domain.com' — see Plan 35 config
 * contract (tlsDir/<hostname>/…).
 *
 * @param hostname
 */
function hostnameToDirName (hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error('hostnameToDirName: hostname is required');
  }
  if (hostname.startsWith('*.')) return 'wildcard.' + hostname.slice(2);
  return hostname;
}

export { splitCertChain, parseValidity, hostnameToDirName };