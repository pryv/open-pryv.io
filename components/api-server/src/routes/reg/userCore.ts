/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Resolve WHICH core hosts a user's account, and its base URL when remote.
 *
 * The platform decides, never the caller. The unauthenticated reg endpoints
 * that use this (the consent check on accept, the credential hand-off) must
 * not treat a posted `apiEndpoint` as the host to query: that would let anyone
 * aim an authenticated outbound request at a host of their choosing. This is
 * the same decision `middleware/checkUserCore` takes for every user request.
 *
 * Shared by `consentCheck.ts` and `credentialHandoff.ts` so the "where does
 * this account live" rule is written once.
 */

import { getPlatform } from 'platform';

/** The slice of the platform this resolver needs. A test injects it to assert
 * WHICH url is used (from the mapping, never from a posted endpoint) without
 * standing up a second core. */
export type UserCorePlatform = {
  isSingleCore: boolean;
  coreId: string;
  getUserCore: (username: string) => Promise<string | null>;
  coreIdToUrl: (coreId: string) => string;
};

export type UserCoreResolution =
  | { kind: 'local' }
  | { kind: 'remote'; coreUrl: string }
  | { kind: 'unavailable'; reason: 'core-unresolvable' | 'storage-error'; detail: string };

/**
 * Is `url` something we can actually send a request to? `coreIdToUrl` answers
 * `"null/"` when it has neither a cached row, a dns domain, nor a configured
 * core url, and that string must not reach `fetch`.
 */
export function isUsableCoreUrl (url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decide whether `username`'s account is local to this core or on another,
 * and give the other core's base URL when remote. Never throws for an
 * expected failure: a platform lookup that faults, or a core with no usable
 * url, is returned as an `unavailable` outcome for the caller to map.
 */
export async function resolveUserCore (
  username: string,
  deps: { platform?: UserCorePlatform } = {}
): Promise<UserCoreResolution> {
  const platform = deps.platform ?? await getPlatform();
  let userCoreId: string | null = null;
  try {
    userCoreId = platform.isSingleCore ? null : await platform.getUserCore(username);
  } catch (err: unknown) {
    return { kind: 'unavailable', reason: 'storage-error', detail: (err as Error)?.message ?? String(err) };
  }
  const isLocal = platform.isSingleCore || userCoreId == null || userCoreId === platform.coreId;
  if (isLocal) return { kind: 'local' };
  const coreUrl = platform.coreIdToUrl(userCoreId as string);
  if (!isUsableCoreUrl(coreUrl)) {
    return {
      kind: 'unavailable',
      reason: 'core-unresolvable',
      detail: 'no url for core ' + String(userCoreId) +
        ' (set `core.url` on that core, or `dns.domain` platform-wide)'
    };
  }
  return { kind: 'remote', coreUrl };
}
