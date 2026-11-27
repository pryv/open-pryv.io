/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { APIError } from 'errors';
import type { AdminRouteRule } from './adminAuth.ts';
import { capabilityOf } from 'business/src/admin/permissions.ts';
import { capabilityState, isPlatformConfigKeyReadonly, NEVER_LOCKED_CAPABILITIES } from 'business/src/admin/lockdown.ts';

/**
 * Lockdown of the `/system/*` routes, mounted right after the gate
 * (`adminAuth.ts`): for a request the gate admitted, refuses the writes this
 * core's `admin.lockdown` marks as managed elsewhere
 * (`business/src/admin/lockdown.ts`), whoever the subject is (administrator
 * session, setup session, admin key).
 *
 * On a route of the admin table whose method is not GET / HEAD and whose
 * permission is not a read (`<capability>:read`):
 * - the permission's capability `readonly` or `hidden`: 403
 *   `admin-lockdown-capability`;
 * - a PUT or DELETE of a platform configuration key listed in
 *   `platformConfig.readonly`: 403 `admin-lockdown-key`.
 * Never refused: reads, the routes without a permission (sessions), routes
 * with their own credential or none, and the setup, role and claim-code
 * routes. A request the gate refused never reaches this step (its 404 comes
 * first, so the 403 tells nothing to a caller without the permission).
 */

type ConfigReader = { get: (key: string) => unknown };

export type AdminLockdownOptions = {
  /** The rule of the route a request goes to, or null for a path no route serves (as for the gate). */
  rule: (method: string, path: string) => AdminRouteRule | null;
  config: ConfigReader;
};

/** The route that writes one platform configuration key, by its last path segment. */
const PLATFORM_CONFIG_KEY_PATH = /^\/system\/admin\/platform-config\/([^/]+)\/?$/i;

function decodeSegment (segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export default function adminLockdown (opts: AdminLockdownOptions): RequestHandler {
  const config = opts.config;
  return function adminLockdownStep (req: Request, _res: Response, next: NextFunction) {
    try {
      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
      const rule = opts.rule(req.method, req.path);
      if (rule == null || rule.auth !== 'admin' || rule.permission == null) return next();
      const permission = rule.permission;
      const capability = capabilityOf(permission);
      if (NEVER_LOCKED_CAPABILITIES.has(capability)) return next();
      if (permission.endsWith(':read')) return next();

      const state = capabilityState(config, capability);
      if (state !== 'editable') {
        return next(new APIError('admin-lockdown-capability',
          `The capability "${capability}" is managed outside the API on this core (admin.lockdown): it cannot be changed here.`,
          { httpStatus: 403, data: { capability } }));
      }
      if (permission === 'config:write' && (method === 'PUT' || method === 'DELETE')) {
        const m = PLATFORM_CONFIG_KEY_PATH.exec(req.path);
        const key = m != null ? decodeSegment(m[1]) : null;
        if (key != null && isPlatformConfigKeyReadonly(config, key)) {
          return next(new APIError('admin-lockdown-key',
            `The platform configuration key "${key}" is managed outside the API on this core (admin.lockdown): it cannot be changed here.`,
            { httpStatus: 403, data: { key } }));
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
