/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { stripCredentials } from './outbound.ts';

/**
 * CMC plugin — token removal from a record's content.
 *
 * A CMC lifecycle record usually lives in a stream the user's apps can read:
 * their own `:_cmc:apps:<app-code>`, or `:_cmc:inbox`, which apps poll by
 * design. An export of the account carries both. (The scrub also runs on an
 * accept landing in `:_cmc:_internal:responses:<capId>`, which is NOT
 * app-readable; scrubbing it anyway costs nothing and keeps one rule.) Three
 * of the fields these records hold
 * are apiEndpoint-shaped, which in Pryv means the token rides in the URL:
 *
 *   - `capabilityUrl`      the invite URL, posted by the app on the trigger.
 *   - `acceptedBy.apiEndpoint`  the data-grant endpoint, a credential to the
 *                          accepter's OWN data.
 *   - `apiEndpoint`        on a `consent/back-channel-cmc` delivered to the
 *                          inbox, the COUNTERPARTY's back-channel endpoint.
 *                          Top-level `apiEndpoint` belongs to that type alone
 *                          (see `validateBackChannel`); every other type nests
 *                          its endpoint, so scrubbing this key is unambiguous.
 *
 * None is read for its token. `dataGrantAccessId` names the access and
 * `content.from` names the counterparty; the back-channel endpoint is copied
 * onto the data-grant access's `clientData` by `handleIncomingBackChannel`
 * before the record is stamped, and THAT copy is the one everything uses. So
 * all three are stored with the token removed and the rest of the URL kept,
 * which still says which endpoint is meant.
 *
 * Two callers share this: the dispatch loop, on the trigger it has just
 * completed, and `bin/cmc-scrub-credentials.js`, on records written before
 * the loop did that. One definition of "what counts as a credential here"
 * keeps them from drifting apart.
 */

type Content = Record<string, unknown> | null | undefined;
// `acceptedBy` takes two shapes: `{ apiEndpoint }` on the accepter's trigger
// (the one that held a credential) and `{ username, host }` on the requester's
// invite. Only `apiEndpoint` is touched; the others are named so the object is
// not an open bag. A spread preserves any further runtime key regardless.
type AcceptedBy = { apiEndpoint?: unknown; username?: unknown; host?: unknown };

/** The token-bearing URLs a CMC record's content may carry. */
function credentialUrlsIn (content: Content): string[] {
  if (content == null || typeof content !== 'object') return [];
  const urls: string[] = [];
  if (typeof content.capabilityUrl === 'string') urls.push(content.capabilityUrl);
  if (typeof content.apiEndpoint === 'string') urls.push(content.apiEndpoint);
  const acceptedBy = content.acceptedBy as AcceptedBy | undefined;
  if (acceptedBy != null && typeof acceptedBy === 'object' &&
      typeof acceptedBy.apiEndpoint === 'string') {
    urls.push(acceptedBy.apiEndpoint);
  }
  return urls;
}

/**
 * True when this content still holds a URL carrying a token. A Pryv
 * apiEndpoint puts the token in the URL's userinfo, so that is what is
 * looked for; a string that does not parse as a URL has nothing to strip.
 */
function hasCredential (content: Content): boolean {
  for (const url of credentialUrlsIn(content)) {
    try {
      const u = new URL(url);
      if (u.username !== '' || u.password !== '') return true;
    } catch (_e) { /* not a URL */ }
  }
  return false;
}

/**
 * The content with every token removed, or `null` when there was nothing to
 * remove — so a caller writing to storage can skip the write entirely rather
 * than rewrite a row identically.
 *
 * Returns a new object; the input is not mutated.
 */
function scrubCredentials (content: Content): Record<string, unknown> | null {
  if (!hasCredential(content)) return null;
  const cleaned: Record<string, unknown> = { ...(content as Record<string, unknown>) };
  if (typeof cleaned.capabilityUrl === 'string') {
    cleaned.capabilityUrl = stripCredentials(cleaned.capabilityUrl);
  }
  if (typeof cleaned.apiEndpoint === 'string') {
    cleaned.apiEndpoint = stripCredentials(cleaned.apiEndpoint);
  }
  const acceptedBy = cleaned.acceptedBy as AcceptedBy | undefined;
  if (acceptedBy != null && typeof acceptedBy === 'object' &&
      typeof acceptedBy.apiEndpoint === 'string') {
    cleaned.acceptedBy = {
      ...acceptedBy,
      apiEndpoint: stripCredentials(acceptedBy.apiEndpoint),
    };
  }
  return cleaned;
}

/**
 * The token-bearing keys a CLIENT or a PEER can put on a record it writes.
 *
 * `acceptedBy.apiEndpoint` is deliberately absent: only `markCompleted` writes
 * it, already stripped, so it never needs stashing.
 */
type CredentialStash = { capabilityUrl?: string; apiEndpoint?: string };

/**
 * Split content into the copy to PERSIST (no tokens) and the originals.
 * Returns `null` when there was nothing to take, so a caller can pass the
 * content through untouched.
 *
 * This is the pre-persist half of the pair: the record is stored without the
 * credential from its very first write, rather than stored as sent and
 * rewritten afterwards. `restoreCredentials` puts the originals back on the
 * in-memory copy the orchestration works from.
 */
function takeCredentials (content: Content): { content: Record<string, unknown>; stash: CredentialStash } | null {
  const cleaned = scrubCredentials(content);
  if (cleaned == null) return null;
  const source = content as Record<string, unknown>;
  const stash: CredentialStash = {};
  if (typeof source.capabilityUrl === 'string') stash.capabilityUrl = source.capabilityUrl;
  if (typeof source.apiEndpoint === 'string') stash.apiEndpoint = source.apiEndpoint;
  return { content: cleaned, stash };
}

/**
 * The content with the stashed originals put back. A new object; the stashed
 * values win. With no stash this is the content unchanged, which is what a
 * caller outside the write path (a unit test, a retry re-dispatch) gets.
 */
function restoreCredentials (content: Content, stash?: CredentialStash): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(content as Record<string, unknown> | null ?? {}) };
  if (stash == null) return base;
  if (typeof stash.capabilityUrl === 'string') base.capabilityUrl = stash.capabilityUrl;
  if (typeof stash.apiEndpoint === 'string') base.apiEndpoint = stash.apiEndpoint;
  return base;
}

export {
  hasCredential,
  scrubCredentials,
  takeCredentials,
  restoreCredentials,
};
export type { CredentialStash };
