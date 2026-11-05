/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — audit-event emission helper.
 *
 * Thin wrapper around components/audit/'s public singleton so every OAuth
 * grant + consent + revoke path emits structured audit rows without each
 * caller knowing the audit-DB API. All token-issuance + consent + revoke
 * events are audited; operator CLI operations are operator-side (separate
 * admin trail) and intentionally do not emit here. See IMPLEMENTERS-GUIDE.md
 * for the event catalogue.
 *
 * Events split into two classes (mirrored by ApiMethods.WITHOUT_USER_METHODS
 * in components/audit/):
 *  - user-resolved (consent.granted, code.exchanged, nonce.reused,
 *    token.issued.authorization_code, token.refreshed, token.revoked) — carry
 *    a `userId` and are persisted to that user's audit storage (+ syslog).
 *  - user-less (consent.shown, consent.refused, code.reused,
 *    token.introspected, token.exchange_refused, client.metadata_fetched,
 *    client.metadata_refused): no user is known (pre-consent / reuse of an
 *    already-consumed code or refresh token / a resource server asking about
 *    any token), so they go to syslog only (per-user storage needs a user to
 *    key on).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfigSync } = require('@pryv/boiler');
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');
const { logServerError } = require('./serverLog.ts');

// OAuth-specific audit event type (not part of components/audit/ Constants).
// The access-/action- streamId prefixes are sourced from the audit singleton's
// CONSTANTS at emit time (below), so they can never drift from components/audit/.
const EVENT_TYPE = 'audit-log/oauth';

/** The set of OAuth audit event types this component emits. */
export type OAuthAuditEvent =
  | 'oauth.consent.shown'
  | 'oauth.consent.granted'
  | 'oauth.consent.refused'
  | 'oauth.code.exchanged'
  | 'oauth.code.reused'
  | 'oauth.nonce.reused'
  | 'oauth.token.issued.authorization_code'
  | 'oauth.token.issued.client_credentials'
  | 'oauth.token.refreshed'
  | 'oauth.token.reuse_detected'
  | 'oauth.token.dpop_mismatch'
  | 'oauth.token.revoked'
  | 'oauth.token.introspected'
  | 'oauth.token.exchanged'
  | 'oauth.token.exchange_refused'
  | 'oauth.client.metadata_fetched'
  | 'oauth.client.metadata_refused';

/**
 * OAuth events for which no user is resolvable at emit time (pre-consent
 * /authorize + /refuse, and reuse of an already-consumed code/refresh where the
 * user is unknown). These route to syslog only, never per-user storage.
 * Exported and kept in lock-step with
 * components/audit/src/ApiMethods.ts#WITHOUT_USER_METHODS (asserted in tests).
 *
 * NB: oauth.token.issued.client_credentials is NOT here — that grant resolves
 * the app-account userId, so it is user-scoped (persisted to the app's trail).
 */
export const USERLESS_EVENTS: ReadonlySet<OAuthAuditEvent> = new Set([
  'oauth.consent.shown',
  'oauth.consent.refused',
  'oauth.code.reused',
  // A resource server's question about a token: the answer may be about no
  // user at all (unknown, expired or another core's token).
  'oauth.token.introspected',
  // A refused token exchange: the subject token may name no user at all.
  'oauth.token.exchange_refused',
  // A client metadata document fetched or refused at /authorize (no user yet).
  'oauth.client.metadata_fetched',
  'oauth.client.metadata_refused'
]);

/**
 * Per-event payload shape. Free-form per event; consumers query by
 * event type + filter by client_id / user_id / time window.
 */
