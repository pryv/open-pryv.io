/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A request URL as it may be logged, with credentials replaced by `***`:
 * - query values: `auth` (the only way an <img> tag or a plain link can send an
 *   access token), `readToken` (attachment links), the one-time tokens of the
 *   reset / verification / MFA links, and `key` / `poll` (the access-request
 *   key and its poll URL, as the auth page receives them);
 * - the access-request key in the poll path (`/reg/access/<key>`, or
 *   `/access/<key>` behind the register host): the key alone fetches the
 *   granted token.
 */
function redactUrl (url: string | undefined | null): string {
  if (url == null) return '';
  const queryAt = url.search(/[?#]/);
  const path = queryAt < 0 ? url : url.slice(0, queryAt);
  const rest = queryAt < 0 ? '' : url.slice(queryAt);
  const shownPath = path.replace(/(\/access\/)(?!invitationtoken(?:\/|$))[^/]+/i, '$1***');
  return shownPath + rest.replace(/([?&](?:auth|readToken|resetToken|verifyToken|mfaToken|token|key|poll)=)[^&#]*/gi, '$1***');
}

export { redactUrl };
