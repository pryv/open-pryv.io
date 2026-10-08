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
   * `ifEquals` write of reserveAttempt may not, and is retried. */
  set: (key: string, value: unknown, opts?: { ttlMs?: number; ifEquals?: unknown }) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
}

interface SessionStoreOpts {
  kvClient?: KvClientLike;
  namespace?: string;
}

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
}

class SessionStore {
  /**
   * @param ttlSeconds - session lifetime in seconds (default 1800)
   * @param [opts]
   * @param [opts.kvClient] - injectable; defaults to a fresh
   *   `cluster_kv.clientFor()` over the live process IPC channel.
   * @param [opts.namespace='mfa-session/'] - key prefix in cluster_kv.
   */
  ttlMilliseconds: number;
  kv: KvClientLike;
  namespace: string;
  /** Key prefix of the per-user pending-enrolment slot. */
  enrolSlotNamespace: string;

  constructor (ttlSeconds = 1800, opts: SessionStoreOpts = {}) {
    this.ttlMilliseconds = ttlSeconds * 1000;
    const clusterKv = require('messages/src/cluster_kv.ts');
    this.kv = opts.kvClient || clusterKv.clientFor();
    this.namespace = opts.namespace || 'mfa-session/';
    this.enrolSlotNamespace = this.namespace.replace(/\/$/, '') + '-enrol-slot/';
  }

  /**
   * Create a new session and return its mfaToken.
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
      attempts: 0
    };
    await this.kv.set(this.namespace + id, stored, { ttlMs: this.ttlMilliseconds });
    return id;
  }

  async has (id: string): Promise<boolean> {
    return (await this.kv.get(this.namespace + id)) != null;
  }

  async get (id: string): Promise<{ id: string; profile: InstanceType<typeof Profile>; context: unknown; attempts: number; smsCode: SmsCode | null } | undefined> {
    const session = await this.kv.get(this.namespace + id) as StoredSession | null | undefined;
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
      const session = await this.kv.get(this.namespace + id) as StoredSession | null | undefined;
      if (!session) return false;
      const next = { ...session, smsCode };
      if (await this.kv.set(this.namespace + id, next, { ttlMs: this.ttlMilliseconds, ifEquals: session })) return true;
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
    const key = this.enrolSlotNamespace + userKey;
    for (let tries = 0; tries < 20; tries++) {
      const previous = await this.kv.get(key);
      if (await this.kv.set(key, id, { ttlMs: this.ttlMilliseconds, ifEquals: previous ?? null })) {
        if (typeof previous === 'string' && previous !== id) {
          await this.clear(previous);
          return previous;
        }
        return null;
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
   * Reserve one verify/confirm attempt on a session BEFORE the code is checked,
   * so the ceiling holds however many attempts are in flight at once.
   * Preserves the session (TTL is refreshed).
   *
   * Answers `{ attempts }` (this attempt's number, 1-based) when reserved, or
   * the reason it was not: `gone` (no such session), `ceiling` (`max` attempts
   * already reserved), `busy` (kept losing the compare-and-set; fail closed).
   */
  async reserveAttempt (id: string, max: number): Promise<{ attempts: number } | { refused: 'gone' | 'ceiling' | 'busy' }> {
    // Compare-and-set: parallel attempts on one session (possibly on different
    // API workers) each take their own slot, and none past `max`.
    for (let tries = 0; tries < 20; tries++) {
      const session = await this.kv.get(this.namespace + id) as StoredSession | null | undefined;
      if (!session) return { refused: 'gone' };
      const previous = session.attempts ?? 0;
      if (previous >= max) return { refused: 'ceiling' };
      const next = { ...session, attempts: previous + 1 };
      if (await this.kv.set(this.namespace + id, next, { ttlMs: this.ttlMilliseconds, ifEquals: session })) {
        return { attempts: next.attempts };
      }
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
      const session = await this.kv.get(this.namespace + id) as StoredSession | null | undefined;
      if (!session) return false;
      const previous = session.attempts ?? 0;
      if (previous <= 0) return false;
      const next = { ...session, attempts: previous - 1 };
      if (await this.kv.set(this.namespace + id, next, { ttlMs: this.ttlMilliseconds, ifEquals: session })) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clear a session immediately. Idempotent — safe to call on an unknown id.
   */
  async clear (id: string): Promise<boolean> {
    const existed = (await this.kv.get(this.namespace + id)) != null;
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

export default SessionStore;
export { SessionStore };
export type { SmsCode };