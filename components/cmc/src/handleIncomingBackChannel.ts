/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accepter-side handler for `consent/back-channel-cmc` events
 * arriving on the accepter's `:_cmc:inbox`.
 *
 * Context: handleAccept on the accepter creates the data-grant access
 * with `clientData.cmc.counterparty = {username, host}` but no
 * apiEndpoint / remote stream-ids — the requester hasn't minted the
 * back-channel yet. After handleIncomingAccept on the requester mints
 * it, the requester POSTs `consent/back-channel-cmc` to the accepter's inbox
 * via the data-grant URL (which carries `:_cmc:inbox` create-only
 * specifically for this handshake step). This handler picks that event
 * up, finds the matching data-grant access (by counterparty username +
 * host), and stamps:
 *
 *   clientData.cmc.counterparty.apiEndpoint
 *   clientData.cmc.counterparty.remoteChatStreamId
 *   clientData.cmc.counterparty.remoteCollectorStreamId
 *
 * After this update, the accepter's chat / system handlers can resolve
 * a remote endpoint to POST to (the requester's back-channel URL on
 * the requester's side) — completing the bidirectional channel.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');

type Counterparty = {
  username: string;
  host: string;
  apiEndpoint?: string;
  remoteChatStreamId?: string;
  remoteCollectorStreamId?: string;
};

import type { CmcAccessLike as AccessLike, MallAccessesLike, CmcClientData, CounterpartyRef } from './_types.ts';
type AccessClientData = { cmc?: CmcClientData; [k: string]: unknown };

type AccessGetParams = Record<string, unknown>;
type AccessUpdateParams = {
  id: string;
  update: { clientData: AccessClientData };
};

type MallLike = { accesses: MallAccessesLike };

type BackChannelEventContent = {
  from?: { username?: unknown; host?: unknown };
  apiEndpoint?: unknown;
  remoteChatStreamId?: string;
  remoteCollectorStreamId?: string;
  appCode?: string;
};

type IncomingBackChannelResult =
  | {
      ok: true;
      dataGrantAccessId: string;
      counterparty: { username: string; host: string };
    }
  | {
      ok: false;
      reason: string;
      detail?: unknown;
    };

/**
 * Choose which data-grant a back-channel delivery belongs to, among the
 * grants that already matched the counterparty identity (username + host).
 *
 * `appCode` is a DISAMBIGUATOR, never a rejector. The two sides derive it
 * independently — the sender falls back to the literal `'unknown'` when it
 * cannot resolve its own request scope — so the values legitimately diverge
 * on a healthy handshake. Rejecting on mismatch drops the only candidate,
 * leaving `backChannelApiEndpoint` null forever and every later revoke on
 * that relationship silently undeliverable.
 *
 * Layered so that nothing which already worked changes behaviour:
 *   1. the FIRST candidate whose appCode is compatible with the delivery
 *      (equal, or not recorded on either side) — predicate- and
 *      order-identical to the previous inline scan, so established
 *      relationships keep resolving to the same grant.
 *   2. only when no candidate is compatible — the case that used to be
 *      rejected outright, so no behaviour can depend on it — take a
 *      candidate rather than dropping the delivery, preferring one whose
 *      back-channel is still unset. The ambiguity is logged.
 *
 * Note this does NOT make appCode a per-relationship key: it is derived from
 * the app scope, so several relationships with one peer under one app remain
 * indistinguishable here and in the outbound selectors. That defect is
 * separate and pinned by the skipped [CMCHS-DUP] handshake tests.
 */
