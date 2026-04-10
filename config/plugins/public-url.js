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
    // Multi-core: api uses {username}.{domain}, register on this core
    const coreUrl = config.get('core:url');
    const dnsDomain = config.get('dns:domain');
    if (coreUrl && dnsDomain) {
      config.set('service', Object.assign({}, existing, {
        api: 'https://{username}.' + dnsDomain + '/',
        register: buildUrl(coreUrl, path.join(REG_PATH, '/')),
        access: buildUrl(coreUrl, path.join(REG_PATH, '/access/')),
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
