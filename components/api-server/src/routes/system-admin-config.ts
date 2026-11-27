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
 * Platform-wide configuration routes (values held in the platform store).
 * Each route has its entry in `systemRoutes/platformConfig.ts`; the /system
 * gate authenticated the caller first.
 *
 *   GET    /system/admin/platform-config         config:read
 *   GET    /system/admin/platform-config/:key    config:read
 *   PUT    /system/admin/platform-config/:key    config:write, body { value } (step-up for a sensitive key)
 *   DELETE /system/admin/platform-config/:key    config:write (step-up for a sensitive key)
 */
export default function systemAdminConfig (expressApp: Application, app: { systemAPI: { call: (...args: unknown[]) => unknown } }): void {
  const systemAPI = app.systemAPI;
  const base = Paths.System + '/admin/platform-config';

  function call (req: PryvRequest, res: Response, next: NextFunction, params: Record<string, unknown>) {
    res.set('Cache-Control', 'no-store');
    systemAPI.call(req.context, params, methodCallback(res, next, 200));
  }
  const body = (req: PryvRequest): Record<string, unknown> =>
    (req.body != null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  expressApp.get(base, setMethodId('system.platformConfig.list'), (req: PryvRequest, res: Response, next: NextFunction) => {
    call(req, res, next, {});
  });
  expressApp.get(base + '/:key', setMethodId('system.platformConfig.get'), (req: PryvRequest, res: Response, next: NextFunction) => {
    call(req, res, next, { key: req.params.key });
  });
  expressApp.put(base + '/:key', contentType.json, setMethodId('system.platformConfig.set'), (req: PryvRequest, res: Response, next: NextFunction) => {
    call(req, res, next, Object.assign({}, body(req), { key: req.params.key }));
  });
  expressApp.delete(base + '/:key', setMethodId('system.platformConfig.delete'), (req: PryvRequest, res: Response, next: NextFunction) => {
    call(req, res, next, { key: req.params.key });
  });
}
