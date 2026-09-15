/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Registration email challenge: proving control of an address BEFORE an account
 * exists.
 *
 * There is no user id and no container yet, so the challenge cannot live on an
 * event. It lives in PlatformDB's TTL access-state store, which is cluster-wide
 * (rqlite Raft, or PostgreSQL in the single-core shape): a code minted on the
 * landing core verifies on any core, and the proof it yields is readable
 * wherever the account is finally created.
 *
 * Shape of the exchange:
 *   createChallenge(email)          -> a short copy/paste code, mailed by the caller
 *   verifyChallenge(email, code)    -> a 256-bit proof
 *   checkProof(email, proof)        -> non-consuming, used by the registration chain
 *   consumeProof(email)             -> single use, only once the user row is committed
 *
 * Only hashes are persisted: the plaintext code lives in memory long enough to
 * be mailed, the plaintext proof long enough to be returned to the client.
 *
 * The code is short enough to retype, so entropy alone does not carry the
 * security argument. Three budgets do: per-code attempts (exact under
 * concurrency, via consume-then-reinstall), codes per address per day, and
 * failed attempts per address per day, the last so that re-requesting a code
 * cannot reset the per-code counter.
 */

import { factory as errors } from 'errors';
import * as storages from 'storages';
import { randomInt } from 'node:crypto';
import { mintToken, hashToken, hashEquals } from './tokens.ts';
import * as policy from './registrationPolicy.ts';

/** 32 symbols, no 0/O/1/I: the holder retypes this from another device. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

type ChallengeRow = { kind: 'challenge'; codeHash: string; attempts: number; createdAt: number };
type ProofRow = { kind: 'proof'; proofHash: string; createdAt: number; verifiedAt: number };
type CounterRow = { count: number };

export type CreateOutcome =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; reason: 'cooldown' | 'daily-limit' | 'failure-budget'; retryAfterSeconds: number };

export type VerifyOutcome =
  | { ok: true; proof: string; expiresAt: number }
  | { ok: false; reason: 'no-challenge' | 'wrong-code' | 'exhausted'; attemptsRemaining: number };

type StateRow = { value: unknown; expiresAt: number };

type ChallengeStore = {
  setAccessState: (key: string, value: unknown, expiresAt: number) => Promise<void>;
  setAccessStateIfAbsent: (key: string, value: unknown, expiresAt: number) => Promise<boolean>;
  getAccessState: (key: string) => Promise<StateRow | null>;
  consumeAccessState: (key: string) => Promise<StateRow | null>;
  deleteAccessState: (key: string) => Promise<void>;
};

/**
 * The cluster-wide TTL store, read at call time through the barrel's live-bound
 * export. Unlike the post-creation send throttle, this NEVER fails open: without
 * a store there is no way to prove an address, and silently skipping the proof
 * would let anyone register unverified on a platform that requires verification.
 */
function getStore (): ChallengeStore {
  const db = storages.platformDB as ChallengeStore | undefined;
  if (db == null || typeof db.consumeAccessState !== 'function') {
    throw errors.unexpectedError(
      new Error('registration email challenge: PlatformDB is not initialised'));
  }
  return db;
}

export function normalizeEmail (email: string): string {
  return email.trim().toLowerCase();
}

/** Accept what a human pastes: any case, with or without the display separator. */
export function normalizeCode (code: string): string {
  return code.toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('');
}

export function generateCode (): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/** Display form: easier to read back off a screen than eight run-together symbols. */
export function formatCode (code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4);
}

/** Hashed so no cleartext address lands in a cluster-wide key. */
export function challengeKey (email: string): string {
  return 'email-challenge/' + hashToken(normalizeEmail(email));
}

function sentKey (email: string): string {
  return 'email-challenge-sent/' + hashToken(normalizeEmail(email));
}

function dailyKey (email: string): string {
  return 'email-challenge-daily/' + hashToken(normalizeEmail(email));
}

function failsKey (email: string): string {
  return 'email-challenge-fails/' + hashToken(normalizeEmail(email));
}

function counterOf (row: StateRow | null): number {
  const value = row?.value as CounterRow | undefined;
  return typeof value?.count === 'number' ? value.count : 0;
}

