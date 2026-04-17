/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert/strict');
const { deriveHostnames } = require('../../src/acme/deriveHostnames');

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

  it('core.url wins over dns.domain when both are set (per priority in Plan 35 PLAN.md)', () => {
    const r = deriveHostnames(cfg({
      'dnsLess:isActive': false,
      'core:url': 'https://core1.example.com/',
      'dns:domain': 'mc.example.com'
    }));
    assert.equal(r.commonName, 'core1.example.com');
    assert.equal(r.challenge, 'http-01');
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
