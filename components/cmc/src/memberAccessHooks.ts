/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: the events.create hooks of the mint trigger
 * (`consent/member-access-cmc`).
 *
 *   - `createMemberAccessServerOwnedFieldsHook`: the outcome fields the
 *     server writes after dispatch (`memberAccess`, `member`,
 *     `relationshipAccessId`, beside `status` / `failure`) are dropped from a
 *     client create; on update the stored values are kept
 *     (acceptServerOwnedFieldsHook.preserveServerOwnedContent).
 *   - `createMemberAccessGateHook`: the authorisation gate at write time, so
 *     a refused ask is an API error with its id in `error.data.id` (see
 *     handleMemberAccess.resolveMintTarget), plus the per-membership rate
 *     limit and the in-flight lock per (membership, relationship). The lock
 *     key is left on `context.cmc.memberMintLock` for the dispatch
 *     middleware to release once the mint settled.
 */

import * as C from './constants.ts';
import { CmcErrorIds } from './errorIds.ts';
import { resolveMintTarget } from './handleMemberAccess.ts';
import { MemberMintRegistry } from './memberMintRegistry.ts';
import type { MemberAccessOptions } from './handleMemberAccess.ts';
import type { CmcAccessLike, CmcLogger, MallLike } from './_types.ts';

type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => Error;
};

type MwContext = {
  user?: { id?: string };
  newEvent?: { type?: string; content?: unknown; streamIds?: string[] };
  access?: CmcAccessLike;
  cmc?: { memberMintLock?: string };
};
type MwNext = (err?: unknown) => void;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown;

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function createMemberAccessServerOwnedFieldsHook (): Middleware {
  return function cmcMemberAccessServerOwnedFields (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event?.type !== C.ET_MEMBER_ACCESS || !isPlainObject(event.content)) return next();
    for (const field of [...C.CMC_SERVER_OWNED_FIELDS, ...C.MEMBER_ACCESS_SERVER_OWNED_FIELDS]) {
      delete event.content[field];
    }
    next();
  };
}

type GateHookDeps = {
  errors: ErrorFactory;
  mall: MallLike;
  options: MemberAccessOptions;
  registry: MemberMintRegistry;
  logger?: CmcLogger;
};

function createMemberAccessGateHook (deps: GateHookDeps): Middleware {
  return async function cmcMemberAccessGate (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event?.type !== C.ET_MEMBER_ACCESS) return next();
    const userId = context?.user?.id;
    if (userId == null) return next();
    const access = context.access;
    if (access?.clientData?.cmc?.role !== C.ROLE_MEMBER || typeof access.id !== 'string') {
      return next(deps.errors.invalidOperation(
        'A member access is asked through a membership access of the group',
        { id: CmcErrorIds.MEMBER_ACCESS_NOT_MEMBER }
      ));
    }
    if (!deps.registry.hit(access.id)) {
      return next(deps.errors.invalidOperation(
        'Too many member access requests for this membership; ask again after a minute',
        { id: CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED }
      ));
    }
    let gate;
    try {
      gate = await resolveMintTarget({
        userId,
        membershipAccess: access,
        triggerStreamIds: event.streamIds,
        content: isPlainObject(event.content) ? event.content : null,
        deps: { mall: deps.mall, options: deps.options, logger: deps.logger },
      });
    } catch (err: unknown) {
      deps.logger?.warn?.('cmc/memberAccessGate: the gate threw', { error: String((err as Error)?.message || err) });
      return next(err);
    }
    if (!gate.ok) {
      return next(deps.errors.invalidOperation('The member access cannot be granted: ' + gate.reason, { id: gate.reason, ...(gate.detail ?? {}) }));
    }
    const key = MemberMintRegistry.keyOf(access.id, gate.target.relationshipAccess.id);
    if (!deps.registry.acquire(key)) {
      return next(deps.errors.invalidOperation(
        'A member access for this patient is being minted; ask again shortly',
        { id: CmcErrorIds.MEMBER_ACCESS_IN_FLIGHT }
      ));
    }
    context.cmc = context.cmc ?? {};
    context.cmc.memberMintLock = key;
    next();
  };
}

export { createMemberAccessServerOwnedFieldsHook, createMemberAccessGateHook };
