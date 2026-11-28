/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Application, Response, NextFunction } from 'express';
import type { PryvRequest } from './_types.ts';
import { setMethodId } from 'middleware';
import methodCallback from './methodCallback.ts';
import { System } from './Paths.ts';

/**
 * Administration audit trail routes. Each route has its entry in
 * `systemRoutes/audit.ts`; the /system gate authenticated the caller first.
 *
 * GET /system/admin/audit: the platform trail of this core (the acts without
 * an account of this core), most recent first. Never cached.
 */
export default function systemAdminAudit (expressApp: Application, app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  const systemAPI = app.systemAPI;
  expressApp.get(System + '/admin/audit', setMethodId('system.audit.get'), function (req: PryvRequest, res: Response, next: NextFunction) {
    res.set('Cache-Control', 'no-store');
    // Unknown parameters are refused by the method.
    systemAPI.call(req.context, Object.assign({}, req.query), methodCallback(res, next, 200));
  });
}
