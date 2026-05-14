/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — anchor-stream provisioning helper.
 *
 * At acceptance time, BOTH sides need four anchor streams under the
 * app scope:
 *
 *   :_cmc:apps:<app>:[<path>:]chats              (parent)
 *   :_cmc:apps:<app>:[<path>:]chats:<peer-slug>
 *   :_cmc:apps:<app>:[<path>:]collectors         (parent)
 *   :_cmc:apps:<app>:[<path>:]collectors:<peer-slug>
 *
 * Plugin auto-creates these so chat + system flows can start
 * immediately. Idempotent — stream-already-exists is treated as
 * success (this re-runs cleanly on a re-delivery or retry).
 */

const C = require('./constants.ts');

type MallLike = {
  streams: { create: (userId: string, params: any) => Promise<any> };
};

type ProvisionResult = {
  ok: boolean;
  created: string[];
  failedStreamId?: string;
  failureMessage?: string;
};

/**
 * Create the four anchor streams for a (user, scope, counterparty) tuple.
 *
 * scopeStreamId: e.g. `:_cmc:apps:my-app:campaign-2026`
 * peerSlug: e.g. `alice--pryv-me`
 *
 * Returns the created stream-ids on success (including those that
 * already existed — treated as success). Failure stops at the first
 * non-idempotent error and returns the offending stream-id.
 */
async function provisionAnchorStreams (params: {
  userId: string;
  scopeStreamId: string;
  peerSlug: string;
  mall: MallLike;
}): Promise<ProvisionResult> {
  const { userId, scopeStreamId, peerSlug, mall } = params;
  const chatsParent = C.chatsParentUnder(scopeStreamId);
  const collectorsParent = C.collectorsParentUnder(scopeStreamId);
  const chatStream = C.chatStreamUnder(scopeStreamId, peerSlug);
  const collectorStream = C.collectorStreamUnder(scopeStreamId, peerSlug);

  const created: string[] = [];
  for (const sid of [chatsParent, collectorsParent, chatStream, collectorStream]) {
    try {
      await mall.streams.create(userId, {
        id: sid,
        name: sid.split(':').pop() ?? sid,
        parentId: parentOf(sid),
      });
      created.push(sid);
    } catch (err: any) {
      const code = err?.id || err?.code || err?.errorId;
      if (code === 'stream-already-exists' || /already.*exist/i.test(String(err?.message || ''))) {
        created.push(sid);
        continue;
      }
      return {
        ok: false,
        created,
        failedStreamId: sid,
        failureMessage: String(err?.message || err),
      };
    }
  }
  return { ok: true, created };
}

function parentOf (streamId: string): string {
  const idx = streamId.lastIndexOf(':');
  if (idx <= 0) return streamId;
  return streamId.substring(0, idx);
}

export {
  provisionAnchorStreams,
};
