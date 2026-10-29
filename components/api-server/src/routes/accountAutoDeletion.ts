/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account auto-deletion setting (per-user routes: mounted with the other
 * account routes).
 */

import type { AppLike, PryvRequest } from './_types.ts';
import type { Response, NextFunction, Application as ExpressApp } from 'express';
import { loadAccess, setMethodId } from 'middleware';
import methodCallback from './methodCallback.ts';
import { Account } from './Paths.ts';

export default function (expressApp: ExpressApp, app: AppLike): void {
  const api = app.api;
  const loadAccessMiddleware = loadAccess(app.storageLayer);
  const path = Account + '/auto-deletion';

  expressApp.get(path, setMethodId('account.getAutoDeletion'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.query, methodCallback(res, next, 200));
  });
  expressApp.put(path, setMethodId('account.setAutoDeletion'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    api.call(req.context, req.body, methodCallback(res, next, 200));
  });
}
