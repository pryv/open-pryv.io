/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';
import type { BackupWriter, UserBackupWriter, BackupWriteManifestParams } from './BackupWriter.js';
import type { BackupEncryptor } from './BackupCipher.js';
import type { Chain, ChainRun } from './chain.ts';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { createBackupWriter, createUserBackupWriter } = require('./BackupWriter.ts');
const { STANDALONE_DECRYPT_SCRIPT, buildRestoreReadme, RESTORE_README_NAME, DECRYPT_SCRIPT_NAME } = require('./restoreReadme.ts');
const { INCREMENTALS_DIR_NAME, FULL_RUN_ID, RUN_ID_RE, BackupChainError, readChain, writeChainAtomic, chainEncryptionOf } = require('./chain.ts');

const DEFAULT_MAX_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB of raw (pre-gzip) bytes per chunk

/**
 * The run of a backup chain this writer writes. The full run writes at the
 * root and creates `chain.json`; an incremental run writes only under
 * `incrementals/<runId>/` and appends itself to the chain. Without a run, the
 * writer writes a full backup at the root and no `chain.json`.
 */
interface WriterRun {
  runId: string;
  /** `.` for the full run, `incrementals/<runId>` for an incremental run. */
  path: string;
  parentRunId: string | null;
  chainId: string;
  /** The chain an incremental run is appended to (default: the directory's `chain.json`). */
  baseChain?: Chain | null;
}

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
  /** The chain run written (see WriterRun). */
  run?: WriterRun | null;
}

interface ResolvedWriterOptions {
  maxChunkSize: number;
  compress: boolean;
  encryptor: BackupEncryptor | null;
}

// A backup holds full account data: what it creates is for its owner only.
// The modes given at creation do not apply to a file that already exists,
// hence the chmod after each write.
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function makePrivateDir (dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
}

