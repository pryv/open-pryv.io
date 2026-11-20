/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-client budget of routing misses (`limits.routing.unknownNamesPerClientPerMinute`).
 *
 * On a multi-core platform every `/{username}/*` request asks the platform
 * database which core hosts the name, unless the answer is cached. A client
 * sending requests for distinct random names makes each one cost a
 * cluster-wide read. Each client (an IPv4 address, or the /64 of an IPv6 one)
 * may have `perMinute` lookups that found no account in a minute; past it, its
 * requests for names not already cached are refused until the minute ends.
 * Names already cached and accounts that exist are never refused. Per API
 * worker, in memory. 0 turns the budget off.
 */

const UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT = 60;
const WINDOW_MS = 60_000;
/** Clients tracked at once; past it the expired ones are dropped (then all, if none is). */
const DEFAULT_MAX_CLIENTS = 50_000;

type Counter = { count: number; windowEndsAt: number };

function readUnknownNamesPerMinute (get: (key: string) => unknown): number {
  const value = get('limits:routing:unknownNamesPerClientPerMinute');
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0) ? value : UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT;
}

class RoutingMissBudget {
  #counters: Map<string, Counter> = new Map();
  #maxClients: number;

  constructor ({ maxClients = DEFAULT_MAX_CLIENTS }: { maxClients?: number } = {}) {
    this.#maxClients = maxClients;
  }

  /** Seconds until `client` may look an uncached name up again, or null when it may now. */
  retryAfter (client: string, perMinute: number, now: number = Date.now()): number | null {
    if (perMinute <= 0) return null;
    const counter = this.#counters.get(client);
    if (counter == null || counter.windowEndsAt <= now || counter.count < perMinute) return null;
    return Math.max(1, Math.ceil((counter.windowEndsAt - now) / 1000));
  }

  /** Count one lookup of `client` that found no account. */
  countMiss (client: string, now: number = Date.now()): void {
    let counter = this.#counters.get(client);
    if (counter == null || counter.windowEndsAt <= now) {
      if (counter == null && this.#counters.size >= this.#maxClients) this.#sweep(now);
      counter = { count: 0, windowEndsAt: now + WINDOW_MS };
      this.#counters.set(client, counter);
    }
    counter.count++;
  }

  /** Clients tracked (tests). */
  get size (): number {
    return this.#counters.size;
  }

  clear (): void {
    this.#counters.clear();
  }

  #sweep (now: number): void {
    for (const [client, counter] of this.#counters) {
      if (counter.windowEndsAt <= now) this.#counters.delete(client);
    }
    if (this.#counters.size >= this.#maxClients) this.#counters.clear();
  }
}

export { UNKNOWN_NAMES_PER_CLIENT_PER_MINUTE_DEFAULT, readUnknownNamesPerMinute, RoutingMissBudget };
