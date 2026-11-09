/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createHash } from 'node:crypto';
import { clientFor } from 'messages/src/cluster_kv.ts';

/**
 * The claim the CMC responses-stream write-hook takes on a single-use link
 * for the accept it lets through (see the cmc plugin's
 * capabilityResponseHook.ts). Create-if-absent in `cluster_kv`, shared by the
 * API workers of this core: a link's capability access lives on its
 * requester's account, so every accept of that link is written on one core.
 * The key is a hash of the account id and the capability id; the value names
 * the accepter, whose own re-delivery may pass again. The claim is held
 * CLAIM_TTL_MS, longer than an accept takes to be handled and the link
 * consumed; if the accept fails before that, the link takes other accepters
 * once the claim expires.
 */

const CLAIM_TTL_MS = 60 * 1000;
const NAMESPACE = 'cmc-accept-claim/';

type KvClient = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown }) => Promise<boolean>;
};

let kvClient: KvClient | null = null;
function getKv (): KvClient {
  if (kvClient == null) kvClient = clientFor() as KvClient;
  return kvClient;
}

/**
 * True when this accept took the link, or `accepter` already holds it; false
 * when another accepter holds it. An empty `accepter` (none named) matches
 * nobody, itself included.
 */
async function claimSingleUseAccept (userId: string, capabilityId: string, accepter: string): Promise<boolean> {
  const key = NAMESPACE + createHash('sha256').update(userId + '/' + capabilityId).digest('hex').slice(0, 32);
  if (await getKv().set(key, { accepter }, { ttlMs: CLAIM_TTL_MS, ifEquals: null }) === true) return true;
  if (accepter === '') return false;
  const held = await getKv().get(key) as { accepter?: unknown } | null;
  return held?.accepter === accepter;
}

export { claimSingleUseAccept, CLAIM_TTL_MS };
