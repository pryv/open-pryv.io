/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { BackupReader, UserBackupReader } from './BackupReader.js';
import type { BackupDecryptor, DecryptorSecrets } from './BackupCipher.js';
import type { Chain, ChainRun } from './chain.ts';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createBackupReader, createUserBackupReader } = require('./BackupReader.ts');
const { createBackupDecryptor } = require('./BackupCipher.ts');
const {
  BackupChainError, damagedRestoreMessage, resolveRuns, runDirectory, readRunManifest,
  readEnvelope, checkRunEnvelope, isRealDirectory, readBackupBytes
} = require('./chain.ts');

// Open for reading without following a symbolic link (where the platform has the flag).
const NO_FOLLOW_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

type Manifest = { compressed?: boolean; users?: unknown; [k: string]: unknown };

interface ReaderOptions {
  /** Decryptor of the root run (a full backup); built from `secrets` when absent. */
  decryptor?: BackupDecryptor | null;
  /** The secret of the backup: each run's decryptor is built from its own envelope and this. */
  secrets?: DecryptorSecrets | null;
  /** Apply the chain up to this run (included). */
  throughRun?: string | null;
  /** Restore a directory holding only the delta of an earlier incremental run anyway. */
  allowIncomplete?: boolean;
  /** Called with what the reader ignores (directories the chain does not list). */
  onWarning?: (message: string) => void;
}

/** One run of the backup as the reader applies it. */
type RunHandle = {
  run: ChainRun;
  /** The run's directory, below the backup's real root. */
  dir: string;
  decryptor: BackupDecryptor | null;
  manifest: Manifest | null;
  compressed: boolean;
  /** Ids of the users the run lists (its manifest). */
  userIds: Set<string>;
  isRoot: boolean;
};

/** Read a file, decrypting first when a decryptor is configured; a symbolic link is refused. */
function loadBytes (filePath: string, decryptor: BackupDecryptor | null): Buffer {
  return readBackupBytes(filePath, decryptor);
}

function userIdsOf (manifest: Manifest | null): Set<string> {
  const ids = new Set<string>();
  if (manifest != null && Array.isArray(manifest.users)) {
    for (const u of manifest.users) if (typeof u?.userId === 'string') ids.add(u.userId);
  }
  return ids;
}

/**
 * Create a FilesystemBackupReader that reads a backup rooted at `inputPath`.
 *
 * The backup is a chain (see `chain.ts`): the full run at the root and the
 * incremental runs listed by `chain.json`, or one run at the root when there
 * is no `chain.json`. The reader presents one merged backup: per collection
 * the items of the newest run first, an id seen in a newer run hiding the
 * older version; whole-collection files (profile, account data, series,
 * platform rows) from the newest run that has them.
 *
 * For encrypted backups, pass the `secrets` (or the root run's `decryptor`):
 * every run is decrypted with its own `encryption.json`.
 */
