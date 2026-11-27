/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AdminRouteRule } from './adminAuth.ts';

/**
 * Lockdown of the `/system/*` routes, mounted right after the gate
 * (`adminAuth.ts`): for a request the gate admitted, refuses the writes this
 * core's `admin.lockdown` marks as managed elsewhere. Lets every request
 * through for now.
 */

type ConfigReader = { get: (key: string) => unknown };

export type AdminLockdownOptions = {
  /** The rule of the route a request goes to, or null for a path no route serves (as for the gate). */
  rule: (method: string, path: string) => AdminRouteRule | null;
  config: ConfigReader;
};

export default function adminLockdown (_opts: AdminLockdownOptions): RequestHandler {
  return function adminLockdownStep (_req: Request, _res: Response, next: NextFunction) {
    next();
  };
}
