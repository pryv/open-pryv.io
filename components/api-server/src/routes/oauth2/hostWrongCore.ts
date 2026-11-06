/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The token and authorization endpoints on an account's own host, when the
 * platform serves that account from another core.
 *
 * On a platform with per-user hosts, DNS sends `https://<account>.<domain>`
 * to the account's core. A client may still reach the wrong one: a resolver
 * that cached the previous answer after the account was moved to another
 * core, a hosts override, a proxy pinned to an address. On such a request:
 *
 *   - `POST /oauth2/token` answers 421 `wrong_core` with that core's URL and
 *     `Retry-After` (the DNS answer's lifetime), before any code or refresh
 *     token is read: the client retries once its resolver has the new answer;
 *   - `/oauth2/authorize` answers a static page saying the address has just
 *     moved (no redirect, no form, no link).
 *
 * The decision is `resolveUserCore`'s, the one every misdirected request gets.
 * A service, core or hosted-site host, a name the platform does not map, and
 * an account of this core are not concerned: the request goes on. A lookup
 * failure lets it go on too: codes and refresh tokens are keyed by the core
 * that issued them, so this core cannot consume another core's.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { PlatformRoutedLabel } from '../../addressedAccount.ts';
import { addressedLabelOf } from '../../addressedAccount.ts';
import type { UserCorePlatform } from '../reg/userCore.ts';
import { resolveUserCore } from '../reg/userCore.ts';

type ConfigReader = { get: (key: string) => unknown };
type LoggerLike = { warn: (msg: string) => void };

const DEFAULT_RETRY_AFTER_SECONDS = 300;

export const HOST_WRONG_CORE_DESCRIPTION = 'this address is served by another core since a recent change: retry after the delay, once its DNS answer has been refreshed';

const MOVED_PAGE = '<!DOCTYPE html><html><head><title>Try again in a few minutes</title></head>' +
  '<body><h1>This address has just moved</h1><p>Try again in a few minutes.</p></body></html>';

/** `dns.defaultTTL` (the lifetime of the DNS answer a client may still hold), in seconds. */
export function retryAfterSeconds (config: ConfigReader): number {
  const ttl = Number(config.get('dns:defaultTTL'));
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_RETRY_AFTER_SECONDS;
}

export function hostWrongCoreGuard (opts: {
  config: ConfigReader;
  isPlatformRoutedLabel: PlatformRoutedLabel;
  logger: LoggerLike;
  platform?: UserCorePlatform;
}): RequestHandler {
  const retryAfter = String(retryAfterSeconds(opts.config));
  const deps = opts.platform != null ? { platform: opts.platform } : {};

  return function hostWrongCore (req: Request, res: Response, next: NextFunction): void {
    const label = addressedLabelOf(req.headers.host, opts.isPlatformRoutedLabel);
    if (label == null) return next();
    resolveUserCore(label, deps).then((placement) => {
      if (placement.kind === 'local') return next();
      if (placement.kind === 'unavailable' && placement.reason === 'storage-error') {
        opts.logger.warn(`oauth2: placement lookup failed on a per-user host, answered here ${req.method} ${req.path}: ${placement.detail}`);
        return next();
      }
      opts.logger.warn(`oauth2: per-user host of an account served by another core, 421 ${req.method} ${req.path}`);
      res.status(421);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('Cache-Control', 'no-store');
      if (req.path.startsWith('/oauth2/token')) {
        res.json({
          error: 'wrong_core',
          error_description: HOST_WRONG_CORE_DESCRIPTION,
          ...(placement.kind === 'remote' ? { coreUrl: placement.coreUrl } : {})
        });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.end(MOVED_PAGE);
    }, next);
  };
}
