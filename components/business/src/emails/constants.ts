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

/** Verification methods. */
export const METHOD_EMAIL_LINK = 'email-link';
export const METHOD_OPERATOR = 'operator';

/** Hard ceiling on emails per account, independent of operator config. */
export const HARD_CAP = 20;

/** Default cap when `account:maxEmails` is unset. */
export const DEFAULT_MAX = 5;

/** True for the container stream (with or without the trailing marker). */
export function isEmailStreamId (streamId: unknown): boolean {
  if (typeof streamId !== 'string') return false;
  return streamId === ':_emails' || streamId.startsWith(CONTAINER_STREAM_ID);
}
