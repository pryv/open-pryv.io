/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * CMC plugin, group accounts: the bookkeeping of member access mints, two
 * things in one object:
 *
 *   - the budgets of a membership access, two token buckets per membership:
 *       `mint`: new member accesses (`mintBurst` from idle, then
 *               `ratePerMinute` sustained);
 *       `ask`:  member access requests of any kind, a re-ask answered with
 *               a live access included (`askBurst`, then
 *               `askRatePerMinute`).
 *     A bucket refills continuously (`perMinute / 60` tokens a second) up to
 *     its burst. The buckets live in a key/value store shared by the API
 *     workers of the core (`store`, the cluster key/value store in the
 *     api-server; an in-process map by default), updated by compare-and-set
 *     so concurrent requests each take their own token. A row expires once
 *     its bucket would be full again. When the store fails, the call is
 *     counted in an in-process bucket instead (never uncounted: the caller is
 *     authenticated and could loop), and its refund goes back there. A store
 *     that does not answer costs its request timeout per call (the cluster
 *     store's: 5 s) before the in-process count applies.
 *     The gate takes an ask token for every request (never given back) and
 *     reserves a mint token; the dispatch gives the mint token back when the
 *     request ended without a new access (a reuse, a failure). The budget
 *     paces a membership, it does not protect the patients: a membership
 *     already reaches every patient its team covers, the controls that end
 *     the exposure are the membership's expiry and its revocation.
 *     The mint token is taken after the gate has loaded the group's accesses
 *     and the ledger record (an ask for a live access is admitted on a spent
 *     mint budget): what bounds the group core's work for a runaway client
 *     is the ask budget, to be sized against that load.
 *   - the in-flight locks per (membership, patient relationship): a second
 *     mint for the same pair while one is running is refused, so two
 *     concurrent asks cannot both miss the ledger and both create a child.
 *     In-process: the worker that handled the write holds the lock, released
 *     by the dispatch middleware once the mint settled. A lock whose holder
 *     never released it (the write failed between the gate and the
 *     dispatch) expires after `staleMs`, so a stuck key never refuses a
 *     member for good.
 */

import * as C from './constants.ts';
import type { CmcLogger } from './_types.ts';

type BudgetKind = 'mint' | 'ask';
type BucketLimits = { burst: number; perMinute: number };
type BudgetLimits = { mint: BucketLimits; ask: BucketLimits };

/** The subset of the cluster key/value client the budgets use. */
type BudgetStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown }) => Promise<boolean>;
};

type RegistryOptions = {
  // The budgets: fixed, or read on every call (so a configuration change
  // applies without a restart). A kind left out takes the defaults.
  limits?: Partial<BudgetLimits> | (() => Partial<BudgetLimits>);
  maxInFlightPerMembership: number;
  // A lock older than this is treated as released (default 60 s).
  staleMs?: number;
  // Shared by the workers of the core; an in-process map when absent.
  store?: BudgetStore;
  logger?: CmcLogger;
  now?: () => number;
};

// `via`: where the token was taken (the shared store, or this process when
// the shared store failed); a refund goes back to the same place.
type TokenSource = 'shared' | 'local';
type ReserveResult = { ok: true; via: TokenSource } | { ok: false; retryAfterSeconds: number };

type Bucket = { tokens: number; at: number };

const DEFAULT_STALE_MS = 60_000;
const CAS_TRIES = 20;
// The half-burst notice is given at most once per membership in this time.
const NOTICE_EVERY_MS = 60_000;
const KEY_PREFIX: Record<BudgetKind, string> = { mint: 'cmc-member-mint/', ask: 'cmc-member-ask/' };

function isBucket (v: unknown): v is Bucket {
  return v != null && typeof v === 'object' &&
    typeof (v as Bucket).tokens === 'number' && typeof (v as Bucket).at === 'number';
}

/**
 * The in-process store: same semantics as the cluster store's fallback
 * (values compared as JSON for `ifEquals`, a missing or expired entry equals
 * only null).
 */
class MemoryStore implements BudgetStore {
  private readonly map = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly now: () => number;

  constructor (now: () => number = Date.now) {
    this.now = now;
  }

