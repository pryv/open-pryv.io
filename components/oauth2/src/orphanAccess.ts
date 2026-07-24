/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — revoke an orphaned pre-minted access.
 *
 * An access is minted at `/oauth2/accept` and its credentials ride on the
 * authorization-code row until the `/token` exchange returns them. If that
 * exchange never happens — the code is abandoned, or it fails AFTER being
 * consumed (PKCE mismatch, DPoP binding failure, …) — the pre-minted access
 * is an orphan: alive until its own (short) TTL, but never delivered to any
 * client. This helper deletes such an orphan proactively via an HTTP
 * `accesses.delete` of the access's own id, authenticated by the access's own
 * token (Pryv "selfRevoke" — an access can delete itself from anywhere).
 *
 * The durable data-grant behind granular (cmc) consent is a SEPARATE access
 * and is intentionally NOT touched here — only the ephemeral session access.
 *
 * Best-effort by contract: NEVER throws. On any failure it records one line on
 * the server trail and returns false; the access then dies by its own TTL. A
 * 2xx delete, or an "already gone" answer (the token/id no longer resolves),
 * counts as success and returns true.
 */

import { logServerError } from './serverLog.ts';

/** How long to wait for the delete before giving up (best-effort). */
const REVOKE_TIMEOUT_MS = 5000;

/**
 * Strip any embedded credentials from a Pryv apiEndpoint and return a base URL
 * suitable for path-appending. Pryv apiEndpoints put the access token in the
 * URL authority (`https://<token>@host/path/`); we authenticate with the
 * explicit `accessToken` header instead, so the token in the URL is dropped.
 * A trailing slash is preserved so `base + 'accesses/<id>'` composes cleanly.
 */
function endpointBase (apiEndpoint: string): string {
  const url = new URL(apiEndpoint);
  url.username = '';
  url.password = '';
  let base = url.toString();
  if (!base.endsWith('/')) base += '/';
  return base;
}

/**
 * Delete the orphaned pre-minted access. Returns true on success (the access
 * is gone or was already gone), false on any failure (logged, never thrown).
 *
 * @param params.apiEndpoint - home-core apiEndpoint the access lives on
 *   (provisioned server-side at accept time — a trusted value, not client
 *   input). May embed a token; it is stripped.
 * @param params.accessToken - the access's own token (the Authorization value).
 * @param params.accessId - the access's own id (the resource to delete).
 */
export async function revokeOrphanAccess (params: {
  apiEndpoint: string;
  accessToken: string;
  accessId: string;
}): Promise<boolean> {
  const { apiEndpoint, accessToken, accessId } = params;
  if (typeof apiEndpoint !== 'string' || apiEndpoint.length === 0 ||
      typeof accessToken !== 'string' || accessToken.length === 0 ||
      typeof accessId !== 'string' || accessId.length === 0) {
    // NB do not log `params` here — it can carry a live access token.
    logServerError('revokeOrphanAccess: missing ' + [
      apiEndpoint ? null : 'apiEndpoint',
      accessToken ? null : 'accessToken',
      accessId ? null : 'accessId'
    ].filter(Boolean).join('+'), null);
    return false;
  }

  let url: string;
  try {
    url = endpointBase(apiEndpoint) + 'accesses/' + encodeURIComponent(accessId);
  } catch (err) {
    logServerError('revokeOrphanAccess: malformed apiEndpoint', err);
    return false;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller != null
    ? setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
    : undefined;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: accessToken },
      signal: controller?.signal,
    });
    if (timer != null) clearTimeout(timer);

    // 2xx: deleted. 404: the access id no longer resolves. 401: the token no
    // longer resolves (a self-authenticated delete of an access that is already
    // gone fails auth first). All three mean the orphan can no longer be used —
    // the goal — so all count as success.
    if ((res.status >= 200 && res.status < 300) || res.status === 401 || res.status === 404) {
      return true;
    }
    logServerError('revokeOrphanAccess: unexpected status ' + res.status + ' revoking access ' + accessId, null);
    return false;
  } catch (err) {
    if (timer != null) clearTimeout(timer);
    logServerError('revokeOrphanAccess: request failed revoking access ' + accessId, err);
    return false;
  }
}
