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
const { getConfigUnsafe } = require('@pryv/boiler');

// Lazy memoized read: previously a module-top
// `getConfigUnsafe(true).get(...)` capture which depended on the partial
// boiler config being far enough along at module-load. All three readers
// (ensurePreviewPath, getPreviewPath, removeAllPreviews) are called at
// request/test time — post-init by lifecycle — so the no-warnOnly
// `getConfigUnsafe()` is safe.
let _previewsDirPath: string | undefined;
function getPreviewsDirPath (): string {
  if (_previewsDirPath == null) {
    _previewsDirPath = getConfigUnsafe().get('storages:engines:filesystem:previewsDirPath');
  }
  return _previewsDirPath;
}

/**
 * Ensures the preview path for the specific event exists.
 * Only support JPEG preview images (fixed size) at the moment.
 *
 */
async function ensurePreviewPath (user, eventId, dimension) {
  const dirPath = path.join(getPreviewsDirPath(), user.id, eventId);
  await fsp.mkdir(dirPath, { recursive: true });
  return path.join(dirPath, getPreviewFileName(dimension));
}

export { ensurePreviewPath };

function getPreviewPath (user, eventId, dimension) {
  return path.join(getPreviewsDirPath(), user.id, eventId, getPreviewFileName(dimension));
}
export { getPreviewPath };

function getPreviewFileName (dimension) {
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
