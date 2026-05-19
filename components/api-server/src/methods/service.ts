/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deepMerge } = require('utils');
const { ready } = require('@pryv/boiler');
const { getAPIVersion } = require('middleware/src/project_version.ts');
export default function (api: any) {
  api.register('service.info', getServiceInfo);
  async function getServiceInfo (context: any, params: any, result: any, next: any) {
    // Read live from config every call so config mutations after boot
    // (e.g. the `public-url.js` plugin rewriting URLs when `dns.domain`
    // changes, or admin APIs updating `service.*`) are picked up without
    // a process restart. The earlier cache-on-first-call behaviour also
    // leaked service state across tests sharing a single api-server.
    const config = await ready();
    const serviceInfo: any = Object.assign({}, config.get('service') || {});
    // Auto-derive `features.noHF` from cluster.hfsWorkers. lib-js's
    // `Service.supportsHF()` (and any other SDK following the same
    // contract) reads `features.noHF: true` to short-circuit HF-series
    // calls instead of erroring opaquely against a cluster that runs
    // with `cluster.hfsWorkers: 0`. An explicit `service.features.noHF`
    // in config takes precedence — operators can hand-override either way.
    serviceInfo.features = Object.assign({}, serviceInfo.features || {});
    if (serviceInfo.features.noHF === undefined && (config.get('cluster:hfsWorkers') || 0) === 0) {
      serviceInfo.features.noHF = true;
    }
    // Surface the API version so SDKs can pick the direct-core
    // registration endpoint (>=1.6.0) — the legacy fallback POSTs to
    // `/reg/user` via reg.{domain} which round-robins across cores and
    // strands cross-core registrations in PlatformDB.
    try {
      serviceInfo.version = await getAPIVersion();
    } catch (err) { /* non-fatal */ }
    result = deepMerge(result, serviceInfo);
    return next();
  }
};
