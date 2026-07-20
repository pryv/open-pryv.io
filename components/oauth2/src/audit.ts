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
 *  - user-resolved (consent.granted, code.exchanged,
 *    token.issued.authorization_code, token.refreshed, token.revoked) — carry
 *    a `userId` and are persisted to that user's audit storage (+ syslog).
 *  - user-less (consent.shown, consent.refused, code.reused,
 *    token.issued.client_credentials) — no user is known (pre-consent /
 *    app-to-app / reuse of an already-consumed code or refresh token), so they
 *    go to syslog only (per-user storage needs a user to key on).
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { getConfigSync } = require('@pryv/boiler');
const { createId: cuid } = require('@paralleldrive/cuid2');
const timestamp = require('unix-timestamp');
const { logServerError } = require('./serverLog.ts');

// Mirror components/audit/ Constants — kept local to avoid a hard require of
// the audit component just for two string prefixes + the event type.
const EVENT_TYPE = 'audit-log/oauth';
const ACCESS_STREAM_ID_PREFIX = 'access-';
const ACTION_STREAM_ID_PREFIX = 'action-';

/** The set of OAuth audit event types this component emits. */
export type OAuthAuditEvent =
  | 'oauth.consent.shown'
  | 'oauth.consent.granted'
  | 'oauth.consent.refused'
  | 'oauth.code.exchanged'
  | 'oauth.code.reused'
  | 'oauth.token.issued.authorization_code'
  | 'oauth.token.issued.client_credentials'
  | 'oauth.token.refreshed'
  | 'oauth.token.revoked';

/**
 * OAuth events for which no user is resolvable at emit time. MUST stay in
 * lock-step with components/audit/src/ApiMethods.ts#WITHOUT_USER_METHODS —
 * those go to syslog only, never per-user storage.
 */
const USERLESS_EVENTS: ReadonlySet<OAuthAuditEvent> = new Set([
  'oauth.consent.shown',
  'oauth.consent.refused',
  'oauth.code.reused',
  'oauth.token.issued.client_credentials'
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
  offerName?: string;
  offerCapabilityId?: string;
  reason?: string;
  source?: 'user' | 'operator';
  scope?: string[]; // for oauth.token.revoked
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
 * Emit an audit row. MUST be awaited — silent fire-and-forget is a
 * deliberate anti-pattern (audit failures must surface per the existing
 * components/audit/ contract).
 *
 * Failures are surfaced via the error log but never propagated: an audit
 * backend hiccup must not deny an OAuth grant (availability > audit
 * completeness for the token path). No-op when `audit:active` is false.
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
  // Guard the audit-component gap: eventForUser() calls storage.forUser(userId)
  // for any non-WITHOUT_USER method, which throws on an undefined userId. Our
  // classification guarantees this never happens, but a future miswiring
  // (a user-resolved event emitted without a userId) would otherwise crash;
  // drop the row with a warning instead.
  if (userId == null && !USERLESS_EVENTS.has(event)) {
    logServerError('audit: user-resolved event "' + event + '" emitted without a userId — dropping the audit row', null);
    return;
  }

  try {
    const auditSingleton = require('audit').default;
    const time = timestamp.now();
    const streamIds: string[] = [];
    if (payload.accessId != null) streamIds.push(ACCESS_STREAM_ID_PREFIX + payload.accessId);
    streamIds.push(ACTION_STREAM_ID_PREFIX + event);

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
