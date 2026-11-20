/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { Request, Response, NextFunction } from 'express';
import { clientIp, addressBucket } from './clientIp.ts';
import { RoutingMissBudget, readUnknownNamesPerMinute } from './routingMissBudget.ts';
const require = createRequire(import.meta.url);
const errors = require('errors').factory;
const { getConfigUnsafe } = require('@pryv/boiler');

type PlatformLike = {
  isSingleCore: boolean;
  coreId: string;
  getUserCore: (username: string) => Promise<string | null>;
  getUserCoreForRouting?: (username: string) => Promise<string | null>;
  peekUserCoreForRouting?: (username: string) => string | null | undefined;
  coreIdToUrl: (coreId: string) => string;
};

// Lookups that found no account, per client (see routingMissBudget.ts).
const missBudget = new RoutingMissBudget();

function unknownNamesPerMinute (): number {
  try {
    return readUnknownNamesPerMinute((key: string) => getConfigUnsafe().get(key));
  } catch {
    return readUnknownNamesPerMinute(() => undefined);
  }
}

/**
 * Wrong-core middleware (DNSless multi-core).
 *
 * Mounted on `/:username/*`. Looks up `req.params.username` in PlatformDB and
 * if the user is mapped to a different core than this one, responds with
 * HTTP 421 Misdirected Request and a `wrong-core` error body containing the
 * URL of the correct core. Clients (SDKs) follow the URL directly — there is
 * NO redirect, because cross-origin redirects strip the Authorization header.
 *
 * The middleware is a no-op when:
 *   - the deployment is single-core (`platform.isSingleCore`), OR
 *   - the username has no core mapping in PlatformDB (the existing 401/404
 *     paths handle unknown users), OR
 *   - the user's core matches `platform.coreId`.
 *
 * Why HTTP 421 (and not 308/302):
 *   1. 421 is the only status that semantically means "this server cannot
 *      produce a response for the request, but a different server can".
 *   2. Cross-origin redirects strip Authorization headers per the HTTP spec —
 *      a 308 to `https://core-b.example.com/...` would 401 on the next core.
 *   3. Socket.IO upgrades cannot follow redirects.
 *
 * Response shape:
 *   {
 *     error: {
 *       id: 'wrong-core',
 *       message: '...',
 *       coreUrl: 'https://core-b.example.com'
 *     }
 *   }
 */

let _platformPromise: Promise<PlatformLike> | null = null;

/**
 * Lazily resolve the Platform singleton. Cached so the first request after
 * boot pays the cost once.
 */
async function getPlatformLazy (): Promise<PlatformLike> {
  if (_platformPromise == null) {
    const { getPlatform } = require('platform');
    _platformPromise = getPlatform();
  }
  return _platformPromise!;
}

/**
 * For tests — reset the cached platform reference.
 */
function _resetPlatformCache () {
  _platformPromise = null;
  missBudget.clear();
}

/**
 * For tests — use `platform` instead of the Platform singleton.
 */
function _setPlatformForTests (platform: PlatformLike) {
  _platformPromise = Promise.resolve(platform);
  missBudget.clear();
}

/**
 * Express middleware. Mount once on `/:username/*`.
 */
async function checkUserCore (req: Request, res: Response, next: NextFunction) {
  try {
    const username = req.params && (req.params.username as string);
    if (!username) return next();

    const platform = await getPlatformLazy();
    if (platform.isSingleCore) return next();

    // Cached per process (any name in any URL reaches this point
    // unauthenticated). A name not cached costs a platform read: a client
    // whose lookups keep finding no account is refused those reads for a while.
    let userCoreId = platform.peekUserCoreForRouting?.(username);
    if (userCoreId === undefined) {
      const ip = clientIp(req);
      const client = ip == null ? null : addressBucket(ip);
      const perMinute = unknownNamesPerMinute();
      const retryAfter = client == null ? null : missBudget.retryAfter(client, perMinute);
      if (retryAfter != null) {
        return next(errors.tooManyRequests('Too many requests for unknown usernames from this address. Please retry later.', retryAfter));
      }
      userCoreId = platform.getUserCoreForRouting != null
        ? await platform.getUserCoreForRouting(username)
        : await platform.getUserCore(username);
      if (userCoreId == null && client != null && perMinute > 0) missBudget.countMiss(client);
    }
    if (userCoreId == null) {
      // Unknown user in PlatformDB — let the existing 401/404 path answer.
      return next();
    }
    if (userCoreId === platform.coreId) {
      // Right core — happy path.
      return next();
    }

    // Wrong core — answer with 421 + the correct URL.
    const coreUrl = platform.coreIdToUrl(userCoreId);
    res.status(421).json({
      error: {
        id: 'wrong-core',
        message: 'User "' + username + '" is hosted on a different core. Retry the request against the URL in `coreUrl`.',
        coreUrl
      }
    });
  } catch (err) {
    next(err);
  }
}

// Test-only handle exposed on the middleware fn.
type CheckUserCoreFn = typeof checkUserCore & { _resetPlatformCache: typeof _resetPlatformCache; _setPlatformForTests: typeof _setPlatformForTests };
const checkUserCoreWithReset: CheckUserCoreFn = Object.assign(checkUserCore, { _resetPlatformCache, _setPlatformForTests });

export default checkUserCoreWithReset;
export { _resetPlatformCache, _setPlatformForTests };
