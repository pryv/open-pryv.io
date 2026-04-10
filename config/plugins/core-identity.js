/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Core identity config plugin.
 *
 * Derives:
 * - core:url — this core's public URL
 * - core:isSingleCore — true when this is a single-core deployment
 *
 * Resolution order for `core:url` (highest priority first):
 *   1. Explicit `core.url` in YAML — DNSless multi-core deployments where DNS is
 *      managed externally and FQDNs cannot be derived from `{id}.{domain}`.
 *      Example: `core.url: https://api1.example.com`
 *   2. Multi-core derivation: `https://{core.id}.{dns.domain}` — when both
 *      `core.id` and `dns.domain` are set and dnsLess is off.
 *   3. Single-core (dnsLess): `dnsLess.publicUrl`.
 *
 * `core:isSingleCore` is `false` when either an explicit `core.url` is set
 * (option 1) AND `dnsLess.isActive` is false, OR when multi-core derivation
 * (option 2) applies. Otherwise it is `true`.
 */
async function load (config) {
  const coreId = config.get('core:id') || 'single';
  const explicitCoreUrl = config.get('core:url');
  const dnsDomain = config.get('dns:domain');
  const isDnsLess = config.get('dnsLess:isActive');

  let coreUrl;

  if (explicitCoreUrl) {
    // Option 1: explicit override (DNSless multi-core)
    coreUrl = stripTrailingSlash(explicitCoreUrl);
    // If dnsLess is also active, the deployment is single-core by definition.
    // Otherwise we treat the explicit URL as a multi-core node identifier.
    config.set('core:isSingleCore', !!isDnsLess);
  } else if (dnsDomain != null && !isDnsLess) {
    // Option 2: multi-core derivation from id + domain
    coreUrl = 'https://' + coreId + '.' + dnsDomain;
    config.set('core:isSingleCore', false);
  } else {
    // Option 3: single-core (dnsLess) — use publicUrl
    const publicUrl = config.get('dnsLess:publicUrl');
    coreUrl = publicUrl ? stripTrailingSlash(publicUrl) : null;
    config.set('core:isSingleCore', true);
  }

  config.set('core:url', coreUrl);
}

function stripTrailingSlash (url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

module.exports = { load };
