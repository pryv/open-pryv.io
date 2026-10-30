/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: session index write at mint time (see storage.ts `oauth-at/`).
 *
 * Every OAuth session token (code exchange and refresh, every client kind)
 * gets an index row, so a later reader (token introspection) can find the
 * home core, user and client of a token from the token alone. A failed write
 * is logged and never fails the mint: such a token is then simply unknown to
 * the index (it introspects inactive).
 */

import { createRequire } from 'node:module';

import type { PlatformDB } from '../../../storages/interfaces/platformStorage/PlatformDB.ts';
import type { OAuthSessionIndex } from './storage.ts';
const require = createRequire(import.meta.url);

const storage = require('./storage.ts');
const { logServerError } = require('./serverLog.ts');

/** Write the index row of a freshly minted session. Never throws. */
export async function indexSession (platform: PlatformDB, accessToken: string, row: OAuthSessionIndex): Promise<void> {
  try {
    await storage.setSessionIndex(platform, accessToken, row);
  } catch (err: unknown) {
    logServerError('oauth2: session index write failed', err);
  }
}
