/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import type { MethodNext as Next, ResultBag } from '../_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import { factory as errors } from 'errors';
import { ready, getLogger } from '@pryv/boiler';
import { getUsersRepository } from 'business/src/users/index.ts';

/**
 * Audit steps shared by the methods of the administration routes (`/system`).
 *
 * An act is recorded without a user: its record carries the kind of subject,
 * the administrator's id and a short session id, never a code or a token.
 * `auditAdminAct` adds a row to the acting administrator's own trail when the
 * account is on this core.
 */

/** What these steps read from and write to a method context. */
export type AdminAuditContext = {
  adminSubject?: AdminSubject;
  adminPersonal?: { userId: string };
  access?: { id?: string } | null;
  auditIntegrityPayload?: unknown;
};

const SESSION_ID_LENGTH = 16;

/**
 * The method step that sets the audit access id and the record of who acted:
 * `subject` = the subject the /system gate resolved, `personal` = the account
 * of the personal token the route verified (or the subject when there is
 * one), `public` = nobody.
 */
export function auditAs (kind: 'subject' | 'personal' | 'public') {
  return function setAuditSubject (context: AdminAuditContext, _params: unknown, _result: ResultBag, next: Next) {
    const subject = context.adminSubject;
    let accessId = 'public';
    const record: Record<string, unknown> = {};
    if (kind === 'personal' && context.adminPersonal != null) {
      accessId = 'personal-token';
      record.userId = context.adminPersonal.userId;
    }
    if (kind !== 'public' && subject != null) {
      accessId = subject.kind === 'key' ? 'admin' : subject.kind === 'session' ? 'admin-session' : 'setup-session';
      record.via = subject.kind === 'key' ? 'admin-key' : subject.kind;
      if (subject.userId != null) record.userId = subject.userId;
      if (subject.sessionId != null) record.sessionId = subject.sessionId.slice(0, SESSION_ID_LENGTH);
    }
    context.access = { id: accessId };
    context.auditIntegrityPayload = { subject: record };
    next();
  };
}

/** The id an act is attributed to in the rows it writes. */
export function actorOf (subject: AdminSubject | undefined): string {
  if (subject?.kind === 'session' && subject.userId != null) return subject.userId;
  return subject?.kind === 'setup' ? 'setup' : 'admin-key';
}

/** A row of the administrator's own trail, when the account is on this core. Best-effort. */
export async function auditAdminAct (userId: string | undefined, action: string, record: Record<string, unknown>): Promise<void> {
  if (userId == null) return;
  try {
    const config = await ready();
    if (config.get('audit:active') !== true) return;
    const usersRepository = await getUsersRepository();
    if ((await usersRepository.getUsernameForUserId(userId)) == null) return; // not an account of this core
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
      type: 'audit-log/admin',
      content: { action, source: { name: 'admin' }, record }
    }, action);
  } catch (err) {
    getLogger('system-admin').error(`administration audit row "${action}" not written`, err);
  }
}

/**
 * A method step from an async function: a returned error (or a thrown API
 * error) ends the call with it, any other thrown value as an unexpected error.
 */
export function wrap<C> (fn: (context: C, params: Record<string, unknown>, result: ResultBag) => Promise<unknown>) {
  return async function adminStep (context: C, params: Record<string, unknown>, result: ResultBag, next: Next) {
    try {
      const err = await fn(context, params ?? {}, result);
      next(err as Error | undefined);
    } catch (err) {
      next(err instanceof Error && 'id' in err ? err : errors.unexpectedError(err));
    }
  };
}
