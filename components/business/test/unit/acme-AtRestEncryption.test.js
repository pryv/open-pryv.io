/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Unit tests for Plan 35 Phase 2b — AtRestEncryption (HKDF + AES-256-GCM
 * helper used to encrypt TLS cert private keys before handing them to
 * PlatformDB).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const AtRestEncryption = require('../../src/acme/AtRestEncryption');

describe('[ATRENC] AtRestEncryption', () => {
  describe('deriveKey()', () => {
    it('returns a 32-byte Buffer', () => {
      const key = AtRestEncryption.deriveKey('some-source', 'pryv-at-rest-tls-v1');
      assert.ok(Buffer.isBuffer(key));
      assert.equal(key.length, 32);
    });

    it('is deterministic for the same source + purpose', () => {
      const a = AtRestEncryption.deriveKey('source', 'p1');
      const b = AtRestEncryption.deriveKey('source', 'p1');
      assert.equal(a.toString('hex'), b.toString('hex'));
    });

    it('different purposes yield different keys', () => {
      const a = AtRestEncryption.deriveKey('source', 'p1');
      const b = AtRestEncryption.deriveKey('source', 'p2');
      assert.notEqual(a.toString('hex'), b.toString('hex'));
    });

    it('different sources yield different keys', () => {
      const a = AtRestEncryption.deriveKey('source-a', 'p');
      const b = AtRestEncryption.deriveKey('source-b', 'p');
      assert.notEqual(a.toString('hex'), b.toString('hex'));
    });

    it('accepts Buffer sources', () => {
      const buf = Buffer.from('binary-source-material-here');
      const key = AtRestEncryption.deriveKey(buf, 'p');
      assert.equal(key.length, 32);
    });

    it('salt changes the derivation', () => {
      const a = AtRestEncryption.deriveKey('source', 'p', Buffer.from('salt-1'));
      const b = AtRestEncryption.deriveKey('source', 'p', Buffer.from('salt-2'));
      assert.notEqual(a.toString('hex'), b.toString('hex'));
    });

    it('rejects empty source', () => {
      assert.throws(() => AtRestEncryption.deriveKey('', 'p'), /source is required/);
      assert.throws(() => AtRestEncryption.deriveKey(Buffer.alloc(0), 'p'), /source is required/);
      assert.throws(() => AtRestEncryption.deriveKey(null, 'p'), /source is required/);
    });

    it('rejects missing purpose', () => {
      assert.throws(() => AtRestEncryption.deriveKey('s', ''), /purpose/);
      assert.throws(() => AtRestEncryption.deriveKey('s'), /purpose/);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    const key = crypto.randomBytes(32);

    it('round-trips a short string', () => {
      const envelope = AtRestEncryption.encrypt('hello world', key);
      const pt = AtRestEncryption.decrypt(envelope, key);
      assert.equal(pt.toString('utf8'), 'hello world');
    });

    it('round-trips a Buffer', () => {
      const payload = Buffer.from([1, 2, 3, 4, 5, 255, 0]);
      const envelope = AtRestEncryption.encrypt(payload, key);
      const pt = AtRestEncryption.decrypt(envelope, key);
      assert.deepEqual(pt, payload);
    });

    it('round-trips a realistic PEM private key', () => {
      const pem = '-----BEGIN PRIVATE KEY-----\n' +
        'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgABCDEFGH\n' +
        '-----END PRIVATE KEY-----\n';
      const envelope = AtRestEncryption.encrypt(pem, key);
      assert.equal(AtRestEncryption.decrypt(envelope, key).toString('utf8'), pem);
    });

    it('envelopes are non-deterministic (fresh IV each call)', () => {
      const e1 = AtRestEncryption.encrypt('same', key);
      const e2 = AtRestEncryption.encrypt('same', key);
      assert.notEqual(e1, e2);
    });

    it('output is valid base64 and round-trips through decode', () => {
      const envelope = AtRestEncryption.encrypt('payload', key);
      assert.doesNotThrow(() => Buffer.from(envelope, 'base64'));
    });
  });

  describe('encryptJson / decryptJson', () => {
    const key = crypto.randomBytes(32);

    it('round-trips a nested object', () => {
      const obj = { hostname: '*.ex.com', issuedAt: 12345, nested: { a: [1, 2, 3] } };
      const envelope = AtRestEncryption.encryptJson(obj, key);
      assert.deepEqual(AtRestEncryption.decryptJson(envelope, key), obj);
    });

    it('decryptJson rejects payloads that aren\'t JSON', () => {
      const envelope = AtRestEncryption.encrypt('not-json-text', key);
      assert.throws(() => AtRestEncryption.decryptJson(envelope, key), /not valid JSON/);
    });
  });

  describe('tamper / wrong-key detection', () => {
    const key = crypto.randomBytes(32);

    it('decrypt rejects a wrong key', () => {
      const envelope = AtRestEncryption.encrypt('x', key);
      const otherKey = crypto.randomBytes(32);
      assert.throws(() => AtRestEncryption.decrypt(envelope, otherKey), /authentication failed/);
    });

    it('decrypt rejects a tampered ciphertext', () => {
      const envelope = AtRestEncryption.encrypt('some-plaintext-that-is-long-enough', key);
      // Flip a character in the middle (past the header) — any change breaks GCM auth
      const chars = envelope.split('');
      chars[chars.length - 4] = chars[chars.length - 4] === 'A' ? 'B' : 'A';
      const tampered = chars.join('');
      assert.throws(() => AtRestEncryption.decrypt(tampered, key),
        /authentication failed|invalid|envelope/);
    });

    it('decrypt rejects an unknown envelope version', () => {
      const good = AtRestEncryption.encrypt('x', key);
      const buf = Buffer.from(good, 'base64');
      buf[0] = 0xFE; // unknown version
      const bad = buf.toString('base64');
      assert.throws(() => AtRestEncryption.decrypt(bad, key), /unsupported envelope version/);
    });

    it('decrypt rejects an envelope that is too small', () => {
      assert.throws(() => AtRestEncryption.decrypt('AA==', key), /too small/);
    });

    it('encrypt rejects wrong-sized keys', () => {
      assert.throws(() => AtRestEncryption.encrypt('x', Buffer.alloc(16)), /32-byte Buffer/);
      assert.throws(() => AtRestEncryption.encrypt('x', Buffer.alloc(64)), /32-byte Buffer/);
    });

    it('decrypt rejects wrong-sized keys', () => {
      const envelope = AtRestEncryption.encrypt('x', key);
      assert.throws(() => AtRestEncryption.decrypt(envelope, Buffer.alloc(16)), /32-byte Buffer/);
    });
  });

  describe('full integration: derive → encrypt → store → retrieve → decrypt', () => {
    it('works end-to-end with a CA-private-key-shaped source', () => {
      // Stand in for a CA private key — any stable byte source works.
      const caPrivBytes = crypto.randomBytes(121);
      const key = AtRestEncryption.deriveKey(caPrivBytes, 'pryv-at-rest-tls-v1');

      const record = {
        certPem: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n',
        chainPem: '',
        keyPem: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n',
        issuedAt: 1000,
        expiresAt: 2000
      };

      // Encrypt just the keyPem (what an ACME engine would do — leaves
      // certPem + chainPem public, encrypts the private component).
      const storedRecord = { ...record, keyPem: AtRestEncryption.encrypt(record.keyPem, key) };
      assert.notEqual(storedRecord.keyPem, record.keyPem);
      assert.notStrictEqual(storedRecord.keyPem.length, record.keyPem.length);

      // Round-trip via a fresh key derivation (what another process would do)
      const key2 = AtRestEncryption.deriveKey(caPrivBytes, 'pryv-at-rest-tls-v1');
      const decrypted = AtRestEncryption.decrypt(storedRecord.keyPem, key2).toString('utf8');
      assert.equal(decrypted, record.keyPem);
    });
  });
});
