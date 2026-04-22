/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const _ = require('lodash');
const { getConfig } = require('@pryv/boiler');
const { getAPIVersion } = require('middleware/src/project_version');
module.exports = function (api) {
  api.register('service.info', getServiceInfo);
  async function getServiceInfo (context, params, result, next) {
    // Read live from config every call so config mutations after boot
    // (e.g. the `public-url.js` plugin rewriting URLs when `dns.domain`
    // changes, or admin APIs updating `service.*`) are picked up without
    // a process restart. The earlier cache-on-first-call behaviour also
    // leaked service state across tests sharing a single api-server.
    const serviceInfo = Object.assign({}, (await getConfig()).get('service') || {});
    // Surface the API version so SDKs can pick the direct-core
    // registration endpoint (>=1.6.0) — the legacy fallback POSTs to
    // `/reg/user` via reg.{domain} which round-robins across cores and
    // strands cross-core registrations in PlatformDB.
    try {
      serviceInfo.version = await getAPIVersion();
    } catch (err) { /* non-fatal */ }
    result = _.merge(result, serviceInfo);
    return next();
  }
};
