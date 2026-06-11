/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Readable } from 'stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createId: cuid } = require('@paralleldrive/cuid2');
const { S3Client, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { _internals } = require('./_internals.ts');
const ds = require('@pryv/datastore');
const errors = ds.errors;

interface AttachmentItem {
  id?: string;
  attachmentData: Readable;
  [k: string]: unknown;
}

interface EventWithAttachments {
  id?: string;
  attachments?: Array<{ id?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

interface EventStoreLike {
  getAttachment?: (userId: string, eventId: string, fileId: string) => Promise<Readable>;
  addAttachment?: (userId: string, eventId: string, item: AttachmentItem, transaction: unknown) => Promise<EventWithAttachments>;
  deleteAttachment?: (userId: string, eventId: string, fileId: string, transaction: unknown) => Promise<EventWithAttachments>;
  getOne: (userId: string, eventId: string) => Promise<EventWithAttachments>;
  update: (userId: string, event: EventWithAttachments, transaction: unknown) => Promise<unknown>;
  [k: string]: unknown;
}

type S3ObjectSummary = { Key?: string, Size?: number };

/**
 * Manages event attachment storage on an S3-compatible object store
 * (AWS S3, MinIO, Ceph RGW, …). Object layout:
 * `<keyPrefix><userId>/<eventId>/<fileId>` — one object per attachment,
 * mirroring the filesystem engine's directory layout.
 */
class EventS3Files {
  client!: InstanceType<typeof S3Client>;
  bucket!: string;
  keyPrefix!: string;
  logger!: { debug: (msg: string) => void };

  async init (): Promise<void> {
    const config = _internals.config || {};
    this.logger = _internals.getLogger('storage:eventFiles-s3');
    this.bucket = config.bucket;
    if (!this.bucket) throw new Error('S3 fileStorage engine: `storages.engines.s3.bucket` is required');
    this.keyPrefix = config.keyPrefix || '';
    const clientConfig: Record<string, unknown> = {
      region: config.region || 'us-east-1',
      forcePathStyle: config.forcePathStyle === true
    };
    if (config.endpoint) clientConfig.endpoint = config.endpoint;
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      };
    }
    this.client = new S3Client(clientConfig);
  }

  /**
   * Computes the total storage size of the given user's attached files, in bytes.
   */
  async getFileStorageInfos (userId: string): Promise<number> {
    let total = 0;
    for await (const object of this.#listObjects(this.#userPrefix(userId))) {
      total += object.Size || 0;
    }
    return total;
  }

  async saveAttachmentFromStream (readableStream: Readable, userId: string, eventId: string, fileId?: string): Promise<string> {
    fileId = fileId || cuid();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.#attachmentKey(userId, eventId, fileId as string),
        Body: readableStream
      }
    });
    await upload.done();
    return fileId as string;
  }

  async getAttachmentStream (userId: string, eventId: string, fileId: string): Promise<Readable> {
    try {
      const res = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.#attachmentKey(userId, eventId, fileId)
      }));
      return res.Body as Readable;
    } catch (err) {
      const s3Err = err as { name?: string, $metadata?: { httpStatusCode?: number } };
      if (s3Err?.name === 'NoSuchKey' || s3Err?.$metadata?.httpStatusCode === 404) {
        throw errors.unknownResource('attachment', JSON.stringify({ userId, eventId, fileId }));
      }
      throw err;
    }
  }

  async removeAttachment (userId: string, eventId: string, fileId: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.#attachmentKey(userId, eventId, fileId)
    }));
  }

  async removeAllForEvent (userId: string, eventId: string): Promise<void> {
    await this.#deletePrefix(this.#eventPrefix(userId, eventId));
  }

  async removeAllForUser (userId: string): Promise<void> {
    await this.#deletePrefix(this.#userPrefix(userId));
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

  // -------------------- internals --------------- //

  async * #listObjects (prefix: string): AsyncGenerator<S3ObjectSummary> {
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }));
      for (const object of res.Contents || []) yield object;
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async #deletePrefix (prefix: string): Promise<void> {
    // DeleteObjects accepts at most 1000 keys per call.
    let batch: Array<{ Key: string }> = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: batch, Quiet: true }
      }));
      batch = [];
    };
    for await (const object of this.#listObjects(prefix)) {
      if (object.Key == null) continue;
      batch.push({ Key: object.Key });
      if (batch.length === 1000) await flush();
    }
    await flush();
  }

  #attachmentKey (userId: string, eventId: string, fileId: string): string {
    return this.#eventPrefix(userId, eventId) + fileId;
  }

  #eventPrefix (userId: string, eventId: string): string {
    return this.#userPrefix(userId) + eventId + '/';
  }

  #userPrefix (userId: string): string {
    return this.keyPrefix + userId + '/';
  }
}

export { EventS3Files };
