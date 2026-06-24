/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — events.create middleware that gates Bucket-1 lifecycle
 * triggers (consent/accept-cmc, consent/scope-update-cmc,
 * consent/revoke-cmc) to require a personal token.
 *
 * Bucket-1 triggers either mint a local data-grant access (`accept`),
 * mutate an existing counterparty access (`scope-update`), or delete
 * the access pair (`revoke`). The plugin's orchestrator treats the
 * trigger event as "the user clicked the action in the consent UI"
 * and acts with full authority — but a non-personal token can be
 * held by any app the user authorized for the trigger stream, with
 * no guarantee the user was present or aware of the offer being
 * accepted. Personal tokens are only minted via the login flow, so
 * requiring one enforces user-presence + user-authentication at the
 * moment the trigger is written.
 *
 * Apps without a personal token should hand off to app-web-auth3 via
 * @pryv/cmc.requestAccept (or .requestRevoke / .requestScopeUpdate).
 *
 * Out of gate:
 *   - consent/request-cmc — publishing an offer is chain-checked on
 *     the requester side at access-mint time (capability access perms
 *     ⊆ requester's own held perms).
 *   - consent/refuse-cmc — no access mutation; sender-attributable
 *     but no escalation surface.
 *   - consent/invalidate-link-cmc — closes an open-link capability
 *     to new accepters; existing relationships untouched. Not a
 *     destructive state change on data-grants.
 *   - consent/scope-request-cmc — collector proposes scope change to
 *     user; user's data-grant is not mutated by this event (the
 *     follow-up consent/scope-update-cmc IS gated).
 *   - message/chat-cmc, notification/alert-cmc, notification/ack-cmc —
 *     communication only.
 */

const C = require('./constants.ts');
const { CmcErrorIds } = require('./errorIds.ts');

const GATED_EVENT_TYPES = new Set<string>([
  C.ET_ACCEPT,
  C.ET_SYSTEM_SCOPE_UPDATE,
  C.ET_REVOKE,
]);

type ErrorFactory = {
  // Matches the existing CMC plugin pattern (inboxWriteHook,
  // forge-prevention hooks). 400 invalid-operation with the
  // CMC-specific id under error.data.id is the convention; clients
  // pattern-match on data.id for token-class rejection UX.
  invalidOperation: (message: string, details?: Record<string, unknown>) => Error;
};

type Deps = { errors: ErrorFactory };

type AccessLike = {
  isPersonal?: () => boolean;
  type?: string;
  clientData?: { cmc?: { role?: string; kind?: string } } | null;
  [k: string]: unknown;
};

type MwContext = {
  newEvent?: { streamIds?: string[]; type?: string; content?: Record<string, unknown> | null; [k: string]: unknown };
  access?: AccessLike;
  [k: string]: unknown;
};
type MwNext = (err?: unknown) => void;
type Middleware = (context: MwContext, params: unknown, result: unknown, next: MwNext) => unknown | Promise<unknown>;

/**
 * Returns the middleware. Inserts at the same point in the events.create
 * chain as the other CMC hooks (after verifyCanCreateEventsOnStream,
 * before the orchestration dispatch).
 */
function createCmcAcceptAccessGateHook (deps: Deps): Middleware {
  return function cmcAcceptAccessGateHook (context, _params, _result, next) {
    const event = context?.newEvent;
    if (event == null || typeof event.type !== 'string') return next();
    if (!GATED_EVENT_TYPES.has(event.type)) return next();

    // Plugin-managed access exemption — pass through writes from
    // accesses the CMC plugin itself created and uses internally:
    //   - clientData.cmc.kind === 'capability' — the one-shot capability
    //     access (set at mint in capability.ts) used by the recipient's
    //     plugin to POST the accept event into the requester's
    //     :_cmc:_internal:responses:<capId> stream. The accept reaches
    //     the requester's mall as a write through this access; without
    //     the exemption the gate would block the cross-platform
    //     handshake (the capability access is `shared`, never
    //     personal).
    //   - clientData.cmc.role === 'counterparty' — the bidirectional
    //     shared access pair created at acceptance, used by each side's
    //     plugin to deliver subsequent protocol events (back-channel
    //     info, inbox mirrors). These also carry consent/* event types
    //     into the peer's mall and must pass through.
    // The user-initiated lifecycle triggers (the threat surface the
    // gate exists to close) come from a user's own personal/app/shared
    // access on their own account — NEVER from an access carrying
    // either of these plugin-stamped markers in clientData.cmc.
    const access = context?.access;
    const cmcMeta = access?.clientData?.cmc;
    if (cmcMeta?.kind === 'capability' || cmcMeta?.role === 'counterparty') {
      return next();
    }

    // Reuse the existing AccessLogic primitive — no parallel isPersonal
    // implementation. If for any reason `access` or `isPersonal` is
    // missing (defensive: shouldn't happen in production middleware
    // chains), fall back to the access.type === 'personal' check.
    const isPersonal = typeof access?.isPersonal === 'function'
      ? access.isPersonal()
      : access?.type === 'personal';
    if (isPersonal) return next();

    return next(deps.errors.invalidOperation(
      'Writing "' + event.type + '" requires a personal access token. ' +
      'Apps without a personal token should hand off to app-web-auth3 ' +
      'via @pryv/cmc helpers (requestAccept / requestRevoke / requestScopeUpdate).',
      { id: CmcErrorIds.ACCEPT_REQUIRES_PERSONAL_TOKEN, eventType: event.type }
    ));
  };
}

export { createCmcAcceptAccessGateHook, GATED_EVENT_TYPES };
