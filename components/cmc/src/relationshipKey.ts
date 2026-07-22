/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger, CmcAccessLike as AccessLike } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — which relationship does this event belong to?
 *
 * A relationship is a single request/accept pair between two accounts. Two
 * accounts can hold SEVERAL relationships at once (a patient consenting to
 * two separate studies run by one collector, say), and each has its own
 * chat / collector streams and its own data-grant.
 *
 * The identifier that names one relationship — on BOTH accounts — is the
 * requester's per-request scope stream, e.g. `:_cmc:apps:my-app:study-a`.
 * The accepter anchors under the offer's originStreamId and the requester
 * under the accept's requesterOriginStreamId; both are that same value, and
 * every channel between them is `<scope>:chats|collectors:<peer-slug>`.
 *
 * `appCode` is NOT such an identifier: it is the app scope
 * (`:_cmc:apps:my-app`), so every relationship of that app shares it.
 * Selecting on it means two relationships with one peer under one app are
 * indistinguishable — the newest wins and older ones are misrouted.
 *
 * Both the inbound side (stamping a back-channel onto a grant) and the
 * outbound side (resolving where to deliver a chat / alert / revoke) route
 * through `selectRelationshipAccess` here. That is deliberate: the two
 * halves ran separate first-match scans before, and they agreed only
 * because they were wrong in the same direction. Correcting one alone
 * desynchronises them and is worse than the original defect. Sharing one
 * selector makes divergence structurally impossible rather than a thing to
 * remember.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');

// `<scope>:chats:<slug>` / `<scope>:collectors:<slug>` — captures the scope.
const CHANNEL_STREAM_RE = /^(:_cmc:apps:[^:]+(?::[^:]+)*):(?:chats|collectors):[a-z0-9-]+--[a-z0-9-]+$/;

function scopeOfChannelStream (streamId: unknown): string | null {
  if (typeof streamId !== 'string') return null;
  const m = streamId.match(CHANNEL_STREAM_RE);
  return m == null ? null : m[1];
}

/**
 * The scope stream an access serves LOCALLY, or null when it cannot be
 * determined.
 *
 * Only two sources are trusted, and both describe this account's own side:
 *   1. the stamped field — authoritative once present;
 *   2. the access's OWN channel permissions — immutable truth about which
 *      streams this grant may write, hence which relationship it serves.
 *
 * `counterparty.remoteChat/CollectorStreamId` is deliberately NOT used.
 * Those name streams on the PEER's account, in the peer's own scope; they
 * happen to coincide today because both sides anchor under the requester's
 * scope, but they are the peer's routing target rather than a statement
 * about where this access lives — and they are also the field the
 * mis-targeting defect overwrites, so a grant corrupted by an older build
 * would otherwise report a scope belonging to someone else's relationship.
 *
 * Returning null is safe: the caller falls back to the legacy behaviour for
 * such accesses, which is exactly what they got before.
 */
function scopeOfAccess (acc: AccessLike | null | undefined): string | null {
  const cmc = acc?.clientData?.cmc;
  if (cmc == null) return null;
  if (typeof cmc.scopeStreamId === 'string' && cmc.scopeStreamId.length > 0) {
    return cmc.scopeStreamId;
  }
  const permissions = acc?.permissions;
  if (Array.isArray(permissions)) {
    for (const p of permissions) {
      const scope = scopeOfChannelStream((p as { streamId?: unknown })?.streamId);
      if (scope != null) return scope;
    }
  }
  return null;
}

type SelectParams = {
  accesses: AccessLike[];
  role?: string;
  counterparty: { username: string; hostSlug: string };
  scopeStreamId?: string | null;
  appCode?: string | null;
  // Whether a differing appCode may ELIMINATE a candidate.
  //
  // true (default) for outbound resolution: the app-code came from our own
  // trigger stream-id, so a grant recording a different one genuinely serves
  // a different app and must not receive this delivery.
  //
  // false for an inbound back-channel: there the app-code was derived
  // independently by the PEER, which falls back to the literal 'unknown'
  // when it cannot resolve its own request scope. Divergence is normal, so
  // it may only order candidates — eliminating on it drops the handshake and
  // leaves the relationship permanently undeliverable.
  appCodeAuthoritative?: boolean;
  logger?: CmcLogger;
};

