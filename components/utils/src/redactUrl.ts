/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A request URL as it may be logged: credential-bearing query values (`auth`,
 * the only way an <img> tag or a plain link can send an access token, and the
 * one-time tokens of the reset / verification / MFA links) replaced by `***`.
 */
function redactUrl (url: string | undefined | null): string {
  if (url == null) return '';
  return url.replace(/([?&](?:auth|resetToken|verifyToken|mfaToken|token)=)[^&#]*/gi, '$1***');
}

export { redactUrl };
