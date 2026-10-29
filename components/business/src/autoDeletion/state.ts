/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Per-user state of account auto-deletion, kept apart by how it changes:
 *  - the holder's **setting**: an account field, written only when the holder
 *    changes it. Account fields keep every version, so its history is the
 *    record of the holder's choices; clearing writes `null`, it erases nothing.
 *  - the sweep's **bookkeeping**: one key-value row per account, replaced in
 *    place, and written only on a material change (see `isMaterialChange`):
 *    accounts with no policy are never written, idle passes write nothing.
 *  - a transfer beneficiary's **identity** (name, date of birth): an account
 *    field holding an encrypted envelope, erased with every version.
 */

import { deriveKey, encryptJson, decryptJson, KEY_BYTES } from '../acme/AtRestEncryption.ts';

export const SETTING_FIELD = 'autoDeletion';
export const IDENTITY_FIELD = 'autoDeletionTransferIdentity';
/** `:_` prefixed: never the id of a configured data store. */
export const BOOKKEEPING_STORE_ID = ':_autoDeletion';
const BOOKKEEPING_KEY = 'state';
const IDENTITY_KEY_PURPOSE = 'account-auto-deletion-identity-v1';
const DAY_SECONDS = 24 * 60 * 60;

export type Mode = 'never' | 'date' | 'inactivity';
export type Action = 'delete' | 'transfer';

export type Setting = {
  mode: Mode;
  /** Pryv seconds, when mode is date. */
  date?: number;
  inactivityDays?: number;
  action: Action;
  transfer?: { email: string; notifyBeneficiary: 'atSetup' | 'atTrigger'; fallback: 'delete' | 'keep' };
  acknowledgedNoReminders?: boolean;
  updatedAt: number;
};

export type Bookkeeping = {
  appliedPolicy: { source: 'user' | 'operator'; mode: Mode; inactivityDays?: number; date?: number };
  policyAppliedAt: number;
  lastActivity: { personal: number | null; app: number | null; delegate: number | null; max: number | null; by: 'owner' | 'delegate' | null };
  /** What the policy says (reminders count down to it). */
  deadline: number | null;
  /** When the account is actually due: the deadline, or later for the minimum notice. */
  deleteAt?: number | null;
  deadlineReason?: 'date' | 'inactivity' | 'minimum-notice';
  /** First notice sent under the current policy (confirmation or reminder). */
  firstNoticeAt?: number;
  /** `skipped`: past together with a more imminent lead (downtime), not sent. */
  reminders: { deadlineDay: number | null; sent: Array<{ leadDays: number; at: number; skipped?: boolean }> };
  /** `notifiedAt`: the holder was mailed about this block (once). */
  blocked?: { reason: string; at: number; notifiedAt?: number };
  transfer?: Record<string, unknown>;
};

export type Identity = { name?: string; dateOfBirth?: string };

type KeyValue = {
  get (userId: string, key: string): Promise<unknown>;
  set (userId: string, key: string, value: unknown): Promise<void>;
};

export type AccountStorage = {
  getAccountField (userId: string, field: string): Promise<unknown>;
  setAccountField (userId: string, field: string, value: unknown, createdBy: string, time?: number): Promise<unknown>;
  deleteAccountField (userId: string, field: string): Promise<void>;
  getKeyValueDataForStore (storeId: string): KeyValue;
};

/**
 * Key of the identity envelopes: `account.autoDeletion.transfer.identitySecretsKey`
 * when set (base64, 32 bytes), else derived from the admin key. Null when
 * neither is available: transfers with an identity are then refused.
 */
export function resolveIdentityKey (secretsKey: string | null | undefined, adminAccessKey: unknown): Buffer | null {
  if (typeof secretsKey === 'string' && secretsKey.length > 0) {
    const buf = Buffer.from(secretsKey, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`account.autoDeletion.transfer.identitySecretsKey must decode to ${KEY_BYTES} bytes (base64), got ${buf.length}`);
    }
    return buf;
  }
  if (typeof adminAccessKey === 'string' && adminAccessKey.length > 0) {
    return deriveKey(adminAccessKey, IDENTITY_KEY_PURPOSE);
  }
  return null;
}

/**
 * Whether going from `prev` to `next` is worth a write. The activity times
 * and the exact deadlines move with every use of the account; they are only
 * worth writing with something else, or when a deadline moves to another
 * day. The stored activity is a floor (it survives the deletion of an
 * access), so a stale value is safe.
 */
export function isMaterialChange (prev: Bookkeeping | null, next: Bookkeeping | null): boolean {
  if (prev == null || next == null) return prev !== next;
  return materialKey(prev) !== materialKey(next);
}

function materialKey (b: Bookkeeping): string {
  const { lastActivity, deadline, deleteAt, ...rest } = b;
  const day = (t: number | null | undefined) => t == null ? null : Math.floor(t / DAY_SECONDS);
  return stableJson({ ...rest, deadlineDay: day(deadline), deleteAtDay: day(deleteAt) });
}

function stableJson (value: unknown): string {
  return JSON.stringify(value, (key, v) => (v != null && typeof v === 'object' && !Array.isArray(v))
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v);
}

export function createAutoDeletionState (storage: AccountStorage) {
  const kv = storage.getKeyValueDataForStore(BOOKKEEPING_STORE_ID);
  return {
    async getSetting (userId: string): Promise<Setting | null> {
      return (await storage.getAccountField(userId, SETTING_FIELD) as Setting | null | undefined) ?? null;
    },

    /** `null` clears the setting (the operator's policy applies again). */
    async setSetting (userId: string, setting: Setting | null, createdBy: string): Promise<void> {
      await storage.setAccountField(userId, SETTING_FIELD, setting, createdBy);
    },

    async getBookkeeping (userId: string): Promise<Bookkeeping | null> {
      return (await kv.get(userId, BOOKKEEPING_KEY) as Bookkeeping | null | undefined) ?? null;
    },

    /** Writes `next` (null removes the row) only on a material change; true when written. */
    async saveBookkeeping (userId: string, prev: Bookkeeping | null, next: Bookkeeping | null): Promise<boolean> {
      if (!isMaterialChange(prev, next)) return false;
      await kv.set(userId, BOOKKEEPING_KEY, next);
      return true;
    },

    async getIdentity (userId: string, key: Buffer): Promise<Identity | null> {
      const envelope = await storage.getAccountField(userId, IDENTITY_FIELD);
      if (typeof envelope !== 'string' || envelope.length === 0) return null;
      return decryptJson(envelope, key) as Identity;
    },

    /** Replaces the identity; the previous one is erased, not kept as a version. */
    async setIdentity (userId: string, identity: Identity, key: Buffer, createdBy: string): Promise<void> {
      await storage.deleteAccountField(userId, IDENTITY_FIELD);
      await storage.setAccountField(userId, IDENTITY_FIELD, encryptJson(identity, key), createdBy);
    },

    /** Removes the identity and every earlier version of it. */
    async eraseIdentity (userId: string): Promise<void> {
      await storage.deleteAccountField(userId, IDENTITY_FIELD);
    }
  };
}
