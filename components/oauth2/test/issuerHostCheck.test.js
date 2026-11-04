/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assert = require('node:assert/strict');
const { issuerHostReport, issuerHostWarnings } = require('../src/issuerHostCheck.ts');
const { describeIssuerHost, issuerLabelUnderDomain } = require('../src/issuerHost.ts');

function configOf (values) {
  return { get: (key) => values[key] };
}

const DNS = { 'dns:domain': 'example.com', 'core:id': 'core-a' };
const LE = { 'letsEncrypt:enabled': true };
const OUTSIDE = /oauth\.issuer names auth\.other\.org, outside dns\.domain \(example\.com\), while this core terminates TLS itself with a certificate for \*\.example\.com only/;
const NO_RESOLVE = /oauth\.issuer names auth-eu\.example\.com under dns\.domain, but nothing in this configuration makes that name resolve.*dns\.staticEntries\.auth-eu/;
const ROUTED = /whose label (\S+) is served by .* and cannot be the OAuth issuer/;

describe('[OIHC] oauth.issuer host check', () => {
  it('[OIHC1] the issuer host relative to dns.domain', () => {
    assert.deepEqual(describeIssuerHost(configOf({ ...DNS, 'oauth:issuer': 'https://Auth-EU.example.com:8443/' })),
      { host: 'auth-eu.example.com', underDomain: true, label: 'auth-eu' });
    assert.deepEqual(describeIssuerHost(configOf({ ...DNS, 'oauth:issuer': 'https://example.com' })),
      { host: 'example.com', underDomain: true, label: null });
    assert.deepEqual(describeIssuerHost(configOf({ ...DNS, 'oauth:issuer': 'https://a.b.example.com' })),
      { host: 'a.b.example.com', underDomain: true, label: null });
    assert.deepEqual(describeIssuerHost(configOf({ ...DNS, 'oauth:issuer': 'https://auth.notexample.com' })),
      { host: 'auth.notexample.com', underDomain: false, label: null });
    assert.deepEqual(describeIssuerHost(configOf({ 'oauth:issuer': 'https://auth-eu.example.com' })),
      { host: 'auth-eu.example.com', underDomain: false, label: null });
    for (const issuer of [undefined, null, '', 'not a url', 'ftp://auth.example.com']) {
      assert.equal(describeIssuerHost(configOf({ ...DNS, 'oauth:issuer': issuer })), null, String(issuer));
    }
    assert.equal(issuerLabelUnderDomain(configOf({ ...DNS, 'oauth:issuer': 'https://auth-eu.example.com' })), 'auth-eu');
  });

  it('[OIHC2] outside dns.domain: a warning on a core that terminates TLS, silent behind a proxy', () => {
    for (const tls of [LE, { 'http:ssl:keyFile': '/etc/tls/key.pem' }]) {
      const report = issuerHostReport(configOf({ ...DNS, ...tls, 'oauth:issuer': 'https://auth.other.org' }));
      assert.deepEqual(report.problems, []);
      assert.equal(report.warnings.length, 1);
      assert.match(report.warnings[0], OUTSIDE);
    }
    assert.deepEqual(issuerHostWarnings(configOf({ ...DNS, 'oauth:issuer': 'https://auth.other.org' })), []);
    assert.deepEqual(issuerHostWarnings(configOf({ ...DNS, 'letsEncrypt:enabled': false, 'http:ssl:keyFile': '', 'oauth:issuer': 'https://auth.other.org' })), []);
  });

  it('[OIHC3] under dns.domain: a warning unless the label is the core id or a static entry', () => {
    const warned = issuerHostReport(configOf({ ...DNS, ...LE, 'oauth:issuer': 'https://auth-eu.example.com' }));
    assert.deepEqual(warned.problems, []);
    assert.equal(warned.warnings.length, 1);
    assert.match(warned.warnings[0], NO_RESOLVE);
    for (const extra of [
      { 'dns:staticEntries': { 'auth-eu': { a: ['10.0.0.1'] } } },
      { 'core:id': 'auth-eu' }
    ]) {
      assert.deepEqual(issuerHostWarnings(configOf({ ...DNS, ...LE, ...extra, 'oauth:issuer': 'https://auth-eu.example.com' })), [], JSON.stringify(extra));
    }
    // the core's own host (the default issuer, set explicitly) and the domain itself
    assert.deepEqual(issuerHostWarnings(configOf({ ...DNS, 'oauth:issuer': 'https://core-a.example.com' })), []);
    assert.deepEqual(issuerHostWarnings(configOf({ ...DNS, 'oauth:issuer': 'https://example.com' })), []);
  });

  it('[OIHC4] a label the core routes elsewhere, or an issuer that is not a URL, is a problem', () => {
    for (const [label, extra] of [['reg', {}], ['access', {}], ['mfa', {}], ['lsc', {}], ['account', { hostedSites: { account: { static: '/srv/account' } } }]]) {
      const report = issuerHostReport(configOf({ ...DNS, ...extra, 'oauth:issuer': `https://${label}.example.com` }));
      assert.equal(report.problems.length, 1, label);
      assert.equal(report.problems[0].match(ROUTED)?.[1], label);
      assert.deepEqual(report.warnings, [], label);
    }
    const bad = issuerHostReport(configOf({ ...DNS, 'oauth:issuer': 'auth-eu.example.com' }));
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0], /oauth\.issuer \("auth-eu\.example\.com"\) is not an absolute http\(s\) URL/);
    // the boot log gets every message
    assert.equal(issuerHostWarnings(configOf({ ...DNS, 'oauth:issuer': 'https://reg.example.com' })).length, 1);
  });

  it('[OIHC5] silent without an issuer, or without dns.domain', () => {
    assert.deepEqual(issuerHostReport(configOf({ ...DNS, ...LE })), { problems: [], warnings: [] });
    assert.deepEqual(issuerHostReport(configOf({ ...LE, 'oauth:issuer': 'https://reg.other.org' })), { problems: [], warnings: [] });
  });
});