function secondsUntil (expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

/**
 * Bump a daily counter, keeping the row's own expiry so the window is a rolling
 * 24h from the FIRST event, not from the latest. Read-modify-write: two
 * concurrent callers can both read the same value and let one extra through.
 * Acceptable for a soft cap whose job is to stop bulk abuse, not to be exact.
 */
async function bumpCounter (store: ChallengeStore, key: string, now: number): Promise<void> {
  const row = await store.getAccessState(key);
  await store.setAccessState(key, { count: counterOf(row) + 1 }, row?.expiresAt ?? now + DAY_MS);
}

export async function createChallenge (email: string): Promise<CreateOutcome> {
  const store = getStore();
  const now = Date.now();

  // Failure budget first: an attacker who burns a code's attempts must not be
  // able to reset the counter simply by asking for a new code.
  const fails = await store.getAccessState(failsKey(email));
  if (fails != null && counterOf(fails) >= (await policy.getRegistrationCodeFailuresPerDay())) {
    return { ok: false, reason: 'failure-budget', retryAfterSeconds: secondsUntil(fails.expiresAt, now) };
  }

  const daily = await store.getAccessState(dailyKey(email));
  if (daily != null && counterOf(daily) >= (await policy.getRegistrationCodeDailyLimit())) {
    return { ok: false, reason: 'daily-limit', retryAfterSeconds: secondsUntil(daily.expiresAt, now) };
  }

  const cooldownMs = await policy.getRegistrationCodeResendCooldownMs();
  if (cooldownMs > 0) {
    const reserved = await store.setAccessStateIfAbsent(sentKey(email), 1, now + cooldownMs);
    if (!reserved) {
      // The row's exact remaining time would cost a second read; the window is
      // short, so report the whole of it.
      return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil(cooldownMs / 1000) };
    }
  }

  await store.setAccessState(dailyKey(email), { count: counterOf(daily) + 1 }, daily?.expiresAt ?? now + DAY_MS);

  const code = generateCode();
  const expiresAt = now + (await policy.getRegistrationCodeMaxAgeMs());
  const row: ChallengeRow = { kind: 'challenge', codeHash: hashToken(code), attempts: 0, createdAt: now };
  await store.setAccessState(challengeKey(email), row, expiresAt);
  return { ok: true, code, expiresAt };
}

/**
 * Undo a challenge whose mail never went out, so a transport failure does not
 * strand the address behind its own cooldown. The daily counter is left alone:
 * the attempt did reach the transport.
 */
export async function discardChallenge (email: string): Promise<void> {
  const store = getStore();
  await store.deleteAccessState(challengeKey(email));
  await store.deleteAccessState(sentKey(email));
}

export async function verifyChallenge (email: string, code: string): Promise<VerifyOutcome> {
  const store = getStore();
  const now = Date.now();
  const key = challengeKey(email);

  // Consume first: the row is the lock. A concurrent caller that consumed
  // nothing sees null and loses, which is what makes the attempt count exact.
  const row = await store.consumeAccessState(key);
  if (row == null) return { ok: false, reason: 'no-challenge', attemptsRemaining: 0 };

  const value = row.value as ChallengeRow | ProofRow;
  if (value.kind !== 'challenge') {
    // A proof row: the client is verifying twice. Put it back untouched.
    await store.setAccessState(key, value, row.expiresAt);
    return { ok: false, reason: 'no-challenge', attemptsRemaining: 0 };
  }

  const maxAttempts = await policy.getRegistrationCodeMaxAttempts();

  if (!hashEquals(value.codeHash, hashToken(normalizeCode(code)))) {
    await bumpCounter(store, failsKey(email), now);
    const attempts = value.attempts + 1;
    if (attempts >= maxAttempts) {
      // Leave the row consumed: this code is spent, the holder asks for another.
      return { ok: false, reason: 'exhausted', attemptsRemaining: 0 };
    }
    const next: ChallengeRow = { ...value, attempts };
    await store.setAccessStateIfAbsent(key, next, row.expiresAt);
    return { ok: false, reason: 'wrong-code', attemptsRemaining: maxAttempts - attempts };
  }

  const proof = mintToken();
  const expiresAt = now + (await policy.getRegistrationProofMaxAgeMs());
  const proofRow: ProofRow = {
    kind: 'proof',
    proofHash: hashToken(proof),
    createdAt: value.createdAt,
    verifiedAt: now
  };
  await store.setAccessState(key, proofRow, expiresAt);
  return { ok: true, proof, expiresAt };
}

/** Non-consuming: the registration chain may run twice (cross-core forward). */
export async function checkProof (email: string, proof: string): Promise<boolean> {
  if (typeof proof !== 'string' || proof.length === 0) return false;
  const store = getStore();
  const row = await store.getAccessState(challengeKey(email));
  if (row == null) return false;
  const value = row.value as ChallengeRow | ProofRow;
  if (value.kind !== 'proof') return false;
  return hashEquals(value.proofHash, hashToken(proof));
}

/** Single use: called only once the user row is committed. Idempotent. */
export async function consumeProof (email: string): Promise<void> {
  const store = getStore();
  await store.deleteAccessState(challengeKey(email));
}
