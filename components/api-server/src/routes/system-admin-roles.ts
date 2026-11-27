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
 * Role management routes. Each route has its entry in
 * `systemRoutes/roles.ts`; the /system gate authenticated the caller first.
 *
 *   GET /system/admin/roles/by-username/:username   roles:read, the account's home core
 *   GET /system/admin/roles/:userId                 roles:read (break-glass)
 *   PUT /system/admin/roles/:userId { role, scope, expiresAt? }   roles:grant (step-up)
 *
 * The role list, the revocation and the claim codes are served by
 * system-setup.ts.
 */
export default function systemAdminRoles (expressApp: Application, app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  const systemAPI = app.systemAPI;

  function call (req: PryvRequest, res: Response, next: NextFunction, params: Record<string, unknown>, status: number) {
    res.set('Cache-Control', 'no-store');
    systemAPI.call(req.context, params, methodCallback(res, next, status));
  }

  // Before `:userId` (a user id never equals `by-username`, but the order must not depend on it).
  expressApp.get(Paths.System + '/admin/roles/by-username/:username', setMethodId('system.roles.getByUsername'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { username: req.params.username }, 200));
  expressApp.get(Paths.System + '/admin/roles/:userId', setMethodId('system.roles.get'),
    (req: PryvRequest, res: Response, next: NextFunction) => call(req, res, next, { userId: req.params.userId }, 200));
  expressApp.put(Paths.System + '/admin/roles/:userId', contentType.json, setMethodId('system.roles.set'),
    (req: PryvRequest, res: Response, next: NextFunction) => {
      const body = req.body != null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      call(req, res, next, Object.assign({}, body, { userId: req.params.userId }), 200);
    });
}
