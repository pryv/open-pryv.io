/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Application, Response, NextFunction } from 'express';
import type { PryvRequest } from './_types.ts';
import * as Paths from './Paths.ts';
import methodCallback from './methodCallback.ts';
import { contentType, setMethodId } from 'middleware';

/**
 * OAuth client and publisher review routes. Each route has its entry in
 * `systemRoutes/oauth.ts`; the /system gate authenticated the caller first.
 *
 *   GET  /system/admin/oauth/clients?queue=&origin=&status=      oauthClients:read
 *   GET  /system/admin/oauth/clients/:clientId                   oauthClients:read
 *   POST /system/admin/oauth/clients/:clientId/approve    { digest, reason? }   oauthClients:review
 *   POST /system/admin/oauth/clients/:clientId/unvalidate { reason }            oauthClients:review
 *   POST /system/admin/oauth/clients/:clientId/suspend    { reason }            oauthClients:review
 *   POST /system/admin/oauth/clients/:clientId/resume     { reason? }           oauthClients:review
 *   GET  /system/admin/oauth/publishers                          publishers:read
 *   GET  /system/admin/oauth/publishers/:userId                  publishers:read
 *   PUT  /system/admin/oauth/publishers/:userId { status, displayName?, regions?, reason }   publishers:review
 */
export default function systemAdminOauth (expressApp: Application, app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  const systemAPI = app.systemAPI;
  const base = Paths.System + '/admin/oauth';

  function call (req: PryvRequest, res: Response, next: NextFunction, params: Record<string, unknown>) {
    res.set('Cache-Control', 'no-store');
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  }

  function bodyOf (req: PryvRequest): Record<string, unknown> {
    return req.body != null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  }

  // A review act may come without a body (resume); a body must be JSON.
  function jsonIfBody (req: PryvRequest, res: Response, next: NextFunction) {
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > 0 || req.headers['transfer-encoding'] != null) return contentType.json(req, res, next);
    next();
  }

  expressApp.get(base + '/clients', setMethodId('system.oauthClients.list'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { ...req.query }));
  expressApp.get(base + '/clients/:clientId', setMethodId('system.oauthClients.get'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { clientId: req.params.clientId }));
  for (const act of ['approve', 'unvalidate', 'suspend', 'resume']) {
    expressApp.post(base + '/clients/:clientId/' + act, jsonIfBody, setMethodId('system.oauthClients.' + act),
      (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { ...bodyOf(req), clientId: req.params.clientId }));
  }
  expressApp.get(base + '/publishers', setMethodId('system.publishers.list'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { ...req.query }));
  expressApp.get(base + '/publishers/:userId', setMethodId('system.publishers.get'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { userId: req.params.userId }));
  expressApp.put(base + '/publishers/:userId', contentType.json, setMethodId('system.publishers.set'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { ...bodyOf(req), userId: req.params.userId }));
}
