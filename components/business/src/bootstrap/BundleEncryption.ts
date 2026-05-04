/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Plan 34 — passphrase-based bundle encryption.
 *
 * Uses AES-256-GCM with scrypt-derived keys from node's built-in crypto.
 * No new npm dep, no system binary to install.
 *
 * Why not `age`? The bundle is only ever consumed by `bin/master.js
 * --bootstrap`, never manually inspected — there is no gain from matching
 * a specific format spec, and every dep adds supply-chain surface.
 *
 * Wire format (base64-decoded struct):
 *   version: 1 byte  — schema version of this envelope (currently 1)
 *   salt:    16 bytes — scrypt salt
 *   iv:      12 bytes — AES-GCM nonce
 *   tag:     16 bytes — AES-GCM auth tag
 *   ct:      N bytes  — ciphertext of the JSON-encoded bundle
 *
 * The full payload is base64-encoded and wrapped in a PEM-style ASCII
 * armor so operators can copy/paste it safely.
 */

const crypto = require('node:crypto');

const ENVELOPE_VERSION = 1;
const SCRYPT_N = 2 ** 15; // 32768 — ~100ms on a modern laptop
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32; // AES-256
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const ARMOR_BEGIN = '-----BEGIN PRYV BOOTSTRAP BUNDLE-----';
const ARMOR_END = '-----END PRYV BOOTSTRAP BUNDLE-----';

/**
 * Encrypt a bundle with a passphrase. Returns an ASCII-armored string
 * suitable for writing to a .bootstrap file and transporting out-of-band.
 *
 * @param {Object} bundle - the plain bundle (see Bundle.js)
 * @param {string} passphrase
 * @returns {string} PEM-armored ciphertext
 */
function encrypt (bundle, passphrase) {
  if (bundle == null || typeof bundle !== 'object') {
    throw new Error('BundleEncryption.encrypt: bundle must be an object');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('BundleEncryption.encrypt: passphrase is required');
  }

  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8');

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = scryptKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const version = Buffer.from([ENVELOPE_VERSION]);
  const envelope = Buffer.concat([version, salt, iv, tag, ct]);

  return armor(envelope.toString('base64'));
}

/**
 * Decrypt an armored bundle with a passphrase. Throws on tampering, wrong
 * passphrase or unknown envelope version.
 *
 * @param {string} armored - ASCII-armored ciphertext (as produced by encrypt)
 * @param {string} passphrase
 * @returns {Object} the decoded (but not yet Bundle-schema-validated) object
 */
function decrypt (armored, passphrase) {
  if (typeof armored !== 'string' || !armored.includes(ARMOR_BEGIN)) {
    throw new Error('BundleEncryption.decrypt: input is not an armored bundle');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('BundleEncryption.decrypt: passphrase is required');
  }

  const b64 = deArmor(armored);
  let envelope;
  try {
    envelope = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('BundleEncryption.decrypt: invalid base64 payload');
  }
  const minSize = 1 + SALT_BYTES + IV_BYTES + TAG_BYTES + 1;
  if (envelope.length < minSize) {
    throw new Error(`BundleEncryption.decrypt: envelope too small (${envelope.length} bytes)`);
  }

  const version = envelope[0];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`BundleEncryption.decrypt: unsupported envelope version ${version} (this binary understands ${ENVELOPE_VERSION})`);
  }

  let offset = 1;
  const salt = envelope.subarray(offset, offset += SALT_BYTES);
  const iv = envelope.subarray(offset, offset += IV_BYTES);
  const tag = envelope.subarray(offset, offset += TAG_BYTES);
  const ct = envelope.subarray(offset);

  const key = scryptKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    // GCM auth failure = wrong passphrase OR tampered ciphertext
    throw new Error('BundleEncryption.decrypt: authentication failed — wrong passphrase or tampered bundle');
  }

  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('BundleEncryption.decrypt: decrypted payload is not valid JSON');
  }
}

/**
 * Generate a human-readable random passphrase suitable for one-off use.
 * 128 bits of entropy in 22 chars (base64url-without-padding), grouped in
 * 4-char chunks separated by dashes so operators can type it without
 * losing their place.
 * @returns {string}
 */
function generatePassphrase () {
  const raw = crypto.randomBytes(16).toString('base64url');
  // e.g. AbCd-EfGh-IjKl-MnOp-QrSt-Uv
  return raw.match(/.{1,4}/g).join('-');
}

// --- internal helpers ---------------------------------------------------

function scryptKey (passphrase, salt) {
  // Synchronous scryptSync is fine here: bundle encryption is a CLI-time
  // operation and only runs once per new-core provisioning.
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024
  });
}

function armor (b64) {
  const lines = b64.match(/.{1,64}/g) || [''];
  return [ARMOR_BEGIN, ...lines, ARMOR_END].join('\n') + '\n';
}

function deArmor (armored) {
  const start = armored.indexOf(ARMOR_BEGIN);
  const end = armored.indexOf(ARMOR_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('BundleEncryption.decrypt: armor markers not found');
  }
  return armored
    .slice(start + ARMOR_BEGIN.length, end)
    .replace(/\s+/g, '');
}

module.exports = {
  ENVELOPE_VERSION,
  encrypt,
  decrypt,
  generatePassphrase
};
