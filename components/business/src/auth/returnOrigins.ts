/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The `returnURL` of an access request (`POST /reg/access`): the address the
 * auth page sends the user back to once the request is decided.
 *
 * Two checks, both at creation (the stored value can never be changed later):
 *
 * - Shape, always: a return address is absent (`undefined`, `null`, `false`,
 *   `""` or `"false"`: poll-only mode), or a string that parses as a URL, with
 *   no control character, no `user:password@` part, and a scheme other than
 *   `javascript:`, `data:`, `vbscript:` or `blob:`.
 * - Origin, when the operator sets `access.returnOrigins`: same grammar as
 *   `auth.trustedApps` (`<appId>@<origin pattern>`, comma separated). An app
 *   id is bound when an entry names it or a `*@...` entry exists; a bound
 *   app's return address must be on one of the origins that apply to it.
 *   An unbound app is not restricted. This is redirect hygiene: whoever
 *   creates a request can still read its outcome by polling, whatever the
 *   return address; binding a client to its redirect is what OAuth2 gives.
 */

import { parseTrustedApps, isTrustedApp } from './trustedApps.ts';

const ABSENT = new Set<unknown>([undefined, null, false, '', 'false']);
// `file:` is not refused: an http(s) auth page cannot navigate to it, and
// lib-js sends the page URL of a hybrid app served from `file://`.
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WITH_AUTHORITY_RE = /^\s*https?:[\\/]{2}/i;

/**
 * `null` when `returnURL` is acceptable for `appId`, else the refusal message
 * (it never echoes the value nor lists the registered origins).
 */
export function checkReturnURL (setting: unknown, appId: unknown, returnURL: unknown): string | null {
  if (ABSENT.has(returnURL)) return null;
  if (typeof returnURL !== 'string') return 'returnURL must be a string';
  // The URL parser silently drops tabs and newlines: refuse them rather than
  // match a value the browser would read differently.
  if (CONTROL_RE.test(returnURL)) return 'returnURL is not a valid URL';
  let url: URL;
  try {
    url = new URL(returnURL);
  } catch (e) {
    return 'returnURL is not a valid URL';
  }
  if (url.username !== '' || url.password !== '') return 'returnURL is not a valid URL';
  // `https:host/x` parses here with that host, but a page assigning it to
  // `location.href` resolves it against its own origin: require the `//`.
  if ((url.protocol === 'https:' || url.protocol === 'http:') && !WITH_AUTHORITY_RE.test(returnURL)) {
    return 'returnURL is not a valid URL';
  }
  if (REFUSED_SCHEMES.has(url.protocol)) return 'returnURL uses a scheme that is not allowed';

  if (typeof setting !== 'string' || setting.trim() === '') return null;
  const { apps, errors } = parseTrustedApps(setting);
  // An invalid entry (refused at boot) would leave its app unbound: fail
  // closed instead, every app is then bound to the valid entries only.
  const bound = errors.length > 0 || apps.some((app) => app.appId === '*' || app.appId === appId);
  if (!bound) return null;
  if (isTrustedApp(apps, appId, returnURL)) return null;
  return 'returnURL is not on an origin registered for this app (access:returnOrigins)';
}
