/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getLogger } from '@pryv/boiler';
import type { ConfigLike } from '@pryv/boiler';
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import { describeMailCapability } from 'business/src/emails/mailCapability.ts';
import { getUsersRepository } from 'business/src/users/index.ts';
import { sendmail } from './mailing.ts';

/**
 * What an MFA change leaves behind besides the change itself: an e-mail
 * notice to the account's address, and an audit row in the account's own
 * trail. Shared by the MFA methods and the admin reset (system.deactivateMfa).
 * Both are best-effort: a failure is logged, never surfaced, so neither can
 * fail or block the change.
 */

const logger = getLogger('methods:mfa');

type UserRef = { id: string; username: string };
type EmailSettings = Parameters<typeof sendmail>[0] & {
  enabled?: unknown;
  mfaChangeTemplate?: string;
};

/** What the e-mail notice reports. */
export type MfaChange = 'enrolled' | 'replaced' | 'deactivated' | 'recovered' | 'deactivatedByAdmin';

/** One template flag per change: 'true' for the change that happened, '' otherwise. */
const CHANGE_FLAGS: Record<MfaChange, string> = {
  enrolled: 'MFA_ENROLLED',
  replaced: 'MFA_REPLACED',
  deactivated: 'MFA_DEACTIVATED',
  recovered: 'MFA_RECOVERED',
  deactivatedByAdmin: 'MFA_DEACTIVATED_BY_ADMIN'
};

/**
 * Send the notice of an MFA change, off the response path. Sent only when
 * mail is configured and the class is not switched off; a failure is logged
 * without the address.
 */
export function notifyMfaChange (config: ConfigLike, user: UserRef, change: MfaChange): void {
  sendMfaChangeNotice(config, user, change).catch((err: unknown) => {
    logger.warn(`MFA change notice (${change}) for user "${user.username}" not sent: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function sendMfaChangeNotice (config: ConfigLike, user: UserRef, change: MfaChange): Promise<void> {
  const emailSettings = config.get('services:email') as EmailSettings | null | undefined;
  if (emailSettings == null || !describeMailCapability(config).ok) return;
  const enabled = emailSettings.enabled;
  if (enabled != null && typeof enabled === 'object' && (enabled as { mfaChange?: unknown }).mfaChange === false) return;
  const account = await (await getUsersRepository()).getUserByUsername(user.username);
  const email = account?.email;
  if (typeof email !== 'string' || email === '') return;
  const substitutions: Record<string, string> = { USERNAME: user.username, MFA_CHANGE: change };
  for (const [kind, flag] of Object.entries(CHANGE_FLAGS)) substitutions[flag] = kind === change ? 'true' : '';
  const lang = account.language || emailSettings.defaultLang || 'en';
  await new Promise<void>((resolve, reject) => {
    sendmail(emailSettings, emailSettings.mfaChangeTemplate || 'mfa-change',
      { email, name: user.username, type: 'to' }, substitutions, lang,
      (err?: Error | null) => (err != null ? reject(err) : resolve()));
  });
}

/** Audit actions of MFA changes made outside the account's own session. */
export type MfaAuditAction = 'mfa.recovered' | 'mfa.deactivatedByAdmin';

/**
 * Audit row of an MFA change, in the account's own trail. The method calls
 * that make these changes (mfa.recover, system.deactivateMfa) are audited
 * without a user (their caller holds no access of the account), so without
 * this row the account's trail would not show its second factor was removed.
 * The record carries the change only, no personal data.
 */
export async function auditMfaChange (config: ConfigLike, userId: string, action: MfaAuditAction, record: Record<string, unknown> = {}): Promise<void> {
  try {
    if (config.get('audit:active') !== true) return;
    // Loaded on demand: the audit singleton must not be pulled in before the
    // storages have initialised it.
    const auditSingleton = (await import('audit')).default;
    const C = auditSingleton.CONSTANTS;
    const now = timestamp.now();
    await auditSingleton.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: [C.ACTION_STREAM_ID_PREFIX + action],
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: 'audit-log/mfa',
      content: { action, source: { name: 'mfa' }, record }
    }, action);
  } catch (err) {
    logger.error(`MFA audit row "${action}" not written`, err);
  }
}
