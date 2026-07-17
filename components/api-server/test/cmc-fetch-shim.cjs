/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Test helper — fetch shim routing in-process api-server URLs through
 * a supertest agent. Used by the CMC handshake + OAuth2 e2e suites so
 * outbound HTTP from the dispatch loop / offer resolution lands on the
 * server under test. External fetches (data-types flat.json etc.) pass
 * through to the native fetch.
 *
 * `service.api` may be either path-based
 * (`http://127.0.0.1:3000/{username}/`, when override-config.yml is in
 * effect) or subdomain-style (`https://{username}.pryv.me/`, from
 * test/service-info.json when the boiler test path skips
 * override-config). Match both: exact-host for the path-based form,
 * *.pryv.me for the subdomain-style form.
 */

const supertest = require('supertest');

function resolveSupertestPath (u) {
  // Path-based test override-config: host is 127.0.0.1:3000, username
  // already in pathname.
  if (u.host === '127.0.0.1:3000' || u.host === 'localhost:3000') {
    return u.pathname + (u.search || '');
  }
  // Subdomain-style canonical test service-info: host is <user>.pryv.me;
  // synthesize `/<user>` prefix.
  if (u.host.endsWith('.pryv.me')) {
    const subdomain = u.host.slice(0, -('.pryv.me'.length));
    if (subdomain.length > 0 && !subdomain.includes('.')) {
      return '/' + subdomain + u.pathname + (u.search || '');
    }
  }
  return null;
}

function buildFetchShim (originalFetch, app) {
  return async function shim (url, init) {
    let u;
    try { u = new URL(url); } catch (_e) { return originalFetch(url, init); }
    const path = resolveSupertestPath(u);
    if (path == null) return originalFetch(url, init);
    const method = (init && init.method ? init.method : 'GET').toLowerCase();
    const headers = (init && init.headers) || {};

    let req = supertest(app)[method](path);
    for (const [k, v] of Object.entries(headers)) {
      req = req.set(k, v);
    }
    if (u.username && !(headers.authorization || headers.Authorization)) {
      req = req.set('Authorization', decodeURIComponent(u.username));
    }
    if (init && init.body != null) {
      try {
        req = req.send(JSON.parse(init.body));
      } catch (_e) {
        req = req.send(init.body);
      }
    }
    const res = await req;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      async json () { return res.body; },
      async text () { return typeof res.text === 'string' ? res.text : JSON.stringify(res.body); },
    };
  };
}

module.exports = { resolveSupertestPath, buildFetchShim };
