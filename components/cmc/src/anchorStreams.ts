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

  // Walk up the scope ancestry under :_cmc:apps and ensure each intermediate
  // exists. The accepter typically writes the trigger on the bare app
  // parent (e.g. `:_cmc:apps:my-app`) — they don't have the requester's
  // per-request sub-paths (e.g. `:_cmc:apps:my-app:study-1`) yet. Without
  // this walk, the very first anchor stream-create would fail on
  // "unknown parent" because we'd jump straight to e.g.
  // `:_cmc:apps:my-app:study-1:chats` whose parent is missing.
  const created: string[] = [];
  const ancestors = scopeAncestors(scopeStreamId);
  for (const sid of ancestors) {
    const failure = await ensureStream(mall, userId, sid, parentOf(sid));
    if (failure != null) {
      return { ok: false, created, failedStreamId: sid, failureMessage: failure };
    }
  }

  for (const sid of [chatsParent, collectorsParent, chatStream, collectorStream]) {
    const failure = await ensureStream(mall, userId, sid, parentOf(sid));
    if (failure != null) {
      return { ok: false, created, failedStreamId: sid, failureMessage: failure };
    }
    created.push(sid);
  }
  return { ok: true, created };
}

/**
 * For a scopeStreamId like `:_cmc:apps:my-app:study-1:cohort-2`, return
 * `[':_cmc:apps:my-app', ':_cmc:apps:my-app:study-1', ':_cmc:apps:my-app:study-1:cohort-2']`.
 * Returns the ordered list of intermediates UNDER `:_cmc:apps`, so callers
 * can ensure each parent exists before attempting the leaf anchor streams.
 * The reserved root + apps parent are auto-created by the lazy-provision
 * code-path elsewhere; we only walk under that.
 */
function scopeAncestors (scopeStreamId: string): string[] {
  const prefix = C.NS_APPS + ':';
  if (!scopeStreamId.startsWith(prefix)) return [];
  const remainder = scopeStreamId.substring(prefix.length); // e.g. 'my-app:study-1:cohort-2'
  const parts = remainder.split(':');
  const out: string[] = [];
  let acc = C.NS_APPS;
  for (const p of parts) {
    acc = acc + ':' + p;
    out.push(acc);
  }
  return out;
}

async function ensureStream (mall: MallLike, userId: string, id: string, parentId: string): Promise<string | null> {
  try {
    await mall.streams.create(userId, {
      id,
      name: id.split(':').pop() ?? id,
      parentId,
    });
    return null;
  } catch (err: any) {
    const code = err?.id || err?.code || err?.errorId;
    if (code === 'stream-already-exists' || code === 'item-already-exists' ||
        /already.*exist/i.test(String(err?.message || ''))) {
      return null;
    }
    return String(err?.message || err);
  }
}

function parentOf (streamId: string): string {
  const idx = streamId.lastIndexOf(':');
  if (idx <= 0) return streamId;
  return streamId.substring(0, idx);
}

export {
  provisionAnchorStreams,
  scopeAncestors,
};
