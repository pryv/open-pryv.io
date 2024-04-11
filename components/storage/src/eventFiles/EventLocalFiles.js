/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

const cuid = require('cuid');
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');

const { pipeline } = require('stream/promises');
const { getConfig, getLogger } = require('@pryv/boiler');
const userLocalDirectory = require('../userLocalDirectory');
const ds = require('@pryv/datastore');
const errors = ds.errors;

const ATTACHMENT_DIRNAME = 'attachments';

module.exports = EventFiles;
/**
 * Manages files storage for events (attachments & previews).
 *
 */
function EventFiles () { }

EventFiles.prototype.init = async function () {
  const config = await getConfig();
  this.settings = config.get('eventFiles');
  this.logger = getLogger('storage:eventFiles');
  await userLocalDirectory.init();
};

/**
 * Computes the total storage size of the given user's attached files, in bytes.
 *
 * @param {Object} user
 * @returns {Promise<number>}
 */
EventFiles.prototype.getFileStorageInfos = async function (userId) {
  const userPath = getUserPath(userId);
  try {
    await fs.promises.access(userPath);
  } catch (err) {
    this.logger.debug('No attachments dir for user ' + userId);
    return 0;
  }
  return getDirectorySize(userPath);
};

EventFiles.prototype.saveAttachmentFromStream = async function (readableStream, userId, eventId, fileId) {
  fileId = fileId || cuid();
  const filePath = getAttachmentPath(userId, eventId, fileId);
  const dirPath = path.dirname(filePath);
  await mkdirp(dirPath);
  const writeStream = fs.createWriteStream(filePath);
  await pipeline(readableStream, writeStream);
  return fileId;
};

EventFiles.prototype.getAttachmentStream = async function (userId, eventId, fileId) {
  const filePath = getAttachmentPath(userId, eventId, fileId);
  if (!fs.existsSync(filePath)) {
    throw errors.unknownResource('attachment', JSON.stringify({ userId, eventId, fileId }));
  }
  return fs.createReadStream(filePath);
};

EventFiles.prototype.removeAttachment = async function (userId, eventId, fileId) {
  const filePath = getAttachmentPath(userId, eventId, fileId);
  await fs.promises.unlink(filePath);
  await cleanupIfEmpty(path.dirname(filePath));
};

EventFiles.prototype.removeAllForEvent = async function (userId, eventId) {
  const dirPath = getEventPath(userId, eventId);
  await fs.promises.rm(dirPath, { recursive: true, force: true });
};

EventFiles.prototype.removeAllForUser = async function (userId) {
  fs.rmSync(getUserPath(userId), { recursive: true, force: true });
};

// -------------------- attach to store --------- //

/**
 * @param es {EventDataStore}
 */
EventFiles.prototype.attachToEventStore = function (es, setIntegrityOnEvent) {
  const eventFiles = this;
  es.getAttachment = async function getAttachment (userId, eventId, fileId) {
    return await eventFiles.getAttachmentStream(userId, eventId, fileId);
  };

  es.addAttachment = async function addAttachment (userId, eventId, attachmentItem, transaction) {
    delete attachmentItem.id;
    const fileId = await eventFiles.saveAttachmentFromStream(attachmentItem.attachmentData, userId, eventId);
    const attachment = Object.assign({ id: fileId }, attachmentItem);
    delete attachment.attachmentData;
    const event = await es.getOne(userId, eventId);
    event.attachments ??= [];
    event.attachments.push(attachment);
    setIntegrityOnEvent(event);
    await es.update(userId, event, transaction);
    return event;
  };

  es.deleteAttachment = async function deleteAttachment (userId, eventId, fileId, transaction) {
    const event = await es.getOne(userId, eventId);
    event.attachments = event.attachments.filter((attachment) => {
      return attachment.id !== fileId;
    });
    await eventFiles.removeAttachment(userId, eventId, fileId);
    setIntegrityOnEvent(event);
    await es.update(userId, event, transaction);
    return event;
  };
};

// -------------------- internals --------------- //

/**
 *
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function getDirectorySize (dirPath) {
  const files = await fs.promises.readdir(dirPath, { withFileTypes: true });

  const paths = files.map(async file => {
    const filePath = path.join(dirPath, file.name);
    if (file.isDirectory()) {
      return await getDirectorySize(filePath);
    }
    if (file.isFile()) {
      const { size } = await fs.promises.stat(filePath);
      return size;
    }
    return 0;
  });

  return (await Promise.all(paths)).flat(Infinity).reduce((i, size) => i + size, 0);
}

/**
 * Attempts to remove the given directory (if empty)
 */
async function cleanupIfEmpty (dirPath) {
  try {
    await fs.promises.rmdir(dirPath);
  } catch (err) {
    // assume dir is not empty
  }
}

/**
 * @param {String} userId
 * @param {String} eventId
 * @param {String} fileId
 */
function getAttachmentPath (userId, eventId, fileId) {
  return path.join(getEventPath(userId, eventId), fileId);
}

/**
 * @param {String} userId
 * @param {String} eventId
 */
function getEventPath (userId, eventId) {
  return path.join(getUserPath(userId), eventId);
}

/**
 * @param {String} userId
 */
function getUserPath (userId) {
  return userLocalDirectory.getPathForUser(userId, ATTACHMENT_DIRNAME);
}
