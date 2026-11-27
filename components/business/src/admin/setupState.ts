/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { generateCode, formatCode, hashCode, normalizeCode, hashesEqual, isSha256Hex } from './codes.ts';
import { KEYS, checkKeyId, parseJson, isPlainObject, updatePlatformKv } from './store.ts';
import type { AdminStore } from './store.ts';

/**
 * Platform setup state and the one-time setup code.
 *
 * `setup/state` (platform KV) says whether the platform still waits for its
 * first administrator (`pending`) or not (`ready`). A fresh platform gets
 * `pending` from the first core that boots (first writer wins, so exactly one
 * core mints the code); a platform that already had accounts when this
 * feature arrived is written `ready` at once (`via: legacy`).
 *
 * While `pending`, one setup code is valid at a time: its hash is the key of
 * an access state `setup-code/<sha256>` (TTL `setup.codeTtlHours`) and the
 * state row points at it (`codeKey`), since live access states cannot be
 * listed. A code not pointed at is refused, so replacing the code invalidates
 * the previous one even if deleting its row failed. Redeeming consumes the row
 * atomically: of two concurrent redeems exactly one wins.
 *
 * Every update of the state row is a compare-and-set (`updateState`): a
 * writer that lost a race reads the row again, so `ready` never goes back.
 */

export type SetupStateName = 'pending' | 'ready';

export type SetupState = {
  state: SetupStateName;
  createdAt: number;
  /** Core that wrote the row first. */
  createdBy: string;
  /** `fresh`: written by the first boot of a new platform; `legacy`: the platform predates setup. */
  via: 'fresh' | 'legacy';
  readyAt?: number;
  /** Who finished setup: an account id, `admin-key`, or `legacy`. */
  readyBy?: string;
  /** SHA-256 of the pending setup code (null: none pending). */
  codeKey?: string | null;
  codeCreatedAt?: number | null;
  codeExpiresAt?: number | null;
  /** The last `setup.codeHash` installed (so a restart never re-arms a consumed one). */
  suppliedCodeHash?: string | null;
};

export type SetupCodeRow = { createdAt: number; coreId: string; supplied?: boolean };

export type MintedCode = {
  /** Canonical form (26 characters). Never stored, never logged except in the one setup block. */
  code: string;
  /** Display form, in groups. */
  display: string;
  expiresAt: number;
};

export const SETUP_ATTEMPTS_MAX = 10;
export const SETUP_ATTEMPTS_WINDOW_MS = 15 * 60 * 1000;

const STATES = new Set<string>(['pending', 'ready']);

export async function readSetupState (db: AdminStore): Promise<SetupState | null> {
  return parseState(await db.getPlatformKv(KEYS.setupState));
}

function parseState (raw: string | null): SetupState | null {
  const parsed = parseJson<unknown>(raw);
  if (!isPlainObject(parsed) || typeof parsed.state !== 'string' || !STATES.has(parsed.state)) return null;
  return parsed as SetupState;
}

/**
 * Compare-and-set update of the state row: `change` gets the current state
 * and answers the next one (null: change nothing), so no write ever lands on
 * a state it did not read (a `ready` is never turned back into `pending` by
 * a writer that read `pending` before).
 */
async function updateState<T> (db: AdminStore, change: (state: SetupState | null) => { next: SetupState; result: T } | null): Promise<T | null> {
  const done = await updatePlatformKv(db, KEYS.setupState, (raw) => {
    const out = change(parseState(raw));
    return out == null ? null : { next: JSON.stringify(out.next), result: out.result };
  });
  return done == null ? null : done.result;
}

/**
 * Write `pending` for a fresh platform, first writer wins: true when this
 * call wrote it (this core then mints the code), false when a row exists.
 */
export async function claimFreshPending (db: AdminStore, opts: { coreId: string; now: number }): Promise<boolean> {
  const state: SetupState = {
    state: 'pending',
    createdAt: opts.now,
    createdBy: checkKeyId('core id', opts.coreId),
    via: 'fresh',
    codeKey: null,
    codeCreatedAt: null,
    codeExpiresAt: null,
    suppliedCodeHash: null
  };
  return await db.setPlatformKvIfAbsent(KEYS.setupState, JSON.stringify(state));
}

/** Write `ready` for a platform that predates setup (no-op when a row exists); answers the stored row. */
export async function recordLegacyReady (db: AdminStore, opts: { coreId: string; now: number }): Promise<SetupState> {
  const state: SetupState = {
    state: 'ready',
    createdAt: opts.now,
    createdBy: checkKeyId('core id', opts.coreId),
    via: 'legacy',
    readyAt: opts.now,
    readyBy: 'legacy'
  };
  await db.setPlatformKvIfAbsent(KEYS.setupState, JSON.stringify(state));
  return (await readSetupState(db)) ?? state;
}

/** Finish setup: `ready`, and the pending code (if any) is deleted. */
export async function markReady (db: AdminStore, opts: { by: string; now: number }): Promise<SetupState> {
  const done = await updateState(db, (current) => {
    const next: SetupState = {
      ...(current ?? { createdAt: opts.now, createdBy: 'unknown', via: 'fresh' as const }),
      state: 'ready',
      readyAt: opts.now,
      readyBy: opts.by,
      codeKey: null,
      codeCreatedAt: null,
      codeExpiresAt: null
    };
    return { next, result: { next, codeKey: current?.codeKey ?? null } };
  });
  if (done == null) throw new Error('markReady: no change made');
  if (done.codeKey != null) await db.deleteAccessState(KEYS.setupCodePrefix + done.codeKey);
  return done.next;
}