function createFilesystemBackupReader (inputPath: string, options?: ReaderOptions): BackupReader {
  const opts: ReaderOptions = options ?? {};
  // The backup root may itself be a link the operator chose: everything below
  // it is read from its real path, where no further link is followed.
  const realRoot = (): string => fs.realpathSync(inputPath);

  let handles: RunHandle[] | null = null;
  let chain: Chain | null = null;
  // A backup without chain.json whose manifest cannot be read: kept for readManifest.
  let rootManifestError: Error | null = null;

  /** Resolve the runs applied, once: directories, envelopes, decryptors, manifests. */
  function openRuns (): RunHandle[] {
    if (handles != null) return handles;
    const root = realRoot();
    const resolved = resolveRuns(root, { throughRun: opts.throughRun });
    chain = resolved.chain;
    if (resolved.strays.length > 0 && opts.onWarning) {
      opts.onWarning(`Backup ${inputPath}: ignored, not listed by ${chain == null ? 'any chain.json' : 'chain.json'}: ${resolved.strays.join(', ')}`);
    }
    const out: RunHandle[] = [];
    resolved.runs.forEach((run: ChainRun, i: number) => {
      const isRoot = run.path === '.';
      const previousRunId = i > 0 ? resolved.runs[i - 1].runId : null;
      const dir = runDirectory(root, run);
      if (dir === '') {
        throw new BackupChainError('incomplete', `Run ${run.runId} of the backup chain at ${inputPath} is missing its directory; later runs assume it: ` +
          (previousRunId != null ? `restore --through-run ${previousRunId} or recover ${run.runId}.` : `recover ${run.runId}.`));
      }
      const envelope = readEnvelope(dir);
      if (chain != null) checkRunEnvelope(inputPath, chain, run, envelope);
      let decryptor: BackupDecryptor | null = null;
      if (isRoot && opts.decryptor) decryptor = opts.decryptor;
      else if (envelope != null) decryptor = createBackupDecryptor(envelope, opts.secrets ?? {});

      let manifest: Manifest | null = null;
      if (chain != null) {
        manifest = readRunManifest(root, inputPath, chain, run, previousRunId, decryptor);
      } else {
        try {
          manifest = JSON.parse(loadBytes(path.join(dir, 'manifest.json'), decryptor).toString('utf8'));
        } catch (err) {
          rootManifestError = err as Error;
        }
        if (manifest?.backupType === 'incremental' && !opts.allowIncomplete) {
          throw new BackupChainError('damaged', damagedRestoreMessage(inputPath));
        }
      }
      out.push({ run, dir, decryptor, manifest, compressed: manifest?.compressed !== false, userIds: userIdsOf(manifest), isRoot });
    });
    handles = out;
    return handles;
  }

  return createBackupReader({
    async readManifest () {
      const runs = openRuns();
      if (rootManifestError != null) throw rootManifestError;
      if (runs.length === 1) return runs[0].manifest;
      // Every user of the applied runs, the newest entry of each.
      const users: unknown[] = [];
      const index = new Map<string, number>();
      for (const h of runs) {
        for (const u of (Array.isArray(h.manifest?.users) ? h.manifest!.users as unknown[] : [])) {
          const id = (u as { userId?: unknown } | null)?.userId;
          if (typeof id === 'string' && index.has(id)) {
            users[index.get(id)!] = u;
          } else {
            if (typeof id === 'string') index.set(id, users.length);
            users.push(u);
          }
        }
      }
      return {
        ...runs[0].manifest,
        users,
        runs: runs.map((h) => ({ runId: h.run.runId, backupType: h.run.backupType, snapshotBefore: h.manifest?.snapshotBefore ?? null, users: h.userIds.size }))
      };
    },

    readPlatformData () {
      // Platform rows are a full export on every run: the newest run that has them.
      const runs = openRuns();
      for (let i = runs.length - 1; i >= 0; i--) {
        const h = runs[i];
        const platformDir = path.join(h.dir, 'platform');
        const filePath = path.join(platformDir, jsonlFileName('platform', h.compressed));
        if (isRealDirectory(platformDir) && fs.existsSync(filePath)) return readJsonlFile(filePath, h.compressed, h.decryptor);
      }
      return emptyIterator();
    },

    /**
     * v1 enterprise backups carry a `register/servers.jsonl.gz` produced
     * by `dev-migrate-v1-v2 export-register.js` — one line per user:
     * `{"username": "...", "server": "..."}` (server is a v1 hostname,
     * not a v2 coreId). Present only for enterprise-v1 sources;
     * open-pryv.io v1.9 exports don't have it. Read from the root run.
     *
     * RestoreOrchestrator uses these to populate `user-core/*` rows
     * so the embedded DNS + /reg/:uid/server can find users post-restore.
     * — fixes the "user-core never written" regression
     * surfaced when restoring pryv.me onto the v2 cluster.
     */
    readServerMappings () {
      const root = openRuns()[0];
      const registerDir = path.join(root.dir, 'register');
      const filePath = path.join(registerDir, jsonlFileName('servers', root.compressed));
      if (!isRealDirectory(registerDir) || !fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, root.compressed, root.decryptor);
    },

    async openUser (userId: string): Promise<UserBackupReader> {
      const usersDir = path.resolve(inputPath, 'users');
      const userDir = typeof userId === 'string' && userId !== '' ? path.resolve(usersDir, userId) : null;
      if (userDir == null || path.dirname(userDir) !== usersDir) {
        throw new Error('Invalid user id in the backup: ' + JSON.stringify(userId));
      }
      // The runs holding this user, newest first: the root run always (as a
      // full backup), an incremental run when it lists the user. `users/` and
      // the user directory of each must be real directories of the backup: a
      // link there would make every read of this user leave the backup.
      const runs = openRuns();
      const userRuns: UserRun[] = [];
      for (let i = runs.length - 1; i >= 0; i--) {
        const h = runs[i];
        if (!h.isRoot && !h.userIds.has(userId)) continue;
        const realUserDir = path.join(h.dir, 'users', userId);
        isRealDirectory(realUserDir);
        userRuns.push({ userDir: realUserDir, compressed: h.compressed, decryptor: h.decryptor });
      }
      if (userRuns.length === 1) {
        return createFilesystemUserBackupReader(userRuns[0].userDir, runs[0].manifest, userRuns[0].decryptor);
      }
      return createMergedUserBackupReader(userRuns);
    },

    async close () { /* no-op for filesystem */ }
  });
}

