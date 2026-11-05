/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the consent of an account served by another core.
 *
 * On a multi-core platform the consent page signs the user in on the user's
 * own core, then posts `/oauth2/authorize/offer` and `/accept` to the core
 * that issued the authorization. When that is another core, the account is
 * not there: the host app's `resolveUser` says so (it answers a
 * `WrongCoreSession`, only when the platform names another core for the
 * username), and both endpoints answer `421 wrong_core` with that core's
 * URL. The signed state is keyed per core, so the flow cannot move: the
 * answer tells the user to start again from the app with the address of
 * their own core. It says no more than the wrong-core answer of
 * `/:username/*` and `/reg/cores` already do for any name.
 */

import { audit } from './audit.ts';

/** The account lives on another core of the platform. */
export type WrongCoreSession = { wrongCore: true; coreUrl: string };

export const WRONG_CORE_DESCRIPTION = 'this account is served by another core: start the authorization again from the app, with the address of that core';

export function isWrongCoreSession (v: unknown): v is WrongCoreSession {
  return v != null && typeof v === 'object' && (v as WrongCoreSession).wrongCore === true &&
    typeof (v as WrongCoreSession).coreUrl === 'string';
}

/** The 421 body (the shape introspection and token exchange use, plus a description). */
export function wrongCoreBody (s: WrongCoreSession): { error: string; error_description: string; coreUrl: string } {
  return { error: 'wrong_core', error_description: WRONG_CORE_DESCRIPTION, coreUrl: s.coreUrl };
}

/** Audited as a refused consent; the account is not named. */
export async function auditWrongCore (payload: { clientId: string; scope: string[] }): Promise<void> {
  await audit('oauth.consent.refused', {
    clientId: payload.clientId,
    requestedScope: payload.scope,
    reason: 'wrong-core',
  });
}
