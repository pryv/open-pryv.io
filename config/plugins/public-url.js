/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');

const REG_PATH = '/reg';
// Default UI assets (login button, CSS, icons) when `service.assets` is not
// set: the core serves none itself, so point at the public Pryv set rather
// than at a path nothing answers. Operators set their own for their branding.
const DEFAULT_ASSETS_DEFINITIONS = 'https://pryv.github.io/assets-pryv.me/index.json';

// The scope of the default UI assets: added after the configuration's own
// scopes, so the files, the environment and the platform store all win over it.
const DEFAULTS_SCOPE = 'service-defaults';

/**
 * Sets only the leaves it derives (`service.api`, `service.register`,
 * `service.access`) in the configuration's memory scope, never the whole
 * `service` object: a copy of the other `service.*` values there would hide
 * the values held in the platform store (the memory scope outranks it). The
 * default assets go in a scope below every other.
 */
async function publicUrlToService (config) {
  const isDnsLess = config.get('dnsLess:isActive');
  const publicUrl = config.get('dnsLess:publicUrl');
  const existing = config.get('service') || {};
  if (isDnsLess && publicUrl != null) {
    // dnsLess: all endpoints on the same URL with username in path
    setDerived(config, existing, {
      api: buildUrl(publicUrl, '/{username}/'),
      register: buildUrl(publicUrl, path.join(REG_PATH, '/')),
      access: buildUrl(publicUrl, path.join(REG_PATH, '/access/'))
    });
  } else {
    // Multi-core: api uses {username}.{domain}, and reg/access use the
    // distribution-reserved subdomains `reg.{domain}` / `access.{domain}`
    // (the embedded DNS resolves both to all available cores — see
    // DnsServer.RESERVED_SERVICE_NAMES). This keeps /service/info
    // symmetric across cores and matches the v1 Pryv.io URL shape.
    // Falls back to the core's own URL when dns.domain isn't set.
    const coreUrl = config.get('core:url');
    const dnsDomain = config.get('dns:domain');
    if (coreUrl && dnsDomain) {
      const regUrl = 'https://reg.' + dnsDomain + '/';
      const accessUrl = 'https://access.' + dnsDomain + '/access/';
      // register/access URLs don't carry the `/reg/` path prefix —
      // expressApp.js maps reg.{domain}/<path> → /reg/<path> internally
      // in multi-core mode, so clients see a clean root-based URL.
      //
      setDerived(config, existing, {
        api: 'https://{username}.' + dnsDomain + '/',
        register: regUrl,
        access: accessUrl
      });
    }
  }
}

function setDerived (config, existing, derived) {
  for (const [name, value] of Object.entries(derived)) config.set('service:' + name, value);
  if (existing.assets != null) return;
  if (typeof config.replaceScopeConfig === 'function') {
    config.replaceScopeConfig(DEFAULTS_SCOPE, { service: { assets: { definitions: DEFAULT_ASSETS_DEFINITIONS } } });
  } else {
    config.set('service:assets:definitions', DEFAULT_ASSETS_DEFINITIONS); // a minimal configuration object
  }
}

function buildUrl (url, path) {
  return decodeURI(new URL(path, url).href);
}

module.exports = {
  load: publicUrlToService,
  DEFAULT_ASSETS_DEFINITIONS,
  DEFAULTS_SCOPE
};
