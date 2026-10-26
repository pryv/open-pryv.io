/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The forced external-id check on the auth-request accept.
 *
 * In forced mode an app must receive a credential only for the account that
 * holds the request's external id. The page mints the access itself, so the
 * server cannot refuse to mint; it refuses to hand the credential over: this
 * check runs before the ACCEPTED state, the only thing the app reads, is
 * written.
 *
 * Two steps, both decided by the platform and never by the caller:
 * 1. **Bind:** the posted token must belong to the posted username, on that
 *    username's core (the loader the consent check uses). Without it, a
 *    non-holder could name the holder and post a token of their own account.
 * 2. **Holder:** the username's home core says whether that account holds the
 *    id: in-process when the account is local, else through the home core's
 *    admin-key `POST /system/ext-id/holds`, which answers a boolean only.
 *
 * A check that cannot be performed is never a pass (503). Only a "not the
 * holder" answer counts in the per-address budget: a bad token is not a probe
 * of the id.
 */

import { peerUrlProblem, insecurePeerUrlAllowed, peerFetchOptions } from 'platform/src/coreIdentity.ts';
import { getExternalIdsService } from 'business/src/external-ids/service.ts';
import { loadAccessForUser, REMOTE_TIMEOUT_MS, type AppLike, type AccessLoaderDeps, type UnavailableReason } from './accessLoader.ts';
import { extIdLookupBudget } from './extIdLookupBudget.ts';

import type { ConfigLike } from '@pryv/boiler';

export type ForcedCheckOutcome =
  | { ok: true }
  | { ok: false; kind: 'mismatch'; reason: 'token-invalid' | 'not-holder' }
  | { ok: false; kind: 'unavailable'; reason: UnavailableReason; detail?: string }
  | { ok: false; kind: 'over-budget'; retryAfter: number };

export type ForcedCheckDeps = AccessLoaderDeps & {
  /** Seam for the local holder answer. */
  holds?: (userId: string, namespace: string, blindedValue: string) => Promise<boolean>;
};

export async function checkForcedAcceptance (
  params: {
    app: AppLike & { config: ConfigLike };
    username: string;
    token: string;
    externalId: { namespace: string; blindedValue: string };
    ip: string | null | undefined;
  },
  deps: ForcedCheckDeps = {}
): Promise<ForcedCheckOutcome> {
  const { app, username, token, externalId, ip } = params;
  const retryAfter = await extIdLookupBudget.check(ip);
  if (retryAfter != null) return { ok: false, kind: 'over-budget', retryAfter };

  const loaded = await loadAccessForUser({ app, username, token, sourceName: 'external-id-check' }, deps);
  if ('failure' in loaded) {
    if (loaded.failure.kind === 'token-invalid') return { ok: false, kind: 'mismatch', reason: 'token-invalid' };
    return { ok: false, kind: 'unavailable', reason: loaded.failure.reason, detail: loaded.failure.detail };
  }

  let holds: boolean;
  if (loaded.location.kind === 'local') {
    try {
      const holdsFn = deps.holds ?? (async (userId: string, namespace: string, value: string) =>
        await (await getExternalIdsService()).holds(userId, namespace, value));
      holds = await holdsFn(loaded.location.userId, externalId.namespace, externalId.blindedValue);
    } catch (err: unknown) {
      return { ok: false, kind: 'unavailable', reason: 'storage-error', detail: (err as Error)?.message ?? String(err) };
    }
  } else {
    const remote = await askHomeCore(app.config, loaded.location.coreUrl, username, externalId, deps.fetch ?? globalThis.fetch);
    if ('failure' in remote) return { ok: false, kind: 'unavailable', reason: 'core-unreachable', detail: remote.failure };
    holds = remote.holds;
  }
  if (!holds) {
    await extIdLookupBudget.reserve(ip).catch(() => {});
    return { ok: false, kind: 'mismatch', reason: 'not-holder' };
  }
  return { ok: true };
}

/** The home core's holder answer. Its URL comes from the platform mapping. */
async function askHomeCore (
  config: ConfigLike, coreUrl: string, username: string,
  externalId: { namespace: string; blindedValue: string }, fetchFn: typeof globalThis.fetch
): Promise<{ holds: boolean } | { failure: string }> {
  // The target receives the admin key: check it is a core URL first.
  const problem = peerUrlProblem(coreUrl, { allowInsecure: insecurePeerUrlAllowed(config) });
  if (problem != null) return { failure: 'refusing the core-to-core call: ' + problem };
  const adminKey = config.get('auth:adminAccessKey');
  if (typeof adminKey !== 'string' || adminKey.length === 0) return { failure: 'auth.adminAccessKey is not set' };
  let response;
  try {
    response = await fetchFn(coreUrl.replace(/\/$/, '') + '/system/ext-id/holds', peerFetchOptions({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: adminKey, accept: 'application/json' },
      body: JSON.stringify({ username, namespace: externalId.namespace, blindedValue: externalId.blindedValue })
    }, REMOTE_TIMEOUT_MS));
  } catch (err: unknown) {
    return { failure: (err as Error)?.message ?? String(err) };
  }
  // A 404 means the account is not on that core: a misrouted call, never a
  // refusal of a legitimate holder.
  if (!response.ok) return { failure: 'the home core answered ' + response.status };
  try {
    const body = await response.json() as { holds?: unknown };
    if (typeof body?.holds !== 'boolean') return { failure: 'the home core answered without a holds boolean' };
    return { holds: body.holds };
  } catch {
    return { failure: 'the home core answered a body that is not JSON' };
  }
}
