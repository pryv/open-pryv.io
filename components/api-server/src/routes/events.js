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

const methodCallback = require('./methodCallback');
const encryption = require('utils').encryption;
const errors = require('errors').factory;
const express = require('express');
const Paths = require('./Paths');
const tryCoerceStringValues = require('../schema/validation').tryCoerceStringValues;
const _ = require('lodash');

const middleware = require('middleware');
const hasFileUpload = require('../middleware/uploads').hasFileUpload;
const attachmentsAccessMiddleware = require('../middleware/attachment_access');

import type Application  from '../application';

// Set up events route handling.
module.exports = function(expressApp: express$Application, app: Application) {
  const api = app.api;
  const config = app.config;
  const storage = app.storageLayer;

  const attachmentsDirPath = config.get('eventFiles:attachmentsDirPath');
  const filesReadTokenSecret = config.get('auth:filesReadTokenSecret');

  const loadAccessMiddleware = middleware.loadAccess(storage);

  const attachmentsStatic = express.static(attachmentsDirPath);
  const events = new express.Router({
    mergeParams: true
  });
  
  // This is the path prefix for the routes in this file. 
  expressApp.use(Paths.Events, events);

  events.get('/', 
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      var params = _.extend({}, req.query);
      tryCoerceStringValues(params, {
        fromTime: 'number',
        toTime: 'number',
        streams: 'object',
        tags: 'array',
        types: 'array',
        sortAscending: 'boolean',
        skip: 'number',
        limit: 'number',
        modifiedSince: 'number',
        includeDeletions: 'boolean'
      });
      api.call('events.get', req.context, params, methodCallback(res, next, 200));
    });

  events.get('/:id',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      var params = _.extend({id: req.params.id}, req.query);
      tryCoerceStringValues(params, {
        includeHistory: 'boolean'
      });
      api.call('events.getOne', req.context, params, methodCallback(res, next, 200));
    });

  // Access an events files
  // 
  // NOTE This `events.get('/:id/:fileId/:fileName?',`  doesn't work because 
  //  using a Router will hide the username from the code here. It appears that 
  //  the url is directly transformed into a file path in attachmentsAccessMiddleware
  //  and thus if something is missing from the (router-)visible url, something 
  //  will be missing upon file access. 
  // 
  expressApp.get(Paths.Events + '/:id/:fileId/:fileName?', 
    retrieveAccessFromReadToken, 
    loadAccessMiddleware,
    attachmentsAccessMiddleware(storage.events), 
    attachmentsStatic
  );

  // Parses the 'readToken' and verifies that the access referred to by id in 
  // the token corresponds to a real access and that the signature is valid. 
  // 
  function retrieveAccessFromReadToken(req: express$Request, res, next) {
    // forbid using access tokens in the URL
    if (req.query.auth != null)
      return next(errors.invalidAccessToken(
        'Query parameter "auth" is forbidden here, ' +
        'please use the "readToken" instead ' +
        'or provide the auth token in "Authorization" header.'));

    const readToken = req.query.readToken;

    // If no readToken was given, continue without checking.
    if (readToken == null) return next();
    
    const tokenParts = encryption.parseFileReadToken(readToken);
    const accessId = tokenParts.accessId;
    
    if (accessId == null)
      return next(errors.invalidAccessToken('Invalid read token.'));
      
    // Now load the access through the context; then verify the HMAC.
    const context = req.context; 
    context.retrieveAccessFromId(storage, accessId)
      .then(access => {
        const hmacValid = encryption
          .isFileReadTokenHMACValid(
            tokenParts.hmac, req.params.fileId, 
            access.token, filesReadTokenSecret);

        if (! hmacValid) 
          return next(errors.invalidAccessToken('Invalid read token.'));
          
        next();
      })
      .catch( err => next(errors.unexpectedError(err)) );
    
    return; // The promise chain above calls next on all branches.
  }

  // Create an event.
  events.post('/', 
    loadAccessMiddleware,
    hasFileUpload,
    function (req: express$Request, res, next) {
      const params = req.body;
      if (req.files) {
        params.files = req.files;
      }
      api.call('events.create', req.context, params, methodCallback(res, next, 201));
    });

  events.post('/start',
    function (req: express$Request, res, next) {
      return next(errors.goneResource());
    });

  expressApp.put(Paths.Events + '/:id',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      api.call('events.update', req.context, { id: req.params.id, update: req.body }, methodCallback(res, next, 200));
    });

  events.post('/stop',
    function (req: express$Request, res, next) {
      return next(errors.goneResource());
    });
  
  // Update an event
  events.post('/:id',
    loadAccessMiddleware,
    hasFileUpload,
    function (req: express$Request, res, next) {
      const params = {
        id: req.params.id,
        update: {}
      };
      if (req.files) {
        params.files = req.files;
      } else {
        delete params.files; // close possible hole
      }
      api.call('events.update', req.context, params, methodCallback(res, next, 200));
    });

  events.delete('/:id',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      api.call('events.delete', req.context, {id: req.params.id}, methodCallback(res, next, 200));
    });

  events.delete('/:id/:fileId',
    loadAccessMiddleware,
    function (req: express$Request, res, next) {
      api.call('events.deleteAttachment', req.context, {id: req.params.id, fileId: req.params.fileId}, methodCallback(res, next, 200));
    });

};
