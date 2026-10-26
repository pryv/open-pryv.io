/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The consent check on the auth-request accept.
 *
 * `POST /reg/access/:key` with `status: 'ACCEPTED'` carries a token the auth
 * page just minted. Historically the server stored it without looking at it:
 * the page was trusted to mint what the app had asked for. Once a request
 * carries a consent form, that trust is no longer enough, because the form
 * says which entries the user was allowed to drop, and only the server can
 * check that the access it is handed matches.
 *
 * So this module answers one question: does the access behind this token
 * satisfy the consent form the request was created with?
 *
 * Two properties shape the implementation:
 *
 * 1. **Where the access lives is decided by the platform, never by the
 *    caller.** This endpoint is unauthenticated, so treating the posted
 *    `apiEndpoint` as the host to query would let anyone aim an
 *    authenticated outbound request at a host of their choosing. The
 *    decision here is the same one `middleware/checkUserCore` takes for
 *    every user request.
 * 2. **A check that cannot be performed is not a check that passed.** The
 *    failures are split by owner: a token that does not resolve is the
 *    page's problem and answers 400, while a core that cannot be resolved
 *    or reached is the operator's and answers 503. The distinction is not
 *    cosmetic: the auth page deletes the access it just minted when it
 *    gets a 400, so telling it "invalid" when the truth is "could not
 *    check" would destroy a perfectly good access.
 *
 * Both properties live in `accessLoader.ts`, shared with the forced
 * external-id check.
 */

import { withoutInjectedPermissions } from 'business/src/accesses/injectedPermissions.ts';
import { checkConsentGrant } from 'business/src/accesses/permissionSet.ts';
import { loadAccessForUser, type AppLike, type UnavailableReason, type AccessLoaderDeps } from './accessLoader.ts';

import type { Permission } from 'business/src/types/public.ts';

/** Why a grant was refused. All of these are the requesting page's fault. */
export type GrantFailureReason =
  | 'token-invalid'
  | 'not-app-access'
  | 'empty-grant'
  | 'not-subset'
  | 'choice-not-allowed'
  | 'mandatory-refused';

export type { UnavailableReason };

export type ConsentCheckOutcome =
  | { ok: true }
  | { ok: false; kind: 'grant'; reason: GrantFailureReason; offending?: Permission[] }
  | { ok: false; kind: 'unavailable'; reason: UnavailableReason; detail?: string };

type ConsentForm = { allowUserChoice: boolean; permissions: Permission[] };

export type ConsentCheckDeps = AccessLoaderDeps;

/**
 * The check itself. Returns an outcome; it never throws for an expected
 * failure, and the caller maps `kind` to the status code (grant → 400,
 * unavailable → 503).
 */
export async function checkAcceptedGrant (
  params: { app: AppLike; username: string; token: string; consentForm: ConsentForm },
  deps: ConsentCheckDeps = {}
): Promise<ConsentCheckOutcome> {
  const { app, username, token, consentForm } = params;

  // Steps 1 and 2: where does this access live (the platform decides, never
  // the caller), then load it through the loader `access-info` runs.
  const loaded = await loadAccessForUser({ app, username, token, sourceName: 'consent-check' }, deps);
  if ('failure' in loaded) {
    if (loaded.failure.kind === 'token-invalid') return { ok: false, kind: 'grant', reason: 'token-invalid' };
    return { ok: false, kind: 'unavailable', reason: loaded.failure.reason, detail: loaded.failure.detail };
  }

  // Step 3: an app access, minus what the server injected into it.
  if (loaded.access.type !== 'app') {
    return { ok: false, kind: 'grant', reason: 'not-app-access' };
  }
  const granted = withoutInjectedPermissions(loaded.access.permissions, loaded.access.id);
  if (granted.length === 0) {
    // Stated here rather than left to the grant rule: an empty set would
    // PASS `checkConsentGrant` under allowUserChoice with no mandatory
    // entry, and an empty grant is a refusal, not a consent.
    return { ok: false, kind: 'grant', reason: 'empty-grant' };
  }

  // Step 4: the one grant rule, the same one the CMC and OAuth2 accept
  // paths call.
  const check = checkConsentGrant(granted, consentForm.permissions, consentForm.allowUserChoice === true);
  if (check.ok) {
    // An "offered versus granted" audit record would be emitted here, if
    // recording refusals were in scope. It deliberately is not: see the
    // consent-record ruling in the design notes.
    return { ok: true };
  }
  return { ok: false, kind: 'grant', reason: check.reason, offending: check.offending };
}
