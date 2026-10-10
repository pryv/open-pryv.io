/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CanReadEventAccess } from 'business/src/accesses/canReadEvent.ts';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = require('path').dirname(__filename);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Cache = require('../cache.ts').default;
const childProcess = require('child_process');
const CronJob = require('cron').CronJob;
const errors = require('errors').factory;
const sharp = require('sharp');
// Previews are raster thumbnails. SVG would be decoded by librsvg, a large
// native parser reached here with user-supplied files, so its loaders are
// blocked for this worker: an SVG attachment is answered like any other
// unsupported format (sharp reports "unsupported image format").
sharp.block({ operation: ['VipsForeignLoadSvg'] });
const timestamp = require('unix-timestamp');
const xattr = require('fs-xattr');
const getAuth = require('middleware/src/getAuth.ts').default;
const isAdminKey = require('middleware/src/isAdminKey.ts').default;
const { getLogger } = require('@pryv/boiler');
const { getMall } = require('mall');
const { canReadEvent } = require('business/src/accesses/canReadEvent.ts');
const attachmentManagement = require('../attachmentManagement.ts');
const { getConfig } = require('@pryv/boiler');

// constants
const StandardDimensions = [256, 512, 768, 1024];
const SmallestStandardDimension = StandardDimensions[0];
const BiggestStandardDimension = StandardDimensions[StandardDimensions.length - 1];
const StandardDimensionsLength = StandardDimensions.length;
/**
 * Routes for retrieving preview images for events.
 *
 */
type RouteHandler = (req: PryvRequest, res: ResponseLike, next: NextFn) => unknown;
type ExpressApp = { all: (path: string, ...handlers: unknown[]) => unknown; get: (path: string, handler: RouteHandler) => unknown; post: (path: string, ...handlers: RouteHandler[]) => unknown };
type PryvRequest = {
  context: {
    user: { id: string; [k: string]: unknown };
    access: CanReadEventAccess;
    [k: string]: unknown;
  };
  params: { id: string };
  query: { width?: string; w?: string; height?: string; h?: string };
  headers: { origin?: string; authorization?: string };
  ip: string;
  [k: string]: unknown;
};
type ResponseLike = {
  sendStatus: (code: number) => void;
  sendFile: (path: string) => void;
  status: (code: number) => { json: (body: unknown) => void };
  [k: string]: unknown;
};
type NextFn = (err?: unknown) => void;
type SourceAttachment = { id: string; width?: number; height?: number; size?: number; integrity?: string };
type EventLike = { type: string; modified: number; streamIds: string[]; deleted?: number | null; attachments?: SourceAttachment[]; [k: string]: unknown };
type ImageError = Error & { message: string };
type Size = { width: number; height: number };
type Logging = unknown;