// ---------------------------------------------------------------------------
// FilesystemUserBackupReader: one run
// ---------------------------------------------------------------------------

function createFilesystemUserBackupReader (userDir: string, manifest: Manifest | null, decryptor: BackupDecryptor | null): UserBackupReader {
  const compressed = manifest?.compressed !== false;

  return createUserBackupReader({
    async readUserManifest () {
      const filePath = path.join(userDir, 'user-manifest.json');
      return JSON.parse(loadBytes(filePath, decryptor).toString('utf8'));
    },

    readStreams () {
      return readUserJsonl(userDir, 'streams', compressed, decryptor);
    },

    readAccesses () {
      return readUserJsonl(userDir, 'accesses', compressed, decryptor);
    },

    readProfile () {
      return readUserJsonl(userDir, 'profile', compressed, decryptor);
    },

    readWebhooks () {
      return readUserJsonl(userDir, 'webhooks', compressed, decryptor);
    },

    readEvents () {
      return readChunkedJsonl(path.join(userDir, 'events'), 'events', compressed, decryptor);
    },

    readAudit () {
      return readChunkedJsonl(path.join(userDir, 'audit'), 'audit', compressed, decryptor);
    },

    readSeries () {
      const seriesDir = path.join(userDir, 'series');
      const filePath = path.join(seriesDir, jsonlFileName('series', compressed));
      if (!isRealDirectory(seriesDir) || !fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed, decryptor);
    },

    readAttachments () {
      return readAttachmentsFromDir(path.join(userDir, 'attachments'), userDir, decryptor);
    },

    async readAccountData () {
      const filePath = path.join(userDir, jsonlFileName('account', compressed));
      if (!fs.existsSync(filePath)) return null;
      // Account data is a single JSON object stored as one JSONL line
      const items: unknown[] = [];
      for await (const item of readJsonlFile(filePath, compressed, decryptor)) {
        items.push(item);
      }
      return items[0] || null;
    }
  });
}

// ---------------------------------------------------------------------------
// Merged user reader: several runs of a chain, newest first
// ---------------------------------------------------------------------------

type UserRun = { userDir: string, compressed: boolean, decryptor: BackupDecryptor | null };

/** The id an item is superseded by: `id` (streams, accesses, webhooks, events). */
function itemId (item: unknown): string | null {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

/** Raw audit rows are keyed by their `eventid` column (both engines). */
function auditRowId (item: unknown): string | null {
  const row = item as { eventid?: unknown, id?: unknown } | null;
  if (typeof row?.eventid === 'string') return row.eventid;
  return itemId(item);
}

/**
 * Yield the items of several sources, newest first, an id already yielded by
 * a newer source hiding the older version. Only the ids of the newer sources
 * are remembered: the oldest (the full run, usually the largest) is streamed
 * and only tested.
 */
async function * newestFirstById (sources: Array<() => AsyncIterable<unknown>>, keyOf: (item: unknown) => string | null): AsyncGenerator<unknown> {
  const seen = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const remember = i < sources.length - 1;
    for await (const item of sources[i]()) {
      const key = keyOf(item);
      if (key != null) {
        if (seen.has(key)) continue;
        if (remember) seen.add(key);
      }
      yield item;
    }
  }
}

