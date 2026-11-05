/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2: the identity of a metadata-document client (a client whose
 * `client_id` is the https URL of a client metadata document).
 *
 * The URL is the client's id on the wire (request parameters in, `client_id`,
 * `azp`, audit rows and consent answers out). It cannot be the stored id: a
 * client id is a key of the platform store and the name of every session
 * (`oauth:<clientId>`), which refuses `/`, `:` and `_`. The row is stored under
 * a key derived from the URL: `url~` and the first 40 hexadecimal characters
 * of the SHA-256 of the URL exactly as the client presents it. The URL is
 * never normalised: two spellings are two clients, and the spellings that
 * invite confusion are refused (`clientIdUrlSyntaxProblem`).
 *
 * Pure module (no storage, no network): the client registry, the routes, the
 * operator CLI and the api-server glue import it.
 */

import crypto from 'node:crypto';
import { isIP } from 'node:net';

/** The prefix of every metadata-document client key; reserved (no other client id may start with it). */
export const METADATA_KEY_PREFIX = 'url~';

/** Bound on a metadata document URL. */
export const MAX_METADATA_URL_LENGTH = 2048;

/** The stored id (row key) of the client whose metadata document is at `url`. */
export function metadataClientKey (url: string): string {
  return METADATA_KEY_PREFIX + crypto.createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 40);
}

/** Whether a stored client id is a metadata-document client key. */
export function isMetadataClientKey (clientId: unknown): boolean {
  return typeof clientId === 'string' && clientId.startsWith(METADATA_KEY_PREFIX);
}

// Control and white-space characters, and the invisible / bidirectional
// formatting characters a URL shown to a user must not hide.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u0020\u007f-\u009f\u00a0\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Why `raw` cannot be a client metadata document URL, or null. Checked before
 * any network call, on the string as presented:
 * - an absolute `https:` URL of at most 2048 characters, without control or
 *   white-space characters;
 * - written exactly as the URL standard serialises it (so the host is
 *   lower-case and in its ASCII form, no default port is written, no dot
 *   segment is left, nothing is escaped by the parser): a string compared as
 *   is cannot then name the same document as another spelling;
 * - a host name, not an IP literal, without a trailing dot;
 * - no user information, no fragment;
 * - a path (a bare origin is refused), without empty segments (`//`) and
 *   without percent-encoded characters;
 * - a query is allowed (kept verbatim).
 */
export function clientIdUrlSyntaxProblem (raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'must be a non-empty string';
  if (raw.length > MAX_METADATA_URL_LENGTH) return `is longer than ${MAX_METADATA_URL_LENGTH} characters`;
  if (UNSAFE_CHARS_RE.test(raw)) return 'carries a control or white-space character';
  if (!raw.startsWith('https://')) return 'must be an https URL';
  let u: URL;
  try { u = new URL(raw); } catch { return 'is not a valid URL'; }
  if (u.protocol !== 'https:') return 'must be an https URL';
  if (u.username !== '' || u.password !== '') return 'must not carry user information';
  if (raw.includes('#')) return 'must not carry a fragment';
  const host = u.hostname;
  if (host.startsWith('[') || isIP(host) !== 0) return 'must name a host, not an IP address';
  if (host.endsWith('.')) return 'must not end its host with a dot';
  // The path as written: what follows the authority, up to the query.
  const afterScheme = raw.slice('https://'.length);
  const slash = afterScheme.search(/[/?]/);
  if (slash < 0 || afterScheme[slash] !== '/') return 'must contain a path (e.g. https://client.example/client.json)';
  const pathPart = afterScheme.slice(slash).split('?')[0];
  if (pathPart.includes('%')) return 'must not carry percent-encoded characters in its path';
  if (pathPart.includes('//')) return 'must not carry an empty path segment (//)';
  if (pathPart.split('/').some((s) => s === '.' || s === '..')) return 'must not carry a dot segment in its path';
  if (u.href !== raw) return 'must be written in its normal form (lower-case host, no default port, nothing the URL parser rewrites)';
  return null;
}

/** Whether `raw` is a client metadata document URL by its syntax (no host policy). */
export function isMetadataClientUrl (raw: unknown): raw is string {
  return clientIdUrlSyntaxProblem(raw) == null;
}

/** A `client_id` as presented, and the key of the row it names. */
export type ClientRef = { key: string; url: string | null };

/**
 * The row key a presented `client_id` names: the derived key for a client
 * metadata document URL, the value itself otherwise (an ordinary id; an
 * `http:` URL or a malformed one stays as it is and is then an unknown
 * client).
 */
export function clientRef (raw: string): ClientRef {
  if (isMetadataClientUrl(raw)) return { key: metadataClientKey(raw), url: raw };
  return { key: raw, url: null };
}

/** The row key for a presented id, or the id itself (see `clientRef`). */
export function clientKeyOf (raw: string): string {
  return clientRef(raw).key;
}

/** The id a client is known by on the wire: its metadata document URL, or its stored id. */
export function publicClientId (row: { clientId: string; metadataUrl?: string | undefined }): string {
  return typeof row.metadataUrl === 'string' && row.metadataUrl.length > 0 ? row.metadataUrl : row.clientId;
}

/** The fields of a client row the access stamp is built from. */
type StampSource = {
  origin?: string | undefined;
  metadataUrl?: string | undefined;
  clientName?: string | undefined;
  name?: string | Record<string, string> | undefined;
};

/** What an access minted for a metadata-document client carries in `clientData.oauth.client`. */
export type MetadataClientStamp = { name?: string; host: string; url: string };

/**
 * The display stamp of an access minted for a metadata-document client: the
 * document's `client_name` as a plain string (the first language of a
 * localized set), the document's host (ASCII form) and the client's URL; null
 * for any other client (curated rows are named from the operator's catalogue).
 */
export function metadataClientStamp (row: StampSource | null | undefined): MetadataClientStamp | null {
  if (row?.origin !== 'metadata-document' || typeof row.metadataUrl !== 'string') return null;
  let host: string;
  try { host = new URL(row.metadataUrl).hostname; } catch { return null; }
  let name: string | undefined;
  if (typeof row.clientName === 'string' && row.clientName.length > 0) {
    name = row.clientName;
  } else if (typeof row.name === 'string' && row.name.length > 0) {
    name = row.name;
  } else if (row.name != null && typeof row.name === 'object') {
    const first = Object.values(row.name).find((v) => typeof v === 'string' && v.length > 0);
    if (first != null) name = first;
  }
  return { ...(name != null ? { name } : {}), host, url: row.metadataUrl };
}
