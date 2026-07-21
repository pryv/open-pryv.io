/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from './_types.ts';
import type { Request, Response, NextFunction, Application as ExpressApp } from 'express';

const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;


const encryption = require('utils').encryption;
const errors = require('errors').factory;
const Paths = require('./Paths.ts');
const tryCoerceStringValues = require('../schema/validation.ts').tryCoerceStringValues;
const middleware = require('middleware');
const { setMethodId } = require('middleware');
const hasFileUpload = require('../middleware/uploads.ts').hasFileUpload;
const attachmentsAccessMiddlewareFactory = require('../middleware/attachment-access.ts').default;
// Set up events route handling.
export default async function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const config = app.config;
  // The storage layer satisfies the MethodContext access/session slice.
  const storage = app.storageLayer as import('business/src/MethodContext.ts').StorageLike;
  const filesReadTokenSecret = config.get('auth:filesReadTokenSecret');
  const loadAccessMiddleware = middleware.loadAccess(storage);
  expressApp.get(Paths.Events + '/', setMethodId('events.get'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.query);
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
      includeDeletions: 'boolean',
      running: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Events + '/:id', setMethodId('events.getOne'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({ id: req.params.id }, req.query);
    tryCoerceStringValues(params, {
      includeHistory: 'boolean'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  // Access an events files
  //
  // NOTE This `expressApp.get(Paths.Events + '/:id/:fileId/:fileName?',`  doesn't work because
  //  using a Router will hide the username from the code here. It appears that
  //  the url is directly transformed into a file path in attachmentsAccessMiddleware
  //  and thus if something is missing from the (router-)visible url, something
  //  will be missing upon file access.
  //
  const attachmentsAccessMiddleware = await attachmentsAccessMiddlewareFactory();
  expressApp.get(Paths.Events + '/:id/:fileId/:fileName?', setMethodId('events.getAttachment'), retrieveAccessFromReadToken, loadAccessMiddleware, attachmentsAccessMiddleware);
  // Parses the 'readToken' and verifies that the access referred to by id in
  // the token corresponds to a real access and that the signature is valid.
  //
  function retrieveAccessFromReadToken (req: PryvRequest, res: Response, next: NextFunction) {
    // forbid using access tokens in the URL
    if (req.query.auth != null) {
      return next(errors.invalidAccessToken('Query parameter "auth" is forbidden here, ' +
                'please use the "readToken" instead ' +
                'or provide the auth token in "Authorization" header.'));
    }
    const readToken = req.query.readToken;
    // If no readToken was given, continue without checking.
    if (readToken == null) { return next(); }
    const tokenParts = encryption.parseFileReadToken(readToken);
    const accessId = tokenParts.accessId;
    if (accessId == null) { return next(errors.invalidAccessToken('Invalid read token.')); }
    // Now load the access through the context; then verify the HMAC.
    const context = req.context!;
    context
      .retrieveAccessFromId(storage, accessId)
      .then((access: { token: string }) => {
        const hmacValid = encryption.isFileReadTokenHMACValid(tokenParts.hmac, req.params.fileId, access.token, filesReadTokenSecret);
        if (!hmacValid) { return next(errors.invalidAccessToken('Invalid read token.')); }
        // The HMAC is the possession proof for this single-file read, so
        // a DPoP-bound access reaches its attachments here without a DPoP
        // header (a download / <img src> GET cannot carry one).
        context.readTokenAuthenticated = true;
        next();
      })
      .catch((err: Error) => next(errors.unexpectedError(err)));
    // The promise chain above calls next on all branches.
  }
  // Create an event.
  expressApp.post(Paths.Events + '/', setMethodId('events.create'), loadAccessMiddleware, hasFileUpload, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = req.body;
    if (req.files) {
      params.files = req.files;
    } else {
      delete params.files;
    }
    api.call(req.context, params, methodCallback(res, next, 201));
  });
  expressApp.post(Paths.Events + '/start', function (req: PryvRequest, res: Response, next: NextFunction) {
    return next(errors.goneResource());
  });
  expressApp.put(Paths.Events + '/:id', setMethodId('events.update'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: req.params.id, update: req.body }, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Events + '/stop', function (req: PryvRequest, res: Response, next: NextFunction) {
    return next(errors.goneResource());
  });
  // Update an event
  expressApp.post(Paths.Events + '/:id', setMethodId('events.update'), loadAccessMiddleware, hasFileUpload, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params: { id: string | undefined; update: Record<string, unknown>; files?: unknown } = {
      id: req.params.id as string,
      update: {}
    };
    if (req.files) {
      params.files = req.files;
    } else {
      delete params.files; // close possible hole
    }
    api.call(req.context, params, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Events + '/:id', setMethodId('events.delete'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: req.params.id }, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Events + '/:id/:fileId', setMethodId('events.deleteAttachment'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { id: req.params.id, fileId: req.params.fileId }, methodCallback(res, next, 200));
  });
};
