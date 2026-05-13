/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Plan 68 — CMC slug helpers.
 *
 *   counterpartySlug = <username> '--' <host-slug>
 *   host-slug        = <host with '.' replaced by '-'>
 *   collectorSlug    = <counterpartySlug> '--' <app-slug>
 *   app-slug         = lowercase <appId> with '.' and '/' replaced by '-'
 *
 * The load-bearing separator is `--`. Usernames and host-slugs use single
 * hyphens; the double-hyphen is reserved as the delimiter. See
 * _plans/68-cmc-datastore-atwork/IMPLEMENTERS-GUIDE.md "Reference — Slug
 * conventions" for examples and stability notes.
 */

const SEPARATOR = '--';

// Pryv stream-ids are reasonably restrictive; mirror Pryv's existing
// validation rule: lowercase letters, digits, and `-` only. We additionally
// allow `:` in stream-ids elsewhere, but a slug never contains `:`.
const SLUG_PIECE_RE = /^[a-z0-9-]+$/;

function assertNonEmpty (label: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('cmc-slug: ' + label + ' must be a non-empty string');
  }
  return value;
}

function slugifyHost (host: string): string {
  assertNonEmpty('host', host);
  return host.toLowerCase().replace(/\./g, '-');
}

function unslugifyHostHint (hostSlug: string): string {
  // NOTE: lossy — we can't tell whether `my-host-example-org` came from
  // `my-host.example.org` or `my.host.example.org`. Callers needing the
  // original host should store it alongside the slug. Use this only as
  // a display fallback.
  return hostSlug.replace(/-/g, '.');
}

function slugifyAppId (appId: string): string {
  assertNonEmpty('appId', appId);
  // Lowercase + replace dots and slashes with single hyphens. Collapse
  // any resulting `--` because `--` is the delimiter.
  return appId
    .toLowerCase()
    .replace(/[./]/g, '-')
    .replace(/--+/g, '-');
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

function collectorSlug (params: { username: string; host: string; appId: string }): string {
  const base = counterpartySlug({ username: params.username, host: params.host });
  const appSlug = slugifyAppId(params.appId);
  assertSlugPiece('app-slug', appSlug);
  return base + SEPARATOR + appSlug;
}

/**
 * Split a slug by `--` separator. Returns the array of pieces (2 for
 * counterparty, 3 for collector). Throws if the slug shape is invalid.
 */
function splitSlug (slug: string): string[] {
  assertNonEmpty('slug', slug);
  const pieces = slug.split(SEPARATOR);
  for (const piece of pieces) {
    assertSlugPiece('slug piece', piece);
  }
  return pieces;
}

function parseCounterpartySlug (slug: string): { username: string; hostSlug: string } {
  const pieces = splitSlug(slug);
  if (pieces.length !== 2) {
    throw new Error(
      'cmc-slug: counterparty slug "' + slug + '" must have exactly 2 ' +
      'double-hyphen-separated pieces, got ' + pieces.length
    );
  }
  return { username: pieces[0], hostSlug: pieces[1] };
}

function parseCollectorSlug (slug: string): {
  username: string;
  hostSlug: string;
  appSlug: string;
} {
  const pieces = splitSlug(slug);
  if (pieces.length !== 3) {
    throw new Error(
      'cmc-slug: collector slug "' + slug + '" must have exactly 3 ' +
      'double-hyphen-separated pieces, got ' + pieces.length
    );
  }
  return { username: pieces[0], hostSlug: pieces[1], appSlug: pieces[2] };
}

export {
  SEPARATOR,
  slugifyHost,
  unslugifyHostHint,
  slugifyAppId,
  counterpartySlug,
  collectorSlug,
  parseCounterpartySlug,
  parseCollectorSlug,
};
