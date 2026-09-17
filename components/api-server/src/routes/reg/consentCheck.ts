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
 */

import { getPlatform } from 'platform';
import { MethodContext } from 'business';
import { withoutInjectedPermissions } from 'business/src/accesses/injectedPermissions.ts';
import { checkConsentGrant } from 'business/src/accesses/permissionSet.ts';

import type { Permission } from 'business/src/types/public.ts';

/** How long we wait on another core before calling the check unavailable. */
const REMOTE_TIMEOUT_MS = 3000;

/** Why a grant was refused. All of these are the requesting page's fault. */
export type GrantFailureReason =
  | 'token-invalid'
  | 'not-app-access'
  | 'empty-grant'
  | 'not-subset'
  | 'choice-not-allowed'
  | 'mandatory-refused';

/** Why the check could not be performed. All of these are the operator's
 * or the network's, never the page's. */
export type UnavailableReason =
  | 'core-unresolvable'
  | 'core-unreachable'
  | 'storage-error';

export type ConsentCheckOutcome =
  | { ok: true }
  | { ok: false; kind: 'grant'; reason: GrantFailureReason; offending?: Permission[] }
  | { ok: false; kind: 'unavailable'; reason: UnavailableReason; detail?: string };

/** The three fields both arms of step 2 produce, whichever way they got them. */
type LoadedAccess = { id: string; type: string; permissions: Permission[] | null };

type ConsentForm = { allowUserChoice: boolean; permissions: Permission[] };

type AppLike = {
  storageLayer: unknown;
  getCustomAuthFunction: (from: string) => unknown;
};

export type ConsentCheckDeps = {
  /** Seam for the remote arm, so a test can assert WHICH url is called
   * (that it comes from the platform mapping and not from the posted
   * apiEndpoint) without standing up a second core. */
  fetch?: typeof globalThis.fetch;
  /** Seam for the platform, same purpose. */
  platform?: {
    isSingleCore: boolean;
    coreId: string;
    getUserCore: (username: string) => Promise<string | null>;
    coreIdToUrl: (coreId: string) => string;
  };
};

/** A token failure raised by the local loader, told apart from a genuine
 * server fault by the error ids the loader uses for "this token is no
 * good". Anything else is a storage or code fault and must not be
 * reported to the page as an invalid token. */
const TOKEN_FAILURE_IDS = new Set([
  'invalid-access-token',
  'unknown-resource',
  'forbidden',
  'invalid-request-structure'
]);

/**
 * Load the access behind `token` from THIS core, through the very loader
 * `GET /:username/access-info` runs, so expiry, revocation, sender
 * constraint (DPoP), session and the operator's custom auth step are all
 * applied exactly as they would be for a real API call.
 */
async function loadLocalAccess (
  app: AppLike, username: string, token: string
): Promise<{ access: LoadedAccess } | { failure: ConsentCheckOutcome }> {
  // Named so an operator's custom auth step can tell this apart from a real
  // client request: it runs the same loader, but with no request headers of
  // its own, so a step that inspects headers would otherwise refuse every
  // annotated sign-in.
  const source = { name: 'consent-check', ip: null };
  let context;
  try {
    // Constructed inside the try: MethodContext parses the authorization
    // material in its constructor, and a token that is not a string throws
    // synchronously there. That is a malformed request, not a server fault.
    context = new MethodContext(
      source, username, token, app.getCustomAuthFunction('consent-check'), {}, {}, null
    );
    await context.init();
    await context.retrieveExpandedAccess(app.storageLayer);
  } catch (err: unknown) {
    const id = (err as { id?: string })?.id;
    if (id != null && TOKEN_FAILURE_IDS.has(id)) {
      return { failure: { ok: false, kind: 'grant', reason: 'token-invalid' } };
    }
    return {
      failure: {
        ok: false,
        kind: 'unavailable',
        reason: 'storage-error',
        detail: (err as Error)?.message ?? String(err)
      }
    };
  }
  const access = context.access;
  if (access == null) {
    return { failure: { ok: false, kind: 'grant', reason: 'token-invalid' } };
  }
  return { access: { id: access.id, type: access.type, permissions: access.permissions ?? null } };
}

