/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';

export interface EventFiles {
  init (): Promise<void>;
  getFileStorageInfos (userId: string): Promise<number>;
  saveAttachmentFromStream (stream: Readable, userId: string, eventId: string, fileId?: string): Promise<string>;
  getAttachmentStream (userId: string, eventId: string, fileId: string): Promise<Readable>;
  removeAttachment (userId: string, eventId: string, fileId: string): Promise<void>;
  removeAllForEvent (userId: string, eventId: string): Promise<void>;
  removeAllForUser (userId: string): Promise<void>;
  attachToEventStore (es: any, setIntegrityOnEvent: Function): void;
}

/**
 * EventFiles prototype object.
 * All event file storage implementations inherit from this via {@link createEventFiles}.
 */
const EventFiles: EventFiles = {
  async init () { throw new Error('Not implemented'); },

  async getFileStorageInfos (userId: string): Promise<number> { throw new Error('Not implemented'); },

  async saveAttachmentFromStream (stream: Readable, userId: string, eventId: string, fileId?: string): Promise<string> { throw new Error('Not implemented'); },

  async getAttachmentStream (userId: string, eventId: string, fileId: string): Promise<Readable> { throw new Error('Not implemented'); },

  async removeAttachment (userId: string, eventId: string, fileId: string): Promise<void> { throw new Error('Not implemented'); },

  async removeAllForEvent (userId: string, eventId: string): Promise<void> { throw new Error('Not implemented'); },

  async removeAllForUser (userId: string): Promise<void> { throw new Error('Not implemented'); },

  attachToEventStore (es: any, setIntegrityOnEvent: Function): void { throw new Error('Not implemented'); }
};

// Limit tampering on existing properties
for (const propName of Object.getOwnPropertyNames(EventFiles)) {
  Object.defineProperty(EventFiles, propName, { configurable: false });
}

/**
 * Create a new EventFiles object with the given implementation (plain-object pattern).
 */
function createEventFiles (implementation: Partial<EventFiles>): EventFiles {
  return Object.assign(Object.create(EventFiles), implementation);
}

const REQUIRED_METHODS: string[] = Object.getOwnPropertyNames(EventFiles);

function validateEventFiles (instance: any): EventFiles {
  for (const method of REQUIRED_METHODS) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`EventFiles implementation missing method: ${method}`);
    }
  }
  return instance;
}

export { EventFiles, createEventFiles, validateEventFiles };