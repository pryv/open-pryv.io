/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Credential hand-off for the auth-request accept (server conversion).
 *
 * When a request asked for `credentialHandoff: 'shared-secret'` and the auth
 * page posted the token inline (shape L), the accept converts it: instead of
 * keeping the token for the poll to return, it stashes { username, token,
 * apiEndpoint } in a one-time shared secret on the USER's core and keeps only
 * the retrieval key. The token then rests only on the user's core, guarded by
 * the hash of the key's random half, until the app retrieves it exactly once;
 * the entry core holds it for the life of the POST handler only.
 *
 * The secret is created authenticated AS THE APP TOKEN (the precedent is the
 * one-time SSO hand-off in routes/sso.ts), on the user's core (resolved by the
 * platform, never the posted apiEndpoint, userCore.ts).
 *
 * A hand-off that cannot be created NEVER breaks sign-in: the accept falls
 * back to inline delivery and the caller logs one warn line, never the token.
 * The reasons that fall back: shared secrets disabled on the user's core
 * (`unavailableMethod`), the access forbidden from creating them
 * (`shared-secret-forbidden`), the core unreachable, a delegation-derived
 * grant (ruling § of the plan: such a token may not create the hand-off
 * secret), or an unparseable apiEndpoint.
 */

import { getLogger } from '@pryv/boiler';
import { MethodContext } from 'business';
import * as delegation from 'delegation';
import { resolveUserCore, type UserCorePlatform } from './userCore.ts';
import type { AppLike } from '../_types.ts';

const logger = getLogger('routes:reg:credentialHandoff');

/** How long we wait on another core before giving up and falling back. */
const REMOTE_TIMEOUT_MS = 3000;

/** The one-time secret's contents: exactly the legacy ACCEPTED body, so the
 * app's post-retrieve code is byte-identical whether it retrieved or read the
 * token inline. `apiEndpoint` here is the TOKEN-BEARING one the page posted. */
type HandoffSecret = { username: string; token: string; apiEndpoint: string };

export type CreateHandoffParams = {
  app: AppLike;
  username: string;
  /** The app's access token the page posted (shape L). */
  token: string;
  /** The token-BEARING apiEndpoint the page posted; carried verbatim in the
   * secret. The token-LESS form is derived here for the poll body. */
  apiEndpoint: string;
  requestingAppId: string;
  /** Seconds; already clamped by the caller to the request's remaining life.
   * The create additionally caps it at `sharedSecrets:maxTtl`. */
  ttlSeconds: number;
  /** Seam for the remote arm, so a test asserts WHICH url is called. */
  fetch?: typeof globalThis.fetch;
  /** Seam for the platform resolution, same purpose. */
  platform?: UserCorePlatform;
};

export type HandoffResult =
  | { handoff: { type: 'shared-secret'; key: string }; apiEndpoint: string }
  | { fallback: string };

/** Promisify the internal method dispatch (the routes/sso.ts pattern). */
function callMethod (app: AppLike, context: unknown, params: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    app.api.call(context, params, (err: unknown, result: unknown) => {
      if (err != null) return reject(err);
      resolve((result ?? {}) as Record<string, unknown>);
    });
  });
}

/**
 * Strip the credential from a posted apiEndpoint: the token rides either in
 * the URL's userinfo (`https://<token>@host/...`) or as an `auth` query
 * parameter. Returns null when the endpoint does not parse, which the caller
 * treats as a fallback (never a silent token leak into the poll body).
 */
