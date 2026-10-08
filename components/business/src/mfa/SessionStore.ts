/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { randomUUID: uuidv4 } = require('node:crypto');
const Profile = require('./Profile.ts').default;
const errors = require('errors').factory;
const { APIError, ErrorIds } = require('errors');

/**
 * MFA session store, backed by `cluster_kv` (master-held in-memory map +
 * worker IPC).
 *
 * Sessions are short-lived (default 30 min) and exist only between a login
 * (or activate) call and the matching verify/confirm call. They are keyed
 * by `mfaToken` — a UUID v4 returned to the client in lieu of an access
 * token while MFA is pending.
 *
 * Cluster-aware: with `cluster.apiWorkers > 1`, login may land on worker A
 * and verify on worker B. Backing on cluster_kv makes the store
 * worker-symmetric within a single core. For cross-core MFA flows (a future
 * need; not today) swap the backing for PlatformDB.
 */
interface KvClientLike {
  get: (key: string) => Promise<unknown>;
  /** Resolves whether it wrote: an unguarded write always does; the
   * `ifEquals` write of reserveAttempt may not, and is retried; the
   * `ifUnderPrefix` write of create may not when the namespace is full. */
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown; ifUnderPrefix?: { prefix: string; max: number } }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
}

interface SessionStoreOpts {
  kvClient?: KvClientLike;
  namespace?: string;
  /** Most live sessions at once (0: no cap). Default 10000. */
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 10000;
/** Retry-After of a refusal at the cap: the drain rate is unknown (sessions
 * leave as users complete them, or on expiry), so a flat minute. */
const CAP_RETRY_AFTER_SECONDS = 60;

interface ProfileLike {
  content?: Record<string, unknown>;
  recoveryCodes?: string[];
  method?: string;
  totp?: unknown;
  [k: string]: unknown;
}

/**
 * The pending SMS code of a session (SMS single mode, where the core generates
 * the code): its hash only, and when it stops being accepted.
 */
interface SmsCode {
  hash: string;
  expiresAt: number;
}

interface StoredSession {
  id: string;
  profile: { content: Record<string, unknown>; recoveryCodes: string[]; method?: string; totp?: unknown };
  context: unknown;
  attempts: number;
  smsCode?: SmsCode | null;
  /** End of the session's life (ms epoch), fixed at creation. */
  expiresAt?: number;
}

class SessionStore {
  /**
   * @param ttlSeconds - session lifetime in seconds (default 1800), counted
   *   from creation: no later write extends it.
   * @param [opts]
   * @param [opts.kvClient] - injectable; defaults to a fresh
   *   `cluster_kv.clientFor()` over the live process IPC channel.
   * @param [opts.namespace='mfa-session/'] - key prefix in cluster_kv.
   * @param [opts.maxPending=10000] - most live sessions at once; 0: no cap.
   */
  ttlMilliseconds: number;
  kv: KvClientLike;
  namespace: string;
  /** Key prefix of the per-user pending-enrolment slot. */
  enrolSlotNamespace: string;
  maxPending: number;

  constructor (ttlSeconds = 1800, opts: SessionStoreOpts = {}) {
    this.ttlMilliseconds = ttlSeconds * 1000;
    const clusterKv = require('messages/src/cluster_kv.ts');
    this.kv = opts.kvClient || clusterKv.clientFor();
    this.namespace = opts.namespace || 'mfa-session/';
    // Not under `namespace` (`mfa-session-enrol-slot/` does not start with
    // `mfa-session/`), so the slots never count toward the session cap.
    this.enrolSlotNamespace = this.namespace.replace(/\/$/, '') + '-enrol-slot/';
    this.maxPending = (typeof opts.maxPending === 'number' && Number.isInteger(opts.maxPending) && opts.maxPending >= 0)
      ? opts.maxPending
      : DEFAULT_MAX_PENDING;
  }