export type OAuthAuditPayload = {
  clientId: string;
  userId?: string | null;
  requestedScope?: string[];
  grantedScope?: string[];
  grantedPermissions?: unknown;
  accessId?: string;
  dataGrantAccessId?: string;
  codeId?: string;
  oldTokenId?: string;
  newTokenId?: string;
  attemptedBy?: string; // for oauth.code.reused — IP / fingerprint of the second attempt
  dpopJkt?: string; // DPoP-bound issuances: RFC 7638 thumbprint of the bound key
  offerName?: string;
  offerCapabilityId?: string;
  reason?: string;
  source?: 'user' | 'operator';
  scope?: string[]; // for oauth.token.revoked
  subjectChange?: { from: string; to: string }; // oauth.consent.granted: an acknowledged change of subject mode
  retiredAccessId?: string; // oauth.token.refreshed: the session the rotation retired
  active?: boolean; // oauth.token.introspected: the answer (the token itself is never recorded)
  tokenClientId?: string; // oauth.token.introspected: the client the token was issued to, when known
  actorClientId?: string; // oauth.token.introspected: the resource server holding a derived token
  subjectClientId?: string; // oauth.token.exchanged: the client the subject token was issued to
  subjectAccessId?: string; // oauth.token.exchanged: the subject session
  reused?: boolean; // oauth.token.exchanged: the derived session existed already
  metadataUrl?: string; // a metadata-document client: its URL (the client's id on the wire)
  host?: string; // oauth.client.metadata_*: the document's host
  metadataHost?: string; // oauth.consent.shown: the host shown next to a metadata-document client's name
  outcome?: 'created' | 'refreshed' | 'unchanged'; // oauth.client.metadata_fetched
  changedFields?: string[]; // oauth.client.metadata_fetched: the row fields a refetch changed
  detail?: string; // oauth.client.metadata_refused: the server-side reason (never the document)
};

/** The subset of AuditEventLike (components/audit/) we build here. */
type OAuthAuditEventRow = {
  id: string;
  createdBy: string;
  modifiedBy: string;
  streamIds: string[];
  time: number;
  endTime: number;
  created: number;
  modified: number;
  trashed: boolean;
  type: string;
  content: { action: string; source: unknown; record: unknown };
};

/**
 * Emit an audit row. MUST be awaited so a failure is observed here rather
 * than lost to an unhandled rejection.
 *
 * Failure policy (deliberate — differs from the core API path, where an audit
 * failure fails the call): emission failures are SURFACED via logServerError
 * but NOT propagated — an audit-backend hiccup must not deny an OAuth token
 * grant (availability is prioritised over audit completeness on this path).
 * No-op when `audit:active` is false or boiler is not yet initialised.
 */
export async function audit (event: OAuthAuditEvent, payload: OAuthAuditPayload): Promise<void> {
  if (process.env.OAUTH_AUDIT_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.debug('[oauth.audit]', event, payload);
  }
  // Config gate. getConfigSync() throws until boiler is fully initialized —
  // in pure unit tests / pre-boot that is expected, so treat it as a silent
  // no-op (there is no audit subsystem to emit into yet) rather than an
  // emission failure worth logging.
  let config;
  try {
    config = getConfigSync();
  } catch {
    return;
  }
  if (config.get('audit:active') !== true) return;

  const userId = payload.userId ?? undefined;
  // Defensive: a user-scoped event (one NOT in USERLESS_EVENTS) reaching here
  // without a userId would hit storage.forUser(undefined), which the storage
  // engine rejects (PG user_id NOT NULL / SQLite bad user dir) — swallowed
  // below as a lost row + error log. Correct classification + the matching
  // WITHOUT_USER_METHODS entries keep this from happening; if a future
  // miswiring breaks that, drop the row with a clear log instead.
  if (userId == null && !USERLESS_EVENTS.has(event)) {
    logServerError('audit: user-resolved event "' + event + '" emitted without a userId — dropping the audit row', null);
    return;
  }

  try {
    const auditSingleton = require('audit').default;
    const C = auditSingleton.CONSTANTS;
    const time = timestamp.now();
    const streamIds: string[] = [];
    if (payload.accessId != null) streamIds.push(C.ACCESS_STREAM_ID_PREFIX + payload.accessId);
    streamIds.push(C.ACTION_STREAM_ID_PREFIX + event);

    const row: OAuthAuditEventRow = {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds,
      time,
      endTime: time,
      created: time,
      modified: time,
      trashed: false,
      type: EVENT_TYPE,
      content: {
        action: event, // eventForUser() re-derives the methodId from content.action
        source: { name: 'oauth2', clientId: payload.clientId },
        record: payload
      }
    };

    await auditSingleton.eventForUser(userId, row, event);
  } catch (err) {
    logServerError('audit emission failed for "' + event + '"', err);
  }
}
