/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { AppLike, PryvRequest } from './_types.ts';
import type { Response, NextFunction, Application as ExpressApp } from 'express';
import { loadAccess, setMethodId } from 'middleware';
import methodCallback from './methodCallback.ts';
import { Audit } from './Paths.ts';
import { tryCoerceStringValues } from '../schema/validation.ts';

// Audit trail routes (the rows themselves are read with events.get on the
// `:_audit:` streams; these are computed views of them).
export default function (expressApp: ExpressApp, app: AppLike) {
  const api = app.api;
  const loadAccessMiddleware = loadAccess(app.storageLayer);
  expressApp.get(Audit + '/summary', setMethodId('audit.getSummary'), loadAccessMiddleware, function (req: PryvRequest, res: Response, next: NextFunction) {
    const params = Object.assign({}, req.query);
    tryCoerceStringValues(params, {
      fromTime: 'number',
      toTime: 'number',
      accessIds: 'array'
    });
    api.call(req.context, params, methodCallback(res, next, 200));
  });
}