  /**
   * Create a new session and return its mfaToken. Refused (429
   * too-many-requests) when the store already holds `maxPending` live
   * sessions: counted and written in one cluster_kv step, so concurrent
   * creations cannot pass the cap together.
   *
   * @param profile - the MFA profile (with content + recoveryCodes)
   * @param context - opaque per-flow context (e.g. the resolved user, login params)
   */
  async create (profile: ProfileLike | null | undefined, context: unknown): Promise<string> {
    const id = uuidv4();
    // Profile is stored as a plain shape so it survives JSON round-trips
    // through the IPC channel; `get()` rehydrates the Profile class.
    const stored: StoredSession = {
      id,
      profile: {
        content: profile?.content || {},
        recoveryCodes: profile?.recoveryCodes || [],
        ...(profile?.method !== undefined ? { method: profile.method } : {}),
        ...(profile?.totp !== undefined ? { totp: profile.totp } : {})
      },
      context,
      attempts: 0,
      expiresAt: Date.now() + this.ttlMilliseconds
    };
    const opts: { ttlMs: number; ifUnderPrefix?: { prefix: string; max: number } } = { ttlMs: this.ttlMilliseconds };
    if (this.maxPending > 0) opts.ifUnderPrefix = { prefix: this.namespace, max: this.maxPending };
    const written = await this.kv.set(this.namespace + id, stored, opts);
    // A guarded write must say it wrote; anything else counts as refused.
    if (opts.ifUnderPrefix != null && written !== true) throw capacityError();
    return id;
  }

  /**
   * The live record of a session, or null. A record past its `expiresAt` is
   * refused even when the store has not dropped it yet.
   */
  async _read (id: string): Promise<StoredSession | null> {
    const session = await this.kv.get(this.namespace + id) as StoredSession | null | undefined;
    if (!session) return null;
    if (typeof session.expiresAt === 'number' && Date.now() >= session.expiresAt) return null;
    return session;
  }

  /**
   * Compare-and-set rewrite of a session, within its remaining lifetime (a
   * rewrite never extends it). Answers false when the write lost (retry) or
   * when no lifetime is left; `expired` tells the two apart. A record without
   * `expiresAt` (written before it was recorded) gets one now, a full
   * lifetime from this first rewrite.
   */
  async _rewrite (id: string, session: StoredSession, next: StoredSession): Promise<{ written: boolean; expired: boolean }> {
    const expiresAt = typeof session.expiresAt === 'number' ? session.expiresAt : Date.now() + this.ttlMilliseconds;
    const remaining = expiresAt - Date.now();
    // cluster_kv takes a non-positive TTL as "never expires": never send one.
    if (!(remaining > 0)) return { written: false, expired: true };
    const written = await this.kv.set(this.namespace + id, { ...next, expiresAt }, { ttlMs: remaining, ifEquals: session });
    return { written, expired: false };
  }

  async has (id: string): Promise<boolean> {
    return (await this._read(id)) != null;
  }

  async get (id: string): Promise<{ id: string; profile: InstanceType<typeof Profile>; context: unknown; attempts: number; smsCode: SmsCode | null } | undefined> {
    const session = await this._read(id);
    if (!session) return undefined;
    const profile = new Profile(
      session.profile?.content || {},
      session.profile?.recoveryCodes || [],
      session.profile?.method,
      session.profile?.totp as undefined
    );
    return { id: session.id, profile, context: session.context, attempts: session.attempts ?? 0, smsCode: session.smsCode ?? null };
  }

  /**
   * Replace the pending SMS code of a session (null drops it), with a
   * compare-and-set so a concurrent attempt reservation is not lost. Answers
   * false when the session is gone (or the write kept losing).
   */
  async setSmsCode (id: string, smsCode: SmsCode | null): Promise<boolean> {
    for (let tries = 0; tries < 20; tries++) {
      const session = await this._read(id);
      if (!session) return false;
      const { written, expired } = await this._rewrite(id, session, { ...session, smsCode });
      if (expired) return false;
      if (written) return true;
    }
    return false;
  }

  /**
   * Add `fields` to the context of a session, with a compare-and-set so a
   * concurrent rewrite (an SMS code, an attempt) is not lost. Answers false
   * when the session is gone (or the write kept losing).
   */
  async addToContext (id: string, fields: Record<string, unknown>): Promise<boolean> {
    for (let tries = 0; tries < 20; tries++) {
      const session = await this._read(id);
      if (!session) return false;
      const context = { ...(session.context as Record<string, unknown> | null ?? {}), ...fields };
      const { written, expired } = await this._rewrite(id, session, { ...session, context });
      if (expired) return false;
      if (written) return true;
    }
    return false;
  }

  /**
   * Make `id` the one pending enrolment of a user: the session that held the
   * user's slot before, if any, is cleared, so pending enrolments cannot pile
   * up. Compare-and-set on the slot, so of concurrent activations exactly one
   * session keeps it. Answers the id of the session cleared, or null.
   */
  async takeEnrolSlot (userKey: string, id: string): Promise<string | null> {
    const previous = await this.claimEnrolSlot(userKey, id);
    if (previous != null) await this.clear(previous);
    return previous;
  }

