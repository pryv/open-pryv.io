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
 *  - the **transfer record**: a second key-value row, the life of one transfer
 *    (beneficiary told, claim window, claim), apart from the schedule so a
 *    change of schedule never loses it. Kept once closed, as the record.
 */

import { deriveKey, encryptJson, decryptJson, KEY_BYTES } from '../acme/AtRestEncryption.ts';

export const SETTING_FIELD = 'autoDeletion';
export const IDENTITY_FIELD = 'autoDeletionTransferIdentity';
/** `:_` prefixed: never the id of a configured data store. */
export const BOOKKEEPING_STORE_ID = ':_autoDeletion';
const BOOKKEEPING_KEY = 'state';
const TRANSFER_KEY = 'transfer';
const FAILED_CLAIMS_KEY = 'transferFailedClaims';
const IDENTITY_KEY_PURPOSE = 'account-auto-deletion-identity-v1';
const LINK_KEY_PURPOSE = 'account-transfer-link-v1';
const DAY_SECONDS = 24 * 60 * 60;

export type Mode = 'never' | 'date' | 'inactivity';
export type Action = 'delete' | 'transfer';

/** What the holder chose for a transfer (name and date of birth are kept apart, encrypted). */
export type TransferSetting = {
  email: string;
  notifyBeneficiary: 'atSetup' | 'atTrigger';
  fallback: 'delete' | 'keep';
  /** A name or a date of birth was given (they are in the identity field). */
  identityGiven?: boolean;
};

/**
 * The life of one transfer. Links (decline, claim) are derived from a salt and
 * the core's key, never stored: re-sent links are the same, and a database dump
 * holds none.
 *  - `named`: the beneficiary was told at setup (or is to be: `namedAt` unset);
 *  - `open`: the claim window is open;
 *  - `claimed`: bound to the first account that claimed it, the delegation
 *    invite is out;
 *  - closed: `completed` (the claimant controls the account), `declined`,
 *    `cancelled` (owner change, or account use before a claim), `lapsed`
 *    (window ended, `keep`), `fallback-delete` (window ended, account erased).
 */
export type TransferStatus = 'named' | 'open' | 'claimed' | 'completed' | 'declined' | 'cancelled' | 'lapsed' | 'fallback-delete';

export type TransferRecord = {
  email: string;
  status: TransferStatus;
  createdAt: number;
  declineSalt?: string;
  namedAt?: number;
  openedAt?: number;
  /** End of the claim window. */
  endsAt?: number;
  claimSalt?: string;
  /** Send times of the claim mail (the first, then the re-sends). */
  claimMailsSent?: number[];
  /** The owner was told the window opened. */
  ownerToldAt?: number;
  claimedBy?: { username: string; hostSlug?: string; relId?: string; at: number };
  closedAt?: number;
  /** Why it closed, when not obvious from the status (e.g. `owner-activity`). */
  closedReason?: string;
};

/**
 * Claims with a wrong link, for the owner's view and the logs, in their own
 * row (an anonymous caller's write must never touch the transfer record). They
 * refuse nothing: a valid link always proceeds. Counted for the claim link of
 * `claimSalt` (a new transfer starts at zero).
 */
export type FailedClaims = { claimSalt: string; count: number; lastAt: number };

export const OPEN_TRANSFER: readonly TransferStatus[] = Object.freeze(['named', 'open', 'claimed']);
export const isOpenTransfer = (r: TransferRecord | null | undefined): r is TransferRecord => r != null && OPEN_TRANSFER.includes(r.status);

export type Setting = {
  mode: Mode;
  /** Pryv seconds, when mode is date. */
  date?: number;
  inactivityDays?: number;
  action: Action;
  transfer?: TransferSetting;
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
  /** `notifiedAt`: the holder was mailed about this block (once); `guard`: the deletion guard that refused. */
  blocked?: { reason: string; at: number; notifiedAt?: number; guard?: string };
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
 * Key the transfer links are derived from: from the same source as the
 * identity key, for another purpose. Null when no source is available.
 */
export function resolveLinkKey (secretsKey: string | null | undefined, adminAccessKey: unknown): Buffer | null {
  if (typeof secretsKey === 'string' && secretsKey.length > 0) {
    return deriveKey(Buffer.from(secretsKey, 'base64'), LINK_KEY_PURPOSE);
  }
  if (typeof adminAccessKey === 'string' && adminAccessKey.length > 0) {
    return deriveKey(adminAccessKey, LINK_KEY_PURPOSE);
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
    },

    async getTransfer (userId: string): Promise<TransferRecord | null> {
      return (await kv.get(userId, TRANSFER_KEY) as TransferRecord | null | undefined) ?? null;
    },

    /** null removes the record. */
    async saveTransfer (userId: string, record: TransferRecord | null): Promise<void> {
      await kv.set(userId, TRANSFER_KEY, record);
    },

    /** The wrong-link count of the transfer whose claim link has `claimSalt`, or null. */
    async getFailedClaims (userId: string, claimSalt: string | undefined): Promise<FailedClaims | null> {
      const v = await kv.get(userId, FAILED_CLAIMS_KEY) as FailedClaims | null | undefined;
      return v != null && claimSalt != null && v.claimSalt === claimSalt ? v : null;
    },

    async countFailedClaim (userId: string, claimSalt: string, at: number): Promise<FailedClaims> {
      const prev = await this.getFailedClaims(userId, claimSalt);
      const next: FailedClaims = { claimSalt, count: (prev?.count ?? 0) + 1, lastAt: at };
      await kv.set(userId, FAILED_CLAIMS_KEY, next);
      return next;
    }
  };
}
