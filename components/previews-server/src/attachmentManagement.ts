/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { getConfigSync } = require('@pryv/boiler');

// Lazy memoized read: previously a module-top
// `getConfigUnsafe(true).get(...)` capture which depended on the partial
// boiler config being far enough along at module-load. All three readers
// (ensurePreviewPath, getPreviewPath, removeAllPreviews) are called at
// request/test time — post-init by lifecycle — so `getConfigSync()` is safe.
let _previewsDirPath: string | undefined;
function getPreviewsDirPath (): string {
  if (_previewsDirPath == null) {
    _previewsDirPath = getConfigSync().get('storages:engines:filesystem:previewsDirPath');
  }
  return _previewsDirPath as string;
}

/**
 * Ensures the preview path for the specific event exists.
 * Only support JPEG preview images (fixed size) at the moment.
 *
 */
type UserLike = { id: string };

async function ensurePreviewPath (user: UserLike, eventId: string, dimension: string | number): Promise<string> {
  const dirPath = getEventPreviewsDir(user, eventId);
  await fsp.mkdir(dirPath, { recursive: true });
  return path.join(dirPath, getPreviewFileName(dimension));
}

export { ensurePreviewPath };

function getPreviewPath (user: UserLike, eventId: string, dimension: string | number): string {
  return path.join(getEventPreviewsDir(user, eventId), getPreviewFileName(dimension));
}

/**
 * The event's previews directory, refused unless the user id and the event id
 * are each a single path segment (no way to reach a sibling or parent folder).
 */
function getEventPreviewsDir (user: UserLike, eventId: string): string {
  const root = path.resolve(getPreviewsDirPath());
  const userDir = path.resolve(root, user.id);
  const eventDir = path.resolve(userDir, eventId);
  if (path.dirname(userDir) !== root || path.dirname(eventDir) !== userDir) {
    throw new Error('Invalid previews path segment: ' + JSON.stringify({ userId: user.id, eventId }));
  }
  return eventDir;
}
export { getPreviewPath };

function getPreviewFileName (dimension: string | number): string {
  return dimension + '.jpg';
}

/**
 * Primarily meant for tests.
 * Synchronous until all related code is async/await.
 */
function removeAllPreviews () {
  fs.rmSync(getPreviewsDirPath(), { recursive: true, force: true });
}
export { removeAllPreviews };
