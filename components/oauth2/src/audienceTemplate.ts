/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the syntax of a per-user audience.
 *
 * A registered audience whose host starts with the literal label `{username}`
 * (`https://{username}.example.com/adapter/calendar/api`) names every
 * account's own address. The registry and the metadata-document template
 * check it here, then with their usual URL rules on a probe (the entry with
 * a label in place of the placeholder); the matching lives in
 * resourceIndicator.ts, the binding to the signed-in account in
 * audienceAccount.ts.
 */

/** The placeholder of a per-user audience, the marker `service:api` uses too. */
export const USERNAME_PLACEHOLDER = '{username}';

/** What a per-user audience starts with: the placeholder is the first host label. */
export const TEMPLATE_PREFIX = 'https://' + USERNAME_PLACEHOLDER + '.';

/** Stands for the placeholder while a per-user audience is checked as a URL. */
export const PROBE_LABEL = 'a1b2c';

/**
 * Upper bound on a per-user audience, in bytes: the resource cap (512, see
 * resourceIndicator.ts) less 50, so an account name (at most 60 characters)
 * in place of the placeholder (10) keeps every address it names within it.
 */
export const MAX_TEMPLATE_BYTES = 462;

/** Whether a registered audience is a per-user one (it holds the placeholder). */
export function isAudienceTemplate (entry: unknown): entry is string {
  return typeof entry === 'string' && entry.includes(USERNAME_PLACEHOLDER);
}

/**
 * A registered audience made checkable as a URL: the entry itself, or for a
 * per-user audience the entry with the probe label in place of the
 * placeholder, which the caller then checks with its usual URL rules. A
 * per-user audience of another form is a problem naming the accepted one:
 * exactly one placeholder, as the first host label, at least one label after
 * it, visible ASCII, no user information, at most `MAX_TEMPLATE_BYTES` bytes.
 */
export function audienceProbe (entry: string): { probe: string } | { problem: string } {
  if (!isAudienceTemplate(entry)) return { probe: entry };
  const problem = {
    problem: `"${entry}" is not a valid per-user audience: the accepted form is ` +
      `https://{username}.<host>[:port][/path][?query], one {username} as the first host label, at most ${MAX_TEMPLATE_BYTES} bytes`,
  };
  if (Buffer.byteLength(entry, 'utf8') > MAX_TEMPLATE_BYTES) return problem;
  if (!entry.startsWith(TEMPLATE_PREFIX) || entry.indexOf(USERNAME_PLACEHOLDER) !== entry.lastIndexOf(USERNAME_PLACEHOLDER)) {
    return problem;
  }
  const rest = entry.slice(TEMPLATE_PREFIX.length);
  if (!/^[\x21-\x7e]+$/.test(rest) || rest.includes('\\')) return problem;
  const authority = rest.split(/[/?#]/, 1)[0];
  // No percent-escape and no explicit default port: the URL parser would
  // normalise them in the probe, while values are compared as written.
  if (authority === '' || authority.includes('@') || authority.includes('%') || /^[.:]/.test(authority) || /:443$/.test(authority)) {
    return problem;
  }
  const probe = entry.replace(USERNAME_PLACEHOLDER, PROBE_LABEL);
  let u: URL;
  try { u = new URL(probe); } catch { return problem; }
  if (!u.hostname.startsWith(PROBE_LABEL + '.') || u.hostname.length <= PROBE_LABEL.length + 1) return problem;
  return { probe };
}
