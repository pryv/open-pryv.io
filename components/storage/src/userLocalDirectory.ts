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

export { init, ensureUserDirectory, getPathForUser, deleteUserDirectory, getBasePath, setBasePathTestOnly, isErased, ErasedUserError, clearErasedTestOnly, forgetErasedTestOnly, USER_ERASED };


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

const USER_ERASED = 'user-erased';
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

function clearErasedTestOnly (): void {
  erased.clear();
}

// Test fixtures re-create accounts with fixed ids (`id === username`); the
// API never lets a caller choose an id, so production never needs this.
function forgetErasedTestOnly (userId: string): void {
  erased.delete(userId);
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
 *   found stale.
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
      for (const name of entries) {
        if (keep.includes(name)) continue;
        await fs.rm(path.join(userFolder, name), { recursive: true, force: true });
      }
      return;
    }
  }
  await fs.rm(userFolder, { recursive: true, force: true });
}

function getBasePath () {
  if (basePath == null) {
    throw new Error('Initialize UserLocalDirectory first');
  }
  return basePath;
}