function writePrivateFile (filePath: string, data: Buffer | string): void {
  fs.writeFileSync(filePath, data, { mode: PRIVATE_FILE_MODE });
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

/**
 * Write a buffer to disk, encrypting it first when an encryptor is configured.
 * This is the single choke point that guarantees only ciphertext is flushed.
 */
function persist (filePath: string, buffer: Buffer, encryptor: BackupEncryptor | null): void {
  writePrivateFile(filePath, encryptor ? encryptor.encryptBuffer(buffer) : buffer);
}

/**
 * Create a FilesystemBackupWriter rooted at `outputPath`.
 */
function createFilesystemBackupWriter (outputPath: string, options?: WriterOptions): BackupWriter {
  const opts: ResolvedWriterOptions = Object.assign(
    { maxChunkSize: DEFAULT_MAX_CHUNK_SIZE, compress: true, encryptor: null },
    options
  );
  const run: WriterRun | null = options?.run ?? null;
  const isIncrementalRun = run != null && run.path !== '.';
  let baseChain: Chain | null = null;
  if (run != null) {
    if (isIncrementalRun) {
      if (typeof run.runId !== 'string' || !RUN_ID_RE.test(run.runId) || run.runId === FULL_RUN_ID || run.path !== INCREMENTALS_DIR_NAME + '/' + run.runId) {
        throw new Error('Backup writer: invalid incremental run ' + JSON.stringify({ runId: run.runId, path: run.path }));
      }
      baseChain = run.baseChain ?? readChain(outputPath);
      if (baseChain == null) throw new Error(`Backup writer: no chain to append run ${run.runId} to at ${outputPath}`);
      const last = baseChain.runs[baseChain.runs.length - 1];
      if (baseChain.chainId !== run.chainId || last.runId !== run.parentRunId) {
        throw new Error(`Backup writer: run ${run.runId} does not follow the last run of the chain at ${outputPath}`);
      }
      // The run encrypts like the chain, or not at all (checked before anything is written).
      const own = chainEncryptionOf(opts.encryptor);
      const chainEnc = baseChain.encryption;
      const sameModel = own == null || chainEnc == null
        ? own == null && chainEnc == null
        : own.mode === chainEnc.mode && (own.mode !== 'hybrid' || (chainEnc.mode === 'hybrid' && own.recipientKeyFingerprint === chainEnc.recipientKeyFingerprint));
      if (!sameModel) {
        throw new Error(`Backup writer: the key model of run ${run.runId} differs from the chain's at ${outputPath}`);
      }
    } else if (run.runId !== FULL_RUN_ID || run.path !== '.') {
      throw new Error('Backup writer: invalid full run ' + JSON.stringify({ runId: run.runId, path: run.path }));
    }
  }

  // An existing output directory keeps its mode (the operator chose it); the
  // directories created below it are private.
  makePrivateDir(outputPath);

  // Every file of this run goes under `runDir`: the root for the full run, a
  // new directory of its own for an incremental run (created here, so no
  // file of an earlier run is ever opened for writing).
  let runDir = outputPath;
  if (isIncrementalRun) {
    const incDir = path.join(outputPath, INCREMENTALS_DIR_NAME);
    let incStat = null;
    try { incStat = fs.lstatSync(incDir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    if (incStat == null) makePrivateDir(incDir);
    else if (!incStat.isDirectory()) throw new Error(`Backup writer: ${incDir} is not a directory (symbolic link or special file): refused`);
    runDir = path.join(incDir, run!.runId);
    fs.mkdirSync(runDir, { mode: PRIVATE_DIR_MODE }); // fails when it exists
  }

  // Write the cleartext crypto envelope so restore can discover key model +
  // wrapped data key. It carries crypto headers only — never user data.
  // Ship self-recovery artifacts next to it so the backup can be decrypted by
  // the key holder even on a machine without Pryv.io installed. Every run
  // carries its own copies, in its own directory: the root copies of a full
  // backup written by an earlier version may not know incremental runs, and
  // no run rewrites a file of an earlier one.
  if (opts.encryptor) {
    writePrivateFile(
      path.join(runDir, 'encryption.json'),
      JSON.stringify(opts.encryptor.envelope, null, 2)
    );
    writePrivateFile(path.join(runDir, DECRYPT_SCRIPT_NAME), STANDALONE_DECRYPT_SCRIPT);
    writePrivateFile(path.join(runDir, RESTORE_README_NAME),
      buildRestoreReadme(opts.encryptor.envelope, isIncrementalRun ? { runId: run!.runId } : {}));
  }

  return createBackupWriter({
    async openUser (userId: string, username: string): Promise<UserBackupWriter> {
      const userDir = path.join(runDir, 'users', userId);
      makePrivateDir(userDir);
      return createFilesystemUserBackupWriter(userDir, userId, username, opts);
    },

    async writePlatformData (data: AsyncIterable<unknown> | unknown[]) {
      const platformDir = path.join(runDir, 'platform');
      makePrivateDir(platformDir);
      const filePath = path.join(platformDir, jsonlFileName('platform', opts.compress));
      await writeJsonlFile(filePath, data, opts.compress, opts.encryptor);
    },

    async writeManifest (params: BackupWriteManifestParams) {
      const manifest: Record<string, unknown> = {
        formatVersion: 1,
        coreVersion: params.coreVersion,
        config: params.config,
        backupType: run != null ? (isIncrementalRun ? 'incremental' : 'full') : params.backupType,
        backupTimestamp: params.backupTimestamp,
        snapshotBefore: params.snapshotBefore || null,
        users: params.userManifests,
        compressed: opts.compress
      };
      if (params.scope != null) manifest.scope = params.scope;
      if (run != null) {
        manifest.chainId = run.chainId;
        manifest.runId = run.runId;
        manifest.parentRunId = run.parentRunId;
      }
      const filePath = path.join(runDir, 'manifest.json');
      persist(filePath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), opts.encryptor);
      if (run == null) return;

      // The run joins the chain only once its manifest is written.
      const entry: ChainRun = {
        runId: run.runId,
        path: run.path,
        backupType: isIncrementalRun ? 'incremental' : 'full',
        parentRunId: run.parentRunId,
        snapshotBefore: params.snapshotBefore ?? null,
        backupTimestamp: params.backupTimestamp,
        coreVersion: params.coreVersion,
        users: params.userManifests.map((u) => u.userId)
      };
      if (params.scope != null) entry.scope = params.scope;
      let chain: Chain;
      if (isIncrementalRun) {
        // Another run into this directory (an overlapping schedule) may have
        // joined the chain since this one was planned: appending to the chain
        // read then would drop that run's entry.
        const current = readChain(outputPath);
        const unchanged = current == null
          ? baseChain!.runs.length === 1 && baseChain!.runs[0].bootstrapped === true
          : current.chainId === run.chainId && current.runs[current.runs.length - 1].runId === run.parentRunId;
        if (!unchanged) {
          throw new BackupChainError('concurrent', `Backup writer: another run joined the backup chain at ${outputPath} (or its chain.json changed) while this one was written: ` +
            `refused; run ${run.runId} is left as a stray ${run.path}/ that restore ignores. Run the backup again.`);
        }
        const base = current ?? baseChain!;
        chain = { ...base, runs: [...base.runs, entry] };
      } else {
        chain = { formatVersion: 1, chainId: run.chainId, encryption: chainEncryptionOf(opts.encryptor), runs: [entry] };
      }
      writeChainAtomic(outputPath, chain);
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
  externalIds: number;
}

function createFilesystemUserBackupWriter (userDir: string, userId: string, username: string, opts: ResolvedWriterOptions): UserBackupWriter {
  const stats: UserStats = { streams: 0, accesses: 0, profile: 0, webhooks: 0, events: 0, audit: 0, series: 0, attachments: 0, externalIds: 0 };
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
      makePrivateDir(eventsDir);
      const result = await writeChunkedJsonlFiles(eventsDir, 'events', items, opts);
      stats.events = result.totalCount;
      chunks.events = result.chunkFiles;
    },

    async writeAudit (items: AsyncIterable<unknown> | unknown[]) {
      const auditDir = path.join(userDir, 'audit');
      makePrivateDir(auditDir);
      const result = await writeChunkedJsonlFiles(auditDir, 'audit', items, opts);
      stats.audit = result.totalCount;
      chunks.audit = result.chunkFiles;
    },

    async writeSeries (items: AsyncIterable<unknown> | unknown[]) {
      const seriesDir = path.join(userDir, 'series');
      makePrivateDir(seriesDir);
      const filePath = path.join(seriesDir, jsonlFileName('series', opts.compress));
      stats.series = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
    },

    async writeAttachment (eventId: string, fileId: string, readStream: Readable) {
      const attachDir = path.join(userDir, 'attachments');
      makePrivateDir(attachDir);
      const filePath = path.join(attachDir, fileId);
      const writeStream = fs.createWriteStream(filePath, { mode: PRIVATE_FILE_MODE });
      // Insert the streaming cipher between read and write so the raw blob is
      // never written in the clear (attachments already stream; the transform
      // keeps memory bounded).
      if (opts.encryptor) {
        await pipeline(readStream, opts.encryptor.encryptStream(), writeStream);
      } else {
        await pipeline(readStream, writeStream);
      }
      fs.chmodSync(filePath, PRIVATE_FILE_MODE);
      stats.attachments++;
    },

    async writeAccountData (data: unknown) {
      const filePath = path.join(userDir, jsonlFileName('account', opts.compress));
      // Account data is a single object, not a collection — write as one JSON line
      await writeJsonlFile(filePath, [data], opts.compress, opts.encryptor);
    },

    async writeExternalIds (items: AsyncIterable<unknown> | unknown[]) {
      const filePath = path.join(userDir, jsonlFileName('external-ids', opts.compress));
      stats.externalIds = await writeJsonlFile(filePath, items, opts.compress, opts.encryptor);
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
