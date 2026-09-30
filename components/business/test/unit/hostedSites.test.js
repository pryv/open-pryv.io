/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * `hostedSites` validation: the one validator shared by the boot-time config
 * check, bin/check-config.js, the platform, the DNS server and the dispatcher.
 */

const assert = require('node:assert/strict');
const { describeHostedSites, parseHostedSites, hostedSiteNames } = require('../../src/hostedSites.ts');

function dnsInput (hostedSites, extra = {}) {
  return Object.assign({ hostedSites, domain: 'pryv.test', dnsLessActive: false, coreId: 'core-a', staticEntryNames: [] }, extra);
}

function problemsOf (hostedSites, extra) {
  return describeHostedSites(dnsInput(hostedSites, extra)).problems;
}

function configOf (values) {
  return { get: (key) => values[key] };
}

describe('[HSCF] hostedSites configuration', function () {
  it('[HSC1] absent or empty config yields no site and no problem', function () {
    for (const v of [undefined, null, {}]) {
      const r = describeHostedSites(dnsInput(v));
      assert.equal(r.sites.size, 0);
      assert.deepEqual(r.problems, []);
    }
    assert.deepEqual(problemsOf([]), ['hostedSites must be a map of name -> { static | proxy }']);
  });

  it('[HSC2] a static and a proxy site parse to their normalized form', function () {
    const r = describeHostedSites(dnsInput({
      account: { static: '/srv/sites/account/' },
      docs: { proxy: 'https://example.github.io/docs', headers: { 'Content-Security-Policy': "default-src 'self'" } }
    }));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.sites.get('account'), { name: 'account', kind: 'static', root: '/srv/sites/account', headers: {} });
    assert.deepEqual(r.sites.get('docs'), {
      name: 'docs',
      kind: 'proxy',
      upstream: 'https://example.github.io/docs/',
      headers: { 'content-security-policy': "default-src 'self'" }
    });
  });

  it('[HSC3] names must be DNS labels', function () {
    for (const bad of ['Account', '-acc', 'acc-', 'a_b', 'a.b', 'x'.repeat(64), '_acme-challenge']) {
      const p = problemsOf({ [bad]: { static: '/srv/x' } });
      assert.ok(p.some((m) => m.includes('must be a DNS label')), bad + ': ' + p.join('|'));
    }
    assert.deepEqual(problemsOf({ a: { static: '/srv/x' }, ['x'.repeat(63)]: { static: '/srv/y' } }), []);
  });

  it('[HSC4] names answered by the distribution, the core id or a static DNS entry are refused', function () {
    for (const name of ['reg', 'access', 'mfa', 'lsc']) {
      assert.ok(problemsOf({ [name]: { static: '/srv/x' } }).some((m) => m.includes('answered by the distribution')), name);
    }
    assert.ok(problemsOf({ 'core-a': { static: '/srv/x' } }).some((m) => m.includes('core.id')));
    assert.ok(problemsOf({ sw: { static: '/srv/x' } }, { staticEntryNames: ['sw'] }).some((m) => m.includes('dns.staticEntries')));
  });

  it('[HSC5] exactly one of static or proxy, absolute folder, known keys only', function () {
    assert.ok(problemsOf({ a: {} }).some((m) => m.includes('exactly one')));
    assert.ok(problemsOf({ a: { static: '/srv/x', proxy: 'https://e.org/' } }).some((m) => m.includes('exactly one')));
    assert.ok(problemsOf({ a: { static: 'relative/dir' } }).some((m) => m.includes('absolute folder')));
    assert.ok(problemsOf({ a: { static: '/srv/x', spa: true } }).some((m) => m.includes('unknown key')));
    assert.ok(problemsOf({ a: 'string' }).some((m) => m.includes('must be an object')));
  });

  it('[HSC6] a proxy upstream must be a plain http(s) URL outside this platform', function () {
    assert.ok(problemsOf({ a: { proxy: 'ftp://e.org/' } }).some((m) => m.includes('http(s) URL')));
    assert.ok(problemsOf({ a: { proxy: 'not a url' } }).some((m) => m.includes('http(s) URL')));
    assert.ok(problemsOf({ a: { proxy: 'https://u:p@e.org/' } }).some((m) => m.includes('credentials')));
    assert.ok(problemsOf({ a: { proxy: 'https://e.org/?x=1' } }).some((m) => m.includes('query')));
    // loop through ourselves: apex, a name inside dns.domain (any case)
    assert.ok(problemsOf({ a: { proxy: 'https://pryv.test/' } }).some((m) => m.includes('loop')));
    assert.ok(problemsOf({ a: { proxy: 'https://Other.PRYV.test/x/' } }).some((m) => m.includes('loop')));
    // dnsLess: the public host is the loop
    const dnsLess = { domain: null, dnsLessActive: true, publicUrl: 'https://api.example.com/' };
    assert.ok(problemsOf({ a: { proxy: 'https://api.example.com/x/' } }, dnsLess).some((m) => m.includes('loop')));
    // a look-alike outside the zone is fine
    assert.deepEqual(problemsOf({ a: { proxy: 'https://notpryv.test/' } }), []);
  });

  it('[HSC7] an http upstream is accepted with a warning', function () {
    const r = describeHostedSites(dnsInput({ a: { proxy: 'http://e.org/p' } }));
    assert.deepEqual(r.problems, []);
    assert.equal(r.sites.get('a').upstream, 'http://e.org/p/');
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes('in clear'));
  });

  it('[HSC8] operator headers: valid names, single-line values, no framing or cookie headers', function () {
    for (const h of ['Set-Cookie', 'transfer-encoding', 'connection', 'content-length', 'host', 'upgrade']) {
      assert.ok(problemsOf({ a: { static: '/srv/x', headers: { [h]: 'v' } } }).some((m) => m.includes('cannot be set')), h);
    }
    assert.ok(problemsOf({ a: { static: '/srv/x', headers: { 'bad name': 'v' } } }).some((m) => m.includes('not a valid header name')));
    assert.ok(problemsOf({ a: { static: '/srv/x', headers: { 'x-a': 'v\r\nx-b: w' } } }).some((m) => m.includes('single-line')));
    assert.ok(problemsOf({ a: { static: '/srv/x', headers: { 'x-a': 3 } } }).some((m) => m.includes('single-line')));
    assert.ok(problemsOf({ a: { static: '/srv/x', headers: ['x'] } }).some((m) => m.includes('map of header')));
  });

  it('[HSC9] topology: without dns.domain the sites need dnsLess; dnsLess refuses API route names', function () {
    assert.ok(problemsOf({ a: { static: '/srv/x' } }, { domain: null }).some((m) => m.includes('set dns.domain')));
    assert.deepEqual(problemsOf({ account: { static: '/srv/x' } }, { domain: null, dnsLessActive: true }), []);
    for (const name of ['reg', 'system', 'www', 'auth', 'users', 'oauth2', 'service', 'apps']) {
      assert.ok(problemsOf({ [name]: { static: '/srv/x' } }, { domain: null, dnsLessActive: true }).some((m) => m.includes('API route')), name);
    }
    // the same names are fine on their own host in the DNS topology
    assert.deepEqual(problemsOf({ www: { static: '/srv/x' } }), []);
  });

  it('[HSFV] frameAncestors: a non-empty list of CSP source expressions, kept only when set', function () {
    const r = describeHostedSites(dnsInput({
      a: { static: '/srv/x', frameAncestors: ["'self'", 'https://app.example.com'] },
      b: { proxy: 'https://e.org/', frameAncestors: ["'self'"] },
      c: { static: '/srv/y' }
    }));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.sites.get('a').frameAncestors, ["'self'", 'https://app.example.com']);
    assert.deepEqual(r.sites.get('b').frameAncestors, ["'self'"]);
    assert.equal('frameAncestors' in r.sites.get('c'), false);
    for (const bad of [[], "'self'", {}, [''], [3], ["'self'; script-src *"], ["'self', https://x.org"], ["'self' https://x.org"], ['https://x.org\r\nx-a: b']]) {
      const p = problemsOf({ a: { static: '/srv/x', frameAncestors: bad } });
      assert.ok(p.some((m) => m.includes('hostedSites.a.frameAncestors must be a non-empty list')), JSON.stringify(bad) + ': ' + p.join('|'));
    }
  });

  it('[HSCA] parseHostedSites throws one error listing every problem; hostedSiteNames never throws', function () {
    const cfg = configOf({
      hostedSites: { reg: { static: '/srv/x' }, b: {} },
      'dns:domain': 'pryv.test',
      'dnsLess:isActive': false
    });
    assert.throws(() => parseHostedSites(cfg), (err) => err.message.includes('hostedSites.reg') && err.message.includes('hostedSites.b'));
    assert.deepEqual(hostedSiteNames(cfg), ['reg', 'b']);
    assert.deepEqual(hostedSiteNames(configOf({})), []);
    const ok = configOf({ hostedSites: { account: { static: '/srv/a' } }, 'dns:domain': 'pryv.test', 'dnsLess:isActive': false });
    assert.equal(parseHostedSites(ok).get('account').root, '/srv/a');
  });
});
