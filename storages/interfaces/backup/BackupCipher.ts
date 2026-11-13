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
 *   header     N bytes   JSON { v: 2, salt(base64), chunk, path, run, chain }
 *   frames...  each: payloadLen(4 BE) | ciphertext | tag(16)
 *
 * Per file: a random 16-byte salt derives a per-file subkey via HKDF-SHA256
 * from the data key, so the data key is never used directly and each file is
 * independently keyed. Per chunk: a counter nonce (chunk index), safe because
 * the subkey is unique per file. AES-256-GCM authenticates every chunk.
 *
 * Version 2 binds every frame to its file: the authenticated data of frame i
 * is sha256(MAGIC | headerLen | header) | u64be(i) | final flag (1 byte). The
 * header names the file (`path`, relative to its run directory), the run and
 * the chain, so a file presented under another name, in another run or chain,
 * a frame moved between files and a file cut at a frame boundary all fail.
 * Every version-2 file ends with exactly one frame flagged final (an empty
 * plaintext is one empty final frame). Version 1 files (no authenticated data,
 * no final frame) are still read.
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
const SCRYPT = { N: 131072, r: 8, p: 1 };
// scrypt needs 128 * N * r bytes; Node's default ceiling (32 MiB) is below N = 2^17.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const FORMAT_VERSION = 2;
const FULL_RUN_ID = 'full';

/** The run a file belongs to: named in the header of every file it writes. */
interface RunIdentity {
  runId: string;
  chainId: string | null;
}

interface EncryptorOptions {
  passphrase?: string;
  recipientPubKeyPem?: string | Buffer;
  chunkSize?: number;
  /** The run this encryptor writes (default: the root run of no chain). */
  run?: RunIdentity | null;
}

interface DecryptorSecrets {
  passphrase?: string;
  privateKeyPem?: string | Buffer;
  privateKeyPassphrase?: string;
}

/**
 * What a reader expects of a file: its path relative to its run directory,
 * its run and chain (each checked against a version-2 header when given), and
 * optionally the format version (`2` refuses a version-1 file).
 */
interface DecryptExpectation {
  path?: string;
  runId?: string;
  chainId?: string | null;
  requireVersion?: number;
}

type Envelope = Record<string, unknown>;

/** A file of an older format where the reader requires the current one. */
class BackupFormatError extends Error {
  code: string;
  constructor (message: string) {
    super(message);
    this.name = 'BackupFormatError';
    this.code = 'ERR_BACKUP_OLD_FORMAT';
  }
}

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

/** Authenticated data of frame `index` of a version-2 file: binds it to the header, its position and the end. */
function frameAad (headerDigest: Buffer, index: number, final: boolean): Buffer {
  const b = Buffer.alloc(9);
  b.writeUInt32BE(Math.floor(index / 0x100000000), 0);
  b.writeUInt32BE(index >>> 0, 4);
  b[8] = final ? 1 : 0;
  return Buffer.concat([headerDigest, b]);
}

interface FileHeader {
  v: number;
  salt: Buffer;
  chunk: number;
  path: string | null;
  run: string | null;
  chain: string | null;
  /** The header bytes as written (magic, length, JSON). */
  bytes: Buffer;
  /** sha256 of `bytes` (version 2). */
  digest: Buffer;
}

function encodeHeader (salt: Buffer, chunk: number, filePath: string | null, run: RunIdentity | null): Buffer {
  const header = Buffer.from(JSON.stringify({
    v: FORMAT_VERSION,
    salt: salt.toString('base64'),
    chunk,
    path: filePath,
    run: run?.runId ?? FULL_RUN_ID,
    chain: run?.chainId ?? null
  }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, len, header]);
}

