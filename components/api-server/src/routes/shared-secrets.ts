/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — routes.
 *
 * Creation and status reads carry a token and go through the usual access
 * middleware. Retrieval deliberately does NOT: the key is the sole credential,
 * because the third party redeeming it has no token yet — that is the whole
 * point of the feature. It therefore resolves the user from the path itself and
 * runs with no access, exactly like the registration routes.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import type { Response, NextFunction } from 'express';

const middleware = require('middleware');
const { setMinimalMethodContext, setMethodId } = require('middleware');
const Paths = require('./Paths.ts');
const methodCallback = require('./methodCallback.ts').default;
const errors = require('errors').factory;
const { getUsersRepository } = require('business/src/users/index.ts');

type ExpressApp = {
  get (path: string, ...handlers: unknown[]): void;
  post (path: string, ...handlers: unknown[]): void;
};
type AppLike = { api: { call (context: unknown, params: unknown, cb: unknown): void }; storageLayer: unknown };
type PryvRequest = {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  context: Record<string, unknown>;
};

export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  expressApp.post(Paths.SharedSecrets, loadAccessMiddleware, setMethodId('sharedSecrets.create'),
    function (req: PryvRequest, res: Response, next: NextFunction) {
      api.call(req.context, req.body, methodCallback(res, next, 201));
    });

  expressApp.get(Paths.SharedSecrets + '/:key', loadAccessMiddleware, setMethodId('sharedSecrets.getOne'),
    function (req: PryvRequest, res: Response, next: NextFunction) {
      api.call(req.context, { key: req.params.key }, methodCallback(res, next, 200));
    });

  // A context may or may not already be attached depending on what ran before
  // this route; setMinimalMethodContext refuses to overwrite one, so only call
  // it when there is nothing there.
  function ensureContext (req: PryvRequest, res: Response, next: NextFunction) {
    if (req.context == null) return setMinimalMethodContext(req, res, next);
    next();
  }

  // Unauthenticated on purpose — see the module comment.
  expressApp.post(Paths.SharedSecrets + '/:key', ensureContext, setMethodId('sharedSecrets.retrieve'),
    async function (req: PryvRequest, res: Response, next: NextFunction) {
      try {
        const username = req.params.username;
        const usersRepository = await getUsersRepository();
        const userId = await usersRepository.getUserIdForUsername(username);
        if (userId == null) {
          // Same refusal as an unknown key: whether the account exists is not
          // something this endpoint should disclose.
          return next(errors.unknownResource('shared secret', ''));
        }
        req.context.user = { id: userId, username };
        const params = Object.assign({ key: req.params.key }, req.body);
        api.call(req.context, params, methodCallback(res, next, 200));
      } catch (err) {
        next(err);
      }
    });
}