  /**
   * The first half of `takeEnrolSlot`: `id` holds the user's slot from now
   * on, and the session that held it before is NOT cleared yet, so the caller
   * can still be refused without touching it: it then hands the slot back
   * with `giveBackEnrolSlot`, else clears the previous session itself.
   * Compare-and-set on the slot; throws 429 (and clears `id`) when it keeps
   * losing to concurrent activations. Answers the previous holder, or null.
   */
  async claimEnrolSlot (userKey: string, id: string): Promise<string | null> {
    const key = this.enrolSlotNamespace + userKey;
    for (let tries = 0; tries < 20; tries++) {
      const previous = await this.kv.get(key);
      if (await this.kv.set(key, id, { ttlMs: this.ttlMilliseconds, ifEquals: previous ?? null })) {
        return (typeof previous === 'string' && previous !== id) ? previous : null;
      }
    }
    // Kept losing to concurrent activations: this one does not get the slot.
    await this.clear(id);
    throw errors.tooManyAttempts(1, {
      message: 'Too many concurrent MFA activations for this account; retry in 1 s.',
      data: { retryAfterSeconds: 1 }
    });
  }

  /**
   * Hand the slot claimed by `id` back to `previous` (from
   * `claimEnrolSlot`), for an activation refused after its claim: the
   * previous pending enrolment stays the user's one. When a later activation
   * claimed the slot meanwhile, that one supersedes both, so `previous` is
   * cleared rather than left pending beside it.
   */
  async giveBackEnrolSlot (userKey: string, id: string, previous: string | null): Promise<void> {
    if (previous == null) return;
    const key = this.enrolSlotNamespace + userKey;
    if (await this.kv.set(key, previous, { ttlMs: this.ttlMilliseconds, ifEquals: id })) return;
    await this.clear(previous);
  }

  /**
   * Reserve one verify/confirm attempt on a session BEFORE the code is checked,
   * so the ceiling holds however many attempts are in flight at once.
   * Preserves the session, within its remaining lifetime (an attempt never
   * extends it).
   *
   * Answers `{ attempts }` (this attempt's number, 1-based) when reserved, or
   * the reason it was not: `gone` (no such session), `ceiling` (`max` attempts
   * already reserved), `busy` (kept losing the compare-and-set; fail closed).
   */
  async reserveAttempt (id: string, max: number): Promise<{ attempts: number } | { refused: 'gone' | 'ceiling' | 'busy' }> {
    // Compare-and-set: parallel attempts on one session (possibly on different
    // API workers) each take their own slot, and none past `max`.
    for (let tries = 0; tries < 20; tries++) {
      const session = await this._read(id);
      if (!session) return { refused: 'gone' };
      const previous = session.attempts ?? 0;
      if (previous >= max) return { refused: 'ceiling' };
      const next = { ...session, attempts: previous + 1 };
      const { written, expired } = await this._rewrite(id, session, next);
      if (expired) return { refused: 'gone' };
      if (written) return { attempts: next.attempts };
    }
    return { refused: 'busy' };
  }

  /**
   * Give back one slot taken by reserveAttempt, for an attempt refused before
   * its code was checked. Best effort: a session that is gone, or a
   * compare-and-set that keeps losing, leaves the count as is.
   */
  async releaseAttempt (id: string): Promise<boolean> {
    for (let tries = 0; tries < 20; tries++) {
      const session = await this._read(id);
      if (!session) return false;
      const previous = session.attempts ?? 0;
      if (previous <= 0) return false;
      const { written, expired } = await this._rewrite(id, session, { ...session, attempts: previous - 1 });
      if (expired) return false;
      if (written) return true;
    }
    return false;
  }

  /**
   * Clear a session immediately. Idempotent — safe to call on an unknown id.
   */
  async clear (id: string): Promise<boolean> {
    const existed = (await this._read(id)) != null;
    await this.kv.delete(this.namespace + id);
    return existed;
  }

  /**
   * Drop everything (for tests / shutdown).
   */
  async clearAll () {
    await this.kv.clear();
  }
}

/**
 * Refusal at the session cap: a capacity limit of this core, not a failed
 * attempt of the caller, so 429 too-many-requests (as for the cap on pending
 * access requests), and it says neither the cap nor how close it is.
 */
function capacityError (): Error {
  const err = new APIError(ErrorIds.TooManyRequests,
    'Too many MFA sessions are pending on this server. Please retry later.',
    { httpStatus: 429, data: { retryAfterSeconds: CAP_RETRY_AFTER_SECONDS } });
  err.httpHeaders = { 'Retry-After': String(CAP_RETRY_AFTER_SECONDS) };
  return err;
}

export default SessionStore;
export { SessionStore };
export type { SmsCode };