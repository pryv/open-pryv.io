/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const path = require('path');

const REG_PATH = '/reg';
const WWW_PATH = '/www';

async function publicUrlToService (config) {
  const isDnsLess = config.get('dnsLess:isActive');
  const publicUrl = config.get('dnsLess:publicUrl');
  const existing = config.get('service') || {};
  if (isDnsLess && publicUrl != null) {
    // dnsLess: all endpoints on the same URL with username in path
    config.set('service', Object.assign({}, existing, {
      api: buildUrl(publicUrl, '/{username}/'),
      register: buildUrl(publicUrl, path.join(REG_PATH, '/')),
      access: buildUrl(publicUrl, path.join(REG_PATH, '/access/')),
      assets: existing.assets || {
        definitions: buildUrl(publicUrl, path.join(WWW_PATH, '/assets/index.json'))
      },
      ...(existing.features ? { features: existing.features } : {})
    }));
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
      config.set('service', Object.assign({}, existing, {
        api: 'https://{username}.' + dnsDomain + '/',
        register: regUrl,
        access: accessUrl,
        assets: existing.assets || {
          definitions: buildUrl(coreUrl, path.join(WWW_PATH, '/assets/index.json'))
        },
        ...(existing.features ? { features: existing.features } : {})
      }));
    }
  }
}

function buildUrl (url, path) {
  return decodeURI(new URL(path, url).href);
}

module.exports = {
  load: publicUrlToService
};
