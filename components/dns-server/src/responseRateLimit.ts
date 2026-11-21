/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Response rate limit of the embedded DNS over UDP (`dns.responseRateLimit`).
 *
 * A UDP source address can be forged, and every query for a random
 * `<name>.<domain>` costs PlatformDB reads (core info, then username). Each
 * client network (/24 for IPv4, /56 for IPv6) gets at most `perSecond` such
 * lookup answers a second, counted together whatever the name; answers that
 * need no lookup (apex, static names, service names, hosted sites) are not
 * counted. Past it the answers are dropped, except every `slip`-th one, sent
 * truncated (TC=1, no records) so a real resolver behind that network retries
 * over TCP, which a forged source cannot complete. TCP is not limited here.
 * `perSecond` 0 turns the limit off; `slip` 0 drops every refused answer.
 *
 * A flood of distinct random names from forged sources spread over many
 * networks passes every per-network limit. `missesPerSecond` bounds, for the
 * whole server, the UDP lookups of names not already known (not a core, not
 * in the routing cache as an account) that found nothing; lookups still
 * running count against it too. Past it such queries are refused the same way
 * (dropped, every `slip`-th sent truncated) until the next second, while known
 * names and TCP are answered. 0 turns it off.
 */

import { isIPv4, isIPv6 } from 'node:net';

const RRL_DEFAULTS = Object.freeze({ perSecond: 20, slip: 2, missesPerSecond: 100 });
/** Networks tracked at once; past it the stale ones are dropped (then all, if none is stale). */
const DEFAULT_MAX_NETWORKS = 100_000;

type RrlDecision = 'answer' | 'slip' | 'drop';
type Bucket = { second: number; count: number; refused: number };

function countOr (value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : fallback;
}

/** The limits to apply, from the `dns.responseRateLimit` config block (defaults when absent or invalid). */
function readRrlConfig (get: (key: string) => unknown): { perSecond: number; slip: number; missesPerSecond: number } {
  return {
    perSecond: countOr(get('dns:responseRateLimit:perSecond'), RRL_DEFAULTS.perSecond),
    slip: countOr(get('dns:responseRateLimit:slip'), RRL_DEFAULTS.slip),
    missesPerSecond: countOr(get('dns:responseRateLimit:missesPerSecond'), RRL_DEFAULTS.missesPerSecond)
  };
}

/** The 8 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups (address: string): number[] | null {
  let text = address.split('%')[0];
  if (!isIPv6(text)) return null;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    // Embedded IPv4 (e.g. ::ffff:192.0.2.1): its 32 bits are the last two groups.
    const b = last.split('.').map(Number);
    text = text.slice(0, lastColon + 1) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = text.split('::');
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length > 1 && halves[1] !== '' ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(fill, 0)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The client network an address belongs to: its /24 (IPv4, IPv4-mapped IPv6 included) or /56 (IPv6). */
function networkOf (address: string): string {
  if (isIPv4(address)) return '4:' + address.split('.').slice(0, 3).join('.');
  const groups = ipv6Groups(address);
  if (groups == null) return 'other:' + address;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return '4:' + [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8].join('.');
  return '6:' + [groups[0], groups[1], groups[2], groups[3] >> 8].map((g) => g.toString(16)).join(':');
}

class ResponseRateLimiter {
  #perSecond: number;
  #slip: number;
  #maxNetworks: number;
  #buckets: Map<string, Bucket> = new Map();

  constructor ({ perSecond, slip, maxNetworks = DEFAULT_MAX_NETWORKS }: { perSecond: number; slip: number; maxNetworks?: number }) {
    this.#perSecond = perSecond;
    this.#slip = slip;
    this.#maxNetworks = maxNetworks;
  }

  /** Whether to answer a datagram from `address` now, send it truncated, or drop it. */
  decide (address: string, nowMs: number = Date.now()): RrlDecision {
    if (this.#perSecond <= 0) return 'answer';
    const network = networkOf(address);
    const second = Math.floor(nowMs / 1000);
    let bucket = this.#buckets.get(network);
    if (bucket == null) {
      if (this.#buckets.size >= this.#maxNetworks) this.#sweep(second);
      bucket = { second, count: 0, refused: 0 };
      this.#buckets.set(network, bucket);
    } else if (bucket.second !== second) {
      bucket.second = second;
      bucket.count = 0;
      bucket.refused = 0;
    }
    if (bucket.count < this.#perSecond) {
      bucket.count++;
      return 'answer';
    }
    bucket.refused++;
    return this.#slip > 0 && bucket.refused % this.#slip === 0 ? 'slip' : 'drop';
  }

  /** Networks tracked (tests). */
  get size (): number {
    return this.#buckets.size;
  }

  #sweep (second: number): void {
    for (const [network, bucket] of this.#buckets) {
      if (bucket.second !== second) this.#buckets.delete(network);
    }
    if (this.#buckets.size >= this.#maxNetworks) this.#buckets.clear();
  }
}

/**
 * A lookup still running stops counting against the budget after this long,
 * so reads that hang (a platform database without a leader) cannot hold the
 * budget for good.
 */
const RUNNING_LOOKUP_MAX_AGE_MS = 5000;

/** Lookups of unknown names that found nothing, for the whole server (`missesPerSecond`). */
class LookupMissBudget {
  #perSecond: number;
  #slip: number;
  #second = -1;
  #misses = 0;
  #refused = 0;
  // Lookups admitted and still running, by the second they were admitted in
  // (not reset each second; dropped once older than RUNNING_LOOKUP_MAX_AGE_MS).
  #running: Map<number, number> = new Map();

  constructor ({ perSecond, slip }: { perSecond: number; slip: number }) {
    this.#perSecond = perSecond;
    this.#slip = slip;
  }

  /**
   * 'answer' (the lookup may run; call `done` with the same `nowMs` when it
   * ends) when this second's misses and the lookups still running are under
   * the budget, otherwise how to refuse the query.
   */
  admit (nowMs: number = Date.now()): RrlDecision {
    if (this.#perSecond <= 0) return 'answer';
    this.#roll(nowMs);
    if (this.#misses + this.#runningCount(nowMs) < this.#perSecond) {
      const second = Math.floor(nowMs / 1000);
      this.#running.set(second, (this.#running.get(second) ?? 0) + 1);
      return 'answer';
    }
    this.#refused++;
    return this.#slip > 0 && this.#refused % this.#slip === 0 ? 'slip' : 'drop';
  }

  /** A lookup admitted at `admittedAtMs` ended; `found` false counts a miss. */
  done (found: boolean, admittedAtMs: number, nowMs: number = Date.now()): void {
    if (this.#perSecond <= 0) return;
    const second = Math.floor(admittedAtMs / 1000);
    const n = this.#running.get(second);
    if (n != null) {
      if (n <= 1) this.#running.delete(second);
      else this.#running.set(second, n - 1);
    }
    if (found) return;
    this.#roll(nowMs);
    this.#misses++;
  }

  #runningCount (nowMs: number): number {
    const oldest = Math.floor((nowMs - RUNNING_LOOKUP_MAX_AGE_MS) / 1000);
    let count = 0;
    for (const [second, n] of this.#running) {
      if (second < oldest) this.#running.delete(second);
      else count += n;
    }
    return count;
  }

  #roll (nowMs: number): void {
    const second = Math.floor(nowMs / 1000);
    if (second === this.#second) return;
    this.#second = second;
    this.#misses = 0;
    this.#refused = 0;
  }
}

export { RRL_DEFAULTS, readRrlConfig, networkOf, ResponseRateLimiter, LookupMissBudget };
export type { RrlDecision };