function pickDataGrant (
  candidates: AccessLike[],
  deliveryAppCode: string | undefined,
  logger?: CmcLogger,
): AccessLike | null {
  if (candidates.length === 0) return null;

  const appCodeCompatible = (acc: AccessLike): boolean => {
    const own = acc.clientData?.cmc?.appCode;
    if (own == null) return true;
    if (typeof deliveryAppCode !== 'string' || deliveryAppCode.length === 0) return true;
    return own === deliveryAppCode;
  };

  const compatible = candidates.find(appCodeCompatible);
  if (compatible != null) return compatible;

  const chosen = candidates.find((a) => a.clientData?.cmc?.backChannelApiEndpoint == null)
    ?? candidates[0];
  logger?.warn?.('cmc: back-channel delivery matches no data-grant with a compatible ' +
    'appCode; storing it rather than dropping it, since the two sides derive appCode ' +
    'independently and a dropped delivery leaves the relationship undeliverable', {
    appCode: deliveryAppCode,
    candidateIds: candidates.map((a) => a.id),
    chosen: chosen.id,
  });
  return chosen;
}

async function handleIncomingBackChannel (params: {
  userId: string;
  event: { type: string; content: BackChannelEventContent; streamIds?: string[] };
  deps: {
    mall: MallLike;
    logger?: CmcLogger;
  };
}): Promise<IncomingBackChannelResult> {
  const { userId, event, deps } = params;

  if (event.type !== C.ET_BACK_CHANNEL) {
    return { ok: false, reason: 'cmc-back-channel-wrong-type', detail: { type: event.type } };
  }

  const c: BackChannelEventContent = event.content || {};
  const from = c.from;
  if (from == null || typeof from.username !== 'string' || typeof from.host !== 'string') {
    return { ok: false, reason: 'cmc-back-channel-from-missing' };
  }
  const fromUsername: string = from.username;
  const fromHost: string = from.host;
  const apiEndpoint = c.apiEndpoint;
  if (typeof apiEndpoint !== 'string' || apiEndpoint.length === 0) {
    return { ok: false, reason: 'cmc-back-channel-no-apiendpoint' };
  }
  const remoteChatStreamId = c.remoteChatStreamId;
  const remoteCollectorStreamId = c.remoteCollectorStreamId;

  if (typeof deps.mall.accesses.get !== 'function') {
    return { ok: false, reason: 'cmc-back-channel-mall-no-get' };
  }

  // Find the data-grant access matching this counterparty. The accepter's
  // data-grant access has clientData.cmc.role='counterparty' AND the
  // counterparty {username, host} we're being told about.
  const accesses = await deps.mall.accesses.get(userId, {});
  const fromHostSlug = slugMod.slugifyHost(fromHost);
  const candidates: AccessLike[] = [];
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== fromUsername) continue;
    if (slugMod.slugifyHost(cp.host) !== fromHostSlug) continue;
    candidates.push(acc);
  }
  const chosen: AccessLike | null = pickDataGrant(candidates, c.appCode, deps.logger);
  if (chosen == null) {
    return {
      ok: false,
      reason: 'cmc-back-channel-data-grant-not-found',
      detail: { from, appCode: c.appCode },
    };
  }

  if (typeof deps.mall.accesses.update !== 'function') {
    return { ok: false, reason: 'cmc-back-channel-mall-no-update' };
  }

  const existingCmc: CmcClientData = chosen.clientData?.cmc || {};
  const existingCp: CounterpartyRef = existingCmc.counterparty || { username: fromUsername, host: fromHost };
  const updatedCp: Counterparty = {
    ...existingCp,
    username: fromUsername,
    host: fromHost,
    apiEndpoint,
    remoteChatStreamId: remoteChatStreamId ?? existingCp.remoteChatStreamId,
    remoteCollectorStreamId: remoteCollectorStreamId ?? existingCp.remoteCollectorStreamId,
  };
  const updatedClientData: AccessClientData = {
    ...(chosen.clientData || {}),
    cmc: {
      ...existingCmc,
      counterparty: updatedCp,
      backChannelApiEndpoint: apiEndpoint,
    },
  };

  try {
    await deps.mall.accesses.update(userId, {
      id: chosen.id,
      update: { clientData: updatedClientData },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'cmc-back-channel-update-failed',
      detail: { accessId: chosen.id, message },
    };
  }

  return {
    ok: true,
    dataGrantAccessId: chosen.id,
    counterparty: { username: fromUsername, host: fromHost },
  };
}

export {
  handleIncomingBackChannel,
};
