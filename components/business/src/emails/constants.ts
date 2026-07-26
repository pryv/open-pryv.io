/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Multiple emails per account, reserved stream-id namespace and item shape.
 *
 * Stream-id model:
 *
 *   :_emails:      reserved container stream (server-managed)
 *
 * The container holds one ordinary event per email address (the primary
 * included). The legacy singular account field `:_system:email` stays
 * authoritative as the PRIMARY email; the container is a parallel record that
 * also carries pending (not yet verified) addresses.
 *
 * The `:_system:` prefix cannot be used for this container: every `:_system:`
 * / `:system:` stream routes to the single-field account datastore adapter,
 * which stores exactly one value per field and blocks deletion. So the
 * container is an ordinary local-store stream guarded like the shared-secrets
 * and CMC namespaces: not creatable, editable, movable or deletable through the
 * generic events API, and kept out of wildcard events.get. A holder that could
 * write these events by hand could forge `status: 'verified'`; the only
 * sanctioned writers are the account methods (and, later, the verification
 * endpoint), which go through the mall directly.
 */

/** Reserved container stream id (also the namespace root). */
export const CONTAINER_STREAM_ID = ':_emails:';

/** Event type carried by every email item in the container. */
export const EVENT_TYPE = 'email/multiple';

/** PlatformDB uniqueness field shared with the legacy singular email. */
export const UNIQUE_FIELD = 'email';

/** Verification statuses. */
export const STATUS_PENDING = 'pending';
export const STATUS_VERIFIED = 'verified';

/**
 * Verification methods — the explicit provenance of an email's status. Every
 * write stamps one of these; `null` is reserved for grandfathered pre-provenance
 * data (read-only, never written again) and counts as NOT proved.
 *
 *   email-link    proved: the holder clicked a mailed one-time token.
 *   operator      proved: set by the root-trusted operator seam.
 *   registration  asserted: the account's founding email (today's trust level,
 *                 never link-proved) — see the D2 policy decision.
 *   legacy        asserted: set by legacy `account.update {email}` with no proof.
 */
export const METHOD_EMAIL_LINK = 'email-link';
export const METHOD_OPERATOR = 'operator';
export const METHOD_REGISTRATION = 'registration';
export const METHOD_LEGACY = 'legacy';

/**
 * The methods that count as PROVED ownership (the holder demonstrated control of
 * the inbox, or a root-trusted operator vouched). `status: 'verified'` alone is
 * NOT proof — registration/legacy/null are asserted-but-unproved. Consumers that
 * must trust ownership (e.g. SSO email matching) MUST gate on
 * {@link isProvedOwnership}, never on `status` alone.
 */
export const PROVED_METHODS = Object.freeze([METHOD_EMAIL_LINK, METHOD_OPERATOR]);

/** True only when the email's ownership was actually proved (see PROVED_METHODS). */
export function isProvedOwnership (content: { status?: unknown; verificationMethod?: unknown }): boolean {
  return content.status === STATUS_VERIFIED &&
    typeof content.verificationMethod === 'string' &&
    (PROVED_METHODS as readonly string[]).includes(content.verificationMethod);
}

/** Hard ceiling on emails per account, independent of operator config. */
export const HARD_CAP = 20;

/** Default cap when `account:maxEmails` is unset. */
export const DEFAULT_MAX = 5;

/** Default verification-token lifetime when config is unset: 24h (ms). */
export const DEFAULT_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Default resend cooldown when config is unset: 5 minutes (ms). */
export const DEFAULT_RESEND_COOLDOWN_MS = 5 * 60 * 1000;

/** True for the container stream (with or without the trailing marker). */
export function isEmailStreamId (streamId: unknown): boolean {
  if (typeof streamId !== 'string') return false;
  return streamId === ':_emails' || streamId.startsWith(CONTAINER_STREAM_ID);
}
