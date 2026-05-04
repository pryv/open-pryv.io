/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Plan 27 Phase 2 — wrong-core middleware (DNSless multi-core).
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

let _platformPromise = null;

/**
 * Lazily resolve the Platform singleton. Cached so the first request after
 * boot pays the cost once.
 */
async function getPlatformLazy () {
  if (_platformPromise == null) {
    const { getPlatform } = require('platform');
    _platformPromise = getPlatform();
  }
  return _platformPromise;
}

/**
 * For tests — reset the cached platform reference.
 */
function _resetPlatformCache () {
  _platformPromise = null;
}

/**
 * Express middleware. Mount once on `/:username/*`.
 */
async function checkUserCore (req, res, next) {
  try {
    const username = req.params && req.params.username;
    if (!username) return next();

    const platform = await getPlatformLazy();
    if (platform.isSingleCore) return next();

    const userCoreId = await platform.getUserCore(username);
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

module.exports = checkUserCore;
module.exports._resetPlatformCache = _resetPlatformCache;
