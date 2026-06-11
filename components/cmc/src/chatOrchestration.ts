/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
import type { CmcLogger } from './_types.ts';
import type { DeliverResult } from './outbound.ts';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — chat orchestration primitives.
 *
 * Chat trigger: an app writes `message/chat-cmc` to its OWN per-counterparty
 * chat stream:
 *
 *   :_cmc:apps:<app-code>:[<user-path>:]chats:<counterparty-slug>
 *
 * Plugin orchestration:
 *   1. Parse the trigger stream-id to extract counterparty-slug.
 *   2. Find the counterparty-access in the user's accesses table
 *      (filtered by clientData.cmc.role='counterparty' + counterparty.{username,host}).
 *   3. Read the remote chat stream-id + remote apiEndpoint from the access's
 *      clientData.cmc.counterparty.{remoteChatStreamId, apiEndpoint}.
 *   4. POST `message/chat-cmc` to the remote chat stream via outbound.postToPeer.
 *
 * This module exposes those steps as separate primitives. The full
 * handleChat loop (which runs from the dispatch middleware) wires them
 * together — added in a later slice.
 *
 * NOTE on the schema gap: the recipient's chats stream-id needs to be
 * stored on the requester's back-channel access at acceptance time. That
 * write happens in the requester-side accept-response handler (Phase E).
 * For now, callers pass remoteChatStreamId explicitly.
 */

const C = require('./constants.ts');
const slugMod = require('./slug.ts');
const outbound = require('./outbound.ts');

// Matches the trailing :chats:<counterparty-slug> portion of a chat stream-id.
// We also capture the prefix (everything before :chats) as the "request scope".
const CHAT_STREAM_ID_RE = /^(:_cmc:apps:[^:]+(?::[^:]+)*):chats:([a-z0-9-]+--[a-z0-9-]+)$/;

type ParsedChatStream = {
  appCode: string;
  scopeStreamId: string;       // the prefix (e.g. :_cmc:apps:my-app:study-A)
  counterpartySlug: string;
  counterparty: { username: string; hostSlug: string };
};

/**
 * Parse a chat trigger stream-id into its components. Returns null if the
 * id doesn't match the expected `:_cmc:apps:<app>:[...:]chats:<slug>`
 * shape.
 */
function parseChatStreamId (streamId: string): ParsedChatStream | null {
  if (typeof streamId !== 'string') return null;
  const m = streamId.match(CHAT_STREAM_ID_RE);
  if (m == null) return null;
  const scopeStreamId = m[1];
  const counterpartySlug = m[2];
  let counterparty;
  try {
    counterparty = slugMod.parseCounterpartySlug(counterpartySlug);
  } catch (_e) {
    return null;
  }
  const appCode = C.getAppCode(scopeStreamId);
  if (appCode == null) return null;
  return { appCode, scopeStreamId, counterpartySlug, counterparty };
}

type Counterparty = { username: string; host: string };

import type { CmcAccessLike as AccessLike, MallAccessesLike } from './_types.ts';

type FindAccessParams = {
  userId: string;
  counterparty: Counterparty;
  mall: { accesses: MallAccessesLike };
};

/**
 * Find the user's CMC counterparty-access matching the given counterparty
 * (username + host). Returns the matching access, or null if none found.
 *
 * If the user has multiple counterparty-accesses to the same person (one
 * per app), this returns the FIRST match. Caller may filter further by
 * appCode if app-specific routing is required.
 */
async function findCounterpartyAccess (params: FindAccessParams): Promise<AccessLike | null> {
  const { userId, counterparty, mall } = params;
  const accesses = await mall.accesses.get(userId, {});
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username === counterparty.username && cp.host === counterparty.host) {
      return acc;
    }
  }
  return null;
}

/**
 * Filter an access list to a specific app-code. Useful when the user has
 * multiple counterparty-accesses to the same person across different apps
 * and we want the one for the current app.
 */
async function findCounterpartyAccessForApp (params: FindAccessParams & { appCode: string }): Promise<AccessLike | null> {
  const { userId, counterparty, mall, appCode } = params;
  const accesses = await mall.accesses.get(userId, {});
  for (const acc of accesses) {
    const cmc = acc?.clientData?.cmc;
    if (cmc?.role !== 'counterparty') continue;
    const cp = cmc?.counterparty;
    if (cp == null) continue;
    if (cp.username !== counterparty.username || cp.host !== counterparty.host) continue;
    if (cmc?.appCode != null && cmc.appCode !== appCode) continue;
    return acc;
  }
  return null;
}

type DeliverChatParams = {
  remoteApiEndpoint: string;
  remoteChatStreamId: string;
  content: string;
  selfIdentity: Counterparty;
  deps: {
    fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>;
    timeoutMs?: number;
    logger?: CmcLogger;
  };
};

/**
 * POST a `message/chat-cmc` event to the counterparty's chat stream via the
 * stored back-channel apiEndpoint.
 *
 * Returns outbound.postToPeer's discriminated-union result.
 */
async function deliverChatToPeer (params: DeliverChatParams): Promise<DeliverResult> {
  const { remoteApiEndpoint, remoteChatStreamId, content, selfIdentity, deps } = params;
  return outbound.postToPeer({
    apiEndpoint: remoteApiEndpoint,
    path: 'events',
    body: {
      streamIds: [remoteChatStreamId],
      type: C.ET_CHAT,
      content: {
        from: selfIdentity,
        content,
      },
    },
    deps,
  });
}

export {
  CHAT_STREAM_ID_RE,
  parseChatStreamId,
  findCounterpartyAccess,
  findCounterpartyAccessForApp,
  deliverChatToPeer,
};
