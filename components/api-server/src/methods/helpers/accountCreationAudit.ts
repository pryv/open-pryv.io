/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { getConfigSync, getLogger } from '@pryv/boiler';
import { createId as cuid } from '@paralleldrive/cuid2';
import timestamp from 'unix-timestamp';
import { parseAccessRef } from 'business/src/accesses/refs.ts';
import { SYSTEM_USER_ACCESS_ID } from 'business/src/users/UserRepositoryOptions.ts';
import { ACCOUNT_EVENT_TYPE } from 'business/src/auth/accountAudit.ts';
import type { MethodNext } from '../_types.ts';

/**
 * The record of an account's creation, the first in its own trail. The call
 * that created it is audited without a user (`auth.register`,
 * `system.createUser`) or in the trail of the account that asked
 * (`delegations.createAccount`); this record is written by the server once
 * the account exists, on the core that created it.
 *
 * It is also the record of the account's first personal access, when one was
 * made: it carries that access's stream, so the access's history starts with
 * its creation (`recordAccessWrite` does not record personal accesses).
 *
 * Ids and fixed words only: no username, address, password, token, app id or
 * invitation, nothing about the administrator or the delegate who asked. The
 * client address is kept for a self-registration only: it is the account
 * holder's own, as on every later call row of the trail. The deletion and the
 * restore of the account are recorded in the same type
 * (business/src/auth/accountAudit.ts).
 */

const logger = getLogger('account-creation-audit');

export { ACCOUNT_EVENT_TYPE };
export const ACCOUNT_CREATED_ACTION = 'account.created';

/** The part of the server that created the account. */
export type AccountCreationSource = 'registration' | 'system' | 'delegation';

export type AccountCreation = {
  source: AccountCreationSource;
  /** The client address, kept for `registration` only. */
  ip?: string | null;
  /** The personal access made with the account, when one was. */
  accessId?: string | null;
};

let uninitialisedLogged = false;

/**
 * Never throws: the account exists; a record that cannot be written is logged
 * (and counted by the audit). `ip` is ignored unless `source` is
 * `registration`.
 */
export async function recordAccountCreated (userId: string, creation: AccountCreation): Promise<void> {
  try {
    if (getConfigSync().get('audit:active') !== true) return;
    // Loaded on demand: the audit singleton must not be pulled in before the
    // storages have initialised it.
    const audit = (await import('audit')).default;
    if (audit.filter == null) {
      if (!uninitialisedLogged) logger.warn('The audit is not initialised in this process: the accounts it creates leave no audit record');
      uninitialisedLogged = true;
      return;
    }
    const C = audit.CONSTANTS;
    const accessId = creation.accessId != null && creation.accessId !== '' && creation.accessId !== SYSTEM_USER_ACCESS_ID
      ? parseAccessRef(creation.accessId).base
      : null;
    const ip = creation.source === 'registration' && typeof creation.ip === 'string' && creation.ip !== '' ? creation.ip : null;
    const now = timestamp.now();
    await audit.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: (accessId != null ? [C.ACCESS_STREAM_ID_PREFIX + accessId] : [])
        .concat([C.ACTION_STREAM_ID_PREFIX + ACCOUNT_CREATED_ACTION]),
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: ACCOUNT_EVENT_TYPE,
      content: {
        action: ACCOUNT_CREATED_ACTION,
        source: { name: creation.source, ...(ip != null ? { ip } : {}) },
        record: accessId != null ? { accessId, accessType: 'personal' } : {}
      }
    }, ACCOUNT_CREATED_ACTION);
  } catch (err) {
    logger.error(`Audit record "${ACCOUNT_CREATED_ACTION}" not written for ${userId}`, err);
  }
}

type CreationContext = {
  newUser?: { id?: unknown; accessId?: unknown };
  source?: { ip?: unknown };
  /** Set on a registration another core forwarded here (routes/auth/register.ts). */
  registrationForwardedFrom?: unknown;
  /** The client address the landing core signed, '' when it knew none. */
  registrationForwardClient?: unknown;
};

/** The client's address: on a forwarded registration, only the signed one (the peer is the other core). */
function clientAddressOf (context: CreationContext): string | null {
  const ip = context.registrationForwardedFrom != null ? context.registrationForwardClient : context.source?.ip;
  return typeof ip === 'string' && ip !== '' ? ip : null;
}

type CreationResult = { redirect?: unknown; forwarded?: unknown };

/**
 * The chain step that follows `registration.createUser`: records the account
 * it created, unless the registration was sent to another core (a redirect or
 * a forward: that core records it).
 */
export function recordAccountCreatedStep (source: 'registration' | 'system') {
  return async function recordAccountCreation (context: CreationContext, _params: unknown, result: CreationResult, next: MethodNext) {
    const userId = context.newUser?.id;
    if (!result.redirect && !result.forwarded && typeof userId === 'string') {
      await recordAccountCreated(userId, {
        source,
        ip: clientAddressOf(context),
        accessId: typeof context.newUser?.accessId === 'string' ? context.newUser.accessId : null
      });
    }
    next();
  };
}
