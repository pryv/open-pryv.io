/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 — audit-event emission helper (skeleton).
 *
 * Thin wrapper around components/audit/'s primitives so every OAuth
 * grant + revoke path emits structured audit rows without each
 * caller knowing the audit-DB API.
 *
 * M1 ships the skeleton + type definitions. Actual `await audit(...)`
 * call-sites land in M2 (/oauth2/authorize, /oauth2/token
 * authorization_code), M3 (refresh), M4 (client_credentials).
 *
 * Per the design: all token-issuance + revoke
 * events are audited. M1 itself emits no audit events — CLI is
 * operator-side (separate admin trail). See IMPLEMENTERS-GUIDE.md
 * for the catalogue.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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
 * Per-event payload shape. Free-form per event; consumers query by
 * event type + filter by client_id / user_id / time window.
 */
export type OAuthAuditPayload = {
  clientId: string;
  userId?: string | null;
  requestedScope?: string[];
  grantedScope?: string[];
  accessId?: string;
  codeId?: string;
  oldTokenId?: string;
  newTokenId?: string;
  attemptedBy?: string; // for oauth.code.reused — IP / fingerprint of the second attempt
  reason?: string;
  source?: 'user' | 'operator';
  scope?: string[]; // for oauth.token.revoked
};

/**
 * Emit an audit row. MUST be awaited — silent fire-and-forget is a
 * deliberate anti-pattern (audit failures must surface per the
 * existing components/audit/ contract).
 *
 * M1 stub: no-op + logs at debug. M2 wires this to the real audit
 * subsystem (`components/audit/`'s public API).
 */
export async function audit (event: OAuthAuditEvent, payload: OAuthAuditPayload): Promise<void> {
  // M1 skeleton — actual call into components/audit/ added when M2's
  // grant handlers need it. Keeping a stub so M1 modules can `await`
  // the call sites without conditional imports.
  if (process.env.OAUTH_AUDIT_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.debug('[oauth.audit]', event, payload);
  }
}
