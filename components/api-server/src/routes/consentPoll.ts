/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Outcome-driven poll for the CMC consent handshake behind an OAuth2
 * authorization.
 *
 * The dispatch that turns a `consent/accept-cmc` trigger into a durable
 * data-grant is fire-and-forget w.r.t. the events.create response. It creates
 * the data-grant access FIRST (the delivered accept must carry the grant's
 * apiEndpoint), delivers the accept to the peer, and — when the peer refuses
 * (an invalidated or consumed link, or an already-recorded accepter) — ROLLS
 * THE DATA-GRANT BACK. A consumer that trusts the data-grant the instant it
 * appears can therefore observe the transient grant during that create-to-
 * rollback window and mint an OAuth access against a consent that is about to
 * be refused. Under CPU contention the window widens and the race is lost.
 *
 * The trigger's terminal status is the single source of truth: the dispatch
 * stamps `content.status = 'completed'` (plus `dataGrantAccessId`) on success
 * and `content.status = 'failed'` (plus `failure`) on refusal. This poll keys
 * on that status and resolves the data-grant only once the trigger reports
 * `completed`, so the transient-grant window is never observed.
 */
import { CAPABILITY_REFUSAL_IDS } from 'cmc/src/errorIds.ts';

type ConsentFailure = { reason?: unknown; detail?: unknown };

export type ConsentTrigger = {
  status?: unknown;
  failure?: ConsentFailure;
  dataGrantAccessId?: unknown;
};

export type AwaitConsentDeps<G> = {
  /** Read the trigger's current content ({} when the trigger has no content yet). */
  getTrigger: () => Promise<ConsentTrigger>;
  /**
   * Resolve the durable data-grant once the trigger reports `completed`.
   * Returns null when the grant cannot (yet) be found; the caller treats a
   * completed-but-missing grant as an inconsistency, not a wait state.
   */
  resolveDataGrant: (trigger: ConsentTrigger) => Promise<G | null>;
  deadlineMs: number;
  sleepMs: number;
  /** Injectable clock/sleep so the loop is unit-testable without wall-clock time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional diagnostic suffix (e.g. `acceptEventId=...`) for error messages. */
  describe?: string;
};

/**
 * The error to throw when the trigger reports `status: 'failed'`.
 *
 * A peer 4xx refusal (`cmc-handler-delivery-rejected`, or the capability's own
 * refusal id reported in its place, e.g. `cmc-capability-invalidated`) is a
 * client-correctable condition, surfaced as a typed `cmc-accept-rejected` error
 * carrying the peer's specific reason id so the OAuth2 accept route returns 400
 * invalid_grant rather than a bare 500. The peer's id rides in `error.data.id`;
 * `error.id` is only the generic Pryv error class.
 * Any other failure reason (e.g. a delivery timeout) stays a generic throw.
 */
export function buildConsentRejectionError (failure: ConsentFailure | undefined): Error {
  if (failure?.reason === 'cmc-handler-delivery-rejected' ||
      (typeof failure?.reason === 'string' && CAPABILITY_REFUSAL_IDS.has(failure.reason))) {
    const errObj = (failure?.detail as { body?: { error?: { id?: unknown; data?: { id?: unknown } } } } | undefined)?.body?.error;
    const peerErrorId =
      typeof errObj?.data?.id === 'string'
        ? errObj.data.id
        : typeof errObj?.id === 'string'
          ? errObj.id
          : String(failure.reason);
    const e = new Error('oauth2.createAccess: consent accept rejected by peer: ' + peerErrorId) as Error & { code?: string; cmcErrorId?: string };
    e.code = 'cmc-accept-rejected';
    e.cmcErrorId = peerErrorId;
    return e;
  }
  return new Error('oauth2.createAccess: consent accept failed' +
    (failure?.reason != null ? ': ' + String(failure.reason) : ''));
}

/**
 * Poll the consent trigger until it reaches a terminal status, then either
 * return the resolved data-grant (`completed`) or throw (`failed` / timeout).
 * Never returns a data-grant observed while the trigger is still in flight.
 */
export async function awaitConsentOutcome<G> (deps: AwaitConsentDeps<G>): Promise<G> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const suffix = deps.describe != null ? ', ' + deps.describe : '';
  const startedAt = now();
  const deadline = startedAt + deps.deadlineMs;
  let polls = 0;
  let lastStatus: unknown;
  while (true) {
    polls++;
    const trigger = (await deps.getTrigger()) ?? {};
    lastStatus = trigger.status;
    if (trigger.status === 'failed') {
      throw buildConsentRejectionError(trigger.failure);
    }
    if (trigger.status === 'completed') {
      const grant = await deps.resolveDataGrant(trigger);
      if (grant != null) return grant;
      throw new Error(
        'oauth2.createAccess: consent trigger reported completed but no data-grant was found after ' +
        (now() - startedAt) + 'ms (' + polls + ' polls' + suffix + ')');
    }
    if (now() > deadline) {
      throw new Error(
        'oauth2.createAccess: timed out waiting for the consent outcome after ' +
        (now() - startedAt) + 'ms (' + polls + ' polls, last trigger status=' +
        JSON.stringify(lastStatus) + suffix + ')');
    }
    await sleep(deps.sleepMs);
  }
}
