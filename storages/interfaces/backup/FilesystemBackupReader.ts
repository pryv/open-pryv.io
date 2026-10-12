/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { BackupReader, UserBackupReader } from './BackupReader.js';
import type { BackupDecryptor } from './BackupCipher.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createBackupReader, createUserBackupReader } = require('./BackupReader.ts');

// Open for reading without following a symbolic link (where the platform has the flag).
const NO_FOLLOW_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

/**
 * Create a FilesystemBackupReader that reads a backup tree rooted at `inputPath`.
 *
 * For encrypted backups (a cleartext `encryption.json` is present at the root),
 * pass a `decryptor` built from that envelope plus the matching secret; every
 * file read is then transparently decrypted before gunzip/parse.
 */
type Manifest = { compressed?: boolean; [k: string]: unknown };

interface ReaderOptions {
  decryptor?: BackupDecryptor | null;
}

/**
 * Read a file, decrypting first when a decryptor is configured. A symbolic
 * link is not followed (refused): the backup's files are read from the backup.
 */
function loadBytes (filePath: string, decryptor: BackupDecryptor | null): Buffer {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath, { flag: NO_FOLLOW_READ_FLAGS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Backup file ${filePath} is a symbolic link: refused`);
    }
    throw err;
  }
  return decryptor ? decryptor.decryptBuffer(raw) : raw;
}

/**
 * Whether `dir` exists as a directory reached without any symbolic link
 * (false when it does not exist). Throws when it is a link, not a directory,
 * or resolves elsewhere: reading through it could import files from outside
 * the backup. `dir` is built from the backup's real root path.
 */
function isRealDirectory (dir: string): boolean {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!stat.isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) {
    throw new Error(`Backup directory ${dir} is not a directory of the backup (symbolic link or special file): refused`);
  }
  return true;
}

function createFilesystemBackupReader (inputPath: string, options?: ReaderOptions): BackupReader {
  let manifest: Manifest | null = null;
  const decryptor: BackupDecryptor | null = options?.decryptor || null;
  // The backup root may itself be a link the operator chose: everything below
  // it is read from its real path, where no further link is followed.
  const realRoot = (): string => fs.realpathSync(inputPath);

  return createBackupReader({
    async readManifest () {
      const filePath = path.join(inputPath, 'manifest.json');
      manifest = JSON.parse(loadBytes(filePath, decryptor).toString('utf8'));
      return manifest;
    },

    readPlatformData () {
      const platformDir = path.join(realRoot(), 'platform');
      const compressed = manifest?.compressed !== false;
      const filePath = path.join(platformDir, jsonlFileName('platform', compressed));
      if (!isRealDirectory(platformDir) || !fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed, decryptor);
    },

    /**
     * v1 enterprise backups carry a `register/servers.jsonl.gz` produced
     * by `dev-migrate-v1-v2 export-register.js` — one line per user:
     * `{"username": "...", "server": "..."}` (server is a v1 hostname,
     * not a v2 coreId). Present only for enterprise-v1 sources;
     * open-pryv.io v1.9 exports don't have it.
     *
     * RestoreOrchestrator uses these to populate `user-core/*` rows
     * so the embedded DNS + /reg/:uid/server can find users post-restore.
     * — fixes the "user-core never written" regression
     * surfaced when restoring pryv.me onto the v2 cluster.
     */
    readServerMappings () {
      const registerDir = path.join(realRoot(), 'register');
      const compressed = manifest?.compressed !== false;
      const filePath = path.join(registerDir, jsonlFileName('servers', compressed));
      if (!isRealDirectory(registerDir) || !fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed, decryptor);
    },

    async openUser (userId: string): Promise<UserBackupReader> {
      const usersDir = path.resolve(inputPath, 'users');
      const userDir = typeof userId === 'string' && userId !== '' ? path.resolve(usersDir, userId) : null;
      if (userDir == null || path.dirname(userDir) !== usersDir) {
        throw new Error('Invalid user id in the backup: ' + JSON.stringify(userId));
      }
      // `users/` and the user directory must be real directories of the backup:
      // a link there would make every read of this user leave the backup.
      const realUserDir = path.join(realRoot(), 'users', userId);
      isRealDirectory(realUserDir);
      return createFilesystemUserBackupReader(realUserDir, manifest, decryptor);
    },

    async close () { /* no-op for filesystem */ }
  });
}

// ---------------------------------------------------------------------------
// FilesystemUserBackupReader
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

  const files = fs.readdirSync(attachDir).filter((f: string) => {
    const stat = fs.lstatSync(path.join(attachDir, f));
    if (stat.isDirectory()) return false;
    if (!stat.isFile()) {
      throw new Error(`Backup attachment ${path.join(attachDir, f)} is not a regular file (symbolic link or special file): refused`);
    }
    return true;
  });

  for (const fileId of files) {
    const eventId = fileIdToEventId.get(fileId) ?? null;
    const fileStream = fs.createReadStream(path.join(attachDir, fileId), { flags: NO_FOLLOW_READ_FLAGS });
    // Decrypt the blob on the fly so the consumer receives plaintext bytes.
    const stream = decryptor ? fileStream.pipe(decryptor.decryptStream()) : fileStream;
    yield { eventId, fileId, stream };
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
  return map;
}

async function * emptyIterator (): AsyncGenerator<unknown> {
  // yields nothing
}

export { createFilesystemBackupReader };