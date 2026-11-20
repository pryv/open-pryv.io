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
 */

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

export { STREAM_LIMIT_DEFAULTS, readStreamLimits, measureTree, streamTreeLimitProblem };
export type { StreamLimits };
