/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Load the access behind a token posted to an auth-request accept, for the
 * account it claims to belong to. Shared by the checks that run on that
 * accept (the consent check, the forced external-id check), so they bind a
 * token to its account with the same code.
 *
 * Where the access lives is decided by the platform, never by the caller:
 * the endpoint is unauthenticated, so the posted `apiEndpoint` is never the
 * host queried. A token that does not resolve is the page's problem
 * (`token-invalid`); a core that cannot be resolved or reached is the
 * operator's (`unavailable`).
 */

import { MethodContext } from 'business';
import { resolveUserCore, type UserCorePlatform } from './userCore.ts';

import type { Permission } from 'business/src/types/public.ts';

/** How long we wait on another core before calling the check unavailable. */
const REMOTE_TIMEOUT_MS = 3000;

/** Why a check could not be performed: the operator's or the network's, never the page's. */
export type UnavailableReason =
  | 'core-unresolvable'
  | 'core-unreachable'
  | 'storage-error';

/** The three fields both arms produce, whichever way they got them. */
export type LoadedAccess = { id: string; type: string; permissions: Permission[] | null };

export type LoadFailure =
  | { kind: 'token-invalid' }
  | { kind: 'unavailable'; reason: UnavailableReason; detail?: string };

/** Where the account lives, as the platform says. */
export type AccountLocation =
  | { kind: 'local'; userId: string }
  | { kind: 'remote'; coreUrl: string };

export type LoadResult =
  | { access: LoadedAccess; location: AccountLocation }
  | { failure: LoadFailure };

export type AppLike = {
  storageLayer: unknown;
  getCustomAuthFunction: (from: string) => unknown;
};

export type AccessLoaderDeps = {
  /** Seam for the remote arm, so a test can assert WHICH url is called
   * (that it comes from the platform mapping and not from the posted
   * apiEndpoint) without standing up a second core. */
  fetch?: typeof globalThis.fetch;
  /** Seam for the platform, same purpose. */
  platform?: UserCorePlatform;
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
 * Resolve the account's core, then load the access behind `token` for that
 * username, locally or on the account's core. `sourceName` labels the call for
 * an operator's custom auth step.
 */
export async function loadAccessForUser (
  params: { app: AppLike; username: string; token: string; sourceName: string },
  deps: AccessLoaderDeps = {}
): Promise<LoadResult> {
  const { app, username, token, sourceName } = params;
  // An unknown user takes the local arm, where the loader answers with its
  // own "no such user" failure, a token failure.
  const resolution = await resolveUserCore(username, { platform: deps.platform });
  if (resolution.kind === 'unavailable') {
    return { failure: { kind: 'unavailable', reason: resolution.reason, detail: resolution.detail } };
  }
  if (resolution.kind === 'local') return await loadLocalAccess(app, username, token, sourceName);
  const loaded = await loadRemoteAccess(resolution.coreUrl, username, token, deps.fetch ?? globalThis.fetch);
  if ('failure' in loaded) return loaded;
  return { access: loaded.access, location: { kind: 'remote', coreUrl: resolution.coreUrl } };
}

/**
 * Load the access behind `token` from THIS core, through the very loader
 * `GET /:username/access-info` runs, so expiry, revocation, sender
 * constraint (DPoP), session and the operator's custom auth step are all
 * applied exactly as they would be for a real API call.
 */
async function loadLocalAccess (
  app: AppLike, username: string, token: string, sourceName: string
): Promise<LoadResult> {
  // Named so an operator's custom auth step can tell this apart from a real
  // client request: it runs the same loader, but with no request headers of
  // its own, so a step that inspects headers would otherwise refuse every
  // annotated sign-in.
  const source = { name: sourceName, ip: null };
  let context;
  try {
    // Constructed inside the try: MethodContext parses the authorization
    // material in its constructor, and a token that is not a string throws
    // synchronously there. That is a malformed request, not a server fault.
    context = new MethodContext(
      source, username, token, app.getCustomAuthFunction(sourceName), {}, {}, null
    );
    await context.init();
    await context.retrieveExpandedAccess(app.storageLayer);
  } catch (err: unknown) {
    const id = (err as { id?: string })?.id;
    if (id != null && TOKEN_FAILURE_IDS.has(id)) return { failure: { kind: 'token-invalid' } };
    return { failure: { kind: 'unavailable', reason: 'storage-error', detail: (err as Error)?.message ?? String(err) } };
  }
  const access = context.access;
  const userId = context.user?.id;
  if (access == null || userId == null) return { failure: { kind: 'token-invalid' } };
  return {
    access: { id: access.id, type: access.type, permissions: access.permissions ?? null },
    location: { kind: 'local', userId }
  };
}

/**
 * Load the access from the core that hosts the user, over the same
 * `access-info` endpoint, which on that core runs the same loader.
 */
async function loadRemoteAccess (
  coreUrl: string, username: string, token: string, fetchFn: typeof globalThis.fetch
): Promise<{ access: LoadedAccess } | { failure: LoadFailure }> {
  const url = coreUrl + encodeURIComponent(username) + '/access-info';
  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
    });
  } catch (err: unknown) {
    return { failure: { kind: 'unavailable', reason: 'core-unreachable', detail: (err as Error)?.message ?? String(err) } };
  }
  // 401/403/404 are the token's verdict and belong to the page. A 404 is
  // ambiguous on its own, because a reverse proxy in front of the other
  // core answers the same way for a misrouted path, so when the body
  // carries an API error id we believe it rather than the status.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    if (response.status === 404 && !(await hasApiErrorId(response))) {
      return {
        failure: {
          kind: 'unavailable',
          reason: 'core-unreachable',
          detail: 'a 404 that carries no API error, so probably not this core answering'
        }
      };
    }
    return { failure: { kind: 'token-invalid' } };
  }
  if (!response.ok) {
    return { failure: { kind: 'unavailable', reason: 'core-unreachable', detail: 'access-info answered ' + response.status } };
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { failure: { kind: 'unavailable', reason: 'core-unreachable', detail: 'access-info answered a body that is not JSON' } };
  }
  // A 2xx whose body is not an access is not a verdict about the token: it
  // is a core answering something we cannot read, which is the operator's
  // problem, not the page's. Blaming the page here would make it delete a
  // possibly good access.
  if (typeof body?.id !== 'string' || typeof body?.type !== 'string') {
    return { failure: { kind: 'unavailable', reason: 'core-unreachable', detail: 'access-info answered 2xx without an id and type' } };
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

export { REMOTE_TIMEOUT_MS };
