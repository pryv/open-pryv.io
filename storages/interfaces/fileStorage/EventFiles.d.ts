/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

export interface EventFiles {
  init(): Promise<void>;
  getFileStorageInfos(userId: string): Promise<number>;
  saveAttachmentFromStream(stream: ReadableStream, userId: string, eventId: string, fileId?: string): Promise<string>;
  getAttachmentStream(userId: string, eventId: string, fileId: string): Promise<ReadableStream>;
  removeAttachment(userId: string, eventId: string, fileId: string): Promise<void>;
  removeAllForEvent(userId: string, eventId: string): Promise<void>;
  removeAllForUser(userId: string): Promise<void>;
  attachToEventStore(es: any, setIntegrityOnEvent: Function): void;
}

export declare const EventFiles: EventFiles;
export declare function createEventFiles(implementation: Partial<EventFiles>): EventFiles;