function createMergedUserBackupReader (runs: UserRun[]): UserBackupReader {
  const userFile = (r: UserRun, baseName: string): string => path.join(r.userDir, jsonlFileName(baseName, r.compressed));

  const mergedEvents = (): AsyncGenerator<unknown> => newestFirstById(
    runs.map((r) => () => readChunkedJsonl(path.join(r.userDir, 'events'), 'events', r.compressed, r.decryptor)), itemId);

  /** A whole-collection file: the newest run that has it. */
  function newestFile (baseName: string): AsyncIterable<unknown> {
    for (const r of runs) {
      const filePath = userFile(r, baseName);
      if (fs.existsSync(filePath)) return readJsonlFile(filePath, r.compressed, r.decryptor);
    }
    return emptyIterator();
  }

  return createUserBackupReader({
    async readUserManifest () {
      for (const r of runs) {
        const filePath = path.join(r.userDir, 'user-manifest.json');
        if (fs.existsSync(filePath)) return JSON.parse(loadBytes(filePath, r.decryptor).toString('utf8'));
      }
      throw new Error('No user manifest in the backup chain for this user');
    },

    readStreams () {
      return newestFirstById(runs.map((r) => () => readUserJsonl(r.userDir, 'streams', r.compressed, r.decryptor)), itemId);
    },

    readAccesses () {
      return newestFirstById(runs.map((r) => () => readUserJsonl(r.userDir, 'accesses', r.compressed, r.decryptor)), itemId);
    },

    readProfile () {
      return newestFile('profile');
    },

    readWebhooks () {
      return newestFirstById(runs.map((r) => () => readUserJsonl(r.userDir, 'webhooks', r.compressed, r.decryptor)), itemId);
    },

    readEvents () {
      return mergedEvents();
    },

    readAudit () {
      return newestFirstById(runs.map((r) => () => readChunkedJsonl(path.join(r.userDir, 'audit'), 'audit', r.compressed, r.decryptor)), auditRowId);
    },

    readSeries () {
      for (const r of runs) {
        const seriesDir = path.join(r.userDir, 'series');
        const filePath = path.join(seriesDir, jsonlFileName('series', r.compressed));
        if (isRealDirectory(seriesDir) && fs.existsSync(filePath)) return readJsonlFile(filePath, r.compressed, r.decryptor);
      }
      return emptyIterator();
    },

    readAttachments () {
      return readMergedAttachments(runs, mergedEvents);
    },

    async readAccountData () {
      for await (const item of newestFile('account')) return item || null;
      return null;
    }
  });
}

/**
 * Attachment files by file id, newest run first; each comes with the event
 * that references it in the MERGED events (null when the newest version of
 * no event references it: the caller does not restore it).
 */
