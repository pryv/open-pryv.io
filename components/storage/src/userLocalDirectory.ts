/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import type { ConfigLike } from '@pryv/boiler';
const require = createRequire(import.meta.url);

/**
 * ToolSet to manipulate User's local directory
 */

const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const { getConfig } = require('@pryv/boiler');

export { init, ensureUserDirectory, ensureUserFile, getPathForUser, listUserIds, deleteUserDirectory, unmarkErased, getBasePath, setBasePathTestOnly, isErased, ErasedUserError, clearErasedTestOnly, forgetErasedTestOnly, USER_ERASED, ERASED_MARKER };

let config: ConfigLike;
let basePath: string | undefined;

// ----- Erased accounts
//
// Once the account erasure has wiped a user's directory, no process of this
// core creates it again: a request that already held the id (a login in
// flight, a cached handle) would otherwise re-create an empty directory and
// database for an erased account. Every per-user directory is created
// through `ensureUserDirectory`, so the refusal lives there. The erasure
// marks the id here and tells the other workers of the core over the
// `cache` pub/sub scope. The set is per process and bounded: after a restart
// nothing holds an erased id any more.
//
// A directory the erasure keeps (audit `keep` mode: the per-user audit
// database stays) holds a marker file instead, `ERASED_MARKER`: on disk, so
// every process of the core and every restart reads it. While it is there,
// no NEW file is created in that directory (`ensureUserFile`); the files
// kept stay usable. Indexing the id again (a restore) removes it
// (`unmarkErased`).

const USER_ERASED = 'user-erased';
const ERASED_MARKER = 'erased.json';
const ERASED_MAX = 10000;
const erased = new Set<string>();
let listening = false;

class ErasedUserError extends Error {
  code = 'USER_ERASED';
  constructor (userId: string) {
    super('user directory erased: ' + userId);
    this.name = 'ErasedUserError';
  }
}

function eraseLocally (userId: string): void {
  erased.delete(userId);
  erased.add(userId);
  if (erased.size > ERASED_MAX) erased.delete(erased.values().next().value as string);
}

function markErased (userId: string): void {
  eraseLocally(userId);
  try {
    require('messages').pubsub.cache.emit(USER_ERASED, { userId });
  } catch (err: unknown) {
    // No pub/sub in this process (an operator tool): the local mark stands.
  }
}

function listenForErasures (): void {
  if (listening) return;
  listening = true;
  try {
    require('messages').pubsub.cache.on(USER_ERASED, (msg: { userId?: unknown }) => {
      if (typeof msg?.userId === 'string') eraseLocally(msg.userId);
    });
  } catch (err: unknown) {
    listening = false; // no pub/sub in this process
  }
}

function isErased (userId: string): boolean {
  return erased.has(userId);
}

/**
 * The id is an account again (indexed by a restore or a registration): its
 * directory may hold files again. Removes the erased marker and this
 * process's mark. Called before the account's data is written.
 */
