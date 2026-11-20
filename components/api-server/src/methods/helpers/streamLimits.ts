/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bounds on an account's stream tree and on an event's stream list:
 *
 * - `limits.streams.maxDepth`: the deepest level a stream may sit at (a root
 *   stream is level 1), checked when a stream is created and when one is
 *   moved (the moved stream's whole subtree counts).
 * - `limits.streams.maxPerAccount`: the most streams one account may hold in
 *   its local store, trashed ones included.
 * - `limits.events.maxStreamIds`: the most distinct stream ids of one event.
 *
 * Every read loads and copies the account's whole tree, tree helpers walk it
 * recursively, and each of an event's stream ids is resolved against it, so
 * an unbounded tree or stream list makes every call of the account slower
 * and a deep enough chain makes them fail. A cap refuses the write that would
 * pass it; streams already stored stay readable. 0 turns a cap off.
 *
 * Soft limits: two creates of the same account running at once can each pass
 * the check and together go a few streams past a cap.
 */

import { getLogger } from '@pryv/boiler';
import { factory as errors } from 'errors';
import { storeDataUtils } from 'mall';

const STREAM_LIMIT_DEFAULTS = Object.freeze({
  maxDepth: 32,
  maxPerAccount: 10000,
  maxStreamIds: 100
});

type StreamLimits = { maxDepth: number; maxPerAccount: number; maxStreamIds: number };

type TreeNode = { id?: string; children?: TreeNode[] | null };

function countOr (value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : fallback;
}

/** The limits to apply, from the `limits` config block (defaults when absent or invalid). */
function readStreamLimits (get: (key: string) => unknown): StreamLimits {
  return {
    maxDepth: countOr(get('limits:streams:maxDepth'), STREAM_LIMIT_DEFAULTS.maxDepth),
    maxPerAccount: countOr(get('limits:streams:maxPerAccount'), STREAM_LIMIT_DEFAULTS.maxPerAccount),
    maxStreamIds: countOr(get('limits:events:maxStreamIds'), STREAM_LIMIT_DEFAULTS.maxStreamIds)
  };
}

/**
 * Walks `tree` without recursion: the number of streams in it, the level of
 * the stream `id` (root = 1; null when absent or `id` is null) and the
 * deepest level reached.
 */
function measureTree (tree: TreeNode[], id: string | null): { count: number; levelOf: number | null; height: number } {
  let count = 0;
  let levelOf: number | null = null;
  let height = 0;
  const stack: Array<{ node: TreeNode; level: number }> = tree.map((node) => ({ node, level: 1 }));
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    count++;
    if (level > height) height = level;
    if (id != null && node.id === id) levelOf = level;
    for (const child of node.children ?? []) stack.push({ node: child, level: level + 1 });
  }
  return { count, levelOf, height };
}

/**
 * Why adding `addedCount` streams, with a subtree `addedHeight` levels deep,
 * under the stream at `parentLevel` (0 = the root) would pass a cap; null when
 * it would not.
 */
function streamTreeLimitProblem (limits: StreamLimits, current: { count: number }, parentLevel: number, addedHeight: number, addedCount: number): string | null {
  if (limits.maxPerAccount > 0 && addedCount > 0 && current.count + addedCount > limits.maxPerAccount) {
    return `the account already holds ${current.count} streams, the most allowed is ${limits.maxPerAccount} (limits.streams.maxPerAccount)`;
  }
  if (limits.maxDepth > 0 && parentLevel + addedHeight > limits.maxDepth) {
    return `the stream would reach level ${parentLevel + addedHeight} of the stream tree, the deepest allowed is ${limits.maxDepth} (limits.streams.maxDepth)`;
  }
  return null;
}

type StreamsReader = { streams: { get: (userId: string, params: object) => Promise<TreeNode[]> } };

/**
 * The error to answer when adding `addedCount` streams, with a subtree
 * `addedHeight` levels deep, under `parentStreamId` (null = the root) of
 * `storeId` would pass a cap; null when it would not. Local store only: other
 * stores bound their own trees. Every creator of user streams calls it
 * (streams.create, a stream move, accesses.create / update with
 * `defaultName`); plugin-provisioned streams (CMC, delegation, the emails
 * container) are bounded by their own logic and stay exempt.
 */
async function streamTreeLimitError (mall: StreamsReader, get: (key: string) => unknown, userId: string, storeId: string, parentStreamId: string | null, addedHeight: number, addedCount: number): Promise<Error | null> {
  if (storeId !== storeDataUtils.LocalStoreId) return null;
  const limits = readStreamLimits(get);
  if (limits.maxDepth <= 0 && limits.maxPerAccount <= 0) return null;
  const tree = await mall.streams.get(userId, { id: '*', storeId, childrenDepth: -1, includeTrashed: true, hideStoreRoots: true });
  const measured = measureTree(tree, parentStreamId);
  let parentLevel = 0;
  if (parentStreamId != null) {
    if (measured.levelOf == null) {
      getLogger('stream-limits').warn(`stream tree limit: parent ${parentStreamId} not found in the tree read, depth checked as if it were a root`);
    } else {
      parentLevel = measured.levelOf;
    }
  }
  const problem = streamTreeLimitProblem(limits, measured, parentLevel, addedHeight, addedCount);
  return problem == null ? null : errors.invalidOperation('Stream tree limit: ' + problem + '.', { parentId: parentStreamId });
}

export { STREAM_LIMIT_DEFAULTS, readStreamLimits, measureTree, streamTreeLimitProblem, streamTreeLimitError };
export type { StreamLimits };
