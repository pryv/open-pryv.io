/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — reserved stream-id namespace and item shape.
 *
 * Stream-id model:
 *
 *   :_shared-secrets:                   reserved root (plugin-managed)
 *     :_shared-secrets:<accessId>       one substream per creating access
 *
 * Items are ordinary events in the local store, distinguished only by this
 * prefix — the plugin owns a namespace, it is not a storage engine. Each item
 * reuses standard event fields: `time` + `duration` carry the TTL (expiry is
 * exactly `now > time + duration`), `trashed` marks an item that has left the
 * `pending` status, and `modified` tracks the last transition.
 *
 * An access sees its own substream and nothing else, and the whole namespace is
 * kept out of wildcard queries — a shared secret only ever appears when its
 * stream is named explicitly.
 */

/** Reserved root. */
export const NS = ':_shared-secrets:';

/** Event type carried by every shared-secret item. */
export const EVENT_TYPE = 'shared-secret/item';

/** Lifecycle states. `pending` is the only one from which a secret is retrievable. */
export const STATUS_PENDING = 'pending';
export const STATUS_CONSUMED = 'consumed';
export const STATUS_DISCARDED = 'discarded';

/** Reasons attached to a `discarded` transition. */
export const INFO_EXPIRED = 'expired';
export const INFO_DELETED = 'deleted';
export const INFO_SIGNATURE_MISMATCH = 'Secret does not match';

/** The substream a given access writes its shared secrets into. */
export function streamIdForAccess (accessId: string): string {
  return NS + accessId;
}

/** True for the reserved root and anything below it. */
export function isSharedSecretStreamId (streamId: unknown): boolean {
  if (typeof streamId !== 'string') return false;
  return streamId === ':_shared-secrets' || streamId.startsWith(NS);
}

/** True for the reserved root itself, which no caller may create or delete. */
export function isReservedRoot (streamId: unknown): boolean {
  return streamId === NS || streamId === ':_shared-secrets';
}

/** The access id owning a substream, or null if the id is not a substream. */
export function accessIdFromStreamId (streamId: unknown): string | null {
  if (typeof streamId !== 'string' || !streamId.startsWith(NS)) return null;
  const rest = streamId.slice(NS.length);
  if (rest.length === 0 || rest.includes(':')) return null;
  return rest;
}
