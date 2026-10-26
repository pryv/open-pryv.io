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
 * What an administrator's release of an external id leaves for the account
 * that held it: an audit row in its own trail (always, when audit is on) and
 * an e-mail notice (when mail is configured). Neither carries the value; a
 * failure is logged and never rolls the release back.
 */

const logger = getLogger('methods:externalIds');

type UserRef = { id: string; username: string };
type EmailSettings = Parameters<typeof sendmail>[0] & {
  enabled?: unknown;
  externalIdReleasedTemplate?: string;
};
type SendFn = typeof sendmail;

export const ADMIN_RELEASE_ACTION = 'account.externalIds.adminRelease';

/**
 * Send the notice and say whether it went out. 'mail' when the send
 * succeeded, 'audit-only' otherwise (mail not configured, the class switched
 * off, no address, or the send failed).
 */
export async function notifyExternalIdReleased (
  config: ConfigLike, user: UserRef, details: { namespaceLabel: string; reason: string },
  deps: { send?: SendFn } = {}
): Promise<'mail' | 'audit-only'> {
  try {
    const emailSettings = config.get('services:email') as EmailSettings | null | undefined;
    if (emailSettings == null || !describeMailCapability(config).ok) return 'audit-only';
    const enabled = emailSettings.enabled;
    if (enabled != null && typeof enabled === 'object' && (enabled as { externalIdReleased?: unknown }).externalIdReleased === false) return 'audit-only';
    const account = await (await getUsersRepository()).getUserByUsername(user.username);
    const email = account?.email;
    if (typeof email !== 'string' || email === '') return 'audit-only';
    const substitutions: Record<string, string> = {
      USERNAME: user.username,
      NAMESPACE_LABEL: details.namespaceLabel,
      REASON: details.reason
    };
    const lang = account.language || emailSettings.defaultLang || 'en';
    const send = deps.send ?? sendmail;
    await new Promise<void>((resolve, reject) => {
      send(emailSettings, emailSettings.externalIdReleasedTemplate || 'external-id-released',
        { email, name: user.username, type: 'to' }, substitutions, lang,
        (err?: Error | null) => (err != null ? reject(err) : resolve()));
    });
    return 'mail';
  } catch (err: unknown) {
    logger.warn(`external-id release notice for user "${user.username}" not sent: ${err instanceof Error ? err.message : String(err)}`);
    return 'audit-only';
  }
}

/**
 * Audit row of the release in the account's own trail: the namespace and the
 * administrator's reason, never the value. The admin call itself is audited
 * without a user (its caller holds no access of the account).
 */
export async function auditExternalIdReleased (config: ConfigLike, userId: string, record: { namespace: string; reason: string }): Promise<void> {
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
      streamIds: [C.ACTION_STREAM_ID_PREFIX + ADMIN_RELEASE_ACTION],
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: 'audit-log/external-id',
      content: { action: ADMIN_RELEASE_ACTION, source: { name: 'admin' }, record }
    }, ADMIN_RELEASE_ACTION);
  } catch (err) {
    logger.error(`external-id release audit row not written for user ${userId}`, err);
  }
}
