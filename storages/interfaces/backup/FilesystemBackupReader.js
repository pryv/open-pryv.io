/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createBackupReader, createUserBackupReader } = require('./BackupReader');

/**
 * Create a FilesystemBackupReader.
 * @param {string} inputPath - root directory of the backup
 * @returns {BackupReader}
 */
module.exports.createFilesystemBackupReader = function createFilesystemBackupReader (inputPath) {
  let manifest = null;

  return createBackupReader({
    async readManifest () {
      const filePath = path.join(inputPath, 'manifest.json');
      manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return manifest;
    },

    async readPlatformData () {
      const platformDir = path.join(inputPath, 'platform');
      const compressed = manifest?.compressed !== false;
      const filePath = path.join(platformDir, jsonlFileName('platform', compressed));
      if (!fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed);
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
    async readServerMappings () {
      const registerDir = path.join(inputPath, 'register');
      const compressed = manifest?.compressed !== false;
      const filePath = path.join(registerDir, jsonlFileName('servers', compressed));
      if (!fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed);
    },

    async openUser (userId) {
      const userDir = path.join(inputPath, 'users', userId);
      return createFilesystemUserBackupReader(userDir, manifest);
    },

    async close () { /* no-op for filesystem */ }
  });
};

// ---------------------------------------------------------------------------
// FilesystemUserBackupReader
// ---------------------------------------------------------------------------

function createFilesystemUserBackupReader (userDir, manifest) {
  const compressed = manifest?.compressed !== false;

  return createUserBackupReader({
    async readUserManifest () {
      const filePath = path.join(userDir, 'user-manifest.json');
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },

    async readStreams () {
      return readUserJsonl(userDir, 'streams', compressed);
    },

    async readAccesses () {
      return readUserJsonl(userDir, 'accesses', compressed);
    },

    async readProfile () {
      return readUserJsonl(userDir, 'profile', compressed);
    },

    async readWebhooks () {
      return readUserJsonl(userDir, 'webhooks', compressed);
    },

    async readEvents () {
      return readChunkedJsonl(path.join(userDir, 'events'), 'events', compressed);
    },

    async readAudit () {
      return readChunkedJsonl(path.join(userDir, 'audit'), 'audit', compressed);
    },

    async readSeries () {
      const seriesDir = path.join(userDir, 'series');
      const filePath = path.join(seriesDir, jsonlFileName('series', compressed));
      if (!fs.existsSync(filePath)) return emptyIterator();
      return readJsonlFile(filePath, compressed);
    },

    async readAttachments () {
      const attachDir = path.join(userDir, 'attachments');
      if (!fs.existsSync(attachDir)) return emptyIterator();
      return readAttachmentsFromDir(attachDir, userDir);
    },

    async readAccountData () {
      const filePath = path.join(userDir, jsonlFileName('account', compressed));
      if (!fs.existsSync(filePath)) return null;
      // Account data is a single JSON object stored as one JSONL line
      const items = [];
      for await (const item of readJsonlFile(filePath, compressed)) {
        items.push(item);
      }
      return items[0] || null;
    }
  });
}

// ---------------------------------------------------------------------------
// JSONL + gzip read helpers
// ---------------------------------------------------------------------------

function jsonlFileName (baseName, compressed) {
  return compressed ? baseName + '.jsonl.gz' : baseName + '.jsonl';
}

async function readUserJsonl (userDir, baseName, compressed) {
  const filePath = path.join(userDir, jsonlFileName(baseName, compressed));
  if (!fs.existsSync(filePath)) return emptyIterator();
  return readJsonlFile(filePath, compressed);
}

/**
 * Read a JSONL file (optionally gzip-compressed) and yield parsed objects.
 * @param {string} filePath
 * @param {boolean} compressed
 * @returns {AsyncIterable<Object>}
 */
async function * readJsonlFile (filePath, compressed) {
  let buffer = fs.readFileSync(filePath);
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
 * @param {string} dir
 * @param {string} baseName
 * @param {boolean} compressed
 * @returns {AsyncIterable<Object>}
 */
async function * readChunkedJsonl (dir, baseName, compressed) {
  if (!fs.existsSync(dir)) return;
  const ext = compressed ? '.jsonl.gz' : '.jsonl';
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(baseName + '-') && f.endsWith(ext))
    .sort();
  for (const file of files) {
    yield * readJsonlFile(path.join(dir, file), compressed);
  }
}

/**
 * Iterate attachment files from the attachments directory.
 * Maps fileIds back to eventIds using event JSONL data.
 * @param {string} attachDir
 * @param {string} userDir
 * @returns {AsyncIterable<{eventId: string, fileId: string, stream: ReadableStream}>}
 */
async function * readAttachmentsFromDir (attachDir, userDir) {
  // Build fileId -> eventId mapping from events data
  const fileIdToEventId = await buildFileIdMapping(userDir);

  const files = fs.readdirSync(attachDir).filter(f => {
    const stat = fs.statSync(path.join(attachDir, f));
    return stat.isFile();
  });

  for (const fileId of files) {
    const eventId = fileIdToEventId.get(fileId) || 'unknown';
    const stream = fs.createReadStream(path.join(attachDir, fileId));
    yield { eventId, fileId, stream };
  }
}

/**
 * Scan events JSONL to build a fileId -> eventId mapping for attachment restore.
 * @param {string} userDir
 * @returns {Promise<Map<string, string>>}
 */
async function buildFileIdMapping (userDir) {
  const map = new Map();
  const eventsDir = path.join(userDir, 'events');
  if (!fs.existsSync(eventsDir)) return map;

  // Detect compression from file extensions
  const files = fs.readdirSync(eventsDir);
  const compressed = files.some(f => f.endsWith('.gz'));

  for await (const event of readChunkedJsonl(eventsDir, 'events', compressed)) {
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

async function * emptyIterator () {
  // yields nothing
}
