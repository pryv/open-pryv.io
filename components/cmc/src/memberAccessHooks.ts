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
 *     handleMemberAccess.resolveMintTarget), plus the per-membership budgets
 *     and the in-flight lock per (membership, relationship). In this order:
 *     one ask token (every request, never given back), the gate, the lock,
 *     one mint token. A spent mint budget still admits an ask whose pair has
 *     a live record (a probable reuse, which mints nothing; should it need a
 *     new child after all, the handler takes the token then). A spent budget
 *     is a 429 with `Retry-After`. Left on `context.cmc` for the dispatch
 *     middleware: the lock key (`memberMintLock`, released once the mint
 *     settled), the mint reservation (`memberMintReservation`, given back
 *     unless a child was minted) and what the gate resolved
 *     (`memberMintTarget`, so the handler does not resolve it again).
 */

import * as C from './constants.ts';
import { CmcErrorIds } from './errorIds.ts';
import { resolveMintTarget } from './handleMemberAccess.ts';
import * as ledger from './memberLedger.ts';
import { MemberMintRegistry } from './memberMintRegistry.ts';
import type { MemberAccessOptions, MintTarget } from './handleMemberAccess.ts';
import type { MintReservation } from './memberMintRegistry.ts';
import type { CmcAccessLike, CmcLogger, MallLike } from './_types.ts';

type ErrorFactory = {
  invalidOperation: (message: string, details?: Record<string, unknown>) => Error;
  tooManyAttempts: (retryAfterSeconds?: number, options?: { message?: string; data?: unknown }) => Error;
};

type MwContext = {
  user?: { id?: string };
  newEvent?: { type?: string; content?: unknown; streamIds?: string[] };
  access?: CmcAccessLike;
  cmc?: { memberMintLock?: string; memberMintReservation?: MintReservation; memberMintTarget?: MintTarget };
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
    const rateLimited = (retryAfterSeconds: number, what: string) => deps.errors.tooManyAttempts(retryAfterSeconds, {
      message: 'Too many ' + what + ' for this membership; ask again in ' + retryAfterSeconds + ' s',
      data: { id: CmcErrorIds.MEMBER_ACCESS_RATE_LIMITED, retryAfterSeconds },
    });
    const ask = await deps.registry.reserve('ask', access.id);
    if (!ask.ok) return next(rateLimited(ask.retryAfterSeconds, 'member access requests'));
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
    const relationshipAccessId = gate.target.relationshipAccess.id;
    const key = MemberMintRegistry.keyOf(access.id, relationshipAccessId);
    if (!deps.registry.acquire(key)) {
      return next(deps.errors.invalidOperation(
        'A member access for this patient is being minted; ask again shortly',
        { id: CmcErrorIds.MEMBER_ACCESS_IN_FLIGHT }
      ));
    }
    let reservation: MintReservation;
    try {
      const mint = await deps.registry.reserve('mint', access.id);
      reservation = mint.ok ? { membershipAccessId: access.id, held: true, via: mint.via } : { membershipAccessId: access.id, held: false };
      if (!mint.ok && !(await hasLiveRecord(userId, access.id, relationshipAccessId))) {
        deps.registry.release(key);
        return next(rateLimited(mint.retryAfterSeconds, 'new member accesses'));
      }
    } catch (err: unknown) {
      deps.registry.release(key);
      return next(err);
    }
    context.cmc = context.cmc ?? {};
    context.cmc.memberMintLock = key;
    context.cmc.memberMintReservation = reservation;
    context.cmc.memberMintTarget = gate.target;
    next();
  };

  /** Whether the pair's ledger record names a live child (read by id). */
  async function hasLiveRecord (userId: string, membershipAccessId: string, relationshipAccessId: string): Promise<boolean> {
    try {
      const record = await ledger.findRecord({ mall: deps.mall, logger: deps.logger }, userId, membershipAccessId, relationshipAccessId);
      return record?.state === 'live';
    } catch (_e) {
      return false;
    }
  }
}

export { createMemberAccessServerOwnedFieldsHook, createMemberAccessGateHook };
