/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
// @flow

const lodash = require('lodash');

const storage = require('storage');
const errors = require('errors').factory;

const config = require('@pryv/boiler').getConfigUnsafe(true);
const pathForAttachment = require('business').users.UserLocalDirectory.pathForAttachment;
const getHTTPDigestHeaderForAttachment = require('business').integrity.attachments.getHTTPDigestHeaderForAttachment;

// -- Audit 
const isAuditActive = (!  config.get('openSource:isActive')) && config.get('audit:active');
let audit;
if (isAuditActive) {
  const throwIfMethodIsNotDeclared = require('audit/src/ApiMethods').throwIfMethodIsNotDeclared;
  throwIfMethodIsNotDeclared('events.getAttachment');
  audit = require('audit');
}
// -- end Audit

const fs = require('fs');
const path = require('path');

function middlewareFactory(userEventsStorage: storage.user.Events) {
  return lodash.partial(attachmentsAccessMiddleware, userEventsStorage);
}
module.exports = middlewareFactory;

// A middleware that checks permissions to access the file attachment, then
// translates the request's resource path to match the actual physical path for
// static-serving the file.
// 
async function attachmentsAccessMiddleware(userEventsStorage, req, res, next) {
  userEventsStorage.findOne(req.context.user, {id: req.params.id}, null, async function (err, event) {
    const _ = lodash; 
    
    if (err) {
      return next(errors.unexpectedError(err));
    }
    if (! event) {
      return next(errors.unknownResource('event', req.params.id));
    }
    let canReadEvent = false;
    for (let i = 0; i < event.streamIds.length ; i++) {
      if (await req.context.access.canGetEventsOnStream(event.streamIds[i], 'local')) {
        canReadEvent = true;
        break;
      }
    }
    if (! canReadEvent) {
      return next(errors.forbidden());
    }

    // set response content type (we can't rely on the filename)
    const attachment = event.attachments ?
      _.find(event.attachments, {id: req.params.fileId}) : null;
    if (! attachment) {
      return next(errors.unknownResource(
        'attachment', req.params.fileId
      ));
    }
    res.header('Content-Type', attachment.type);
    res.header('Content-Length', attachment.size);
    res.header('Content-Disposition', 'attachment; filename="' + attachment.fileName + '"');
    if (attachment.integrity != null) {
      const digest = getHTTPDigestHeaderForAttachment(attachment.integrity)
      if (digest != null) {
        res.header('Digest', digest);
      }
    }
    const fullPath = pathForAttachment(req.context.user.id, req.params.id, req.params.fileId);
    const fsReadStream = fs.createReadStream(fullPath);

    // for Audit
    req.context.originalQuery = req.params;

    const pipedStream = fsReadStream.pipe(res);
    let streamHasErrors = false;
    fsReadStream.on('error', async (err) => {
      streamHasErrors = true;
      try { 
        fsReadStream.unpipe(res);
      } catch(e) {}
      // error audit is taken in charge by express error management
      next(err);
    });
    pipedStream.on('finish', async (a) => {
      if (streamHasErrors) return;
      if (isAuditActive) await audit.validApiCall(req.context, null);
      // do not call "next()" 
    });
  });
}
