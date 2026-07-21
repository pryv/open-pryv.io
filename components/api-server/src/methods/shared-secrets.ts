/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — API methods.
 *
 * Three operations: create an item (authenticated), retrieve it exactly once by
 * key (unauthenticated — the key IS the credential), and read its status
 * without consuming it (authenticated).
 *
 * Retrieval is deliberately uniform in failure: an unknown id, a wrong random
 * half and a malformed string all produce the same refusal, so the endpoint
 * cannot be used to discover which ids exist. A consumed or expired item is a
 * separate, deliberate case — it returns the creator's own message so the end
 * user learns what happened.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const errors = require('errors').factory;
const { getMall } = require('mall');
const { getConfig, getLogger } = require('@pryv/boiler');
const timestamp = require('unix-timestamp');

const S = require('shared-secrets');

import type {
  CreateParams, OnConsumed, ItemSignature, ItemContent
} from 'shared-secrets/src/item.ts';

type MethodNext = (err?: unknown) => void;
type Context = {
  user: { id: string };
  access?: { id: string; isPersonal (): boolean; canCreateSharedSecrets? (): boolean };
};
type Result = Record<string, unknown>;

const logger = getLogger('shared-secrets');

/** Same refusal for every shape that does not resolve to a live item. */
function unknownKey (): Error {
  return errors.unknownResource('shared secret', '');
}

/** Refusal that carries the creator's message + returnUrl to the end user. */
function unavailable (content: { onConsumed?: { message?: string; returnUrl?: string } }): Error {
  const onConsumed = content?.onConsumed ?? {};
  const err = errors.forbidden(onConsumed.message ?? 'This shared secret is no longer available.');
  err.data = Object.assign({}, err.data, {
    id: 'shared-secret-unavailable',
    returnUrl: onConsumed.returnUrl
  });
  return err;
}