/**
 * Load the access from the core that hosts the user, over the same
 * `access-info` endpoint, which on that core runs the same loader.
 */
async function loadRemoteAccess (
  coreUrl: string, username: string, token: string, fetchFn: typeof globalThis.fetch
): Promise<{ access: LoadedAccess } | { failure: ConsentCheckOutcome }> {
  const url = coreUrl + encodeURIComponent(username) + '/access-info';
  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    return {
      failure: {
        ok: false,
        kind: 'unavailable',
        reason: 'core-unreachable',
        detail: (err as Error)?.message ?? String(err)
      }
    };
  }
  // 401/403/404 are the token's verdict and belong to the page. A 404 is
  // ambiguous on its own, because a reverse proxy in front of the other
  // core answers the same way for a misrouted path, so when the body
  // carries an API error id we believe it rather than the status.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    if (response.status === 404 && !(await hasApiErrorId(response))) {
      return {
        failure: {
          ok: false,
          kind: 'unavailable',
          reason: 'core-unreachable',
          detail: 'a 404 that carries no API error, so probably not this core answering'
        }
      };
    }
    return { failure: { ok: false, kind: 'grant', reason: 'token-invalid' } };
  }
  if (!response.ok) {
    return {
      failure: {
        ok: false,
        kind: 'unavailable',
        reason: 'core-unreachable',
        detail: 'access-info answered ' + response.status
      }
    };
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch (err: unknown) {
    return {
      failure: {
        ok: false,
        kind: 'unavailable',
        reason: 'core-unreachable',
        detail: 'access-info answered a body that is not JSON'
      }
    };
  }
  // A 2xx whose body is not an access is not a verdict about the token: it
  // is a core answering something we cannot read, which is the operator's
  // problem, not the page's. Blaming the page here would make it delete a
  // possibly good access.
  if (typeof body?.id !== 'string' || typeof body?.type !== 'string') {
    return {
      failure: {
        ok: false,
        kind: 'unavailable',
        reason: 'core-unreachable',
        detail: 'access-info answered 2xx without an id and type'
      }
    };
  }
  return {
    access: {
      id: body.id,
      type: body.type,
      permissions: (body.permissions as Permission[] | undefined) ?? null
    }
  };
}

/** Did this error response come from a Pryv core, rather than from
 * something in front of it? A core always names the error. */
async function hasApiErrorId (response: { json: () => Promise<unknown> }): Promise<boolean> {
  try {
    const body = await response.json() as { error?: { id?: unknown } };
    return typeof body?.error?.id === 'string';
  } catch {
    return false;
  }
}

/** Is `url` something we can actually send a request to? `coreIdToUrl`
 * answers `"null/"` when it has neither a cached row, a dns domain, nor a
 * configured core url, and that string must not reach `fetch`. */
function isUsableCoreUrl (url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

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
  const platform = deps.platform ?? await getPlatform();
  const fetchFn = deps.fetch ?? globalThis.fetch;

  // Step 1: where does this access live? The platform decides, never the
  // caller. An unknown user takes the local arm, where the loader answers
  // with its own "no such user" failure, which is a token failure.
  let userCoreId: string | null = null;
  try {
    userCoreId = platform.isSingleCore ? null : await platform.getUserCore(username);
  } catch (err: unknown) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'storage-error',
      detail: (err as Error)?.message ?? String(err)
    };
  }
  const isLocal = platform.isSingleCore || userCoreId == null || userCoreId === platform.coreId;

  // Step 2: load the access through the loader `access-info` runs.
  let loaded;
  if (isLocal) {
    loaded = await loadLocalAccess(app, username, token);
  } else {
    const coreUrl = platform.coreIdToUrl(userCoreId as string);
    if (!isUsableCoreUrl(coreUrl)) {
      return {
        ok: false,
        kind: 'unavailable',
        reason: 'core-unresolvable',
        detail: 'no url for core ' + String(userCoreId) +
          ' (set `core.url` on that core, or `dns.domain` platform-wide)'
      };
    }
    loaded = await loadRemoteAccess(coreUrl, username, token, fetchFn);
  }
  if ('failure' in loaded) return loaded.failure;

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
