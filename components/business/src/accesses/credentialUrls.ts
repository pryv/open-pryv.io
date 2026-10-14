/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Removal of the credentials a URL carries in its user part.
 *
 * In Pryv an API endpoint carries its token in the URL's user part
 * (`https://<token>@<host>/<user>/`), and such endpoints get stored in
 * places that are later read by callers who must not receive them: a consent
 * grant's `clientData` names the counterparty's endpoints, a lifecycle record
 * echoes an invite URL. These functions take the user part out and keep the
 * rest (scheme, host, path, query), which still says which endpoint is meant.
 *
 * The removal covers a string that is a URL, a URL inside a longer text (a
 * second one in a query or a fragment too), a URL percent-encoded in a query
 * value (`https%3A%2F%2F<token>%40<host>`), and the lenient spellings a URL
 * parser accepts for a whole string (`https:\\token@host`, `https:/token@host`).
 * Anything else is left as it is: an e-mail address, a bare token stored as a
 * plain value, a secret in a path or a query.
 */

// A URL's user part inside a text: scheme, "//", then everything up to the
// "@" of the authority. Bounded quantifiers keep a long hostile text linear
// (a user part longer than 512 characters inside a text is not recognised).
const EMBEDDED_USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@"'<>]{1,512}@/gi;
// The same, percent-encoded in a query value.
const ENCODED_USERINFO = /([a-z][a-z0-9+.-]{0,31}%3a%2f%2f)(?:(?!%40|%2f|%3f|%23)[^\s&"'<>]){1,512}%40/gi;

/**
 * `value` with the user part of every URL in it removed. A string that is a
 * URL with a user part (no whitespace) is rebuilt from the parsed URL, so a
 * spelling the parser accepts cannot keep the token; it comes back
 * normalised. Then every URL inside the result is handled too. A string
 * without a URL user part is returned unchanged.
 */
export function withoutUrlUserinfo (value: string): string {
  if (!value.includes('@') && !/%40/i.test(value)) return value;
  let out = value;
  // With whitespace it is a text, not one URL (the parser would percent-encode it).
  if (!/\s/.test(value)) {
    try {
      const url = new URL(value);
      if (url.username !== '' || url.password !== '') {
        url.username = '';
        url.password = '';
        out = url.toString();
      }
    } catch {
      // Not a URL as a whole: only the URLs inside it.
    }
  }
  return out.replace(EMBEDDED_USERINFO, '$1').replace(ENCODED_USERINFO, '$1');
}

// Deeper than this, a value is dropped rather than returned as stored: a
// credential nested that deep must not come through, and no genuine
// clientData is anywhere near it.
const MAX_DEPTH = 32;

/**
 * A copy of `value` with `withoutUrlUserinfo` applied to every string, in
 * objects and arrays at any depth (what the API returns as JSON). Never
 * mutates the input (which may be a cached storage row). An own key named
 * `__proto__` is kept as data.
 */
export function withoutCredentialUrls (value: unknown, depth: number = 0): unknown {
  if (typeof value === 'string') return withoutUrlUserinfo(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => withoutCredentialUrls(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k, withoutCredentialUrls(v, depth + 1)]));
}