  private live (key: string): string | null {
    const e = this.map.get(key);
    if (e == null) return null;
    if (e.expiresAt != null && this.now() > e.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }

  async get (key: string): Promise<unknown> {
    const v = this.live(key);
    return v == null ? null : JSON.parse(v);
  }

  async set (key: string, value: unknown, opts: { ttlMs?: number; ifEquals?: unknown } = {}): Promise<boolean> {
    if (opts.ifEquals !== undefined) {
      const current = this.live(key) ?? 'null';
      if (current !== JSON.stringify(opts.ifEquals ?? null)) return false;
    }
    const expiresAt = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? this.now() + opts.ttlMs : null;
    this.map.set(key, { value: JSON.stringify(value), expiresAt });
    return true;
  }
}

function positive (v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function defaultLimits (): BudgetLimits {
  const d = C.MEMBER_ACCESS_CONFIG_DEFAULTS;
  return {
    mint: { burst: d.mintBurst, perMinute: d.ratePerMinute },
    ask: { burst: d.askBurst, perMinute: d.askRatePerMinute },
  };
}

/**
 * The budgets as configured (`cmc:memberAccess:*`), anything unset or
 * invalid at its default. A mint is also an ask, so the ask budget is raised
 * to the mint budget when set lower; `clamped` names what was raised.
 */
function memberMintLimitsFromConfig (config: { get: (key: string) => unknown }): BudgetLimits & { clamped: string[] } {
  const d = defaultLimits();
  const read = (key: string, fallback: number): number => positive(config.get('cmc:memberAccess:' + key), fallback);
  const mint = { burst: read('mintBurst', d.mint.burst), perMinute: read('ratePerMinute', d.mint.perMinute) };
  const ask = { burst: read('askBurst', d.ask.burst), perMinute: read('askRatePerMinute', d.ask.perMinute) };
  const clamped: string[] = [];
  if (ask.burst < mint.burst) { ask.burst = mint.burst; clamped.push('askBurst'); }
  if (ask.perMinute < mint.perMinute) { ask.perMinute = mint.perMinute; clamped.push('askRatePerMinute'); }
  return { mint, ask, clamped };
}

class MemberMintRegistry {
  private readonly options: RegistryOptions;
  private readonly store: BudgetStore;
  // Counts a call when the shared store fails.
  private readonly local: MemoryStore;
  private readonly locks = new Map<string, number[]>();
  private readonly noticed = new Map<string, number>();

  constructor (options: RegistryOptions) {
    this.options = options;
    this.local = new MemoryStore(() => this.now());
    this.store = options.store ?? new MemoryStore(() => this.now());
  }

  private now (): number {
    return (this.options.now ?? Date.now)();
  }

  private limitsOf (kind: BudgetKind): BucketLimits {
    const raw = typeof this.options.limits === 'function' ? this.options.limits() : this.options.limits;
    const d = defaultLimits()[kind];
    const l = raw?.[kind];
    return { burst: positive(l?.burst, d.burst), perMinute: positive(l?.perMinute, d.perMinute) };
  }

  /** The bucket's tokens at `now`, refilled since it was written. */
  private tokensOf (row: unknown, limits: BucketLimits, now: number): number {
    if (!isBucket(row)) return limits.burst;
    const elapsed = Math.max(0, now - row.at);
    return Math.min(limits.burst, row.tokens + elapsed * limits.perMinute / 60_000);
  }

  /** Time until the bucket is full again (the row's lifetime). */
  private ttlOf (tokens: number, limits: BucketLimits): number {
    return Math.max(1, Math.ceil((limits.burst - tokens) * 60_000 / limits.perMinute));
  }

  private async casReserve (store: BudgetStore, via: TokenSource, kind: BudgetKind, membershipAccessId: string): Promise<ReserveResult> {
    const limits = this.limitsOf(kind);
    const key = KEY_PREFIX[kind] + membershipAccessId;
    for (let tries = 0; tries < CAS_TRIES; tries++) {
      const row = await store.get(key);
      const now = this.now();
      const tokens = this.tokensOf(row, limits, now);
      if (tokens < 1) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) * 60 / limits.perMinute)) };
      }
      const next: Bucket = { tokens: tokens - 1, at: now };
      if (await store.set(key, next, { ttlMs: this.ttlOf(next.tokens, limits), ifEquals: row ?? null }) === true) {
        if (kind === 'mint') this.noticeBulk(membershipAccessId, tokens, next.tokens, limits);
        return { ok: true, via };
      }
    }
    // Kept losing to concurrent requests: refuse rather than run uncounted.
    this.options.logger?.debug?.('cmc/memberMintBudget: lost every compare-and-set; refused for a second', {
      membershipAccessId, kind, tries: CAS_TRIES,
    });
    return { ok: false, retryAfterSeconds: 1 };
  }

  /** One info line when a membership's mint bucket falls below half. */
  private noticeBulk (membershipAccessId: string, before: number, after: number, limits: BucketLimits): void {
    const half = limits.burst / 2;
    if (!(before >= half && after < half)) return;
    const now = this.now();
    const last = this.noticed.get(membershipAccessId);
    if (last != null && now - last < NOTICE_EVERY_MS) return;
    this.noticed.set(membershipAccessId, now);
    for (const [k, t] of this.noticed) if (now - t >= NOTICE_EVERY_MS) this.noticed.delete(k);
    this.options.logger?.info?.('cmc/memberMintBudget: bulk minting by membership ' + membershipAccessId, {
      membershipAccessId, mintBurst: limits.burst, ratePerMinute: limits.perMinute,
    });
  }

  /**
   * Take one token of `kind` for `membershipAccessId`. Refused with the
   * seconds until one token is back.
   */
  async reserve (kind: BudgetKind, membershipAccessId: string): Promise<ReserveResult> {
    try {
      return await this.casReserve(this.store, 'shared', kind, membershipAccessId);
    } catch (err: unknown) {
      this.options.logger?.debug?.('cmc/memberMintBudget: the shared store failed; counted in this process', {
        error: String((err as Error)?.message || err),
      });
      return await this.casReserve(this.local, 'local', kind, membershipAccessId);
    }
  }

  /**
   * Give back one token of `kind` (never above the burst) where it was
   * taken (`via`, from `reserve`). Best-effort: a store failure or lost
   * compare-and-sets lose the token, which refills.
   */
  async refund (kind: BudgetKind, membershipAccessId: string, via: TokenSource = 'shared'): Promise<void> {
    const limits = this.limitsOf(kind);
    const key = KEY_PREFIX[kind] + membershipAccessId;
    const store = via === 'local' ? this.local : this.store;
    try {
      for (let tries = 0; tries < CAS_TRIES; tries++) {
        const row = await store.get(key);
        // No row: the bucket is full already.
        if (!isBucket(row)) return;
        const now = this.now();
        const tokens = this.tokensOf(row, limits, now);
        if (tokens >= limits.burst) return;
        const next: Bucket = { tokens: Math.min(limits.burst, tokens + 1), at: now };
        if (await store.set(key, next, { ttlMs: this.ttlOf(next.tokens, limits), ifEquals: row }) === true) return;
      }
    } catch (_e) { /* the token is lost; it refills */ }
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

/**
 * The mint token a request holds between the gate and the dispatch
 * (`context.cmc.memberMintReservation`). `held` false: the gate found the
 * mint budget spent but a live record for the pair, and admitted the ask as
 * a probable reuse; a mint it turns out to need takes its token then.
 */
type MintReservation = { membershipAccessId: string; held: boolean; via?: TokenSource };

/** What the gate leaves on `context.cmc` for the end of the request. */
type MemberMintGateState = {
  memberMintLock?: string;
  memberMintReservation?: MintReservation;
  memberMintSettled?: boolean;
};

/**
 * End of a request the gate admitted: release the pair's lock and give the
 * mint token back unless a child was minted. Once per request (marked on the
 * state), whichever comes first: the dispatch once the mint settled, or the
 * events.create chain failing after the gate (the dispatch then never runs).
 */
async function settleMemberMint (registry: MemberMintRegistry | null | undefined, state: MemberMintGateState | null | undefined, mintOutcome?: 'minted' | 'reused'): Promise<void> {
  if (registry == null || state == null || state.memberMintSettled === true) return;
  if (state.memberMintLock == null && state.memberMintReservation == null) return;
  state.memberMintSettled = true;
  try {
    if (typeof state.memberMintLock === 'string') registry.release(state.memberMintLock);
    const r = state.memberMintReservation;
    if (r?.held === true && mintOutcome !== 'minted') await registry.refund('mint', r.membershipAccessId, r.via);
  } catch (_e) { /* the token refills */ }
}

function createMemberMintRegistry (options: RegistryOptions): MemberMintRegistry {
  return new MemberMintRegistry(options);
}

export { MemberMintRegistry, createMemberMintRegistry, memberMintLimitsFromConfig, settleMemberMint };
export type {
  RegistryOptions as MemberMintRegistryOptions,
  BudgetKind,
  BudgetLimits,
  BudgetStore,
  ReserveResult,
  TokenSource,
  MintReservation,
  MemberMintGateState,
};
