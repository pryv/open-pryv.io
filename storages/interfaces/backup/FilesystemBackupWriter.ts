/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';
import type { BackupWriter, UserBackupWriter, BackupWriteManifestParams } from './BackupWriter.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { createBackupWriter, createUserBackupWriter } = require('./BackupWriter');

const DEFAULT_MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB (output file size)

interface WriterOptions {
  /** max output file size in bytes (compressed when compression is on) */
  maxChunkSize?: number;
  /** gzip JSONL/CSV files */
  compress?: boolean;
}

interface ResolvedWriterOptions {
  maxChunkSize: number;
  compress: boolean;
}

/**
 * Create a FilesystemBackupWriter rooted at `outputPath`.
 */
function createFilesystemBackupWriter (outputPath: string, options?: WriterOptions): BackupWriter {
  const opts: ResolvedWriterOptions = Object.assign(
    { maxChunkSize: DEFAULT_MAX_CHUNK_SIZE, compress: true },
    options
  );
  fs.mkdirSync(outputPath, { recursive: true });

  return createBackupWriter({
    async openUser (userId: string, username: string): Promise<UserBackupWriter> {
      const userDir = path.join(outputPath, 'users', userId);
      fs.mkdirSync(userDir, { recursive: true });
      return createFilesystemUserBackupWriter(userDir, userId, username, opts);
    },

    async writePlatformData (data: AsyncIterable<any> | any[]) {
      const platformDir = path.join(outputPath, 'platform');
      fs.mkdirSync(platformDir, { recursive: true });
      const filePath = path.join(platformDir, jsonlFileName('platform', opts.compress));
      await writeJsonlFile(filePath, data, opts.compress);
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
      fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
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
    async writeStreams (items: AsyncIterable<any> | any[]) {
      const filePath = path.join(userDir, jsonlFileName('streams', opts.compress));
      stats.streams = await writeJsonlFile(filePath, items, opts.compress);
    },

    async writeAccesses (items: AsyncIterable<any> | any[]) {
      const filePath = path.join(userDir, jsonlFileName('accesses', opts.compress));
      stats.accesses = await writeJsonlFile(filePath, items, opts.compress);
    },

    async writeProfile (items: AsyncIterable<any> | any[]) {
      const filePath = path.join(userDir, jsonlFileName('profile', opts.compress));
      stats.profile = await writeJsonlFile(filePath, items, opts.compress);
    },

    async writeWebhooks (items: AsyncIterable<any> | any[]) {
      const filePath = path.join(userDir, jsonlFileName('webhooks', opts.compress));
      stats.webhooks = await writeJsonlFile(filePath, items, opts.compress);
    },

    async writeEvents (items: AsyncIterable<any> | any[]) {
      const eventsDir = path.join(userDir, 'events');
      fs.mkdirSync(eventsDir, { recursive: true });
      const result = await writeChunkedJsonlFiles(eventsDir, 'events', items, opts);
      stats.events = result.totalCount;
      chunks.events = result.chunkFiles;
    },

    async writeAudit (items: AsyncIterable<any> | any[]) {
      const auditDir = path.join(userDir, 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const result = await writeChunkedJsonlFiles(auditDir, 'audit', items, opts);
      stats.audit = result.totalCount;
      chunks.audit = result.chunkFiles;
    },

    async writeSeries (items: AsyncIterable<any> | any[]) {
      const seriesDir = path.join(userDir, 'series');
      fs.mkdirSync(seriesDir, { recursive: true });
      const filePath = path.join(seriesDir, jsonlFileName('series', opts.compress));
      stats.series = await writeJsonlFile(filePath, items, opts.compress);
    },

    async writeAttachment (eventId: string, fileId: string, readStream: Readable) {
      const attachDir = path.join(userDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });
      const filePath = path.join(attachDir, fileId);
      const writeStream = fs.createWriteStream(filePath);
      await pipeline(readStream, writeStream);
      stats.attachments++;
    },

    async writeAccountData (data: any) {
      const filePath = path.join(userDir, jsonlFileName('account', opts.compress));
      // Account data is a single object, not a collection — write as one JSON line
      await writeJsonlFile(filePath, [data], opts.compress);
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
      fs.writeFileSync(filePath, JSON.stringify(userManifest, null, 2));
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
async function writeJsonlFile (filePath: string, items: AsyncIterable<any> | any[], compress: boolean): Promise<number> {
  let count = 0;
  const lines: string[] = [];
  for await (const item of items) {
    lines.push(JSON.stringify(item));
    count++;
  }
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const buffer = Buffer.from(content, 'utf8');

  if (compress) {
    const compressed = zlib.gzipSync(buffer);
    fs.writeFileSync(filePath, compressed);
  } else {
    fs.writeFileSync(filePath, buffer);
  }
  return count;
}

/**
 * Write items to chunked JSONL files, targeting maxChunkSize per output file.
 * When compression is enabled, the target applies to the compressed (gzip) output size.
 * When compression is off, the target applies to the raw file size.
 * Files may exceed the target by ~10% — this is a soft limit.
 */
async function writeChunkedJsonlFiles (dir: string, baseName: string, items: AsyncIterable<any> | any[], opts: ResolvedWriterOptions): Promise<{ totalCount: number, chunkFiles: string[] }> {
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
    fs.writeFileSync(filePath, output);
    chunkFiles.push(fileName);
    chunkIndex++;
    currentLines = [];
  }

  // Track uncompressed size as a proxy — check actual output size every N items.
  // In compressed mode we also trigger an early check when rawSize has already
  // reached maxChunkSize: gzip never expands highly compressible input below its
  // header size but cannot shrink below ~20 bytes either, so once the raw size
  // exceeds the target, the compressed output is *possibly* over the limit —
  // worth a check. Without this lower-bound trigger, small datasets (fewer than
  // CHECK_INTERVAL items) never fire the batch check and produce a single chunk
  // regardless of maxChunkSize — see Plan 28 Phase 1.
  let rawSize = 0;
  const CHECK_INTERVAL = 100;

  for await (const item of items) {
    const line = JSON.stringify(item);
    currentLines.push(line);
    rawSize += Buffer.byteLength(line, 'utf8') + 1;
    totalCount++;

    // Uncompressed mode: rawSize IS the file size — check directly.
    if (!opts.compress) {
      if (rawSize >= opts.maxChunkSize) {
        flushChunk();
        rawSize = 0;
      }
      continue;
    }

    // Compressed mode: check when either
    //   (a) the batch interval hit — amortizes gzipSync cost on large datasets
    //   (b) raw size already exceeds the target — catches small datasets and
    //       aggressive maxChunkSize values where the batch check never fires.
    const batchHit = currentLines.length % CHECK_INTERVAL === 0;
    const rawOverBudget = rawSize >= opts.maxChunkSize;
    if (batchHit || rawOverBudget) {
      const content = currentLines.join('\n') + '\n';
      const compressed = zlib.gzipSync(Buffer.from(content, 'utf8'));
      if (compressed.length >= opts.maxChunkSize) {
        flushChunk();
        rawSize = 0;
      }
    }
  }

  flushChunk();
  return { totalCount, chunkFiles };
}

export { createFilesystemBackupWriter };