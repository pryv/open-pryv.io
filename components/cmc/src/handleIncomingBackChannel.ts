/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
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

type Counterparty = { username: string; host: string };

type AccessLike = {
  id: string;
  clientData?: any;
};

type MallLike = {
  accesses: {
    get?: (userId: string, params?: any) => Promise<AccessLike[]>;
    update?: (userId: string, params: any) => Promise<any>;
  };
};

type IncomingBackChannelResult =
  | {
      ok: true;
      dataGrantAccessId: string;
      counterparty: Counterparty;
    }
  | {
      ok: false;
      reason: string;
      detail?: any;
    };

async function handleIncomingBackChannel (params: {
  userId: string;
  event: { type: string; content: any; streamIds?: string[] };
  deps: {
    mall: MallLike;
    logger?: { debug: Function; warn: Function };
  };
}): Promise<IncomingBackChannelResult> {
  const { userId, event, deps } = params;

  if (event.type !== C.ET_BACK_CHANNEL) {
    return { ok: false, reason: 'cmc-back-channel-wrong-type', detail: { type: event.type } };
  }

  const c = event.content || {};
  const from = c.from;
  if (from == null || typeof from.username !== 'string' || typeof from.host !== 'string') {
    return { ok: false, reason: 'cmc-back-channel-from-missing' };
  }
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
  const fromHostSlug = slugMod.slugifyHost(from.host);
  for (const acc of accesses) {
    const cmc = (acc as any)?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== from.username) continue;
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

  const existingCmc = (chosen as any).clientData?.cmc || {};
  const existingCp = existingCmc.counterparty || {};
  const updatedCp = {
    ...existingCp,
    username: from.username,
    host: from.host,
    apiEndpoint,
    remoteChatStreamId: remoteChatStreamId ?? existingCp.remoteChatStreamId,
    remoteCollectorStreamId: remoteCollectorStreamId ?? existingCp.remoteCollectorStreamId,
  };
  const updatedClientData = {
    ...((chosen as any).clientData || {}),
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
  } catch (err: any) {
    return {
      ok: false,
      reason: 'cmc-back-channel-update-failed',
      detail: { accessId: chosen.id, message: String(err?.message || err) },
    };
  }

  return {
    ok: true,
    dataGrantAccessId: chosen.id,
    counterparty: { username: from.username, host: from.host },
  };
}

export {
  handleIncomingBackChannel,
};
