/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — events.create middleware that mints a capability access
 * for `consent/request-cmc` triggers with `capabilityRequested: true`.
 *
 * Runs synchronously inside the events.create chain BEFORE `createEvent`:
 *   - if the trigger is consent/request-cmc + capabilityRequested === true,
 *     calls capability.mintCapability (which creates 2 streams + offer
 *     event + shared access via direct mall calls);
 *   - stamps context.newEvent.content with capabilityUrl +
 *     capabilityExpiresAt + capabilityAccessId before the trigger gets
 *     persisted, so the integrity hash + the events.create response
 *     include the capability handles.
 *
 * Errors during minting surface as middleware errors (the trigger is
 * NOT persisted). The events.create caller sees a normal API error.
 * Tests inject fakes via deps.
 */

const C = require('./constants.ts');
const capabilityMod = require('./capability.ts');

type MallLike = {
  streams: { create: (userId: string, params: Record<string, unknown>) => Promise<unknown> };
  events:  { create: (userId: string, params: Record<string, unknown>) => Promise<unknown> };
  accesses:{ create: (userId: string, params: Record<string, unknown>) => Promise<unknown> };
};

type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => Error;
  unexpectedError?: (err: unknown) => Error;
};

type LoggerLike = { debug: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

type Deps = {
  mall: MallLike;
  errors: ErrorFactory;
  idGen?: () => string;
  now?: () => number;
  serviceUrlBase?: string;
  logger?: LoggerLike;
  // Optional: when present, the resolved {username, host} is stamped on
  // the offer event as content.requesterHost so the accepter's
  // handleAccept can compute the counterparty's CANONICAL host (e.g.
  // `pryv.me` in a federated subdomain-style deployment) instead of
  // the per-user URL hostname (`<username>.pryv.me`). Without this,
  // both sides compute different slugs for the same identity and
  // chat / system delivery 4xx with `unknown-referenced-resource`.
  selfIdentityFor?: (userId: string) => Promise<{ username: string; host: string }> | { username: string; host: string };
};

type MwContext = {
  user?: { id?: string; [k: string]: unknown };
  newEvent?: { id?: string; type?: string; content?: Record<string, unknown>; [k: string]: unknown };
  cmc?: Record<string, unknown>;
  [k: string]: unknown;
};
type MwNext = (err?: unknown) => unknown;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown | Promise<unknown>;

/**
 * Returns a middleware that fires for consent/request-cmc events with
 * capabilityRequested:true on context.newEvent. Other events passthrough.
 */
/**
 * Post-create middleware: AFTER `createEvent` persists the
 * consent/request-cmc trigger and assigns its real event id, stamp
 * that id onto the capability access's `clientData.cmc.requestEventId`.
 *
 * Why this is a separate hook from the mint hook: the mint hook fires
 * BEFORE createEvent, so `context.newEvent.id` is null at mint time
 * (it's assigned by the mall during persist). HDS reported null
 * requestEventId on real deploys; unit tests passed only because
 * fixtures set explicit `id`. Without this post-stamp, the
 * inviteEventId-on-inbox-mirror feature degrades silently because the
 * source `requestEventId` is null on real-deploy capability accesses.
 *
 * Best-effort: errors are logged but don't fail the trigger create.
 * The base `consent/request-cmc` event is already persisted at this
 * point; failing the request here would leave the user with an
 * orphan event the caller can't see (returned the error instead).
 */
function createCapabilityPostCreateHook (deps: Deps): Middleware {
  return async function cmcCapabilityPostCreateHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    if (event.type !== C.ET_REQUEST) return next();
    if (event.content?.capabilityRequested !== true) return next();
    if (typeof event.id !== 'string' || event.id.length === 0) return next();
    const accessId = event.content?.capabilityAccessId as string | undefined;
    if (typeof accessId !== 'string' || accessId.length === 0) return next();
    const userId = context.user?.id;
    if (typeof userId !== 'string') return next();
    try {
      await capabilityMod.setRequestEventIdOnAccess({
        userId,
        accessId,
        requestEventId: event.id,
        deps: { mall: deps.mall },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn?.('cmc/capability-post-create: requestEventId stamp failed (non-fatal)', {
        userId,
        accessId,
        eventId: event.id,
        error: message,
      });
    }
    next();
  };
}

function createCapabilityMintHook (deps: Deps): Middleware {
  return async function cmcCapabilityMintHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null) return next();
    if (event.type !== C.ET_REQUEST) return next();
    if (event.content?.capabilityRequested !== true) return next();

    const userId = context.user?.id;
    if (typeof userId !== 'string') {
      return next(deps.errors.invalidOperation(
        'CMC capability-mint hook: missing user.id on context',
        { id: 'cmc-mint-missing-user' }
      ));
    }

    let requesterIdentity: { username: string; host: string } | null = null;
    if (typeof deps.selfIdentityFor === 'function') {
      try {
        requesterIdentity = await Promise.resolve(deps.selfIdentityFor(userId));
      } catch (_e) {
        requesterIdentity = null;
      }
    }

    // Per-invite TTL from `content.request.expiresAt` (absolute
    // unix-seconds timestamp; lib-js `cmc.createInvite({expiresAt})`
    // writes it there). When present, convert to `ttlSeconds` for
    // mintCapability and apply platform bounds. Out-of-range rejects
    // the createInvite at this layer — the trigger event is NOT
    // persisted, the events.create caller gets a typed API error.
    // Absent / non-number → fall through to mintCapability's
    // DEFAULT_TTL_SECONDS (7d).
    let ttlSeconds: number | undefined;
    const callerExpiresAt = (event.content?.request as { expiresAt?: number } | undefined)?.expiresAt;
    if (typeof callerExpiresAt === 'number' && Number.isFinite(callerExpiresAt)) {
      const now = (deps.now ?? (() => Date.now() / 1000))();
      const computed = Math.floor(callerExpiresAt - now);
      if (computed < capabilityMod.MIN_TTL_SECONDS || computed > capabilityMod.MAX_TTL_SECONDS) {
        return next(deps.errors.invalidOperation(
          'CMC capability TTL out of range: expiresAt resolves to ' + computed +
          's, must be within [' + capabilityMod.MIN_TTL_SECONDS + ', ' +
          capabilityMod.MAX_TTL_SECONDS + '] seconds from now.',
          {
            id: 'cmc-capability-ttl-out-of-range',
            expiresAt: callerExpiresAt,
            computedTtlSeconds: computed,
            minTtlSeconds: capabilityMod.MIN_TTL_SECONDS,
            maxTtlSeconds: capabilityMod.MAX_TTL_SECONDS,
          }
        ));
      }
      ttlSeconds = computed;
    }

    try {
      const result = await capabilityMod.mintCapability({
        userId,
        triggerEvent: event,
        ttlSeconds,
        deps: {
          mall: deps.mall,
          idGen: deps.idGen,
          now: deps.now,
          serviceUrlBase: deps.serviceUrlBase,
        },
        requesterIdentity: requesterIdentity ?? undefined,
      });

      // Stamp the trigger's content BEFORE createEvent persists it, so
      // the persisted event + integrity hash + events.create response
      // all carry the capability handles.
      event.content = {
        ...(event.content || {}),
        capabilityUrl: result.capabilityUrl,
        capabilityExpiresAt: result.expiresAt,
        capabilityAccessId: result.accessId,
        capabilityId: result.capabilityId,
        status: 'pending',
      };
      context.newEvent = event;
      context.cmc = context.cmc || {};
      context.cmc.capabilityMinted = {
        capabilityId: result.capabilityId,
        accessId: result.accessId,
        offerStreamId: result.offerStreamId,
        responsesStreamId: result.responsesStreamId,
      };

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.warn?.('cmc/capability-mint: failed', {
        userId,
        error: message,
      });
      const wrap = deps.errors.unexpectedError
        ? deps.errors.unexpectedError(err)
        : deps.errors.invalidOperation(
            'CMC capability mint failed: ' + message,
            { id: 'cmc-mint-failed', error: message }
          );
      next(wrap);
    }
  };
}

export { createCapabilityMintHook, createCapabilityPostCreateHook };
