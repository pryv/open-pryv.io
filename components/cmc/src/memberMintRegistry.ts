/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: the per-worker bookkeeping of member access
 * mints, two things in one object:
 *
 *   - a rate limit per membership access (`ratePerMinute` triggers in a
 *     sliding minute, per worker process; a 4-worker core allows four times
 *     the number);
 *   - the in-flight locks per (membership, patient relationship): a second
 *     mint for the same pair while one is running is refused, so two
 *     concurrent asks cannot both miss the ledger and both create a child.
 *
 * Both are in-process: a worker that handled the write holds the lock, and
 * the lock is released by the dispatch middleware once the mint settled. A
 * lock whose holder never released it (the write failed between the gate
 * and the dispatch) expires after `staleMs`, so a stuck key never refuses a
 * member for good.
 */

type RegistryOptions = {
  ratePerMinute: number;
  maxInFlightPerMembership: number;
  // A lock older than this is treated as released (default 60 s).
  staleMs?: number;
  now?: () => number;
};

const WINDOW_MS = 60_000;
const DEFAULT_STALE_MS = 60_000;

class MemberMintRegistry {
  private readonly options: RegistryOptions;
  private readonly hits = new Map<string, number[]>();
  private readonly locks = new Map<string, number[]>();

  constructor (options: RegistryOptions) {
    this.options = options;
  }

  private now (): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Record a mint trigger by `membershipAccessId`; false when the membership
   * already used its share of the last minute on this worker (the trigger
   * is then refused and not counted).
   */
  hit (membershipAccessId: string): boolean {
    const now = this.now();
    const list = (this.hits.get(membershipAccessId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= this.options.ratePerMinute) {
      this.hits.set(membershipAccessId, list);
      return false;
    }
    list.push(now);
    this.hits.set(membershipAccessId, list);
    return true;
  }

  /** The in-flight key of a (membership, relationship) pair. */
  static keyOf (membershipAccessId: string, relationshipAccessId: string): string {
    return membershipAccessId + ':' + relationshipAccessId;
  }

  /** Take a lock on `key`; false when `maxInFlightPerMembership` are held. */
  acquire (key: string): boolean {
    const now = this.now();
    const staleMs = this.options.staleMs ?? DEFAULT_STALE_MS;
    const held = (this.locks.get(key) ?? []).filter((t) => now - t < staleMs);
    if (held.length >= this.options.maxInFlightPerMembership) {
      this.locks.set(key, held);
      return false;
    }
    held.push(now);
    this.locks.set(key, held);
    return true;
  }

  /** Release one lock on `key` (the oldest). No-op when none is held. */
  release (key: string): void {
    const held = this.locks.get(key);
    if (held == null) return;
    held.shift();
    if (held.length === 0) this.locks.delete(key);
    else this.locks.set(key, held);
  }

  /** Locks currently held on `key` (test seam). */
  inFlight (key: string): number {
    const now = this.now();
    const staleMs = this.options.staleMs ?? DEFAULT_STALE_MS;
    return (this.locks.get(key) ?? []).filter((t) => now - t < staleMs).length;
  }
}

function createMemberMintRegistry (options: RegistryOptions): MemberMintRegistry {
  return new MemberMintRegistry(options);
}

export { MemberMintRegistry, createMemberMintRegistry };
export type { RegistryOptions as MemberMintRegistryOptions };
