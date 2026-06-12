/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { ConfigLike } from '@pryv/boiler';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const { getConfig } = require('@pryv/boiler');
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
    getAttachment: (userId: string, event: EventLike, fileId: string) => Promise<NodeJS.ReadableStream & { unpipe: (dest: unknown) => void; on: (ev: string, fn: (...args: unknown[]) => void) => void; pipe: (dest: NodeJS.WritableStream) => NodeJS.WritableStream }>;
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
  // try/catch a rejecting getAttachment (s3 / postgresql engines reject on
  // missing content; filesystem surfaces it as a late stream error) crashes
  // the worker instead of yielding a 404.
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
    // set response content type (we can't rely on the filename)
    const attachment = event.attachments
      ? event.attachments.find((att: AttachmentLike) => att.id === req.params.fileId)
      : null;
    if (!attachment) {
      return next(errors.unknownResource('attachment', req.params.fileId));
    }
    res.header('Content-Type', attachment.type);
    res.header('Content-Length', String(attachment.size));
    res.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(attachment.fileName));
    if (attachment.integrity != null) {
      const digest = getHTTPDigestHeaderForAttachment(attachment.integrity);
      if (digest != null) {
        res.header('Digest', digest);
      }
    }
    const fileReadStream = await mall!.events.getAttachment(req.context.user.id, event, req.params.fileId);
    // for Audit
    req.context.originalQuery = req.params;
    const pipedStream = fileReadStream.pipe(res);
    let streamHasErrors = false;
    fileReadStream.on('error', async (err: unknown) => {
      streamHasErrors = true;
      try {
        fileReadStream.unpipe(res);
      } catch (e) {
        // error audit is taken in charge by express error management
      }
      next(err);
    });
    pipedStream.on('finish', async () => {
      if (streamHasErrors) { return; }
      if (isAuditActive) { await audit!.validApiCall(req.context, null); }
      // do not call "next()"
    });
  } catch (err) {
    next(err);
  }
}
