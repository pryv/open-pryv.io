/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import crypto from 'node:crypto';
/**
 * At-rest encryption helper for PlatformDB-stored TLS certificate and ACME
 * account private keys.
 *
 * Problem: rqlite-replicated snapshots carry every row of the keyValue
 * table. If a cert's keyPem sits there in plaintext, any node that can
 * read the snapshot (or any off-host backup of it) yields the private
 * key. Today's platform-wide secrets (adminAccessKey,
 * filesReadTokenSecret) avoid this by living in YAML, not PlatformDB.
 * Auto-renewed certs NEED to replicate — so we keep them in PlatformDB
 * but encrypt the sensitive bits at rest.
 *
 * Model:
 *   - The encryption key is a 32-byte symmetric key derived via
 *     HKDF-SHA256 from a single source-of-truth byte string, parameterised
 *     by a `purpose` label so we can run multiple independent "key
 *     schedules" without needing separate source material.
 *   - The caller chooses the source-of-truth byte string. For the
 *     cluster-CA-holder topology this is the CA private key's DER bytes;
 *     for a future per-cluster `platform_key` it would be that key.
 *     This module does NOT take a stance on WHICH source to use —
 *     that's a wiring decision in the caller.
 *   - AES-256-GCM for the actual encryption. Fixed 1-byte envelope
 *     version prefix so we can rev the format later.
 *
 * Wire format (base64 of the concatenated buffer):
 *   version:  1 byte   (2; envelopes of version 1 are still read)
 *   iv:       12 bytes (GCM nonce; fresh per encrypt)
 *   tag:      16 bytes (GCM auth tag)
 *   ct:       N bytes  (ciphertext of the plaintext)
 *
 * Version 2 authenticates a context with the ciphertext: AAD =
 * 'pryv-at-rest-v2' | 0x00 | context, where the caller names the row that
 * holds the envelope (the purpose is in the key). An envelope moved to
 * another row of the same purpose then fails to decrypt. Version 1 (no
 * authenticated data) decrypts with any context. The tag length is pinned
 * to 16 bytes on both sides.
 */

const ENVELOPE_VERSION = 2;
const LEGACY_ENVELOPE_VERSION = 1;
const AAD_LABEL = 'pryv-at-rest-v2';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function aadOf (context: string): Buffer {
  return Buffer.concat([Buffer.from(AAD_LABEL, 'utf8'), Buffer.from([0]), Buffer.from(context, 'utf8')]);
}

/**
 * Derive a 32-byte AES key from arbitrary source material + a purpose
 * label. The purpose lets one source key feed multiple independent
 * schedules (e.g. one for TLS certs, one for future uses).
 *
 * @param source - source material (e.g. CA private key DER bytes)
 * @param purpose       - label, e.g. 'pryv-at-rest-tls-v1'
 * @param [salt]        - optional salt; default: empty (acceptable because source has entropy)
 */
function deriveKey (source: string | Buffer, purpose: string, salt: Buffer = Buffer.alloc(0)): Buffer {
  if (source == null || (Buffer.isBuffer(source) && source.length === 0) ||
      (typeof source === 'string' && source.length === 0)) {
    throw new Error('AtRestEncryption.deriveKey: source is required');
  }
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('AtRestEncryption.deriveKey: purpose label is required');
  }
  const ikm = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  const info = Buffer.from(purpose, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, KEY_BYTES));
}

/**
 * Encrypt a plaintext string or Buffer with a 32-byte key. Returns a
 * base64-encoded envelope (version 2) safe to store in a JSON field.
 *
 * @param key - 32 bytes
 * @param context - the row that holds the envelope (authenticated, not stored)
 */
function encrypt (plaintext: string | Buffer, key: Buffer, context: string = ''): string {
  if (plaintext == null) {
    throw new Error('AtRestEncryption.encrypt: plaintext is required');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`AtRestEncryption.encrypt: key must be a ${KEY_BYTES}-byte Buffer`);
  }
  const ptBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(context));
  const ct = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, tag, ct]);
  return envelope.toString('base64');
}

/** The version byte of an envelope (1 or 2); throws on anything else. */
function envelopeVersion (encoded: string): number {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('AtRestEncryption.envelopeVersion: encoded is required');
  }
  const version = Buffer.from(encoded, 'base64')[0];
  if (version !== ENVELOPE_VERSION && version !== LEGACY_ENVELOPE_VERSION) {
    throw new Error(`AtRestEncryption: unsupported envelope version ${version} (this binary understands ${LEGACY_ENVELOPE_VERSION} and ${ENVELOPE_VERSION})`);
  }
  return version;
}

/**
 * Decrypt a base64 envelope produced by encrypt(). Throws on tamper,
 * wrong key, another context, or unknown envelope version.
 *
 * @param key - 32 bytes
 * @param context - the row that holds the envelope (as given to encrypt; ignored for a version-1 envelope)
 */
function decrypt (encoded: string, key: Buffer, context: string = ''): Buffer {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('AtRestEncryption.decrypt: encoded is required');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`AtRestEncryption.decrypt: key must be a ${KEY_BYTES}-byte Buffer`);
  }
  let envelope: Buffer;
  try { envelope = Buffer.from(encoded, 'base64'); } catch {
    throw new Error('AtRestEncryption.decrypt: invalid base64');
  }
  const minSize = 1 + IV_BYTES + TAG_BYTES;
  if (envelope.length < minSize) {
    throw new Error(`AtRestEncryption.decrypt: envelope too small (${envelope.length} bytes)`);
  }
  const version = envelope[0];
  if (version !== ENVELOPE_VERSION && version !== LEGACY_ENVELOPE_VERSION) {
    throw new Error(`AtRestEncryption.decrypt: unsupported envelope version ${version} (this binary understands ${LEGACY_ENVELOPE_VERSION} and ${ENVELOPE_VERSION})`);
  }
  let off = 1;
  const iv = envelope.subarray(off, off += IV_BYTES);
  const tag = envelope.subarray(off, off += TAG_BYTES);
  const ct = envelope.subarray(off);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (version === ENVELOPE_VERSION) decipher.setAAD(aadOf(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('AtRestEncryption.decrypt: authentication failed — wrong key or tampered envelope');
  }
}

/**
 * Convenience: encrypt a JS object as JSON and return the envelope.
 */
function encryptJson (obj: unknown, key: Buffer, context: string = ''): string {
  return encrypt(JSON.stringify(obj), key, context);
}

/**
 * Convenience: decrypt and JSON.parse. Throws if the plaintext isn't valid JSON.
 */
function decryptJson (encoded: string, key: Buffer, context: string = ''): unknown {
  const pt = decrypt(encoded, key, context);
  try { return JSON.parse(pt.toString('utf8')); } catch {
    throw new Error('AtRestEncryption.decryptJson: decrypted payload is not valid JSON');
  }
}

export { ENVELOPE_VERSION, LEGACY_ENVELOPE_VERSION, KEY_BYTES, deriveKey, encrypt, decrypt, encryptJson, decryptJson, envelopeVersion };
