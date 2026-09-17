/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike } from '@pryv/boiler';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const { getConfig, getLogger } = require('@pryv/boiler');
const logger = getLogger('attachment-access');
const getHTTPDigestHeaderForAttachment = require('business').integrity.attachments.getHTTPDigestHeaderForAttachment;
const { getMall } = require('mall');

type AccessLike = { canGetEventsOnStream: (streamId: string, scope: string) => Promise<boolean> };
type ContextLike = { user: { id: string }; access: AccessLike; originalQuery?: unknown };
type AttachmentLike = {
  id: string;
  type: string;
  size: number;
  fileName: string;
  integrity?: unknown;
};
type EventLike = {
  streamIds: string[];
  attachments?: AttachmentLike[];
};
type MallLike = {
  events: {
    getOne: (userId: string, id: string) => Promise<EventLike | null>;
    getAttachment: (userId: string, event: EventLike, fileId: string) => Promise<Readable>;
  };
};
type AuditLike = { validApiCall: (context: ContextLike, err: unknown) => Promise<void> };
type PryvRequest = Request & { context: ContextLike; params: { id: string; fileId: string } & Request['params'] };

// Populated by the middleware factory before the middleware is returned —
// the `mall!` / `audit!` uses in handlers rely on that ordering
// (`audit!` additionally guarded by isAuditActive).
let initialized = false;
let config: ConfigLike | null = null;
let mall: MallLike | null = null;
let isAuditActive = false;
let audit: AuditLike | null = null;
async function middlewareFactory (): Promise<RequestHandler> {
  if (initialized) { return attachmentsAccessMiddleware as RequestHandler; }
  const loadedConfig = await getConfig();
  config = loadedConfig;
  mall = await getMall();
  // -- Audit
  isAuditActive = !!loadedConfig.get('audit:active');
  if (isAuditActive) {
    const throwIfMethodIsNotDeclared = require('audit/src/ApiMethods.ts').throwIfMethodIsNotDeclared;
    throwIfMethodIsNotDeclared('events.getAttachment');
    audit = require('audit').default;
  }
  // -- end Audit
  initialized = true;
  return attachmentsAccessMiddleware as RequestHandler;
}
export default middlewareFactory;
export { middlewareFactory };
// A middleware that checks permissions to access the file attachment, then
// translates the request's resource path to match the actual physical path for
// static-serving the file.
//
async function attachmentsAccessMiddleware (req: PryvRequest, res: Response, next: NextFunction): Promise<void> {
  // Express 4 does not catch async middleware rejections — without the
  // try/catch a rejecting getAttachment (every file engine rejects on missing
  // content before a stream exists) crashes the worker instead of yielding a
  // 404.
  try {
    const event = await mall!.events.getOne(req.context.user.id, req.params.id);
    if (!event) {
      return next(errors.unknownResource('event', req.params.id));
    }
    let canReadEvent = false;
    for (let i = 0; i < event.streamIds.length; i++) {
      if (await req.context.access.canGetEventsOnStream(event.streamIds[i], 'local')) {
        canReadEvent = true;
        break;
      }
    }
    if (!canReadEvent) {
      return next(errors.forbidden());
    }
    const attachment = event.attachments
      ? event.attachments.find((att: AttachmentLike) => att.id === req.params.fileId)
      : null;
    if (!attachment) {
      return next(errors.unknownResource('attachment', req.params.fileId));
    }
    const fileReadStream = await mall!.events.getAttachment(req.context.user.id, event, req.params.fileId);
    // for Audit
    req.context.originalQuery = req.params;

    // The client may already be gone: `.pipe()` onto a destroyed response does
    // not throw, it leaves the source waiting for a drain that never comes, and
    // a 'close' listener attached now would never fire. Release the file and
    // stop; nothing was served, so nothing is audited.
    if (res.destroyed) {
      fileReadStream.destroy();
      return;
    }
    // Attachment headers only once there is a file to serve: an error before
    // this point (a missing file rejects getAttachment above) must go out as a
    // plain JSON error, not presented as the attachment. Content type comes
    // from the attachment metadata, we can't rely on the filename.
    res.header('Content-Type', attachment.type);
    res.header('Content-Length', String(attachment.size));
    res.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(attachment.fileName));
    if (attachment.integrity != null) {
      const digest = getHTTPDigestHeaderForAttachment(attachment.integrity);
      if (digest != null) {
        res.header('Digest', digest);
      }
    }
    // `.pipe()` is deliberate here, not pipeline(): a source error before any
    // byte was written must leave `res` usable so the error middleware can still
    // answer with a status (and audit the error). What `.pipe()` lacks is destroy
    // propagation, so the response's 'close' (emitted on completion AND on
    // premature termination) releases the source by hand. Idempotent after a
    // normal end or a source error.
    res.once('close', () => { fileReadStream.destroy(); });
    fileReadStream.pipe(res);
    let streamHasErrors = false;
    fileReadStream.on('error', (err: Error) => {
      streamHasErrors = true;
      try {
        fileReadStream.unpipe(res);
      } catch (e) {
        // error audit is taken in charge by express error management
      }
      // Before the first byte the error middleware still answers with a JSON
      // error: drop the attachment's headers so it is not presented (or saved)
      // as the file.
      if (!res.headersSent) {
        for (const name of ['Content-Type', 'Content-Length', 'Content-Disposition', 'Digest']) res.removeHeader(name);
      }
      next(err);
    });
    res.once('finish', async () => {
      if (streamHasErrors) { return; }
      // The file is already served: a failing audit write can only be logged.
      // Left to reject, it would be unhandled (nothing awaits an event
      // listener) and take the worker down.
      try {
        if (isAuditActive) { await audit!.validApiCall(req.context, null); }
      } catch (err) {
        logger.error('Failed to audit a served attachment download', err);
      }
      // do not call "next()"
    });
  } catch (err) {
    next(err);
  }
}
