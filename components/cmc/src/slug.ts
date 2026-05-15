/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin — counterparty slug helpers.
 *
 *   counterpartySlug = <username> '--' <host-slug>
 *   host-slug        = <host with '.' replaced by '-'>
 *
 * The load-bearing separator is `--`. Usernames and host-slugs use single
 * hyphens; the double-hyphen is reserved as the delimiter so the slug
 * round-trips deterministically.
 *
 * No collector slug — the app-code and request scope live in the stream
 * PATH (`:_cmc:apps:<app-code>:<...>:chats:<counterparty-slug>` etc.),
 * not in the slug. This is what enables app-level and per-request-scoped
 * access permissions via natural prefix matching. See README.md.
 */

const SEPARATOR = '--';
const SLUG_PIECE_RE = /^[a-z0-9-]+$/;

function assertNonEmpty (label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('cmc-slug: ' + label + ' must be a non-empty string');
  }
  return value;
}

function slugifyHost (host: string): string {
  assertNonEmpty('host', host);
  // Strip trailing port (`:3000`) — port doesn't affect cross-account
  // identity. Two users on the same hostname are the same platform
  // regardless of which port their api endpoint listens on.
  const hostNoPort = host.replace(/:\d+$/, '');
  return hostNoPort.toLowerCase().replace(/\./g, '-');
}

function unslugifyHostHint (hostSlug: string): string {
  // NOTE: lossy — we can't tell whether `my-host-example-org` came from
  // `my-host.example.org` or `my.host.example.org`. Callers needing the
  // original host should store it alongside the slug. Use this only as
  // a display fallback.
  return hostSlug.replace(/-/g, '.');
}

function assertSlugPiece (label: string, value: string): void {
  if (!SLUG_PIECE_RE.test(value)) {
    throw new Error(
      'cmc-slug: ' + label + ' "' + value + '" must match ' + SLUG_PIECE_RE.toString()
    );
  }
  if (value.includes(SEPARATOR)) {
    throw new Error(
      'cmc-slug: ' + label + ' "' + value + '" must not contain the double-hyphen separator'
    );
  }
}

function counterpartySlug (params: { username: string; host: string }): string {
  const username = assertNonEmpty('username', params.username).toLowerCase();
  assertSlugPiece('username', username);
  const hostSlug = slugifyHost(params.host);
  assertSlugPiece('host-slug', hostSlug);
  return username + SEPARATOR + hostSlug;
}

function parseCounterpartySlug (slug: string): { username: string; hostSlug: string } {
  assertNonEmpty('slug', slug);
  const pieces = slug.split(SEPARATOR);
  if (pieces.length !== 2) {
    throw new Error(
      'cmc-slug: counterparty slug "' + slug + '" must have exactly 2 ' +
      'double-hyphen-separated pieces, got ' + pieces.length
    );
  }
  for (const piece of pieces) {
    assertSlugPiece('slug piece', piece);
  }
  return { username: pieces[0], hostSlug: pieces[1] };
}

export {
  SEPARATOR,
  slugifyHost,
  unslugifyHostHint,
  counterpartySlug,
  parseCounterpartySlug,
};
