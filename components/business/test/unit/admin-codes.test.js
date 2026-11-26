/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADCD] one-time codes and bearer tokens of the administration features:
 * 130 / 256 random bits, lenient code input, SHA-256 hashes only.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  generateCode, formatCode, normalizeCode, hashCode, generateToken, hashToken, isTokenShape, hashesEqual, CODE_BITS, TOKEN_BITS
} from '../../src/admin/codes.ts';
import { PERMISSIONS, isPermission, capabilityOf } from '../../src/admin/permissions.ts';
import { CAPABILITY_NAMES, offeredCapabilities } from '../../src/admin/capabilities.ts';

describe('[ADCD] administration codes and tokens', function () {
  it('[ADCD1] a code is 26 Crockford base32 characters (130 bits), all distinct over many draws', function () {
    assert.equal(CODE_BITS, 130);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      seen.add(code);
    }
    assert.equal(seen.size, 2000);
  });

  it('[ADCD2] display form in groups; typed input read leniently; garbage refused', function () {
    const code = generateCode();
    const display = formatCode(code);
    assert.match(display, /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/);
    assert.equal(normalizeCode(display), code);
    assert.equal(normalizeCode(' ' + display.toLowerCase().replace(/-/g, ' ') + ' '), code);
    assert.equal(normalizeCode('O'.repeat(26)), '0'.repeat(26));
    assert.equal(normalizeCode('IL' + '1'.repeat(24)), '1'.repeat(26));
    for (const bad of [null, 42, '', 'U'.repeat(26), code.slice(1), code + '0', 'x'.repeat(100)]) {
      assert.equal(normalizeCode(bad), null, String(bad));
    }
  });

  it('[ADCD3] hashes are SHA-256 hex of the canonical form; hashCode refuses a non-canonical input', function () {
    const code = generateCode();
    assert.equal(hashCode(code), createHash('sha256').update(code).digest('hex'));
    assert.throws(() => hashCode(formatCode(code)), /canonical/);
    assert.equal(hashesEqual(hashCode(code), hashCode(code)), true);
    assert.equal(hashesEqual(hashCode(code), hashCode(generateCode())), false);
    assert.equal(hashesEqual('nope', hashCode(code)), false);
    assert.equal(hashesEqual(null, null), false);
  });

  it('[ADCD4] a token is 256 bits in base64url; only token-shaped values are hashed', function () {
    assert.equal(TOKEN_BITS, 256);
    const token = generateToken();
    assert.equal(isTokenShape(token), true);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.match(hashToken(token), /^[0-9a-f]{64}$/);
    assert.notEqual(generateToken(), token);
    assert.equal(isTokenShape(token + 'x'), false);
    assert.throws(() => hashToken('short'), /not a token/);
  });

  it('[ADCD5] the permission names are unique <capability>:<action>, each capability is offered by name', function () {
    assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      assert.match(p, /^[a-z][A-Za-z]*:[a-z][A-Za-z]*$/);
      assert.ok(CAPABILITY_NAMES.includes(capabilityOf(p)), 'capability of ' + p);
    }
    assert.equal(isPermission('users:read'), true);
    assert.equal(isPermission('users:fly'), false);
    const config = (values) => ({ get: (k) => values[k] });
    const off = offeredCapabilities(config({}));
    assert.ok(!off.includes('dns') && !off.includes('certs') && !off.includes('mail'));
    const on = offeredCapabilities(config({ 'dns:active': true, 'letsEncrypt:enabled': true, 'services:email:method': 'in-process' }));
    assert.ok(on.includes('dns') && on.includes('certs') && on.includes('mail'));
  });
});
