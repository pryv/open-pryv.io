/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';

const { createId: cuid } = require('@paralleldrive/cuid2');
const fs = require('fs');
const path = require('path');

const { pipeline } = require('stream/promises');
const _internals = require('./_internals');
const ds = require('@pryv/datastore');
const errors = ds.errors;

const ATTACHMENT_DIRNAME = 'attachments';

/**
 * Manages files storage for events (attachments & previews).
 */
function EventFiles (this: any): void { }

EventFiles.prototype.init = async function (): Promise<void> {
  this.settings = _internals.config;
  this.logger = _internals.getLogger('storage:eventFiles');
  await _internals.userLocalDirectory.init();
};

/**
 * Computes the total storage size of the given user's attached files, in bytes.
 */
EventFiles.prototype.getFileStorageInfos = async function (userId: string): Promise<number> {
  const userPath = getUserPath(userId);
  try {
    await fs.promises.access(userPath);
  } catch (err) {
    this.logger.debug('No attachments dir for user ' + userId);
    return 0;
  }
  return getDirectorySize(userPath);
};

EventFiles.prototype.saveAttachmentFromStream = async function (readableStream: Readable, userId: string, eventId: string, fileId?: string): Promise<string> {
  fileId = fileId || cuid();
  const filePath = getAttachmentPath(userId, eventId, fileId as string);
  const dirPath = path.dirname(filePath);
  await fs.promises.mkdir(dirPath, { recursive: true });
  const writeStream = fs.createWriteStream(filePath);
  await pipeline(readableStream, writeStream);
  return fileId as string;
};

EventFiles.prototype.getAttachmentStream = async function (userId: string, eventId: string, fileId: string): Promise<Readable> {
  const filePath = getAttachmentPath(userId, eventId, fileId);
  if (!fs.existsSync(filePath)) {
    throw errors.unknownResource('attachment', JSON.stringify({ userId, eventId, fileId }));
  }
  return fs.createReadStream(filePath);
};

EventFiles.prototype.removeAttachment = async function (userId: string, eventId: string, fileId: string): Promise<void> {
  const filePath = getAttachmentPath(userId, eventId, fileId);
  await fs.promises.unlink(filePath);
  await cleanupIfEmpty(path.dirname(filePath));
};

EventFiles.prototype.removeAllForEvent = async function (userId: string, eventId: string): Promise<void> {
  const dirPath = getEventPath(userId, eventId);
  await fs.promises.rm(dirPath, { recursive: true, force: true });
};

EventFiles.prototype.removeAllForUser = async function (userId: string): Promise<void> {
  fs.rmSync(getUserPath(userId), { recursive: true, force: true });
};

// -------------------- attach to store --------- //

EventFiles.prototype.attachToEventStore = function (es: any, setIntegrityOnEvent: (event: any) => void): void {
  const eventFiles = this;
  es.getAttachment = async function getAttachment (userId: string, eventId: string, fileId: string) {
    return await eventFiles.getAttachmentStream(userId, eventId, fileId);
  };

  es.addAttachment = async function addAttachment (userId: string, eventId: string, attachmentItem: any, transaction: any) {
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

  es.deleteAttachment = async function deleteAttachment (userId: string, eventId: string, fileId: string, transaction: any) {
    const event = await es.getOne(userId, eventId);
    event.attachments = event.attachments.filter((attachment: any) => {
      return attachment.id !== fileId;
    });
    await eventFiles.removeAttachment(userId, eventId, fileId);
    setIntegrityOnEvent(event);
    await es.update(userId, event, transaction);
    return event;
  };
};

// -------------------- internals --------------- //

async function getDirectorySize (dirPath: string): Promise<number> {
  const files = await fs.promises.readdir(dirPath, { withFileTypes: true });

  const paths = files.map(async (file: any) => {
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

  return (await Promise.all(paths)).flat(Infinity).reduce((i: number, size: number) => i + size, 0);
}

/**
 * Attempts to remove the given directory (if empty)
 */
async function cleanupIfEmpty (dirPath: string): Promise<void> {
  try {
    await fs.promises.rmdir(dirPath);
  } catch (err) {
    // assume dir is not empty
  }
}

function getAttachmentPath (userId: string, eventId: string, fileId: string): string {
  return path.join(getEventPath(userId, eventId), fileId);
}

function getEventPath (userId: string, eventId: string): string {
  return path.join(getUserPath(userId), eventId);
}

function getUserPath (userId: string): string {
  return _internals.userLocalDirectory.getPathForUser(userId, ATTACHMENT_DIRNAME);
}

module.exports = EventFiles;
