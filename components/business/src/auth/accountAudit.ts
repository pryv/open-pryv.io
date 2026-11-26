/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getConfigSync, getLogger } from '@pryv/boiler';
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import { parseAccessRef } from '../accesses/refs.ts';
import { SYSTEM_USER_ACCESS_ID } from '../users/UserRepositoryOptions.ts';

/**
 * The records the server writes in an account's own trail about the account
 * itself (type `audit-log/account`): its creation (api-server
 * methods/helpers/accountCreationAudit.ts), its deletion and its restore
 * (here: the erasure and the restore live in this component).
 *
 * Ids and fixed words only: no username, address of the account, token or
 * free text. A record never stops what it records: one that cannot be
 * written is logged, and counted as lost by the audit.
 */

const logger = getLogger('account-audit');

export const ACCOUNT_EVENT_TYPE = 'audit-log/account';
export const ACCOUNT_DELETED_ACTION = 'account.deleted';
export const ACCOUNT_RESTORED_ACTION = 'account.restored';

type ConfigReader = { get (key: string): unknown };

/**
 * How long a record an erasure writes (`account.deleted`, and the
 * auto-deletion sweep's erasure record) waits for the audit storage: past it
 * the record counts as lost and the erasure goes on. Tests change `ms`.
 */
export const erasureRecordWait = { ms: 10 * 1000 };

/**
 * The words an erasure's trigger may be (its record and the erasure ledger
 * keep the same word), and who erased the account for each. Any other word
 * (an old or foreign record: the trigger is a free string in storage) is
 * written `unknown`.
 */
const SOURCE_OF_TRIGGER: Record<string, string> = {
  holder: 'holder',
  admin: 'admin',
  date: 'auto-deletion',
  inactivity: 'auto-deletion',
  'transfer-fallback': 'auto-deletion',
  'ledger-replay': 'ledger-replay',
  system: 'system',
  'unfinished-registration': 'system'
};

/** The `source.name` and `record.trigger` written for an erasure's `trigger`. */
export function deletionWordsOf (trigger: unknown): { source: string; trigger: string } {
  if (typeof trigger === 'string' && Object.hasOwn(SOURCE_OF_TRIGGER, trigger)) {
    return { source: SOURCE_OF_TRIGGER[trigger], trigger };
  }
  return { source: 'unknown', trigger: 'unknown' };
}

export type AccountDeletion = {
  /** The trigger of the erasure (its record's). */
  trigger: unknown;
  /** The client address of the request: kept for the trigger `holder` only. */
  ip?: string | null;
  /** The personal access that asked: kept for the trigger `holder` only. */
  accessId?: string | null;
};

export type AccountRestore = {
  /** When the backup's data of the account was taken (ms), null when the backup does not say. */
  snapshotMs: number | null;
  /** `existing`: the id was an account of this core before the restore. */
  target: 'new' | 'existing';
  /** The restore overrode an erasure recorded after the backup (`completed`), or withdrew one that had stopped (`unfinished`). */
  afterErasure?: 'completed' | 'unfinished' | null;
};

let uninitialisedLogged = false;

/** Writes `content` in `userId`'s trail, waiting at most `waitMs` for the storage when set; never throws. */
async function write (userId: string, action: string, accessId: string | null, content: Record<string, unknown>, config: ConfigReader, waitMs: number | null = null): Promise<void> {
  try {
    if (config.get('audit:active') !== true) return;
    // Loaded on demand: the audit singleton must not be pulled in before the
    // storages have initialised it.
    const audit = (await import('audit')).default;
    if (audit.filter == null) {
      if (!uninitialisedLogged) logger.warn('The audit is not initialised in this process: the accounts it erases or restores leave no audit record of it');
      uninitialisedLogged = true;
      return;
    }
    const C = audit.CONSTANTS;
    const now = timestamp.now();
    await audit.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: (accessId != null ? [C.ACCESS_STREAM_ID_PREFIX + accessId] : [])
        .concat([C.ACTION_STREAM_ID_PREFIX + action]),
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: ACCOUNT_EVENT_TYPE,
      content: { action, ...content }
    }, action, 'event', waitMs);
  } catch (err) {
    logger.error(`Audit record "${action}" not written for ${userId}`, err);
  }
}

/**
 * The record of an account's deletion, the last one the server writes on
 * purpose in its trail: only where the trail outlives the account
 * (`audit.onUserDelete: keep`, read now, as the erasure reads it), written
 * before any of the account's data goes. Never throws, and waits at most
 * `erasureRecordWait.ms` for the audit storage.
 */
export async function recordAccountDeleted (userId: string, deletion: AccountDeletion, config: ConfigReader = getConfigSync()): Promise<void> {
  if (config.get('audit:active') !== true || config.get('audit:onUserDelete') !== 'keep') return;
  const words = deletionWordsOf(deletion.trigger);
  const byHolder = words.trigger === 'holder';
  const accessId = byHolder && typeof deletion.accessId === 'string' && deletion.accessId !== '' && deletion.accessId !== SYSTEM_USER_ACCESS_ID
    ? parseAccessRef(deletion.accessId).base
    : null;
  const ip = byHolder && typeof deletion.ip === 'string' && deletion.ip !== '' ? deletion.ip : null;
  await write(userId, ACCOUNT_DELETED_ACTION, accessId, {
    source: { name: words.source, ...(ip != null ? { ip } : {}) },
    record: { trigger: words.trigger, ...(accessId != null ? { accessId, accessType: 'personal' } : {}) }
  }, config, erasureRecordWait.ms);
}

const EARLIEST_BACKUP_MS = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC date (`YYYY-MM-DD`) of a backup's snapshot, null when it is not a plausible one (a manifest is input). */
export function backupDateOf (snapshotMs: unknown, now: number = Date.now()): string | null {
  if (typeof snapshotMs !== 'number' || !Number.isFinite(snapshotMs)) return null;
  if (snapshotMs < EARLIEST_BACKUP_MS || snapshotMs > now + DAY_MS) return null;
  return new Date(snapshotMs).toISOString().slice(0, 10);
}

/**
 * The record of an account's restore from a backup, in the restored
 * account's trail, once the restore keeps it. Never throws.
 */
export async function recordAccountRestored (userId: string, restore: AccountRestore, config: ConfigReader = getConfigSync()): Promise<void> {
  const backupDate = backupDateOf(restore.snapshotMs);
  await write(userId, ACCOUNT_RESTORED_ACTION, null, {
    source: { name: 'backup' },
    record: {
      ...(backupDate != null ? { backupDate } : {}),
      target: restore.target === 'existing' ? 'existing' : 'new',
      ...(restore.afterErasure === 'completed' || restore.afterErasure === 'unfinished' ? { afterErasure: restore.afterErasure } : {})
    }
  }, config);
}
