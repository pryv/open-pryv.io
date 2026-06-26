/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * On-demand encryption for backup output.
 *
 * Goal: the bytes written to the backup destination are ciphertext only —
 * plaintext PHI/PII is never materialised on the recipient disk. Encryption
 * is the OUTERMOST layer in the write pipeline:
 *
 *   serialize -> gzip -> encrypt -> disk        (read: disk -> decrypt -> gunzip -> parse)
 *
 * Two key models (opt-in; absence of a key = today's plaintext behaviour):
 *
 *   - hybrid (recommended): a fresh random 32-byte data key encrypts every
 *     file; that data key is wrapped with the recipient's RSA public key
 *     (RSA-OAEP, SHA-256). The backup-producing host holds NO secret that can
 *     decrypt its own output — only the holder of the private key can restore.
 *   - symmetric: a single passphrase is scrypt-derived into the data key. The
 *     simple option; the operator can decrypt its own backups.
 *
 * Wire format — per file (identical filenames; only the content changes):
 *   MAGIC      8 bytes   "PRYVBKE1"
 *   headerLen  4 bytes   big-endian uint32
 *   header     N bytes   JSON { v, salt(base64), chunk }
 *   frames...  each: payloadLen(4 BE) | ciphertext | tag(16)
 *
 * Per file: a random 16-byte salt derives a per-file subkey via HKDF-SHA256
 * from the data key, so the data key is never used directly and each file is
 * independently keyed. Per chunk: a counter nonce (chunk index), safe because
 * the subkey is unique per file. AES-256-GCM authenticates every chunk.
 *
 * The data-key envelope (mode + wrapped key / kdf params) lives in a single
 * cleartext `encryption.json` at the backup root — it carries crypto headers
 * only, never user-identifying data.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const crypto = require('node:crypto');
const { Transform } = require('node:stream');

const MAGIC = Buffer.from('PRYVBKE1', 'utf8'); // 8 bytes
const DEFAULT_CHUNK = 64 * 1024; // plaintext bytes per GCM chunk
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const HKDF_INFO = Buffer.from('pryv-backup-file-v1', 'utf8');
const ENVELOPE_ALG = 'AES-256-GCM-CHUNKED';
const SCRYPT = { N: 16384, r: 8, p: 1 };

interface EncryptorOptions {
  passphrase?: string;
  recipientPubKeyPem?: string | Buffer;
  chunkSize?: number;
}

interface DecryptorSecrets {
  passphrase?: string;
  privateKeyPem?: string | Buffer;
  privateKeyPassphrase?: string;
}

type Envelope = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Key + frame primitives
// ---------------------------------------------------------------------------

function deriveFileKey (dataKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', dataKey, salt, HKDF_INFO, KEY_BYTES));
}

/** 12-byte big-endian counter nonce — safe because the file subkey is unique. */
function counterNonce (index: number): Buffer {
  const b = Buffer.alloc(NONCE_BYTES);
  b.writeUInt32BE(Math.floor(index / 0x100000000), NONCE_BYTES - 8);
  b.writeUInt32BE(index >>> 0, NONCE_BYTES - 4);
  return b;
}

function encodeHeader (salt: Buffer, chunk: number): Buffer {
  const header = Buffer.from(JSON.stringify({ v: 1, salt: salt.toString('base64'), chunk }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, len, header]);
}

function encryptChunk (fileKey: Buffer, index: number, plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, counterNonce(index));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const payload = Buffer.concat([ct, cipher.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

function decryptChunk (fileKey: Buffer, index: number, payload: Buffer): Buffer {
  if (payload.length < TAG_BYTES) throw new Error('BackupCipher: truncated chunk');
  const ct = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, counterNonce(index));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function parseHeader (buf: Buffer): { salt: Buffer; chunk: number; offset: number } {
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('BackupCipher: not a Pryv encrypted backup file (bad magic)');
  }
  const headerLen = buf.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  const header = JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8'));
  return { salt: Buffer.from(header.salt, 'base64'), chunk: header.chunk, offset: headerEnd };
}

// ---------------------------------------------------------------------------
// Buffer-level encrypt / decrypt (used by the in-memory JSONL path)
// ---------------------------------------------------------------------------

function encryptBuffer (dataKey: Buffer, chunk: number, plaintext: Buffer): Buffer {
  const salt = crypto.randomBytes(16);
  const fileKey = deriveFileKey(dataKey, salt);
  const parts: Buffer[] = [encodeHeader(salt, chunk)];
  let index = 0;
  for (let off = 0; off < plaintext.length; off += chunk) {
    parts.push(encryptChunk(fileKey, index++, plaintext.subarray(off, off + chunk)));
  }
  return Buffer.concat(parts);
}

function decryptBuffer (dataKey: Buffer, full: Buffer): Buffer {
  const { salt, offset } = parseHeader(full);
  const fileKey = deriveFileKey(dataKey, salt);
  const out: Buffer[] = [];
  let off = offset;
  let index = 0;
  while (off < full.length) {
    const len = full.readUInt32BE(off);
    off += 4;
    out.push(decryptChunk(fileKey, index++, full.subarray(off, off + len)));
    off += len;
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Streaming encrypt / decrypt (used by the attachment path — bounded memory)
// ---------------------------------------------------------------------------

function createEncryptStream (dataKey: Buffer, chunk: number): NodeJS.ReadWriteStream {
  const salt = crypto.randomBytes(16);
  const fileKey = deriveFileKey(dataKey, salt);
  let buffered = Buffer.alloc(0);
  let index = 0;
  let headerPushed = false;
  return new Transform({
    transform (piece: Buffer, _enc: string, cb: (e?: Error) => void) {
      try {
        if (!headerPushed) { this.push(encodeHeader(salt, chunk)); headerPushed = true; }
        buffered = Buffer.concat([buffered, piece]);
        while (buffered.length >= chunk) {
          this.push(encryptChunk(fileKey, index++, buffered.subarray(0, chunk)));
          buffered = buffered.subarray(chunk);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush (cb: (e?: Error) => void) {
      try {
        if (!headerPushed) { this.push(encodeHeader(salt, chunk)); headerPushed = true; }
        if (buffered.length > 0) this.push(encryptChunk(fileKey, index++, buffered));
        cb();
      } catch (e) { cb(e as Error); }
    }
  });
}

function createDecryptStream (dataKey: Buffer): NodeJS.ReadWriteStream {
  let fileKey: Buffer | null = null;
  let buffered = Buffer.alloc(0);
  let index = 0;
  let headerParsed = false;
  return new Transform({
    transform (piece: Buffer, _enc: string, cb: (e?: Error) => void) {
      try {
        buffered = Buffer.concat([buffered, piece]);
        if (!headerParsed) {
          if (buffered.length < MAGIC.length + 4) return cb();
          const headerLen = buffered.readUInt32BE(MAGIC.length);
          const headerEnd = MAGIC.length + 4 + headerLen;
          if (buffered.length < headerEnd) return cb();
          const { salt } = parseHeader(buffered.subarray(0, headerEnd));
          fileKey = deriveFileKey(dataKey, salt);
          buffered = buffered.subarray(headerEnd);
          headerParsed = true;
        }
        while (buffered.length >= 4) {
          const len = buffered.readUInt32BE(0);
          if (buffered.length < 4 + len) break;
          this.push(decryptChunk(fileKey as Buffer, index++, buffered.subarray(4, 4 + len)));
          buffered = buffered.subarray(4 + len);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush (cb: (e?: Error) => void) {
      if (!headerParsed || buffered.length !== 0) return cb(new Error('BackupCipher: truncated encrypted stream'));
      cb();
    }
  });
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------

interface BackupEncryptor {
  envelope: Envelope;
  chunk: number;
  encryptBuffer: (buf: Buffer) => Buffer;
  encryptStream: () => NodeJS.ReadWriteStream;
}

interface BackupDecryptor {
  decryptBuffer: (buf: Buffer) => Buffer;
  decryptStream: () => NodeJS.ReadWriteStream;
}

/**
 * Build an encryptor. Provide `recipientPubKeyPem` for the hybrid model
 * (recommended — the host holds no decrypt secret) or `passphrase` for the
 * symmetric model. The returned `envelope` MUST be written cleartext to the
 * backup root as `encryption.json`.
 */
function createBackupEncryptor (opts: EncryptorOptions): BackupEncryptor {
  const chunk = opts.chunkSize || DEFAULT_CHUNK;
  let dataKey: Buffer;
  let envelope: Envelope;
  if (opts.recipientPubKeyPem) {
    dataKey = crypto.randomBytes(KEY_BYTES);
    const wrapped = crypto.publicEncrypt(
      { key: opts.recipientPubKeyPem, oaepHash: 'sha256' },
      dataKey
    );
    envelope = { v: 1, alg: ENVELOPE_ALG, chunk, mode: 'hybrid', wrap: 'RSA-OAEP-SHA256', wrappedKey: wrapped.toString('base64') };
  } else if (opts.passphrase) {
    const salt = crypto.randomBytes(16);
    dataKey = crypto.scryptSync(opts.passphrase, salt, KEY_BYTES, SCRYPT);
    envelope = { v: 1, alg: ENVELOPE_ALG, chunk, mode: 'symmetric', kdf: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  } else {
    throw new Error('createBackupEncryptor: passphrase or recipientPubKeyPem required');
  }
  return {
    envelope,
    chunk,
    encryptBuffer: (buf: Buffer) => encryptBuffer(dataKey, chunk, buf),
    encryptStream: () => createEncryptStream(dataKey, chunk)
  };
}

/**
 * Build a decryptor from the cleartext `encryption.json` envelope plus the
 * matching secret (`privateKeyPem` for hybrid, `passphrase` for symmetric).
 */
function createBackupDecryptor (envelope: Envelope, secrets: DecryptorSecrets): BackupDecryptor {
  let dataKey: Buffer;
  if (envelope.mode === 'hybrid') {
    if (!secrets.privateKeyPem) throw new Error('createBackupDecryptor: private key required to decrypt this backup');
    dataKey = crypto.privateDecrypt(
      { key: secrets.privateKeyPem, oaepHash: 'sha256', passphrase: secrets.privateKeyPassphrase },
      Buffer.from(envelope.wrappedKey as string, 'base64')
    );
  } else if (envelope.mode === 'symmetric') {
    if (!secrets.passphrase) throw new Error('createBackupDecryptor: passphrase required to decrypt this backup');
    dataKey = crypto.scryptSync(
      secrets.passphrase,
      Buffer.from(envelope.salt as string, 'base64'),
      KEY_BYTES,
      { N: envelope.N as number, r: envelope.r as number, p: envelope.p as number }
    );
  } else {
    throw new Error('createBackupDecryptor: unknown encryption mode: ' + String(envelope.mode));
  }
  return {
    decryptBuffer: (buf: Buffer) => decryptBuffer(dataKey, buf),
    decryptStream: () => createDecryptStream(dataKey)
  };
}

export { createBackupEncryptor, createBackupDecryptor, DEFAULT_CHUNK };
export type { BackupEncryptor, BackupDecryptor, EncryptorOptions, DecryptorSecrets, Envelope };
