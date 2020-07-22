/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

const lodash = require('lodash');

const storage = require('components/storage');
const errors = require('components/errors').factory;

function middlewareFactory(userEventsStorage: storage.user.Events) {
  return lodash.partial(attachmentsAccessMiddleware, userEventsStorage);
}
module.exports = middlewareFactory;

// A middleware that checks permissions to access the file attachment, then
// translates the request's resource path to match the actual physical path for
// static-serving the file.
// 
function attachmentsAccessMiddleware(userEventsStorage, req, res, next) {
  userEventsStorage.findOne(req.context.user, {id: req.params.id}, null, function (err, event) {
    const _ = lodash; 
    
    if (err) {
      return next(errors.unexpectedError(err));
    }
    if (! event) {
      return next(errors.unknownResource('event', req.params.id));
    }
    if (! req.context.canReadStream(event.streamId)) {
      return next(errors.forbidden());
    }

    req.url = req.url
      .replace(req.params.username, req.context.user.id)
      .replace('/events/', '/');
      
    if (req.params.fileName) {
      // ignore filename (it's just there to help clients build nice URLs)
      var encodedFileId = encodeURIComponent(req.params.fileId);
      req.url = req.url.substr(0, req.url.indexOf(encodedFileId) + encodedFileId.length);
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

    next();
  });
}
