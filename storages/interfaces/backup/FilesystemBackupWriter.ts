/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';
import type { BackupWriter, UserBackupWriter, BackupWriteManifestParams } from './BackupWriter.js';
import type { BackupEncryptor } from './BackupCipher.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { createBackupWriter, createUserBackupWriter } = require('./BackupWriter.ts');
const { STANDALONE_DECRYPT_SCRIPT, buildRestoreReadme, RESTORE_README_NAME, DECRYPT_SCRIPT_NAME } = require('./restoreReadme.ts');

const DEFAULT_MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB of raw (pre-gzip) bytes per chunk

interface WriterOptions {
  /**
   * Target chunk size in RAW (pre-gzip) bytes. gzip shrinks compressible data
   * well below this and, worst case, expands incompressible data by only
   * ~0.03% plus a small header, so this approximately bounds the on-disk file
   * size too. Only affects chunked collections (events, audit).
   */
  maxChunkSize?: number;
  /** gzip JSONL/CSV files */
  compress?: boolean;
  /**
   * When set, every file's content is encrypted (outermost layer, after gzip)
   * so plaintext never touches the destination disk. Filenames are unchanged;
   * the cleartext `encryption.json` envelope at the root flags the backup as
   * encrypted for restore.
   */
  encryptor?: BackupEncryptor | null;
}

interface ResolvedWriterOptions {
  maxChunkSize: number;
  compress: boolean;
  encryptor: BackupEncryptor | null;
}

/**
 * Write a buffer to disk, encrypting it first when an encryptor is configured.
 * This is the single choke point that guarantees only ciphertext is flushed.
 */
function persist (filePath: string, buffer: Buffer, encryptor: BackupEncryptor | null): void {
  fs.writeFileSync(filePath, encryptor ? encryptor.encryptBuffer(buffer) : buffer);
}

/**
 * Create a FilesystemBackupWriter rooted at `outputPath`.
 */
function createFilesystemBackupWriter (outputPath: string, options?: WriterOptions): BackupWriter {
  const opts: ResolvedWriterOptions = Object.assign(
    { maxChunkSize: DEFAULT_MAX_CHUNK_SIZE, compress: true, encryptor: null },
    options
  );
  fs.mkdirSync(outputPath, { recursive: true });

  // Write the cleartext crypto envelope so restore can discover key model +
  // wrapped data key. It carries crypto headers only — never user data.
  // Ship self-recovery artifacts next to it so the backup can be decrypted by
  // the key holder even on a machine without Pryv.io installed.
  if (opts.encryptor) {
    fs.writeFileSync(
      path.join(outputPath, 'encryption.json'),
      JSON.stringify(opts.encryptor.envelope, null, 2)
    );
    fs.writeFileSync(path.join(outputPath, DECRYPT_SCRIPT_NAME), STANDALONE_DECRYPT_SCRIPT);
    fs.writeFileSync(path.join(outputPath, RESTORE_README_NAME), buildRestoreReadme(opts.encryptor.envelope));
  }

  return createBackupWriter({
    async openUser (userId: string, username: string): Promise<UserBackupWriter> {
      const userDir = path.join(outputPath, 'users', userId);
      fs.mkdirSync(userDir, { recursive: true });
      return createFilesystemUserBackupWriter(userDir, userId, username, opts);
    },

    async writePlatformData (data: AsyncIterable<unknown> | unknown[]) {
      const platformDir = path.join(outputPath, 'platform');
      fs.mkdirSync(platformDir, { recursive: true });
      const filePath = path.join(platformDir, jsonlFileName('platform', opts.compress));
      await writeJsonlFile(filePath, data, opts.compress, opts.encryptor);
    },

    async writeManifest (params: BackupWriteManifestParams) {
      const manifest = {
        formatVersion: 1,
        coreVersion: params.coreVersion,
        config: params.config,
        backupType: params.backupType,
        backupTimestamp: params.backupTimestamp,
        snapshotBefore: params.snapshotBefore || null,
        users: params.userManifests,
        compressed: opts.compress
      };
      const filePath = path.join(outputPath, 'manifest.json');
      persist(filePath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), opts.encryptor);
    },

    async close () { /* no-op for filesystem */ }
  });
}

// ---------------------------------------------------------------------------
// FilesystemUserBackupWriter
// ---------------------------------------------------------------------------

interface UserStats {
  streams: number;
  accesses: number;
  profile: number;
  webhooks: number;
  events: number;
  audit: number;
  series: number;
  attachments: number;
}