/**
 * Pick the access serving one relationship.
 *
 * Tier 1 — exact: a candidate whose scope equals the one we are resolving.
 * Tier 2 — legacy: only among candidates whose scope cannot be determined
 *   at all, fall back to the historical appCode-compatible first-match.
 *   Restricting tier 2 to scope-less candidates is what keeps a resolvable
 *   grant from being claimed by a different relationship's traffic; and
 *   because every grant minted by current code carries channel permissions,
 *   this tier only ever sees genuinely ancient accesses.
 *
 * appCode remains a disambiguator and never a rejector — the two sides
 * derive it independently and the sender falls back to the literal
 * 'unknown', so a mismatch must not eliminate the only candidate.
 */
function selectRelationshipAccess (params: SelectParams): AccessLike | null {
  const {
    accesses, role = 'counterparty', counterparty, scopeStreamId, appCode,
    appCodeAuthoritative = true, logger,
  } = params;
  if (!Array.isArray(accesses)) return null;

  const candidates: AccessLike[] = [];
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== role) continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== counterparty.username) continue;
    if (slugMod.slugifyHost(cp.host) !== counterparty.hostSlug) continue;
    candidates.push(acc);
  }
  if (candidates.length === 0) return null;

  const haveScope = typeof scopeStreamId === 'string' && scopeStreamId.length > 0;
  if (haveScope) {
    const exact = candidates.find((a) => scopeOfAccess(a) === scopeStreamId);
    if (exact != null) return exact;
  }

  const appCodeCompatible = (acc: AccessLike): boolean => {
    const own = acc.clientData?.cmc?.appCode;
    if (own == null) return true;
    if (typeof appCode !== 'string' || appCode.length === 0) return true;
    return own === appCode;
  };
  const scopeless = candidates.filter((a) => scopeOfAccess(a) == null);

  // Outbound (appCode is ours, from our own trigger stream): a scope we
  // supplied that matches no STAMPED grant means those grants serve other
  // relationships — only scope-less legacy grants are eligible, and an
  // appCode mismatch genuinely eliminates. With no scope to match on we
  // cannot distinguish, so fall back to the historic appCode-first-match
  // over everything.
  if (appCodeAuthoritative) {
    const pool = haveScope ? scopeless : candidates;
    const hit = pool.find(appCodeCompatible);
    if (hit == null && haveScope) {
      logger?.warn?.('cmc: no relationship access matches this scope; not delivering, ' +
        'since every stamped candidate serves a different relationship', {
        scopeStreamId,
        candidateScopes: candidates.map((a) => scopeOfAccess(a)),
      });
    }
    return hit ?? null;
  }

  // Inbound back-channel (appCode was derived independently by the peer and
  // may be the literal 'unknown'): NEVER drop the delivery — doing so leaves
  // the relationship permanently undeliverable. Prefer scope-less candidates,
  // but if the exact tier missed and every candidate is stamped (version
  // skew, where the two sides derived different scope strings), still take
  // one rather than dropping. appCode only orders; among equals prefer a
  // grant whose back-channel is still unset so a completed relationship is
  // never clobbered.
  const pool = scopeless.length > 0 ? scopeless : candidates;
  const compatible = pool.find(appCodeCompatible);
  if (compatible != null) return compatible;
  const chosen = pool.find((a) => a.clientData?.cmc?.backChannelApiEndpoint == null) ?? pool[0];
  logger?.warn?.('cmc: no candidate matches the delivered appCode; taking one anyway, ' +
    'since the two sides derive appCode independently and dropping the delivery would ' +
    'leave the relationship undeliverable', {
    appCode,
    scopeStreamId,
    candidateIds: pool.map((a) => a.id),
    chosen: chosen.id,
  });
  return chosen;
}

export {
  scopeOfAccess,
  scopeOfChannelStream,
  selectRelationshipAccess,
};
