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
  const { coreUrl, isSingleCore } = deriveCoreIdentity((key) => config.get(key));
  config.set('core:isSingleCore', isSingleCore);
  config.set('core:url', coreUrl);
}

/**
 * The derivation behind `load`, without touching the config. `get` reads a
 * colon-separated key. bin/check-config.js uses it too, so that it classifies
 * a core (single or multi-core) exactly as boot does.
 *
 * Boot registers this plugin as a synchronous one, which runs before
 * `default-config.yml` is loaded: `get` then sees the operator's layers
 * (override, bootstrap, environment, base layer) but not the shipped defaults.
 *
 * @param {(key: string) => any} get
 * @returns {{ coreUrl: string|null, isSingleCore: boolean }}
 */
function deriveCoreIdentity (get) {
  const coreId = get('core:id') || 'single';
  const explicitCoreUrl = get('core:url');
  const dnsDomain = get('dns:domain');
  const isDnsLess = get('dnsLess:isActive');

  if (explicitCoreUrl) {
    // Option 1: explicit override (DNSless multi-core)
    // If dnsLess is also active, the deployment is single-core by definition.
    // Otherwise we treat the explicit URL as a multi-core node identifier.
    return { coreUrl: stripTrailingSlash(explicitCoreUrl), isSingleCore: !!isDnsLess };
  }
  if (dnsDomain != null && !isDnsLess) {
    // Option 2: multi-core derivation from id + domain
    return { coreUrl: 'https://' + coreId + '.' + dnsDomain, isSingleCore: false };
  }
  // Option 3: single-core (dnsLess) — use publicUrl
  const publicUrl = get('dnsLess:publicUrl');
  return { coreUrl: publicUrl ? stripTrailingSlash(publicUrl) : null, isSingleCore: true };
}

function stripTrailingSlash (url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

module.exports = { load, deriveCoreIdentity };
