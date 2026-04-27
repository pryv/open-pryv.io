/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const errors = require('errors').factory;
const { getConfig } = require('@pryv/boiler');
const getHTTPDigestHeaderForAttachment = require('business').integrity.attachments.getHTTPDigestHeaderForAttachment;
const { getMall } = require('mall');
let initialized = false;
let config = null;
let mall = null;
let isAuditActive = false;
let audit = null;
/**
 * @returns {Class<attachmentsAccessMiddleware>>}
 */
async function middlewareFactory () {
  if (initialized) { return attachmentsAccessMiddleware; }
  config = await getConfig();
  mall = await getMall();
  // -- Audit
  isAuditActive = config.get('audit:active');
  if (isAuditActive) {
    const throwIfMethodIsNotDeclared = require('audit/src/ApiMethods').throwIfMethodIsNotDeclared;
    throwIfMethodIsNotDeclared('events.getAttachment');
    audit = require('audit');
  }
  // -- end Audit
  initialized = true;
  return attachmentsAccessMiddleware;
}
module.exports = middlewareFactory;
// A middleware that checks permissions to access the file attachment, then
// translates the request's resource path to match the actual physical path for
// static-serving the file.
//
/**
 * @returns {Promise<any>}
 */
async function attachmentsAccessMiddleware (req, res, next) {
  const event = await mall.events.getOne(req.context.user.id, req.params.id);
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
    ? event.attachments.find(att => att.id === req.params.fileId)
    : null;
  if (!attachment) {
    return next(errors.unknownResource('attachment', req.params.fileId));
  }
  res.header('Content-Type', attachment.type);
  res.header('Content-Length', attachment.size);
  res.header('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(attachment.fileName));
  if (attachment.integrity != null) {
    const digest = getHTTPDigestHeaderForAttachment(attachment.integrity);
    if (digest != null) {
      res.header('Digest', digest);
    }
  }
  const fileReadStream = await mall.events.getAttachment(req.context.user.id, event, req.params.fileId);
  // for Audit
  req.context.originalQuery = req.params;
  const pipedStream = fileReadStream.pipe(res);
  let streamHasErrors = false;
  fileReadStream.on('error', async (err) => {
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
    if (isAuditActive) { await audit.validApiCall(req.context, null); }
    // do not call "next()"
  });
}