export default async function (expressApp: ExpressApp, initContextMiddleware: unknown, loadAccessMiddleware: unknown, _logging: Logging) {
  const mall = await getMall();
  const previewsLogger = getLogger('previews');
  const previewsCacheCleanUpCronTime = (await getConfig()).get('eventFiles:previewsCacheCleanUpCronTime') || '00 00 2 * * *';
  // CACHE CLEAN-UP: a maintenance call taking the raw admin key only
  // (`Authorization: <auth.adminAccessKey>`), answered "unknown resource"
  // otherwise, like the /system routes. Registered before getAuth, which would
  // also accept the key as `?auth=`, Bearer or Basic. The nightly cron below
  // does not need it.
  const adminAccessKey = (await getConfig()).get('auth:adminAccessKey');
  expressApp.post('/clean-up-cache', checkAdminKey, cleanUpCache);
  expressApp.post('/:username/clean-up-cache', checkAdminKey, cleanUpCache);
  // SERVING PREVIEWS
  expressApp.all('/*', getAuth);
  expressApp.all('/:username/events/*', initContextMiddleware, loadAccessMiddleware);
  expressApp.get('/:username/events/:id:extension(.jpg|.jpeg|)', async function (req: PryvRequest, res: ResponseLike, next: NextFn): Promise<void> {
    let originalSize, previewPath;
    let cached = false;
    const context = req.context;
    const user = req.context.user;
    const id = req.params.id;
    try {
      // Check Event
      const event = await mall.events.getOne(user.id, id);
      if (event == null || event.deleted != null) {
        // Whatever was cached for a deleted event goes with it.
        await dropEventPreviews(user, id);
        if (event == null) return next(errors.unknownResource('event', id));
      }
      // same exclusions as events.get
      if (!(await canReadEvent(context.access, event))) { return next(errors.forbidden()); }
      if (!canHavePreview(event)) {
        await dropEventPreviews(user, id);
        return res.sendStatus(204);
      }

      const attachment = getSourceAttachment(event);
      if (attachment == null) {
        // The attachment was removed: so are its cached copies.
        await dropEventPreviews(user, id);
        throw errors.corruptedData('Corrupt event data: expected an attachment.');
      }
      // The local copy of the attachment is tied to the attachment it was made
      // from: a replaced attachment is fetched again and the previews rendered
      // from the old one are dropped.
      const source = sourceAttachmentKey(attachment);
      const attachmentPath = await attachmentManagement.ensurePreviewPath(req.context.user, req.params.id, 0);
      if (await readXattr(attachmentPath, Cache.SourceAttachmentXattrKey) !== source) {
        await refreshSourceCopy(user.id, id, attachment.id, source, attachmentPath);
      }
      await xattr.set(attachmentPath, Cache.LastAccessedXattrKey, timestamp.now().toString());
      // Get aspect ratio
      if (attachment.width != null) {
        originalSize = { width: attachment.width, height: attachment.height };
      }
      try {
        const metadata = await sharp(attachmentPath).metadata();
        originalSize = { width: metadata.width, height: metadata.height };
        attachment.width = originalSize.width;
        attachment.height = originalSize.height;
      } catch (err) {
        return next(adjustImageError(err));
      }
      // Prepare path
      // Query values arrive as strings; getPreviewSize's arithmetic coerces
      // them numerically (legacy behavior — '0' stays truthy, unlike Number('0')).
      const targetSize = getPreviewSize(originalSize, {
        width: (req.query.width || req.query.w) as unknown as number,
        height: (req.query.height || req.query.h) as unknown as number
      });
      previewPath = await attachmentManagement.ensurePreviewPath(req.context.user, req.params.id, Math.max(targetSize.width, targetSize.height));
      try {
        const cacheModified = await xattr.get(previewPath, Cache.EventModifiedXattrKey);
        const cacheSource = await xattr.get(previewPath, Cache.SourceAttachmentXattrKey);
        cached = cacheModified.toString() === event.modified.toString() && cacheSource.toString() === source;
      } catch (err) {
        // assume no cache (don't throw any error)
      }
      if (!cached) {
        try {
          await sharp(attachmentPath, { pages: 1 }) // pages: 1 extracts first frame (animated GIFs)
            .resize(Math.round(targetSize.width), Math.round(targetSize.height))
            .jpeg({ progressive: true })
            .toFile(previewPath);
        } catch (err) {
          return next(adjustImageError(err));
        }
        await xattr.set(previewPath, Cache.EventModifiedXattrKey, event.modified.toString());
        await xattr.set(previewPath, Cache.SourceAttachmentXattrKey, source);
      }
      res.sendFile(previewPath);
      // update last accessed time (don't check result)
      await xattr.set(previewPath, Cache.LastAccessedXattrKey, timestamp.now().toString());
    } catch (err) {
      next(err);
    }
  });
  function canHavePreview (event: EventLike): boolean {
    return event.type === 'picture/attached';
  }
  function getSourceAttachment (event: EventLike) {
    // for now: just return the first attachment
    return event.attachments?.[0];
  }
  /** Identifies an attachment's content: a replaced file gets a new id. */
  function sourceAttachmentKey (attachment: SourceAttachment): string {
    return JSON.stringify([attachment.id, attachment.size ?? null, attachment.integrity ?? null]);
  }
  /** An extended attribute's value, or null when the file or the attribute is missing. */
  async function readXattr (filePath: string, key: string): Promise<string | null> {
    try {
      return (await xattr.get(filePath, key)).toString();
    } catch (err) {
      return null;
    }
  }
  /**
   * Replaces the local copy of the attachment (written aside, then renamed, so
   * a concurrent render reads a whole file) and drops the previews rendered
   * from the previous one.
   */
  async function refreshSourceCopy (userId: string, eventId: string, attachmentId: string, source: string, attachmentPath: string): Promise<void> {
    const dirPath = path.dirname(attachmentPath);
    for (const name of await fs.promises.readdir(dirPath)) {
      if (/^\d+\.jpg$/.test(name) && name !== path.basename(attachmentPath)) {
        await fs.promises.rm(path.join(dirPath, name), { force: true });
      }
    }
    const tmpPath = attachmentPath + '.' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      const attachmentStream = await mall.events.getAttachment(userId, { id: eventId }, attachmentId);
      await fs.promises.writeFile(tmpPath, attachmentStream);
      await xattr.set(tmpPath, Cache.SourceAttachmentXattrKey, source);
      await fs.promises.rename(tmpPath, attachmentPath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true });
      throw err;
    }
  }
  /** Removes every cached file of an event; failures are logged, never thrown. */
  async function dropEventPreviews (user: { id: string }, eventId: string): Promise<void> {
    try {
      const dirPath = path.dirname(attachmentManagement.getPreviewPath(user, eventId, 0));
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (err) {
      previewsLogger.warn('Could not drop the cached previews of an event', { eventId, error: (err as Error).message });
    }
  }
  function adjustImageError (err: unknown) {
    const e = err as ImageError;
    // sharp throws on corrupt/missing files with specific messages
    if (e.message && (e.message.includes('Input file is missing') || e.message.includes('unsupported image format'))) {
      return errors.corruptedData('Corrupt event data: expected an attached file.', err);
    }
    return err;
  }
  function getPreviewSize (original: Size, desired: { width?: number; height?: number }): Size {
    if (!(desired.width || desired.height)) {
      // return default size
      return {
        width: SmallestStandardDimension,
        height: SmallestStandardDimension
      };
    }
    const originalRatio = original.width / original.height; const result: Size = { width: 0, height: 0 };
    if (!desired.height || desired.width! / desired.height > originalRatio) {
      // reference = width
      result.width = adjustToStandardDimension(desired.width!);
      result.height = result.width / originalRatio;
    } else {
      // reference = height
      result.height = adjustToStandardDimension(desired.height);
      result.width = result.height * originalRatio;
    }
    // fix if oversize
    if (result.width > BiggestStandardDimension) {
      result.width = BiggestStandardDimension;
    }
    if (result.height > BiggestStandardDimension) {
      result.height = BiggestStandardDimension;
    }
    return result;
  }
  function adjustToStandardDimension (value: number): number {
    for (let i = 0; i < StandardDimensionsLength; i++) {
      if (value < StandardDimensions[i]) {
        return StandardDimensions[i];
      }
    }
    return StandardDimensions[StandardDimensionsLength - 1];
  }
  // CACHE CLEAN-UP (routes registered at the top, before getAuth)
  const logger = getLogger('previews-cache'); let workerRunning = false;
  function checkAdminKey (req: PryvRequest, _res: ResponseLike, next: NextFn) {
    if (!isAdminKey(req.headers.authorization, adminAccessKey)) {
      logger.warn('Refused previews cache clean-up without the admin key', { ip: req.ip });
      return next(errors.unknownResource());
    }
    next();
  }
  function cleanUpCache (req: PryvRequest, res: ResponseLike, next: NextFn) {
    if (workerRunning) {
      return res.status(200).json({ message: 'Clean-up already in progress.' });
    }
    logger.info('Start cleaning up previews cache (on request' +
            (req.headers.origin ? ' from ' + req.headers.origin : '') +
            ', client IP: ' +
            req.ip +
            ')...');
    runCacheCleanupWorker(function (err: Error | null) {
      if (err) {
        return next(errors.unexpectedError(err));
      }
      res.status(200).json({ message: 'Clean-up successful.' });
    });
  }
  const cronJob = CronJob.from({
    cronTime: previewsCacheCleanUpCronTime,
    onTick: function () {
      if (workerRunning) {
        return;
      }
      logger.info('Start cleaning up previews cache (cron job)...');
      runCacheCleanupWorker();
    }
  });
  logger.info('Start cron job for cache clean-up, time pattern: ' + cronJob.cronTime);
  cronJob.start();
  /**
   * @param callback Optional, will be passed an error on failure
   */
  function runCacheCleanupWorker (callback?: (err: Error | null) => void) {
    callback = typeof callback === 'function' ? callback : function () { };
    const worker = childProcess.fork(path.resolve(__dirname, '../runCacheCleanup.ts'), process.argv.slice(2));
    workerRunning = true;
    worker.on('exit', function (code: number | null) {
      workerRunning = false;
      callback(code !== 0
        ? new Error('Cache cleanup unexpectedly failed (see logs for details)')
        : null);
    });
  }
};