function tokenlessEndpoint (apiEndpoint: unknown): string | null {
  if (typeof apiEndpoint !== 'string' || apiEndpoint === '') return null;
  try {
    const url = new URL(apiEndpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.searchParams.delete('auth');
    return url.toString();
  } catch {
    return null;
  }
}

/** The id class of a create failure, for the warn line (never the token). */
function failureReason (err: unknown): string {
  const id = (err as { data?: { id?: unknown }, id?: unknown })?.data?.id ?? (err as { id?: unknown })?.id;
  if (typeof id === 'string') return id;
  return 'create-failed';
}

/**
 * Create the one-time hand-off secret and return the poll descriptor, or a
 * fallback reason. Never throws: every failure is an inline fallback.
 */
export async function createHandoff (params: CreateHandoffParams): Promise<HandoffResult> {
  const { app, username, token, requestingAppId, ttlSeconds } = params;
  const fetchFn = params.fetch ?? globalThis.fetch;

  const pollApiEndpoint = tokenlessEndpoint(params.apiEndpoint);
  if (pollApiEndpoint == null) return { fallback: 'unparseable-apiEndpoint' };

  const secret: HandoffSecret = { username, token, apiEndpoint: params.apiEndpoint };
  const createParams = {
    title: 'access-handoff:' + requestingAppId,
    ttl: ttlSeconds,
    onConsumed: { message: 'The credential for this access request was already retrieved.' },
    secret
  };

  const resolution = await resolveUserCore(username, { platform: params.platform });
  if (resolution.kind === 'unavailable') return { fallback: resolution.reason };

  try {
    let key: unknown;
    if (resolution.kind === 'local') {
      // Authenticate AS the app token, in-process, exactly as sso.ts stashes
      // its login token. A delegation-derived token may not create the
      // hand-off secret (plan ruling § 13): fall back to inline instead.
      const context = new MethodContext(
        { name: 'credential-handoff', ip: null }, username, token, null, {}, {}, null
      );
      await context.init();
      await context.retrieveExpandedAccess(app.storageLayer);
      if (delegation.isDelegationDerivedAccess(context.access)) {
        return { fallback: 'delegation-derived' };
      }
      context.methodId = 'sharedSecrets.create';
      const result = await callMethod(app, context, createParams);
      key = (result.sharedSecret as { key?: unknown } | undefined)?.key;
    } else {
      // Remote user core: create over HTTPS with the app token. The target is
      // the platform-resolved core, never the posted apiEndpoint host.
      const url = resolution.coreUrl + encodeURIComponent(username) + '/shared-secrets';
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(createParams),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
      });
      if (!response.ok) {
        let id = 'create-failed';
        try {
          const body = await response.json() as { error?: { id?: unknown } };
          if (typeof body?.error?.id === 'string') id = body.error.id;
        } catch { /* keep the generic reason */ }
        return { fallback: id };
      }
      const body = await response.json() as { sharedSecret?: { key?: unknown } };
      key = body?.sharedSecret?.key;
    }

    if (typeof key !== 'string' || key === '') return { fallback: 'no-key' };
    return { handoff: { type: 'shared-secret', key }, apiEndpoint: pollApiEndpoint };
  } catch (err: unknown) {
    return { fallback: failureReason(err) };
  }
}

/** A hand-off key posted by the auth UI (shape H): `<eventId>.<randomPart>`
 * per the shared-secrets key grammar. Validated with the same parser the
 * retrieve uses, so the two can never disagree. Returns the clean descriptor
 * or an error message. */
export function parseHandoffField (value: unknown, keyParse: (k: unknown) => unknown): { type: 'shared-secret'; key: string } | string {
  const message = "handoff must be { type: 'shared-secret', key }";
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return message;
  const hint = value as Record<string, unknown>;
  if (Object.keys(hint).some((k) => k !== 'type' && k !== 'key')) return message;
  if (hint.type !== 'shared-secret') return "handoff.type must be 'shared-secret'";
  if (typeof hint.key !== 'string' || keyParse(hint.key) == null) return 'handoff.key is not a valid shared-secret key';
  return { type: 'shared-secret', key: hint.key };
}

/** For shape H: the posted apiEndpoint must be a plain https?:// URL with no
 * embedded credentials (the UI already stripped the token). Returns an error
 * message or null. */
export function tokenlessEndpointError (apiEndpoint: unknown): string | null {
  if (typeof apiEndpoint !== 'string' || apiEndpoint === '') return 'apiEndpoint is required';
  let url: URL;
  try { url = new URL(apiEndpoint); } catch { return 'apiEndpoint must be a valid URL'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'apiEndpoint must be http(s)';
  if (url.username !== '' || url.password !== '') return 'apiEndpoint must not carry credentials';
  return null;
}
