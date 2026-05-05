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

const previewsDirPath = getConfigUnsafe(true).get('storages:engines:filesystem:previewsDirPath');

/**
 * Ensures the preview path for the specific event exists.
 * Only support JPEG preview images (fixed size) at the moment.
 *
 * @param {Object} user
 * @param {String} eventId
 * @param {Number} dimension
 */
async function ensurePreviewPath (user, eventId, dimension) {
  const dirPath = path.join(previewsDirPath, user.id, eventId);
  await fsp.mkdir(dirPath, { recursive: true });
  return path.join(dirPath, getPreviewFileName(dimension));
}

export { ensurePreviewPath };

/**
 * @param {Object} user
 * @param {String} eventId
 * @param {Number} dimension
 * @returns {String}
 */
function getPreviewPath (user, eventId, dimension) {
  return path.join(previewsDirPath, user.id, eventId, getPreviewFileName(dimension));
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
  fs.rmSync(previewsDirPath, { recursive: true, force: true });
}
export { removeAllPreviews };