function createFilesystemUserBackupWriter (userDir: string, userId: string, username: string, opts: ResolvedWriterOptions): UserBackupWriter {
  const stats: UserStats = { streams: 0, accesses: 0, profile: 0, webhooks: 0, events: 0, audit: 0, series: 0, attachments: 0 };
  const chunks: Record<string, string[]> = {};

  return createUserBackupWriter({
    async writeStreams (items: AsyncIterable<unknown> | unknown[]) {
      const filePath = path.join(userDir, jsonlFileName('streams', opts.compress));
      stats.streams = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeAccesses (items: AsyncIterable<unknown> | unknown[]) {
      const filePath = path.join(userDir, jsonlFileName('accesses', opts.compress));
      stats.accesses = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeProfile (items: AsyncIterable<unknown> | unknown[]) {
      const filePath = path.join(userDir, jsonlFileName('profile', opts.compress));
      stats.profile = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeWebhooks (items: AsyncIterable<unknown> | unknown[]) {
      const filePath = path.join(userDir, jsonlFileName('webhooks', opts.compress));
      stats.webhooks = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeEvents (items: AsyncIterable<unknown> | unknown[]) {
      const eventsDir = path.join(userDir, 'events');
      fs.mkdirSync(eventsDir, { recursive: true });
      const result = await writeChunkedJsonlFiles(eventsDir, 'events', items, opts);
      stats.events = result.totalCount;
      chunks.events = result.chunkFiles;
    },

    async writeAudit (items: AsyncIterable<unknown> | unknown[]) {
      const auditDir = path.join(userDir, 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const result = await writeChunkedJsonlFiles(auditDir, 'audit', items, opts);
      stats.audit = result.totalCount;
      chunks.audit = result.chunkFiles;
    },

    async writeSeries (items: AsyncIterable<unknown> | unknown[]) {
      const seriesDir = path.join(userDir, 'series');
      fs.mkdirSync(seriesDir, { recursive: true });
      const filePath = path.join(seriesDir, jsonlFileName('series', opts.compress));
      stats.series = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeAttachment (eventId: string, fileId: string, readStream: Readable) {
      const attachDir = path.join(userDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });
      const filePath = path.join(attachDir, fileId);
      const writeStream = fs.createWriteStream(filePath);
      // Insert the streaming cipher between read and write so the raw blob is
      // never written in the clear (attachments already stream; the transform
      // keeps memory bounded).
      if (opts.encryptor) {
        await pipeline(readStream, opts.encryptor.encryptStream(), writeStream);
      } else {
        await pipeline(readStream, writeStream);
      }
      stats.attachments++;
    },

    async writeAccountData (data: unknown) {
      const filePath = path.join(userDir, jsonlFileName('account', opts.compress));
      // Account data is a single object, not a collection — write as one JSON line
      await writeJsonlFile(filePath, [data], opts.compress, opts.encryptor);
    },

    async close () {
      const userManifest = {
        userId,
        username,
        backupTimestamp: Date.now(),
        stats,
        chunks
      };
      const filePath = path.join(userDir, 'user-manifest.json');
      persist(filePath, Buffer.from(JSON.stringify(userManifest, null, 2), 'utf8'), opts.encryptor);
      return userManifest;
    }
  });
}

// ---------------------------------------------------------------------------
// JSONL + gzip helpers
// ---------------------------------------------------------------------------

function jsonlFileName (baseName: string, compress: boolean): string {
  return compress ? baseName + '.jsonl.gz' : baseName + '.jsonl';
}

/**
 * Write items to a single JSONL file (optionally gzip-compressed).
 * Returns the count of items written.
 */
async function writeJsonlFile (filePath: string, items: AsyncIterable<unknown> | unknown[], compress: boolean, encryptor: BackupEncryptor | null): Promise<number> {
  let count = 0;
  const lines: string[] = [];
  for await (const item of items) {
    lines.push(JSON.stringify(item));
    count++;
  }
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const buffer = Buffer.from(content, 'utf8');

  persist(filePath, compress ? zlib.gzipSync(buffer) : buffer, encryptor);
  return count;
}

/**
 * Write items to chunked JSONL files, targeting maxChunkSize of RAW (pre-gzip)
 * bytes per chunk. Each chunk is compressed exactly once, at flush time, so the
 * total gzip work is O(total bytes) regardless of how compressible the data is.
 * gzip output approximately bounds the on-disk file to the target (worst-case
 * expansion on incompressible data is ~0.03% plus a small header); highly
 * compressible data simply yields smaller, more numerous files. The last
 * (partial) chunk may fall short of the target — this is a soft limit, sized by
 * raw bytes.
 */
async function writeChunkedJsonlFiles (dir: string, baseName: string, items: AsyncIterable<unknown> | unknown[], opts: ResolvedWriterOptions): Promise<{ totalCount: number, chunkFiles: string[] }> {
  let chunkIndex = 1;
  let currentLines: string[] = [];
  let totalCount = 0;
  const chunkFiles: string[] = [];

  function flushChunk () {
    if (currentLines.length === 0) return;
    const chunkName = `${baseName}-${String(chunkIndex).padStart(4, '0')}`;
    const fileName = jsonlFileName(chunkName, opts.compress);
    const filePath = path.join(dir, fileName);
    const content = currentLines.join('\n') + '\n';
    const raw = Buffer.from(content, 'utf8');
    const output = opts.compress ? zlib.gzipSync(raw) : raw;
    persist(filePath, output, opts.encryptor);
    chunkFiles.push(fileName);
    chunkIndex++;
    currentLines = [];
  }

  // Size chunks by RAW bytes and compress once per chunk in flushChunk(). This
  // works identically whether or not compression is on: gzip keeps the file at
  // or (worst case, on incompressible data) marginally above the raw cap, well
  // within the soft-limit tolerance. The
  // earlier design probed gzip(whole buffer) on every item once rawSize passed
  // the target; for highly compressible data the probe stayed under the cap, so
  // the flush never fired and the growing buffer was re-gzipped on every item —
  // O(n^2) synchronous compression that never completed (issue #121).
  let rawSize = 0;

  for await (const item of items) {
    const line = JSON.stringify(item);
    currentLines.push(line);
    rawSize += Buffer.byteLength(line, 'utf8') + 1;
    totalCount++;

    if (rawSize >= opts.maxChunkSize) {
      flushChunk();
      rawSize = 0;
    }
  }

  flushChunk();
  return { totalCount, chunkFiles };
}

export { createFilesystemBackupWriter };