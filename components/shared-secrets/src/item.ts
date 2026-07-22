/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — item shape, validation and status transitions.
 *
 * Kept free of storage and HTTP so the state machine can be exercised directly:
 * these are the rules that decide whether a secret is handed over or burned,
 * and they are worth testing without a server in the way.
 */

import * as C from './constants.ts';
import { SIGNATURE_TYPES, isStorableHash } from './key.ts';

export type OnConsumed = { message: string; returnUrl?: string };
// `value` is required at creation, but dropped once the item leaves pending —
// see applyTransition. A stored terminal item keeps only the type.
export type ItemSignature = { type: string; value?: string };

export type StatusEntry = { status: string; time: number; info?: string };

export type ItemContent = {
  keyHash: string;
  title: string;
  status: string;
  statusHistory: StatusEntry[];
  onConsumed: OnConsumed;
  signature?: ItemSignature;
  secret?: unknown;
};

export type CreateParams = {
  ttl?: unknown;
  title?: unknown;
  onConsumed?: unknown;
  signature?: unknown;
  secret?: unknown;
  keyHash?: unknown;
};

export type Limits = { maxSizeBytes: number; maxTtl: number };

/** A validation failure: `id` becomes the API error's data id, `message` its text. */
export type Invalid = { id: string; message: string };

const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

/**
 * Validate creation parameters. Returns null when they are acceptable.
 *
 * `ttl` is mandatory and has no default on purpose — a caller must decide how
 * long the secret may live. A non-positive ttl is refused rather than coerced,
 * since `duration: null` means "running" for an event and would make the secret
 * immortal.
 */
export function validateCreate (params: CreateParams, limits: Limits): Invalid | null {
  const { ttl, title, onConsumed, signature, secret, keyHash } = params;

  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    return { id: 'shared-secret-invalid-ttl', message: 'ttl must be a positive number of seconds.' };
  }
  if (ttl > limits.maxTtl) {
    return { id: 'shared-secret-ttl-too-long', message: 'ttl exceeds the maximum of ' + limits.maxTtl + ' seconds.' };
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { id: 'shared-secret-invalid-title', message: 'title is required.' };
  }
  const oc = onConsumed as OnConsumed | undefined;
  if (oc == null || typeof oc !== 'object' || typeof oc.message !== 'string' || oc.message.length === 0) {
    return { id: 'shared-secret-invalid-on-consumed', message: 'onConsumed.message is required.' };
  }
  if (oc.returnUrl != null) {
    // Handed to unauthenticated consumers who are expected to follow it, so a
    // javascript:/data:/file: scheme here would be an open-redirect vector.
    if (typeof oc.returnUrl !== 'string' || !HTTP_URL_RE.test(oc.returnUrl)) {
      return { id: 'shared-secret-invalid-return-url', message: 'onConsumed.returnUrl must be an http(s) URL.' };
    }
  }
  if (secret === undefined || secret === null) {
    return { id: 'shared-secret-missing-secret', message: 'secret is required and may not be null.' };
  }
  if (serializedSize(secret) > limits.maxSizeBytes) {
    return { id: 'shared-secret-too-large', message: 'secret exceeds the maximum of ' + limits.maxSizeBytes + ' bytes.' };
  }
  if (keyHash !== undefined && !isStorableHash(keyHash)) {
    return { id: 'shared-secret-invalid-key-hash', message: 'keyHash must be a hex SHA-256 digest.' };
  }
  const sig = signature as ItemSignature | undefined;
  if (sig != null) {
    if (typeof sig !== 'object' || !SIGNATURE_TYPES.includes(sig.type) ||
        typeof sig.value !== 'string' || sig.value.length === 0) {
      return { id: 'shared-secret-invalid-signature', message: 'signature.type must be one of ' + SIGNATURE_TYPES.join(', ') + ' with a non-empty value.' };
    }
  }
  return null;
}

/** Byte length of the secret as persisted — serialized JSON, not character count. */
export function serializedSize (secret: unknown): number {
  return Buffer.byteLength(JSON.stringify(secret) ?? '', 'utf8');
}

/** Build the content of a fresh, pending item. */
export function buildContent (params: {
  keyHash: string;
  title: string;
  onConsumed: OnConsumed;
  signature?: ItemSignature | null;
  secret: unknown;
  now: number;
}): ItemContent {
  const content: ItemContent = {
    keyHash: params.keyHash,
    title: params.title,
    status: C.STATUS_PENDING,
    statusHistory: [{ status: C.STATUS_PENDING, time: params.now }],
    onConsumed: params.onConsumed,
    secret: params.secret
  };
  if (params.signature != null) content.signature = params.signature;
  return content;
}

/**
 * Move an item out of `pending`, appending to its history.
 *
 * The clear secret is dropped at this point: once consumed or discarded it has
 * served its purpose, and keeping it only adds at-rest exposure in backups and
 * exports. The signature `value` goes with it — for a `secret`-type signature it
 * is the user's passphrase in clear, same class of liability. Title, status,
 * history and the signature TYPE survive so the record stays auditable.
 */
export function applyTransition (content: ItemContent, params: {
  status: string;
  info?: string;
  now: number;
}): ItemContent {
  const entry: StatusEntry = { status: params.status, time: params.now };
  if (params.info != null) entry.info = params.info;
  const next: ItemContent = {
    ...content,
    status: params.status,
    statusHistory: [...(content.statusHistory ?? []), entry]
  };
  delete next.secret;
  if (next.signature != null) next.signature = { type: next.signature.type };
  return next;
}

/** Only a pending item is retrievable — everything else is terminal. */
export function isPending (content: ItemContent | null | undefined): boolean {
  return content?.status === C.STATUS_PENDING;
}

/**
 * The public view of an item: status and metadata, never the secret or the hash.
 *
 * When `now` is given, a still-`pending` item whose time has run out is reported
 * as expired rather than pending — expiry is lazy (evaluated on read, not swept),
 * so without this a status read would call a dead secret live. The stored record
 * is not mutated; a GET stays side-effect-free.
 */
export function toPublicView (
  event: { id: string; time: number; duration?: number | null; content: ItemContent },
  now?: number
): Record<string, unknown> {
  const c = event.content;
  const expires = event.time + (event.duration ?? 0);
  const effectiveStatus = (now != null && c.status === C.STATUS_PENDING && now > expires)
    ? C.STATUS_DISCARDED
    : c.status;
  const view: Record<string, unknown> = {
    id: event.id,
    title: c.title,
    status: effectiveStatus,
    statusHistory: c.statusHistory,
    onConsumed: c.onConsumed,
    signatureType: c.signature?.type,
    expires
  };
  if (effectiveStatus !== c.status) view.expired = true;
  return view;
}