async function * readMergedAttachments (runs: UserRun[], mergedEvents: () => AsyncIterable<unknown>): AsyncGenerator<{ eventId: string | null, fileId: string, stream: NodeJS.ReadableStream }> {
  const dirs = runs.map((r) => ({ run: r, attachDir: path.join(r.userDir, 'attachments') }))
    .filter((d) => isRealDirectory(d.attachDir));
  if (dirs.length === 0) return;
  const fileIdToEventId = new Map<string, string>();
  for await (const item of mergedEvents()) addAttachmentRefs(fileIdToEventId, item);
  const yielded = new Set<string>();
  for (const { run, attachDir } of dirs) {
    for (const fileId of listAttachmentFiles(attachDir)) {
      if (yielded.has(fileId)) continue;
      yielded.add(fileId);
      yield { eventId: fileIdToEventId.get(fileId) ?? null, fileId, stream: openAttachment(attachDir, fileId, run.decryptor) };
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL + gzip read helpers
// ---------------------------------------------------------------------------

function jsonlFileName (baseName: string, compressed: boolean): string {
  return compressed ? baseName + '.jsonl.gz' : baseName + '.jsonl';
}

function readUserJsonl (userDir: string, baseName: string, compressed: boolean, decryptor: BackupDecryptor | null): AsyncIterable<unknown> {
  const filePath = path.join(userDir, jsonlFileName(baseName, compressed));
  if (!fs.existsSync(filePath)) return emptyIterator();
  return readJsonlFile(filePath, compressed, decryptor);
}

/**
 * Read a JSONL file (optionally encrypted, optionally gzip-compressed) and
 * yield parsed objects. Decryption is the outermost layer (applied first).
 */
async function * readJsonlFile (filePath: string, compressed: boolean, decryptor: BackupDecryptor | null): AsyncGenerator<unknown> {
  let buffer = loadBytes(filePath, decryptor);
  if (compressed) {
    buffer = zlib.gunzipSync(buffer);
  }
  const content = buffer.toString('utf8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed);
  }
}

/**
 * Read chunked JSONL files from a directory, yielding all items in order.
 * Chunk files are sorted alphabetically (events-0001, events-0002, ...).
 */
async function * readChunkedJsonl (dir: string, baseName: string, compressed: boolean, decryptor: BackupDecryptor | null): AsyncGenerator<unknown> {
  if (!isRealDirectory(dir)) return;
  const ext = compressed ? '.jsonl.gz' : '.jsonl';
  const files = fs.readdirSync(dir)
    .filter((f: string) => f.startsWith(baseName + '-') && f.endsWith(ext))
    .sort();
  for (const file of files) {
    yield * readJsonlFile(path.join(dir, file), compressed, decryptor);
  }
}

/**
 * The attachment files of a directory. Nothing is followed: a symbolic link
 * or any other non-regular entry is refused, it could make the restore import
 * a file from outside the backup.
 */
function listAttachmentFiles (attachDir: string): string[] {
  return fs.readdirSync(attachDir).filter((f: string) => {
    const stat = fs.lstatSync(path.join(attachDir, f));
    if (stat.isDirectory()) return false;
    if (!stat.isFile()) {
      throw new Error(`Backup attachment ${path.join(attachDir, f)} is not a regular file (symbolic link or special file): refused`);
    }
    return true;
  });
}

function openAttachment (attachDir: string, fileId: string, decryptor: BackupDecryptor | null): NodeJS.ReadableStream {
  const fileStream = fs.createReadStream(path.join(attachDir, fileId), { flags: NO_FOLLOW_READ_FLAGS });
  // Decrypt the blob on the fly so the consumer receives plaintext bytes.
  return decryptor ? fileStream.pipe(decryptor.decryptStream()) : fileStream;
}

/**
 * Iterate attachment files from the attachments directory.
 * Maps fileIds back to eventIds using event JSONL data; a file no event of
 * the backup references comes with a null eventId (the caller does not
 * restore it). Nothing is followed: an attachments directory that is a
 * symbolic link, or a symbolic link or any other non-regular entry in it, is
 * refused, it could make the restore import a file from outside the backup.
 */
async function * readAttachmentsFromDir (attachDir: string, userDir: string, decryptor: BackupDecryptor | null): AsyncGenerator<{ eventId: string | null, fileId: string, stream: NodeJS.ReadableStream }> {
  if (!isRealDirectory(attachDir)) return;
  // Build fileId -> eventId mapping from events data
  const fileIdToEventId = await buildFileIdMapping(userDir, decryptor);

  const files = listAttachmentFiles(attachDir);

  for (const fileId of files) {
    const eventId = fileIdToEventId.get(fileId) ?? null;
    yield { eventId, fileId, stream: openAttachment(attachDir, fileId, decryptor) };
  }
}

function addAttachmentRefs (map: Map<string, string>, item: unknown): void {
  // JSONL boundary — events were serialized by the backup writer.
  const event = item as { id: string; attachments?: Array<{ id?: string }> };
  if (event.attachments && Array.isArray(event.attachments)) {
    for (const att of event.attachments) {
      if (att.id) {
        map.set(att.id, event.id);
      }
    }
  }
}

/**
 * Scan events JSONL to build a fileId -> eventId mapping for attachment restore.
 */
async function buildFileIdMapping (userDir: string, decryptor: BackupDecryptor | null): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const eventsDir = path.join(userDir, 'events');
  if (!isRealDirectory(eventsDir)) return map;

  // Detect compression from file extensions
  const files: string[] = fs.readdirSync(eventsDir);
  const compressed = files.some((f: string) => f.endsWith('.gz'));

  for await (const item of readChunkedJsonl(eventsDir, 'events', compressed, decryptor)) {
    addAttachmentRefs(map, item);
  }
  return map;
}

async function * emptyIterator (): AsyncGenerator<unknown> {
  // yields nothing
}

export { createFilesystemBackupReader };