async function unmarkErased (userId: string): Promise<void> {
  erased.delete(userId);
  if (basePath == null) {
    try {
      await init();
    } catch (err: unknown) {
      return; // no per-user local directory in this setup: no marker either
    }
  }
  let markerPath: string;
  try {
    markerPath = getPathForUser(userId, ERASED_MARKER);
  } catch (err: unknown) {
    return; // not an id a local directory can hold: no marker either
  }
  try {
    await fs.unlink(markerPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function clearErasedTestOnly (): void {
  erased.clear();
}

// Test fixtures re-create accounts with fixed ids (`id === username`); the
// API never lets a caller choose an id, so production never needs this.
function forgetErasedTestOnly (userId: string): void {
  erased.delete(userId);
  if (basePath != null) fsSync.rmSync(getPathForUser(userId, ERASED_MARKER), { force: true });
}

// temporarly set baseBath for tests;
function setBasePathTestOnly (path: string | undefined) {
  basePath = path || (config.get('storages:engines:sqlite:path') as string);
}

/**
 * Load config and make sure baseUserDirectory exists.
 *
 * The base is `storages:engines:sqlite:path` and holds ALL per-user local
 * data under `<base>/<shard>/<userId>/`: the sqlite user DBs, HF series
 * files, AND event file attachments (`.../attachments/`). There is no
 * separate `attachmentsDirPath` - attachments co-locate here by design, so
 * per-user erasure is a single recursive delete of the user directory.
 * (Only previews live elsewhere, via `previewsDirPath`.)
 *
 * This could also handle eventual migrations.
 */
async function init () {
  listenForErasures();
  if (basePath) return;
  config = await getConfig();
  const candidateBasePath = config.get('storages:engines:sqlite:path') as string | undefined;
  if (!candidateBasePath || candidateBasePath === 'REPLACE ME') {
    throw new Error('storages:engines:sqlite:path is not configured (still "REPLACE ME"). Load the paths-config plugin or set an explicit path.');
  }
  fsSync.mkdirSync(candidateBasePath, { recursive: true });
  basePath = candidateBasePath;
}

/**
 * Return and **creates** the desired user path
 * @param userId -- user id (cuid format)
 * @param [extraPath] -- Optional, extra path
 */
async function ensureUserDirectory (userId: string, extraPath = '') {
  const resultPath = getPathForUser(userId, extraPath);
  if (erased.has(userId)) {
    // An erased account's directory is never created again; one kept by the
    // erasure (audit `keep` mode) stays usable.
    try {
      await fs.stat(getPathForUser(userId));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ErasedUserError(userId);
      throw err;
    }
  }
  await fs.mkdir(resultPath, { recursive: true });
  return resultPath;
}

/**
 * The path of `fileName` (a file or a directory) directly in the user's
 * directory, which is created. Refused (`ErasedUserError`) when the entry
 * does not exist yet and the directory carries the erased marker: an
 * erased account's kept directory never gets a new file, while the files it
 * kept still open.
 */
async function ensureUserFile (userId: string, fileName: string): Promise<string> {
  const userPath = await ensureUserDirectory(userId);
  const filePath = getPathForUser(userId, fileName);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(userPath)) {
    throw new Error('Invalid user file name: ' + JSON.stringify(fileName));
  }
  if (await exists(filePath)) return filePath;
  if (await exists(path.join(userPath, ERASED_MARKER))) throw new ErasedUserError(userId);
  return filePath;
}

async function exists (target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Return the local storage for this user. (does not create it)
 * @param userId -- user id (cuid format)
 * @param [extraPath] -- Optional, extra path
 */
function getPathForUser (userId: string, extraPath = ''): string {
  if (basePath == null) {
    throw new Error('Run init() first');
  }
  if (typeof userId !== 'string' || userId.length < 3) {
    throw new Error('Invalid or too short userId: ' + userId);
  }
  // The id names one directory: never a way to reach a parent or a sibling
  // (the result is a target for recursive deletes and writes).
  if (/[/\\\0]/.test(userId)) {
    throw new Error('Invalid userId for a local path: ' + JSON.stringify(userId));
  }
  const dir1 = userId.substr(userId.length - 1, 1); // last character of id
  const dir2 = userId.substr(userId.length - 2, 1);
  const dir3 = userId.substr(userId.length - 3, 1);
  const resultPath = path.join(basePath, dir1, dir2, dir3, userId, extraPath);
  // Whatever the id and the extra path: below the user's own directory.
  const userPath = path.resolve(basePath, dir1, dir2, dir3, userId);
  const resolved = path.resolve(resultPath);
  if (!isInside(path.resolve(basePath), userPath) || (resolved !== userPath && !isInside(userPath, resolved))) {
    throw new Error('Invalid local path for user: ' + JSON.stringify(userId));
  }
  return resultPath;
}

/**
 * The user ids holding a directory under the base path, whether the users
 * index knows them or not: `<base>/<shard>/<userId>/`, the shard being the
 * last three characters of the id. The directories of the HF series
 * namespaces (`user.<username>`, same layout) are not user ids and are left
 * out.
 */
async function listUserIds (): Promise<string[]> {
  const base = getBasePath();
  let parents: string[][] = [[]];
  for (let level = 0; level < 3; level++) {
    const children = await Promise.all(parents.map(async (parent) =>
      (await subdirectories(path.join(base, ...parent), true)).map((name) => parent.concat(name))));
    parents = children.flat();
  }
  const userIds = await Promise.all(parents.map(async ([dir1, dir2, dir3]) =>
    (await subdirectories(path.join(base, dir1, dir2, dir3), false))
      .filter((userId) => userId.length >= 3 && userId.endsWith(dir3 + dir2 + dir1) && !userId.startsWith('user.'))));
  return userIds.flat();
}

/** Names of the directories in `dir` (only one-character ones for a shard level). */
async function subdirectories (dir: string, shard: boolean): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory() && (!shard || e.name.length === 1)).map((e) => e.name);
}

/** True when `target` lies strictly below `base` (both resolved). */
function isInside (base: string, target: string): boolean {
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Delete user data folder
 *
 * @param userId -- user id
 * @param [keep] -- names of entries directly in the user folder to retain:
 *   everything else in it is removed. When none of them exists, the folder
 *   itself is removed, as without `keep`.
 * @param [options.erased] -- the account is erased: its directory is never
 *   created again by this core (see `ensureUserDirectory`). Marked before the
 *   removal, so a request landing in between is refused once its handle is
 *   found stale. A directory kept for some of its entries gets the erased
 *   marker file (see `ensureUserFile`), written before the removal and never
 *   removed by it (a resumed erasure keeps the first one).
 */
async function deleteUserDirectory (userId: string, keep: string[] = [], options: { erased?: boolean } = {}): Promise<void> {
  const userFolder = getPathForUser(userId);
  if (options.erased) markErased(userId);
  if (keep.length > 0) {
    let entries: string[];
    try {
      entries = await fs.readdir(userFolder);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (entries.some((name) => keep.includes(name))) {
      if (options.erased) await writeErasedMarker(userFolder);
      for (const name of entries) {
        if (keep.includes(name) || name === ERASED_MARKER) continue;
        await fs.rm(path.join(userFolder, name), { recursive: true, force: true });
      }
      return;
    }
  }
  await fs.rm(userFolder, { recursive: true, force: true });
}

/** The erased marker in `userFolder`; one already there (a resumed erasure) is kept as it is. */
async function writeErasedMarker (userFolder: string): Promise<void> {
  try {
    await fs.writeFile(path.join(userFolder, ERASED_MARKER), JSON.stringify({ v: 1, erasedAt: Date.now() }), { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function getBasePath () {
  if (basePath == null) {
    throw new Error('Initialize UserLocalDirectory first');
  }
  return basePath;
}
