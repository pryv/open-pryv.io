/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * `adapterRoutes` validation: the one validator shared by the boot-time config
 * check, bin/check-config.js and the dispatcher.
 */

const assert = require('node:assert/strict');
const { describeAdapterRoutes, parseAdapterRoutes, checkAdapterRoutesAtBoot } = require('../../src/adapterRoutes.ts');

const UP = 'http://172.17.0.1:7450';

function input (adapterRoutes, extra = {}) {
  return Object.assign({ adapterRoutes, domain: 'pryv.test', dnsLessActive: false, publicUrl: null, coreUrl: null }, extra);
}
function problemsOf (adapterRoutes, extra) {
  return describeAdapterRoutes(input(adapterRoutes, extra)).problems;
}
function warningsOf (adapterRoutes, extra) {
  return describeAdapterRoutes(input(adapterRoutes, extra)).warnings;
}
function configOf (values) {
  return { get: (key) => values[key] };
}

describe('[ADRC] adapterRoutes configuration', function () {
  it('[ADRC01] absent or empty config yields no route and no problem; a non-map is refused', function () {
    for (const v of [undefined, null, {}]) {
      const r = describeAdapterRoutes(input(v));
      assert.equal(r.routes.size, 0);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(r.warnings, []);
    }
    assert.equal(problemsOf([]).length, 1);
    assert.equal(problemsOf('x').length, 1);
    const r = describeAdapterRoutes(input({ calendar: { upstream: UP } }));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.routes.get('calendar'), {
      name: 'calendar',
      upstream: UP,
      protocol: 'http:',
      hostname: '172.17.0.1',
      port: 7450,
      paths: ['/adapter/calendar/'],
      maxBodyBytes: 1048576,
      idleTimeoutMs: 60000
    });
    assert.equal(parseAdapterRoutes(configOf({ adapterRoutes: { calendar: { upstream: UP } } })).size, 1);
    assert.throws(() => parseAdapterRoutes(configOf({ adapterRoutes: { calendar: {} } })), /Invalid adapterRoutes configuration: adapterRoutes\.calendar\.upstream is required/);
  });

  it('[ADRC02] the name is a DNS label and not "adapter"', function () {
    for (const name of ['Calendar', 'a_b', '-a', 'a-', 'a'.repeat(64), 'a.b', '']) {
      assert.match(problemsOf({ [name]: { upstream: UP } }).join(), /must be a DNS label/, name);
    }
    assert.match(problemsOf({ adapter: { upstream: UP } }).join(), /"adapter" cannot be a route name/);
    for (const name of ['a', 'facade', 'r2-d2', 'a'.repeat(63)]) {
      assert.deepEqual(problemsOf({ [name]: { upstream: UP } }), [], name);
    }
    assert.match(problemsOf({ calendar: 'http://x' }).join(), /must be an object with an "upstream"/);
  });

  it('[ADRC03] the upstream is an http(s) origin, off this platform; clear text to a public address warns', function () {
    const bad = {
      'ftp://x:1': /absolute http\(s\) origin/,
      'not a url': /absolute http\(s\) origin/,
      'http://u:p@x:1': /credentials/,
      'http://x:1/base': /without a path/,
      'http://x:1/?q=1': /without a path/,
      'http://x:1?': /without a path/,
      'http://x:1/#f': /without a path/,
      'http://pryv.test:7450': /points at this platform/,
      'https://core-a.pryv.test': /points at this platform/
    };
    for (const [upstream, re] of Object.entries(bad)) {
      assert.match(problemsOf({ calendar: { upstream } }).join(), re, upstream);
    }
    assert.match(problemsOf({ calendar: { upstream: 7450 } }).join(), /upstream is required/);
    // dnsLess public URL and core.url: refused on the same host and port only
    assert.match(problemsOf({ calendar: { upstream: 'http://127.0.0.1:3000' } }, { dnsLessActive: true, publicUrl: 'http://127.0.0.1:3000/' }).join(), /points at this platform/);
    assert.deepEqual(problemsOf({ calendar: { upstream: 'http://127.0.0.1:7450' } }, { dnsLessActive: true, publicUrl: 'http://127.0.0.1:3000/' }), []);
    assert.match(problemsOf({ calendar: { upstream: 'https://api.example.com' } }, { coreUrl: 'https://api.example.com/' }).join(), /points at this platform/);
    // The public URL counts only in dnsLess
    assert.deepEqual(problemsOf({ calendar: { upstream: 'http://127.0.0.1:3000' } }, { publicUrl: 'http://127.0.0.1:3000/' }), []);
    // https and a default port
    const https = describeAdapterRoutes(input({ calendar: { upstream: 'https://sidecar.example.org/' } }));
    assert.deepEqual(https.problems, []);
    assert.deepEqual(https.warnings, []);
    assert.equal(https.routes.get('calendar').port, 443);
    assert.equal(https.routes.get('calendar').upstream, 'https://sidecar.example.org');
    // Warnings: clear text off the host
    assert.match(warningsOf({ calendar: { upstream: 'http://sidecar.example.org:7450' } }).join(), /travels in clear/);
    assert.match(warningsOf({ calendar: { upstream: 'http://203.0.113.5:7450' } }).join(), /travels in clear/);
    for (const upstream of ['http://172.17.0.1:7450', 'http://127.0.0.1:7450', 'http://sidecar:7450', 'http://localhost:7450', 'http://10.1.2.3:1', 'http://192.168.0.2:1', 'http://[::1]:7450', 'http://[fd00::1]:7450']) {
      assert.deepEqual(warningsOf({ calendar: { upstream } }), [], upstream);
    }
    assert.equal(describeAdapterRoutes(input({ calendar: { upstream: 'http://[::1]:7450' } })).routes.get('calendar').hostname, '::1');
  });

  it('[ADRC04] paths: /adapter/<name>/ implied, only own prefixes, no core label, no dubious form, no overlap', function () {
    const ok = describeAdapterRoutes(input({
      calendar: { upstream: UP, paths: ['/.well-known/oauth-protected-resource/adapter/calendar/', '/adapter/calendar/', '/adapter/calendar/api/'] }
    }));
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.routes.get('calendar').paths, ['/adapter/calendar/', '/.well-known/oauth-protected-resource/adapter/calendar/', '/adapter/calendar/api/']);
    const bad = {
      '/adapter/facade/': /must start with \/adapter\/calendar\//,
      '/adapterx/calendar/': /must start with/,
      '/oauth2/': /must start with/,
      '/.well-known/openid-configuration/adapter/calendar/': /served by the core/,
      '/.well-known/oauth-authorization-server/adapter/calendar/': /served by the core/,
      '/.well-known/oauth-protected-resource/adapter/facade/': /must start with/,
      '/adapter/calendar/../x/': /dot segment/,
      '/adapter/calendar/./x/': /dot segment/,
      '/adapter/calendar/%2e%2e/': /encoded character/,
      '/adapter/calendar//x/': /empty segment/,
      '/adapter/calendar/x': /must end with \//,
      '/adapter/calendar/?a=1/': /query or a fragment/,
      'adapter/calendar/': /absolute path/,
      '': /non-empty string/
    };
    for (const [p, re] of Object.entries(bad)) {
      assert.match(problemsOf({ calendar: { upstream: UP, paths: [p] } }).join(), re, p);
    }
    assert.match(problemsOf({ calendar: { upstream: UP, paths: [12] } }).join(), /non-empty string/);
    assert.match(problemsOf({ calendar: { upstream: UP, paths: '/adapter/calendar/' } }).join(), /must be a list/);
    // No two routes can share a prefix: only reachable through a bad entry, so
    // checked on the valid routes as a safety net.
    assert.deepEqual(problemsOf({ calendar: { upstream: UP }, facade: { upstream: UP } }), []);
  });

  it('[ADRC05] maxBodyBytes and idleTimeoutMs are positive integers; a short idle timeout warns', function () {
    for (const v of [0, -1, 1.5, '1000', true, Number.MAX_VALUE]) {
      assert.match(problemsOf({ calendar: { upstream: UP, maxBodyBytes: v } }).join(), /maxBodyBytes must be a positive integer/, String(v));
      assert.match(problemsOf({ calendar: { upstream: UP, idleTimeoutMs: v } }).join(), /idleTimeoutMs must be a positive integer/, String(v));
    }
    const r = describeAdapterRoutes(input({ calendar: { upstream: UP, maxBodyBytes: 16384, idleTimeoutMs: 120000 } }));
    assert.equal(r.routes.get('calendar').maxBodyBytes, 16384);
    assert.equal(r.routes.get('calendar').idleTimeoutMs, 120000);
    assert.deepEqual(r.warnings, []);
    assert.match(warningsOf({ calendar: { upstream: UP, idleTimeoutMs: 4999 } }).join(), /idleTimeoutMs is 4999 ms/);
    assert.deepEqual(warningsOf({ calendar: { upstream: UP, idleTimeoutMs: 5000 } }), []);
  });

  it('[ADRC06] an unknown key is a problem (typo safety); an invalid route is left out', function () {
    const r = describeAdapterRoutes(input({ calendar: { upstream: UP, maxBodySize: 10 }, facade: { upstream: UP } }));
    assert.match(r.problems.join(), /adapterRoutes\.calendar\.maxBodySize: unknown key/);
    assert.deepEqual([...r.routes.keys()], ['facade']);
  });

  it('[ADRC07] the boot check refuses an account named "adapter" only once a route is configured', async function () {
    const withAdapter = { usernameExistsOnPlatform: async (name) => name === 'adapter' };
    const without = { usernameExistsOnPlatform: async () => false };
    const routes = describeAdapterRoutes(input({ calendar: { upstream: UP } })).routes;
    assert.deepEqual(await checkAdapterRoutesAtBoot(new Map(), withAdapter), []);
    assert.deepEqual(await checkAdapterRoutesAtBoot(routes, without), []);
    const problems = await checkAdapterRoutesAtBoot(routes, withAdapter);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /a user named "adapter" exists; rename that user/);
  });
});
