/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const mkdirp = require('mkdirp');
const path = require('path');
const fs = require('fs');
const { getConfigUnsafe } = require('@pryv/boiler');

const previewsDirPath = getConfigUnsafe(true).get('eventFiles:previewsDirPath');

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
  await mkdirp(dirPath);
  return path.join(dirPath, getPreviewFileName(dimension));
}

exports.ensurePreviewPath = ensurePreviewPath;

/**
 * @param {Object} user
 * @param {String} eventId
 * @param {Number} dimension
 * @returns {String}
 */
function getPreviewPath (user, eventId, dimension) {
  return path.join(previewsDirPath, user.id, eventId, getPreviewFileName(dimension));
}
exports.getPreviewPath = getPreviewPath;

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
exports.removeAllPreviews = removeAllPreviews;
