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
 * for `cmc/request-v1` triggers with `capabilityRequested: true`.
 *
 * Runs synchronously inside the events.create chain BEFORE `createEvent`:
 *   - if the trigger is cmc/request-v1 + capabilityRequested === true,
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
  streams: { create: (userId: string, params: any) => Promise<any> };
  events:  { create: (userId: string, params: any) => Promise<any> };
  accesses:{ create: (userId: string, params: any) => Promise<any> };
};

type ErrorFactory = {
  invalidOperation: (message: string, details?: any) => any;
  unexpectedError?: (err: any) => any;
};

type Deps = {
  mall: MallLike;
  errors: ErrorFactory;
  idGen?: () => string;
  now?: () => number;
  serviceUrlBase?: string;
  logger?: { debug: Function; warn: Function };
};

type Middleware = (context: any, params: any, result: any, next: any) => any | Promise<any>;

/**
 * Returns a middleware that fires for cmc/request-v1 events with
 * capabilityRequested:true on context.newEvent. Other events passthrough.
 */
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

    try {
      const result = await capabilityMod.mintCapability({
        userId,
        triggerEvent: event,
        deps: {
          mall: deps.mall,
          idGen: deps.idGen,
          now: deps.now,
          serviceUrlBase: deps.serviceUrlBase,
        },
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
    } catch (err: any) {
      deps.logger?.warn?.('cmc/capability-mint: failed', {
        userId,
        error: String(err?.message || err),
      });
      const wrap = deps.errors.unexpectedError
        ? deps.errors.unexpectedError(err)
        : deps.errors.invalidOperation(
            'CMC capability mint failed: ' + (err?.message || String(err)),
            { id: 'cmc-mint-failed', error: String(err?.message || err) }
          );
      next(wrap);
    }
  };
}

export { createCapabilityMintHook };
