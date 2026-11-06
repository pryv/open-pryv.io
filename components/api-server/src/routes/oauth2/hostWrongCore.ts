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
 * On a platform with per-user hosts, DNS sends `https://<account>.<dns.domain>`
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
 * The host is read by `addressedLabelOf` (the adapter ingress's reader) and
 * the decision is `resolveUserCore`'s, the one every misdirected request
 * gets. A service, core or hosted-site host, a host under another domain, a
 * name the platform does not map, and an account of this core are not
 * concerned: the request goes on. A lookup failure lets it go on too: codes
 * and refresh tokens are keyed by the core that issued them, so this core
 * cannot consume another core's.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { PerUserAddressing } from '../../addressedAccount.ts';
import { addressedLabelOf } from '../../addressedAccount.ts';
import { resolveUserCore } from '../reg/userCore.ts';
import type { UserCoreResolution } from '../reg/userCore.ts';

type LoggerLike = { warn: (msg: string) => void };

export const HOST_WRONG_CORE_DESCRIPTION = 'this address is served by another core since a recent change: retry after the delay, once its DNS answer has been refreshed';

const MOVED_PAGE = '<!DOCTYPE html><html><head><title>Try again in a few minutes</title></head>' +
  '<body><h1>This address has just moved</h1><p>Try again in a few minutes.</p></body></html>';

type Answer = (res: Response, placement: Exclude<UserCoreResolution, { kind: 'local' }>) => void;

const ANSWERS: Record<'token' | 'authorize', Answer> = {
  token (res, placement) {
    res.json({
      error: 'wrong_core',
      error_description: HOST_WRONG_CORE_DESCRIPTION,
      ...(placement.kind === 'remote' ? { coreUrl: placement.coreUrl } : {})
    });
  },
  authorize (res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(MOVED_PAGE);
  }
};

/** `endpoint`: `token` answers OAuth JSON, `authorize` the static page. */
export function hostWrongCoreGuard (opts: {
  addressing: PerUserAddressing;
  endpoint: 'token' | 'authorize';
  logger: LoggerLike;
}): RequestHandler {
  const { addressing, logger } = opts;
  const retryAfter = String(addressing.retryAfterSeconds ?? 300);
  const answer = ANSWERS[opts.endpoint];
  const deps = addressing.platform != null ? { platform: addressing.platform } : {};

  return function hostWrongCore (req: Request, res: Response, next: NextFunction): void {
    const label = addressedLabelOf(req.headers.host, addressing.isPlatformRoutedLabel, addressing.domain);
    if (label == null) return next();
    resolveUserCore(label, deps).then((placement) => {
      if (placement.kind === 'local') return next();
      if (placement.kind === 'unavailable' && placement.reason === 'storage-error') {
        logger.warn(`oauth2: placement lookup failed on a per-user host, answered here ${req.method} ${req.path}: ${placement.detail}`);
        return next();
      }
      logger.warn(`oauth2: per-user host of an account served by another core, 421 ${req.method} ${req.path}`);
      res.status(421);
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('Cache-Control', 'no-store');
      answer(res, placement);
    }).catch((err: unknown) => {
      if (res.headersSent) {
        logger.warn(`oauth2: per-user host answer failed after it started ${req.method} ${req.path}: ${(err as Error)?.message ?? String(err)}`);
        return;
      }
      next(err);
    });
  };
}
