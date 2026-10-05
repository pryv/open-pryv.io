/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * A request URL as it may be logged: the `auth` query value (an access token;
 * the only way an <img> tag or a plain link can send one) replaced by `***`.
 */
function redactUrl (url: string | undefined | null): string {
  if (url == null) return '';
  return url.replace(/([?&]auth=)[^&#]*/g, '$1***');
}

export { redactUrl };