export default async function produceSharedSecretsApiMethods (api: { register: (...args: unknown[]) => void }) {
  const mall = await getMall();
  const config = await getConfig();

  // Read per-request, not captured at registration: a slice taken here would
  // freeze the platform's settings at boot, so an operator toggle (and any test
  // that injects config) would never reach the callsites. Same reason events.ts
  // uses getters for its auth/updates config.
  const getLimits = () => ({
    maxSizeBytes: config.get('sharedSecrets:maxSizeBytes') ?? 4096,
    maxTtl: config.get('sharedSecrets:maxTtl') ?? 2592000
  });
  const isEnabled = () => config.get('sharedSecrets:enabled') !== false;

  function checkEnabled (context: Context, params: unknown, result: Result, next: MethodNext) {
    if (!isEnabled()) {
      return next(errors.unavailableMethod('Shared secrets are disabled on this platform.'));
    }
    next();
  }

  // ------------------------------------------------------------------ create

  api.register('sharedSecrets.create',
    checkEnabled,
    function checkPermission (context: Context, params: unknown, result: Result, next: MethodNext) {
      const access = context.access;
      if (access == null) return next(errors.invalidAccessToken('Missing access token.'));
      if (typeof access.canCreateSharedSecrets === 'function' && !access.canCreateSharedSecrets()) {
        const err = errors.forbidden('This access may not create shared secrets.');
        err.data = Object.assign({}, err.data, { id: 'shared-secret-forbidden' });
        return next(err);
      }
      next();
    },
    function validate (context: Context, params: CreateParams, result: Result, next: MethodNext) {
      const invalid = S.validateCreate(params, getLimits());
      if (invalid != null) {
        const err = errors.invalidParametersFormat(invalid.message);
        err.data = Object.assign({}, err.data, { id: invalid.id });
        return next(err);
      }
      next();
    },
    async function create (context: Context, params: CreateParams, result: Result, next: MethodNext) {
      const accessId = context.access!.id;
      const userId = context.user.id;
      await S.ensureStreams({ mall, userId, accessId, logger });

      const now = timestamp.now();
      const eventId = mall.newEventId != null ? mall.newEventId() : require('cuid')();

      // Two modes: the caller supplies the hash of a random half it generated
      // itself (so it can bind an hmac-sha256 signature to key material before
      // the item exists), or the server mints the whole key and returns it once.
      const clientSupplied = params.keyHash !== undefined;
      const minted = clientSupplied ? null : S.key.mint(eventId);
      const keyHash = clientSupplied ? String(params.keyHash) : minted!.keyHash;

      const content = S.buildContent({
        keyHash,
        title: String(params.title),
        onConsumed: params.onConsumed as OnConsumed,
        signature: (params.signature ?? null) as ItemSignature | null,
        secret: params.secret,
        now
      });

      const event = await mall.events.create(userId, {
        id: eventId,
        streamIds: [S.streamIdForAccess(accessId)],
        type: S.EVENT_TYPE,
        time: now,
        duration: params.ttl as number,
        content,
        createdBy: accessId,
        modifiedBy: accessId,
        created: now,
        modified: now
      });

      const view = S.toPublicView({ id: event.id, time: now, duration: params.ttl as number, content });
      if (minted != null) view.key = minted.key;
      result.sharedSecret = view;
      next();
    });

  // ---------------------------------------------------------------- retrieve

  api.register('sharedSecrets.retrieve',
    checkEnabled,
    async function retrieve (context: Context, params: { key?: unknown; signature?: unknown }, result: Result, next: MethodNext) {
      const parsed = S.key.parse(params.key);
      if (parsed == null) return next(unknownKey());

      const userId = context.user.id;
      const event = await mall.events.getOne(userId, parsed.eventId);
      // Type alone is not identity: an event of this type sitting in an ordinary
      // stream is a forgery, not a shared secret, and must not be redeemable.
      if (event == null || event.type !== S.EVENT_TYPE ||
          !(event.streamIds ?? []).some((id: string) => S.isSharedSecretStreamId(id))) {
        return next(unknownKey());
      }

      const content = event.content as ItemContent;
      // A wrong random half is indistinguishable from an unknown id, and never
      // touches the item — otherwise a guesser could burn secrets at will.
      if (!S.key.constantTimeEquals(S.key.hashRandomPart(parsed.randomPart), content.keyHash ?? '')) {
        return next(unknownKey());
      }

      if (!S.isPending(content)) return next(unavailable(content));

      const now = timestamp.now();
      if (S.key.isExpired({ time: event.time, duration: event.duration }, now)) {
        await transition(userId, event, content, S.STATUS_DISCARDED, S.INFO_EXPIRED, now);
        return next(unavailable(content));
      }

      if (content.signature != null) {
        const given = params.signature as { type?: string; payload?: unknown } | undefined;
        // A missing payload refuses without burning, so a client can discover a
        // passphrase is needed and retry. A WRONG one burns the secret.
        if (given == null || given.payload === undefined) {
          return next(unavailable(content));
        }
        if (!S.key.verifySignature(content.signature, given, params.key as string)) {
          await transition(userId, event, content, S.STATUS_DISCARDED, S.INFO_SIGNATURE_MISMATCH, now);
          return next(unavailable(content));
        }
      }

      // One-shot: the consume must win exactly once under concurrency.
      const consumed = await transition(userId, event, content, S.STATUS_CONSUMED, undefined, now);
      if (!consumed) return next(unavailable(content));

      result.secret = content.secret;
      next();
    });

  // ------------------------------------------------------------------ status

  api.register('sharedSecrets.getOne',
    checkEnabled,
    async function status (context: Context, params: { key?: unknown }, result: Result, next: MethodNext) {
      const access = context.access;
      if (access == null) return next(errors.invalidAccessToken('Missing access token.'));

      const parsed = S.key.parse(params.key);
      if (parsed == null) return next(unknownKey());

      const event = await mall.events.getOne(context.user.id, parsed.eventId);
      // Type alone is not identity: an event of this type sitting in an ordinary
      // stream is a forgery, not a shared secret, and must not be redeemable.
      if (event == null || event.type !== S.EVENT_TYPE ||
          !(event.streamIds ?? []).some((id: string) => S.isSharedSecretStreamId(id))) {
        return next(unknownKey());
      }

      const content = event.content as ItemContent;
      if (!S.key.constantTimeEquals(S.key.hashRandomPart(parsed.randomPart), content.keyHash ?? '')) {
        return next(unknownKey());
      }
      // Only the creator or a personal token may look; reading status must not
      // become a way to probe a key without consuming it.
      const ownerStream = S.streamIdForAccess(access.id);
      const isOwner = (event.streamIds ?? []).includes(ownerStream);
      if (!isOwner && !access.isPersonal()) return next(unknownKey());

      result.sharedSecret = S.toPublicView({
        id: event.id, time: event.time, duration: event.duration, content
      });
      next();
    });

  /**
   * Move an item out of `pending`, returning false if someone else got there first.
   *
   * The decision is made by the database, not by this process: the update is a
   * compare-and-set on "still untrashed", so of N concurrent redemptions exactly
   * one writes and the rest are told they lost. A read-then-write here would let
   * every racer through, which for a one-shot secret is the whole ballgame.
   *
   * It goes through `mall.events.update` rather than a raw engine write so the
   * event's integrity hash is recomputed with the new content.
   */
  async function transition (
    userId: string,
    event: { id: string; streamIds?: string[] },
    content: ItemContent,
    status: string,
    info: string | undefined,
    now: number
  ): Promise<boolean> {
    const fresh = await mall.events.getOne(userId, event.id);
    if (fresh == null || !S.isPending(fresh.content as ItemContent)) return false;
    const next = S.applyTransition(fresh.content as ItemContent, { status, info, now });
    const written = await mall.events.update(userId, Object.assign({}, fresh, {
      content: next,
      trashed: true,
      modified: now
    }), undefined, { onlyIfNotTrashed: true, skipVersioning: true });
    return written != null;
  }
}
