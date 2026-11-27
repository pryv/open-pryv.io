/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const { deriveHostnames, http01ListenerNeeded } = require('../../src/acme/deriveHostnames.ts');

function cfg (values) {
  return { get: (k) => values[k] };
}

describe('[DERIVEHOSTS] deriveHostnames', () => {
  it('dnsLess.isActive + publicUrl → single host, http-01', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': true,
      'dnsLess:publicUrl': 'https://api.example.com/'
    }));
    assert.deepEqual(r, { commonName: 'api.example.com', altNames: [], challenge: 'http-01' });
  });

  it('core.url (DNSless multi-core) → single host, http-01', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'core:url': 'https://api2.example.com:8443/'
    }));
    assert.equal(r.commonName, 'api2.example.com');
    assert.equal(r.challenge, 'http-01');
  });

  it('dns.domain → wildcard + apex, dns-01', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, '*.mc.example.com');
    assert.deepEqual(r.altNames, ['mc.example.com']);
    assert.equal(r.challenge, 'dns-01');
  });

  it('core.url wins over dns.domain when dns.active is FALSE (DNSless multi-core)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'dns:active': false,
      'core:url': 'https://core1.example.com/',
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, 'core1.example.com');
    assert.equal(r.challenge, 'http-01');
  });

  it('certRenewer: false + dns.domain → wildcard even when core.url is set (materialize-only cluster member)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'dns:active': false,
      'letsEncrypt:certRenewer': false,
      'core:url': 'https://core-use1.mc.example.com',    // auto-derived
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, '*.mc.example.com');
    assert.deepEqual(r.altNames, ['mc.example.com']);
    assert.equal(r.challenge, 'dns-01');
  });

  it('certRenewer UNSET keeps core.url priority (per-core DNSless multi-core unchanged)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'core:url': 'https://core1.example.com/',
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, 'core1.example.com');
    assert.equal(r.challenge, 'http-01');
  });

  it('dns.active: true + dns.domain → wildcard DNS-01 even when core.url is set (auto-derived from core-identity)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'dns:active': true,
      'core:url': 'https://core-use1.mc.example.com',    // auto-derived
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, '*.mc.example.com');
    assert.deepEqual(r.altNames, ['mc.example.com']);
    assert.equal(r.challenge, 'dns-01');
  });

  it('dns.domain set without dns.active → still wildcard (external-DNS-plugin slot)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, '*.mc.example.com');
    assert.equal(r.challenge, 'dns-01');
  });

  it('dnsLess wins over core.url and dns.domain', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': true,
      'dnsLess:publicUrl': 'https://old.example.com/',
      'core:url': 'https://ignored.example.com/',
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, 'old.example.com');
  });

  it('throws when none of the three topology keys are set', () => {
    assert.throws(
      () => deriveHostnames(cfg({})),
      /cannot derive hostname/
    );
  });

  it('treats "REPLACE ME" placeholder as unset', () => {
    assert.throws(
      () => deriveHostnames(cfg({ 'dns:domain': 'REPLACE ME' })),
      /cannot derive hostname/
    );
    assert.throws(
      () => deriveHostnames(cfg({
        'dnsLess:isActive': true,
        'dnsLess:publicUrl': 'REPLACE ME'
      })),
      /cannot derive hostname/
    );
  });

  it('throws on invalid URLs', () => {
    assert.throws(
      () => deriveHostnames(cfg({
        'dnsLess:isActive': true,
        'dnsLess:publicUrl': 'not a url'
      })),
      /invalid URL/
    );
  });
});

describe('[HT01L] http01ListenerNeeded (port 80 challenge listener)', () => {
  it('[HT01A] dnsLess http-01 topology needs the port 80 listener', () => {
    assert.equal(http01ListenerNeeded(cfg({
      'dnsLess:isActive': true,
      'dnsLess:publicUrl': 'https://api.example.com/'
    })), true);
  });

  it('[HT01B] per-core core.url http-01 topology needs the port 80 listener', () => {
    assert.equal(http01ListenerNeeded(cfg({
      'dnsLess:isActive': false,
      'core:url': 'https://core1.example.com/'
    })), true);
  });

  it('[HT01C] embedded DNS (dns-01 wildcard) leaves port 80 free', () => {
    assert.equal(http01ListenerNeeded(cfg({
      'dnsLess:isActive': false,
      'dns:active': true,
      'core:url': 'https://core-use1.mc.example.com',
      'dns:domain': 'mc.example.com'
    })), false);
  });

  it('[HT01D] materialize-only cluster member (dns-01) leaves port 80 free', () => {
    assert.equal(http01ListenerNeeded(cfg({
      'dnsLess:isActive': false,
      'letsEncrypt:certRenewer': false,
      'core:url': 'https://core-euc1.mc.example.com',
      'dns:domain': 'mc.example.com'
    })), false);
  });

  it('[HT01E] an underivable topology keeps the former behaviour (listener bound)', () => {
    assert.equal(http01ListenerNeeded(cfg({})), true);
    assert.equal(http01ListenerNeeded(cfg({
      'dnsLess:isActive': true,
      'dnsLess:publicUrl': 'not a url'
    })), true);
  });
});
