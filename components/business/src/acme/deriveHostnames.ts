/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Plan 35 — derive the hostnames and challenge type for the letsEncrypt
 * feature from the existing topology config, so operators don't have
 * to maintain a duplicate list that can drift.
 *
 * Rules (first match wins):
 *
 *   | Observed config                                        | Host(s)  | Challenge |
 *   | ------------------------------------------------------ | -------- | --------- |
 *   | dnsLess.isActive: true + dnsLess.publicUrl: https://X/ | X        | http-01   |
 *   | dns.active: true + dns.domain: Z (embedded DNS)        | *.Z + Z  | dns-01    |
 *   | core.url: https://Y/  (DNSless multi-core per-core)    | Y        | http-01   |
 *   | dns.domain: Z (set but not authoritative here)         | *.Z + Z  | dns-01    |
 *
 * `dns.active: true` takes priority over `core.url` because the
 * core-identity plugin auto-populates `core.url` from
 * `{core.id}.{dns.domain}` when not explicitly set, which would
 * otherwise short-circuit the wildcard path.
 *
 * When none of the four apply, throws — the operator must fix their
 * topology config, not invent a hostname list.
 *
 * @param {Object} config - thing with `.get(key)` (e.g. @pryv/boiler)
 * @returns {{ commonName: string, altNames: string[], challenge: 'http-01'|'dns-01' }}
 */
function deriveHostnames (config) {
  const dnsLessActive = config.get('dnsLess:isActive');
  const dnsLessUrl = config.get('dnsLess:publicUrl');

  if (dnsLessActive && typeof dnsLessUrl === 'string' && dnsLessUrl.length > 0 &&
      dnsLessUrl !== 'REPLACE ME') {
    return { commonName: hostnameFromUrl(dnsLessUrl), altNames: [], challenge: 'http-01' };
  }

  const domain = config.get('dns:domain');
  const dnsActive = config.get('dns:active');
  const hasDomain = typeof domain === 'string' && domain.length > 0 && domain !== 'REPLACE ME';

  // Multi-core with embedded DNS: the core itself is authoritative for
  // the domain, so DNS-01 wildcard is the natural path.
  if (dnsActive && hasDomain) {
    return { commonName: '*.' + domain, altNames: [domain], challenge: 'dns-01' };
  }

  const coreUrl = config.get('core:url');
  if (typeof coreUrl === 'string' && coreUrl.length > 0 && coreUrl !== 'REPLACE ME') {
    return { commonName: hostnameFromUrl(coreUrl), altNames: [], challenge: 'http-01' };
  }

  // Fallback: dns.domain set without dns.active still implies wildcard
  // (DNS-01 via some external mechanism). Currently only realistic when
  // operator has another ACME-capable DNS provider — future-proof slot.
  if (hasDomain) {
    return { commonName: '*.' + domain, altNames: [domain], challenge: 'dns-01' };
  }

  throw new Error(
    'letsEncrypt.enabled but cannot derive hostname: set dnsLess.publicUrl, core.url, or dns.domain'
  );
}

function hostnameFromUrl (url) {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`deriveHostnames: invalid URL ${url}`);
  }
}

module.exports = { deriveHostnames };
