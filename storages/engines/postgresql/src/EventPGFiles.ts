/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable as ReadableT } from 'stream';
import type { Logger } from '@pryv/boiler';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { Readable } = require('stream');
const { createId: cuid } = require('@paralleldrive/cuid2');
const { _internals } = require('./_internals.ts');
const ds = require('@pryv/datastore');
const errors = ds.errors;

interface AttachmentItem {
  id?: string;
  attachmentData: ReadableT;
  [k: string]: unknown;
}

interface EventWithAttachments {
  id?: string;
  attachments?: Array<{ id?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

interface EventStoreLike {
  getAttachment?: (userId: string, eventId: string, fileId: string) => Promise<ReadableT>;
  addAttachment?: (userId: string, eventId: string, item: AttachmentItem, transaction: unknown) => Promise<EventWithAttachments>;
  deleteAttachment?: (userId: string, eventId: string, fileId: string, transaction: unknown) => Promise<EventWithAttachments>;
  getOne: (userId: string, eventId: string) => Promise<EventWithAttachments>;
  update: (userId: string, event: EventWithAttachments, transaction: unknown) => Promise<unknown>;
  [k: string]: unknown;
}

type PgClientLike = { query (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
type PgDbLike = PgClientLike & {
  initSchema (): Promise<void>;
  withTransaction<T> (fn: (client: PgClientLike) => Promise<T>): Promise<T>;
};

/** Rows stream in fixed-size chunks so a file never sits whole in memory. */
const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/**
 * Manages event attachment storage as chunked BYTEA rows in PostgreSQL —
 * the zero-extra-service alternative to the s3 engine for the diskless
 * shape. One row per chunk in `attachment_files`, keyed
 * (user_id, event_id, file_id, seq).
 *
 * Intended for deployments where LOW attachment volume is foreseen:
 * attachment bytes inflate the database, its WAL and every backup
 * (pg_dump includes them). For attachment-heavy deployments use the s3
 * engine (`storages.file.engine: s3`) or the filesystem engine.
 */
class EventPGFiles {
  db!: PgDbLike;
  logger!: Logger;

  async init (): Promise<void> {
    this.logger = _internals.getLogger('storage:eventFiles-pg');
    const shared = _internals.databasePG as PgDbLike | undefined;
    if (shared) {
      this.db = shared;
    } else {
      // file engine is postgresql while baseStorage is not — dedicated pool
      const { DatabasePG } = require('./DatabasePG.ts');
      this.db = new DatabasePG(_internals.config);
    }
    // Idempotent (advisory-locked, guarded by _schemaReady) — guarantees
    // `attachment_files` exists whatever the boot order.
    await this.db.initSchema();
    this.logger.warn(
      'PostgreSQL file storage is intended for deployments where low ' +
      'attachment volume is foreseen — attachment bytes inflate the ' +
      'database, its WAL and every backup. For attachment-heavy ' +
      'deployments use the s3 engine (storages.file.engine: s3) or the ' +
      'filesystem engine.');
  }

  /**
   * Computes the total storage size of the given user's attached files, in bytes.
   */
  async getFileStorageInfos (userId: string): Promise<number> {
    const res = await this.db.query(
      'SELECT COALESCE(SUM(OCTET_LENGTH(data)), 0) AS total FROM attachment_files WHERE user_id = $1',
      [userId]);
    return Number(res.rows[0].total);
  }

  async saveAttachmentFromStream (readableStream: ReadableT, userId: string, eventId: string, fileId?: string): Promise<string> {
    fileId = fileId || cuid();
    await this.db.withTransaction(async (client) => {
      let seq = 0;
      let pending: Buffer = Buffer.alloc(0);
      const writeChunk = async (data: Buffer) => {
        await client.query(
          'INSERT INTO attachment_files (user_id, event_id, file_id, seq, data) VALUES ($1, $2, $3, $4, $5)',
          [userId, eventId, fileId, seq++, data]);
      };
      for await (const piece of readableStream) {
        pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, Buffer.from(piece)]);
        while (pending.length >= CHUNK_SIZE) {
          await writeChunk(pending.subarray(0, CHUNK_SIZE));
          pending = pending.subarray(CHUNK_SIZE);
        }
      }
      // remainder — also writes the empty seq-0 row marking a 0-byte file
      if (pending.length > 0 || seq === 0) await writeChunk(pending);
    });
    return fileId as string;
  }

  async getAttachmentStream (userId: string, eventId: string, fileId: string): Promise<ReadableT> {
    const head = await this.db.query(
      'SELECT 1 FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3 AND seq = 0',
      [userId, eventId, fileId]);
    if (head.rows.length === 0) {
      throw errors.unknownResource('attachment', JSON.stringify({ userId, eventId, fileId }));
    }
    const db = this.db;
    return Readable.from((async function * () {
      for (let seq = 0; ; seq++) {
        const res = await db.query(
          'SELECT data FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3 AND seq = $4',
          [userId, eventId, fileId, seq]);
        if (res.rows.length === 0) return;
        yield res.rows[0].data as Buffer;
      }
    })());
  }

  async removeAttachment (userId: string, eventId: string, fileId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM attachment_files WHERE user_id = $1 AND event_id = $2 AND file_id = $3',
      [userId, eventId, fileId]);
  }

  async removeAllForEvent (userId: string, eventId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM attachment_files WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]);
  }

  async removeAllForUser (userId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM attachment_files WHERE user_id = $1',
      [userId]);
  }

  // -------------------- attach to store --------- //

  attachToEventStore (es: EventStoreLike, setIntegrityOnEvent: (event: EventWithAttachments) => void): void {
    const eventFiles = this;
    es.getAttachment = async function getAttachment (userId: string, eventId: string, fileId: string) {
      return await eventFiles.getAttachmentStream(userId, eventId, fileId);
    };

    es.addAttachment = async function addAttachment (userId: string, eventId: string, attachmentItem: AttachmentItem, transaction: unknown) {
      delete attachmentItem.id;
      const fileId = await eventFiles.saveAttachmentFromStream(attachmentItem.attachmentData, userId, eventId);
      const attachment = Object.assign({ id: fileId }, attachmentItem);
      delete (attachment as { attachmentData?: unknown }).attachmentData;
      const event = await es.getOne(userId, eventId);
      event.attachments ??= [];
      event.attachments.push(attachment);
      setIntegrityOnEvent(event);
      await es.update(userId, event, transaction);
      return event;
    };

    es.deleteAttachment = async function deleteAttachment (userId: string, eventId: string, fileId: string, transaction: unknown) {
      const event = await es.getOne(userId, eventId);
      event.attachments = event.attachments?.filter((attachment) => {
        return attachment.id !== fileId;
      });
      await eventFiles.removeAttachment(userId, eventId, fileId);
      setIntegrityOnEvent(event);
      await es.update(userId, event, transaction);
      return event;
    };
  }
}

export { EventPGFiles };
