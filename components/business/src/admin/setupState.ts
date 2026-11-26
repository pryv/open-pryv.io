/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { generateCode, formatCode, hashCode, normalizeCode, hashesEqual, isSha256Hex } from './codes.ts';
import { KEYS, checkKeyId, parseJson, isPlainObject } from './store.ts';
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
 * The state row is updated read-modify-write (setup is a one-operator act:
 * no concurrent writers are expected beyond the first-writer claim).
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
  const parsed = parseJson<unknown>(await db.getPlatformKv(KEYS.setupState));
  if (!isPlainObject(parsed) || typeof parsed.state !== 'string' || !STATES.has(parsed.state)) return null;
  return parsed as SetupState;
}

async function writeState (db: AdminStore, state: SetupState): Promise<void> {
  await db.setPlatformKv(KEYS.setupState, JSON.stringify(state));
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
  const current = await readSetupState(db);
  if (current?.codeKey != null) await db.deleteAccessState(KEYS.setupCodePrefix + current.codeKey);
  const next: SetupState = {
    ...(current ?? { createdAt: opts.now, createdBy: 'unknown', via: 'fresh' as const }),
    state: 'ready',
    readyAt: opts.now,
    readyBy: opts.by,
    codeKey: null,
    codeCreatedAt: null,
    codeExpiresAt: null
  };
  await writeState(db, next);
  return next;
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
  const state = await readSetupState(db);
  if (state?.state !== 'pending') return null;
  const expiresAt = opts.now + opts.ttlMs;
  const row: SetupCodeRow = { createdAt: opts.now, coreId: checkKeyId('core id', opts.coreId) };
  if (opts.supplied === true) row.supplied = true;
  await db.setAccessState(KEYS.setupCodePrefix + opts.codeHash, row, expiresAt);
  const previous = state.codeKey;
  await writeState(db, {
    ...state,
    codeKey: opts.codeHash,
    codeCreatedAt: opts.now,
    codeExpiresAt: expiresAt,
    suppliedCodeHash: opts.supplied === true ? opts.codeHash : (state.suppliedCodeHash ?? null)
  });
  if (previous != null && previous !== opts.codeHash) await db.deleteAccessState(KEYS.setupCodePrefix + previous);
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
  const state = await readSetupState(db);
  if (state?.codeKey == null) return;
  await db.deleteAccessState(KEYS.setupCodePrefix + state.codeKey);
  await writeState(db, { ...state, codeKey: null, codeCreatedAt: null, codeExpiresAt: null });
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
  const latest = await readSetupState(db);
  if (latest != null && hashesEqual(latest.codeKey, codeHash)) {
    await writeState(db, { ...latest, codeKey: null, codeCreatedAt: null, codeExpiresAt: null });
  }
  return entry.value as SetupCodeRow;
}

/**
 * Count one redeem attempt on this core (10 per 15 min). Past the budget the
 * pending code is deleted (a new one must be minted) and the attempt refused.
 */
export async function countSetupAttempt (db: AdminStore, opts: { coreId: string; now: number }): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
  const key = KEYS.setupAttemptsPrefix + checkKeyId('core id', opts.coreId);
  const refusedUntil = await db.bumpWindowedCounter(key, SETUP_ATTEMPTS_MAX, SETUP_ATTEMPTS_WINDOW_MS, opts.now);
  if (refusedUntil == null) return { allowed: true };
  await invalidatePendingCode(db);
  return { allowed: false, retryAt: refusedUntil };
}
