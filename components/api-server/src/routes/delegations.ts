/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { AppLike, PryvRequest } from './_types.ts';
import type { Response, NextFunction, Application as ExpressApp } from 'express';
const require = createRequire(import.meta.url);
const methodCallback = require('./methodCallback.ts').default;
const Paths = require('./Paths.ts');
const middleware = require('middleware');
const { setMethodId } = require('middleware');

/**
 * Account-delegation routes.
 *
 * Client-facing paths (personal token): request/accept/refuse/cancel + the two
 * lists. Controlled-side paths (`/controlled-side/*`) are reached core-to-core
 * by a delegate's core using a plugin-minted capability bearer; they authorize
 * on the forge-protected marker inside the method, not on stream permissions.
 */
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = middleware.loadAccess(app.storageLayer);

  // ---- client-facing (B or A, personal token) ----
  expressApp.post(Paths.Delegations + '/attach-request', setMethodId('delegations.requestAttach'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 201));
  });
  expressApp.post(Paths.Delegations + '/controlled/:controlled/accept', setMethodId('delegations.acceptAttach'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.controlled }, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled/:controlled/refuse', setMethodId('delegations.refuseAttach'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.controlled }, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/delegates/:delegate/cancel', setMethodId('delegations.cancelInvite'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.delegate }, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Delegations + '/delegates', setMethodId('delegations.listDelegates'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
  expressApp.get(Paths.Delegations + '/controlled', setMethodId('delegations.listControlled'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, {}, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled/:controlled/token', setMethodId('delegations.getToken'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.controlled }, methodCallback(res, next, 200));
  });
  // Authoritative detach (B, genuine login only) + local stale-mirror dismiss (A).
  expressApp.delete(Paths.Delegations + '/delegates/:delegate', setMethodId('delegations.detachDelegate'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.delegate }, methodCallback(res, next, 200));
  });
  expressApp.delete(Paths.Delegations + '/controlled/:controlled', setMethodId('delegations.dismissControlled'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, { username: req.params.controlled }, methodCallback(res, next, 200));
  });

  // ---- controlled-side (core-to-core, capability / control bearer) ----
  expressApp.post(Paths.Delegations + '/controlled-side/token', setMethodId('delegations.issueToken'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled-side/accept-response', setMethodId('delegations.acceptResponse'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled-side/refuse-response', setMethodId('delegations.refuseResponse'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled-side/accept-complete', setMethodId('delegations.acceptComplete'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
  expressApp.post(Paths.Delegations + '/controlled-side/detach-notify', setMethodId('delegations.notifyDetach'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
};