/**
 * Make `codeHash` the one valid setup code (while `pending` only), replacing
 * the previous one. `supplied` marks an operator-supplied hash
 * (`setup.codeHash`). Answers the expiry, or null when setup is not pending.
 */
export async function installSetupCode (db: AdminStore, opts: {
  codeHash: string; coreId: string; ttlMs: number; now: number; supplied?: boolean;
}): Promise<{ expiresAt: number } | null> {
  if (!isSha256Hex(opts.codeHash)) throw new Error('installSetupCode: codeHash must be a SHA-256 hex digest');
  if (!(opts.ttlMs > 0)) throw new Error('installSetupCode: ttlMs must be positive');
  if ((await readSetupState(db))?.state !== 'pending') return null;
  const expiresAt = opts.now + opts.ttlMs;
  const row: SetupCodeRow = { createdAt: opts.now, coreId: checkKeyId('core id', opts.coreId) };
  if (opts.supplied === true) row.supplied = true;
  // The code row first: it is refused until the state points at it.
  await db.setAccessState(KEYS.setupCodePrefix + opts.codeHash, row, expiresAt);
  const previous = await updateState(db, (state) => {
    if (state?.state !== 'pending') return null;
    return {
      next: {
        ...state,
        codeKey: opts.codeHash,
        codeCreatedAt: opts.now,
        codeExpiresAt: expiresAt,
        suppliedCodeHash: opts.supplied === true ? opts.codeHash : (state.suppliedCodeHash ?? null)
      },
      result: { codeKey: state.codeKey ?? null }
    };
  });
  if (previous == null) {
    // Setup finished meanwhile: the new code never becomes valid.
    await db.deleteAccessState(KEYS.setupCodePrefix + opts.codeHash);
    return null;
  }
  if (previous.codeKey != null && previous.codeKey !== opts.codeHash) await db.deleteAccessState(KEYS.setupCodePrefix + previous.codeKey);
  return { expiresAt };
}

/** Generate and install a new setup code (while `pending` only); null when not pending. */
export async function mintSetupCode (db: AdminStore, opts: { coreId: string; ttlMs: number; now: number }): Promise<MintedCode | null> {
  const code = generateCode();
  const installed = await installSetupCode(db, { codeHash: hashCode(code), coreId: opts.coreId, ttlMs: opts.ttlMs, now: opts.now });
  if (installed == null) return null;
  return { code, display: formatCode(code), expiresAt: installed.expiresAt };
}

/** The pending code's times, when one is live. */
export async function pendingSetupCode (db: AdminStore): Promise<{ createdAt: number; expiresAt: number; supplied: boolean } | null> {
  const state = await readSetupState(db);
  if (state?.state !== 'pending' || state.codeKey == null) return null;
  const entry = await db.getAccessState(KEYS.setupCodePrefix + state.codeKey);
  if (entry == null) return null;
  const row = entry.value as SetupCodeRow;
  return { createdAt: row.createdAt, expiresAt: entry.expiresAt, supplied: row.supplied === true };
}

/** Delete the pending code (state stays `pending`): a new one must be minted. */
export async function invalidatePendingCode (db: AdminStore): Promise<void> {
  const cleared = await updateState(db, (state) => {
    if (state?.codeKey == null) return null;
    return { next: { ...state, codeKey: null, codeCreatedAt: null, codeExpiresAt: null }, result: state.codeKey };
  });
  if (cleared != null) await db.deleteAccessState(KEYS.setupCodePrefix + cleared);
}

/**
 * Redeem a typed setup code: consumed atomically, valid only while `pending`
 * and only if it is the code the state points at. Answers its row, or null
 * (unknown, expired, already used, replaced, or setup not pending).
 */
export async function redeemSetupCode (db: AdminStore, input: unknown): Promise<SetupCodeRow | null> {
  const canonical = normalizeCode(input);
  if (canonical == null) return null;
  const codeHash = hashCode(canonical);
  const state = await readSetupState(db);
  if (state?.state !== 'pending') return null;
  const entry = await db.consumeAccessState(KEYS.setupCodePrefix + codeHash);
  if (entry == null) return null;
  if (!hashesEqual(state.codeKey, codeHash)) return null;
  await updateState(db, (latest) => {
    if (latest == null || !hashesEqual(latest.codeKey, codeHash)) return null;
    return { next: { ...latest, codeKey: null, codeCreatedAt: null, codeExpiresAt: null }, result: true };
  });
  return entry.value as SetupCodeRow;
}

/**
 * Count one redeem attempt on this core (10 per 15 min); past the budget the
 * attempt is refused until the window ends. The pending code stays valid: it
 * cannot be guessed at that rate, and withdrawing it would let anyone lock
 * the operator out of the setup page.
 */
export async function countSetupAttempt (db: AdminStore, opts: { coreId: string; now: number }): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
  const key = KEYS.setupAttemptsPrefix + checkKeyId('core id', opts.coreId);
  const refusedUntil = await db.bumpWindowedCounter(key, SETUP_ATTEMPTS_MAX, SETUP_ATTEMPTS_WINDOW_MS, opts.now);
  if (refusedUntil == null) return { allowed: true };
  return { allowed: false, retryAt: refusedUntil };
}
