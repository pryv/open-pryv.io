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
  let chosen: AccessLike | null = null;
  const fromHostSlug = slugMod.slugifyHost(fromHost);
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== fromUsername) continue;
    if (slugMod.slugifyHost(cp.host) !== fromHostSlug) continue;
    if (typeof c.appCode === 'string' && c.appCode.length > 0 &&
        cmc.appCode != null && cmc.appCode !== c.appCode) continue;
    chosen = acc;
    break;
  }
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