function encryptChunk (fileKey: Buffer, index: number, plain: Buffer, aad: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, counterNonce(index), { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const payload = Buffer.concat([ct, cipher.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([len, payload]);
}

function decryptChunk (fileKey: Buffer, index: number, payload: Buffer, aad: Buffer | null): Buffer {
  if (payload.length < TAG_BYTES) throw new Error('BackupCipher: truncated chunk');
  const ct = payload.subarray(0, payload.length - TAG_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, counterNonce(index), { authTagLength: TAG_BYTES });
  if (aad != null) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Decrypt frame `index` of a version-2 file. Which frame is the last is not
 * known in advance: the frame is tried as not final, then as final (GCM
 * releases no plaintext of a frame whose tag fails).
 */
function decryptFrameV2 (fileKey: Buffer, header: FileHeader, index: number, payload: Buffer): { plain: Buffer, final: boolean } {
  if (payload.length < TAG_BYTES) throw new Error('BackupCipher: truncated chunk');
  try {
    return { plain: decryptChunk(fileKey, index, payload, frameAad(header.digest, index, false)), final: false };
  } catch (err) {
    try {
      return { plain: decryptChunk(fileKey, index, payload, frameAad(header.digest, index, true)), final: true };
    } catch (err2) {
      throw new Error(`BackupCipher: authentication failed (frame ${index}${header.path != null ? ' of ' + header.path : ''}): wrong key, or the file was altered`);
    }
  }
}

function parseHeader (buf: Buffer): FileHeader & { offset: number } {
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('BackupCipher: not a Pryv encrypted backup file (bad magic)');
  }
  const headerLen = buf.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLen;
  if (buf.length < headerEnd) throw new Error('BackupCipher: truncated encrypted file (header)');
  let header;
  try {
    header = JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8'));
  } catch (err) {
    throw new Error('BackupCipher: invalid file header');
  }
  if (header == null || (header.v !== 1 && header.v !== FORMAT_VERSION)) {
    throw new Error('BackupCipher: unsupported file format version ' + JSON.stringify(header?.v));
  }
  const bytes = buf.subarray(0, headerEnd);
  return {
    v: header.v,
    salt: Buffer.from(header.salt, 'base64'),
    chunk: header.chunk,
    path: typeof header.path === 'string' ? header.path : null,
    run: typeof header.run === 'string' ? header.run : null,
    chain: typeof header.chain === 'string' ? header.chain : null,
    bytes,
    digest: crypto.createHash('sha256').update(bytes).digest(),
    offset: headerEnd
  };
}

/** Refuse a file whose header names another file, run or chain than the one expected. */
function checkHeader (header: FileHeader, expect: DecryptExpectation): void {
  if (expect.requireVersion != null && header.v < expect.requireVersion) {
    throw new BackupFormatError(`BackupCipher: file ${expect.path ?? '(unnamed)'} of run ${expect.runId ?? '(any)'} is in format version ${header.v} in a run of format ${expect.requireVersion}: refused`);
  }
  if (header.v < FORMAT_VERSION) return;
  const mismatch = (expect.path !== undefined && header.path !== expect.path) ||
    (expect.runId !== undefined && header.run !== expect.runId) ||
    (expect.chainId !== undefined && header.chain !== (expect.chainId ?? null));
  if (mismatch) {
    throw new Error(`BackupCipher: file ${expect.path ?? '(unnamed)'} of run ${expect.runId ?? '(any)'} carries the identity of ` +
      `${header.path ?? '(unnamed)'} (run ${header.run ?? '?'}${header.chain != null ? ', chain ' + header.chain : ''}): refused`);
  }
}

// ---------------------------------------------------------------------------
// Buffer-level encrypt / decrypt (used by the in-memory JSONL path)
// ---------------------------------------------------------------------------

function encryptBuffer (dataKey: Buffer, chunk: number, plaintext: Buffer, filePath: string | null, run: RunIdentity | null): Buffer {
  const salt = crypto.randomBytes(16);
  const fileKey = deriveFileKey(dataKey, salt);
  const header = encodeHeader(salt, chunk, filePath, run);
  const digest = crypto.createHash('sha256').update(header).digest();
  const parts: Buffer[] = [header];
  const frames = Math.max(1, Math.ceil(plaintext.length / chunk));
  for (let index = 0; index < frames; index++) {
    const final = index === frames - 1;
    parts.push(encryptChunk(fileKey, index, plaintext.subarray(index * chunk, (index + 1) * chunk), frameAad(digest, index, final)));
  }
  return Buffer.concat(parts);
}

function decryptBuffer (dataKey: Buffer, full: Buffer, expect: DecryptExpectation): Buffer {
  const header = parseHeader(full);
  checkHeader(header, expect);
  const fileKey = deriveFileKey(dataKey, header.salt);
  const out: Buffer[] = [];
  let off = header.offset;
  let index = 0;
  let finalSeen = false;
  while (off < full.length) {
    if (finalSeen) throw new Error('BackupCipher: data after the final frame');
    if (off + 4 > full.length) throw new Error('BackupCipher: truncated chunk');
    const len = full.readUInt32BE(off);
    off += 4;
    if (off + len > full.length) throw new Error('BackupCipher: truncated chunk');
    const payload = full.subarray(off, off + len);
    off += len;
    if (header.v === 1) {
      out.push(decryptChunk(fileKey, index++, payload, null));
    } else {
      const frame = decryptFrameV2(fileKey, header, index++, payload);
      out.push(frame.plain);
      finalSeen = frame.final;
    }
  }
  if (header.v !== 1 && !finalSeen) throw new Error('BackupCipher: truncated encrypted file (no final frame)');
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Streaming encrypt / decrypt (used by the attachment path — bounded memory)
// ---------------------------------------------------------------------------

function createEncryptStream (dataKey: Buffer, chunk: number, filePath: string | null, run: RunIdentity | null): NodeJS.ReadWriteStream {
  const salt = crypto.randomBytes(16);
  const fileKey = deriveFileKey(dataKey, salt);
  const header = encodeHeader(salt, chunk, filePath, run);
  const digest = crypto.createHash('sha256').update(header).digest();
  let buffered = Buffer.alloc(0);
  let index = 0;
  let headerPushed = false;
  return new Transform({
    transform (piece: Buffer, _enc: string, cb: (e?: Error) => void) {
      try {
        if (!headerPushed) { this.push(header); headerPushed = true; }
        buffered = Buffer.concat([buffered, piece]);
        // Keep at least one chunk back: the last frame is written final, in flush.
        while (buffered.length > chunk) {
          this.push(encryptChunk(fileKey, index, buffered.subarray(0, chunk), frameAad(digest, index, false)));
          index++;
          buffered = buffered.subarray(chunk);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush (cb: (e?: Error) => void) {
      try {
        if (!headerPushed) { this.push(header); headerPushed = true; }
        // Always one final frame, empty when the input was.
        this.push(encryptChunk(fileKey, index, buffered, frameAad(digest, index, true)));
        index++;
        cb();
      } catch (e) { cb(e as Error); }
    }
  });
}

function createDecryptStream (dataKey: Buffer, expect: DecryptExpectation): NodeJS.ReadWriteStream {
  let fileKey: Buffer | null = null;
  let header: FileHeader | null = null;
  let buffered = Buffer.alloc(0);
  let index = 0;
  let finalSeen = false;
  return new Transform({
    transform (piece: Buffer, _enc: string, cb: (e?: Error) => void) {
      try {
        buffered = Buffer.concat([buffered, piece]);
        if (header == null) {
          if (buffered.length < MAGIC.length + 4) return cb();
          const headerLen = buffered.readUInt32BE(MAGIC.length);
          const headerEnd = MAGIC.length + 4 + headerLen;
          if (buffered.length < headerEnd) return cb();
          const parsed = parseHeader(buffered.subarray(0, headerEnd));
          checkHeader(parsed, expect);
          header = parsed;
          fileKey = deriveFileKey(dataKey, parsed.salt);
          buffered = buffered.subarray(headerEnd);
        }
        while (buffered.length >= 4) {
          if (finalSeen) throw new Error('BackupCipher: data after the final frame');
          const len = buffered.readUInt32BE(0);
          if (buffered.length < 4 + len) break;
          const payload = buffered.subarray(4, 4 + len);
          if (header.v === 1) {
            this.push(decryptChunk(fileKey as Buffer, index++, payload, null));
          } else {
            const frame = decryptFrameV2(fileKey as Buffer, header, index++, payload);
            finalSeen = frame.final;
            if (frame.plain.length > 0) this.push(frame.plain);
          }
          buffered = buffered.subarray(4 + len);
        }
        if (finalSeen && buffered.length > 0) throw new Error('BackupCipher: data after the final frame');
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush (cb: (e?: Error) => void) {
      if (header == null || buffered.length !== 0) return cb(new Error('BackupCipher: truncated encrypted stream'));
      if (header.v !== 1 && !finalSeen) return cb(new Error('BackupCipher: truncated encrypted file (no final frame)'));
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
  /** Hybrid model only: `sha256:<hex>` of the recipient public key (SPKI DER). */
  recipientKeyFingerprint?: string;
  /** The run this encryptor is bound to; null: not bound (a writer binds it to its own run). */
  run: RunIdentity | null;
  /** Encrypt a whole file; `filePath` is its path relative to its run directory. */
  encryptBuffer: (buf: Buffer, filePath?: string) => Buffer;
  encryptStream: (filePath?: string) => NodeJS.ReadWriteStream;
  /** The same data key bound to `run`; refused when this encryptor is bound to another run. */
  forRun: (run: RunIdentity) => BackupEncryptor;
}

/**
 * `sha256:<hex>` of the SPKI DER of a public key, or of the public half of a
 * private key: names the recipient key of a hybrid backup chain without
 * holding any secret.
 */
function recipientKeyFingerprint (key: string | Buffer | { key: string | Buffer, passphrase?: string } | object): string {
  const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return 'sha256:' + crypto.createHash('sha256').update(der).digest('hex');
}

interface BackupDecryptor {
  /** Decrypt a whole file; `expect` names the file (see DecryptExpectation). */
  decryptBuffer: (buf: Buffer, expect?: DecryptExpectation) => Buffer;
  decryptStream: (expect?: DecryptExpectation) => NodeJS.ReadWriteStream;
}

function sameRun (a: RunIdentity, b: RunIdentity): boolean {
  return a.runId === b.runId && (a.chainId ?? null) === (b.chainId ?? null);
}

function bindEncryptor (envelope: Envelope, chunk: number, dataKey: Buffer, fingerprint: string | undefined, run: RunIdentity | null): BackupEncryptor {
  return {
    envelope,
    chunk,
    ...(fingerprint != null ? { recipientKeyFingerprint: fingerprint } : {}),
    run,
    encryptBuffer: (buf: Buffer, filePath?: string) => encryptBuffer(dataKey, chunk, buf, filePath ?? null, run),
    encryptStream: (filePath?: string) => createEncryptStream(dataKey, chunk, filePath ?? null, run),
    forRun (target: RunIdentity): BackupEncryptor {
      if (run != null && !sameRun(run, target)) {
        throw new Error(`Backup writer: the encryptor is bound to run ${run.runId}, this writer writes run ${target.runId}`);
      }
      return bindEncryptor(envelope, chunk, dataKey, fingerprint, { runId: target.runId, chainId: target.chainId ?? null });
    }
  };
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
    dataKey = crypto.scryptSync(opts.passphrase, salt, KEY_BYTES, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
    envelope = { v: 1, alg: ENVELOPE_ALG, chunk, mode: 'symmetric', kdf: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  } else {
    throw new Error('createBackupEncryptor: passphrase or recipientPubKeyPem required');
  }
  const fingerprint = opts.recipientPubKeyPem ? recipientKeyFingerprint(opts.recipientPubKeyPem) : undefined;
  const run = opts.run != null ? { runId: opts.run.runId, chainId: opts.run.chainId ?? null } : null;
  return bindEncryptor(envelope, chunk, dataKey, fingerprint, run);
}

/**
 * Build a decryptor from the cleartext `encryption.json` envelope plus the
 * matching secret (`privateKeyPem` for hybrid, `passphrase` for symmetric).
 * `run` names the run every file read must belong to (version-2 headers).
 */
function createBackupDecryptor (envelope: Envelope, secrets: DecryptorSecrets, run?: RunIdentity | null): BackupDecryptor {
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
      { N: envelope.N as number, r: envelope.r as number, p: envelope.p as number, maxmem: SCRYPT_MAXMEM }
    );
  } else {
    throw new Error('createBackupDecryptor: unknown encryption mode: ' + String(envelope.mode));
  }
  const base: DecryptExpectation = run != null ? { runId: run.runId, chainId: run.chainId ?? null } : {};
  return {
    decryptBuffer: (buf: Buffer, expect?: DecryptExpectation) => decryptBuffer(dataKey, buf, { ...base, ...expect }),
    decryptStream: (expect?: DecryptExpectation) => createDecryptStream(dataKey, { ...base, ...expect })
  };
}

/** The format version in the header of an encrypted backup file (1 or 2). */
function fileFormatVersion (buf: Buffer): number {
  return parseHeader(buf).v;
}

export { createBackupEncryptor, createBackupDecryptor, recipientKeyFingerprint, fileFormatVersion, BackupFormatError, DEFAULT_CHUNK, FORMAT_VERSION };
export type { BackupEncryptor, BackupDecryptor, EncryptorOptions, DecryptorSecrets, DecryptExpectation, Envelope, RunIdentity };
