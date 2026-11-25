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
import { getStorageLayer } from 'storage';
import { fromCallback } from 'utils';
import { deleteAccessChain } from './accessDeletion.ts';

/**
 * The audit records of the app and shared accesses the server itself creates,
 * changes (permissions, expiry) or deletes, in the trail of the account that
 * holds them. An `accesses.*` API call has its own row, and the issuance of an
 * OAuth session its `oauth.*` event; every other such write is recorded here.
 * Personal accesses are not: the sign-in is their record.
 *
 * A record names the access written (its stream, and one stream per access
 * deleted with it), never an actor on a stream: `access-<id>` on a call row
 * means "this access called". `by` names the access of the account that asked,
 * where one is known. Ids and words of the lists below only: no token, name,
 * address or counterparty.
 */

const logger = getLogger('access-write-audit');

export const ACCESS_EVENT_TYPE = 'audit-log/access';

export type AccessWriteAction = 'accesses.created' | 'accesses.changed' | 'accesses.deleted';
/** The part of the server that wrote. */
export type AccessWriteSource = 'oauth2' | 'cmc' | 'delegation' | 'account' | 'operator-cli';
export type AccessWriteCause =
  // an OAuth consent: another subject mode, an alias another consent holds, a grant that ended
  'consent-subject-changed' | 'alias-race-lost' | 'grant-expired-or-client-revoked' |
  // OAuth sessions
  'refresh-token-reuse' | 'client-revocation' | 'derived-session-replaced' | 'subject-session-gone' | 'grant-changed' |
  'client-purged' | 'address-alias-deleted' |
  // a write of the CMC or delegation plugin: `kind` says what the access is for
  'plugin';

type AccessRef = { id: string; type?: string; clientData?: unknown };
export type AccessWrite = {
  source: AccessWriteSource;
  cause: AccessWriteCause;
  /** The access of this account that asked for it, when one did. */
  by?: string;
  /** The grant whose change caused it. */
  grantId?: string;
};
type AccessWriteRecord = AccessWrite & {
  access: AccessRef;
  /** What was deleted with it. */
  related?: string[];
  changed?: Array<'permissions' | 'expires'>;
};
type DeletionUser = Parameters<typeof deleteAccessChain>[0];
type DeletionParams = Parameters<typeof deleteAccessChain>[1];
type NodeCallback = (err: Error | null, result?: unknown) => void;

let uninitialisedLogged = false;

/** Never throws: the write is done, a record that cannot be written is logged (and counted by the audit). */
export async function recordAccessWrite (userId: string, action: AccessWriteAction, write: AccessWriteRecord): Promise<void> {
  if (write.access.type === 'personal') return;
  try {
    if (getConfigSync().get('audit:active') !== true) return;
    // Loaded on demand: the audit singleton must not be pulled in before the
    // storages have initialised it.
    const audit = (await import('audit')).default;
    if (audit.filter == null) {
      if (!uninitialisedLogged) logger.warn('The audit is not initialised in this process: the accesses it writes leave no audit record');
      uninitialisedLogged = true;
      return;
    }
    const accessId = parseAccessRef(write.access.id).base;
    const related = [...new Set((write.related ?? []).map((id) => parseAccessRef(id).base))].filter((id) => id !== accessId);
    const C = audit.CONSTANTS;
    const now = timestamp.now();
    await audit.eventForUser(userId, {
      id: cuid(),
      createdBy: 'system',
      modifiedBy: 'system',
      streamIds: [C.ACCESS_STREAM_ID_PREFIX + accessId]
        .concat(related.map((id) => C.ACCESS_STREAM_ID_PREFIX + id), [C.ACTION_STREAM_ID_PREFIX + action]),
      time: now,
      endTime: now,
      created: now,
      modified: now,
      trashed: false,
      type: ACCESS_EVENT_TYPE,
      content: {
        action,
        source: { name: write.source },
        record: {
          accessId,
          ...(write.access.type != null ? { accessType: write.access.type } : {}),
          ...kindOf(write.access),
          cause: write.cause,
          ...(write.by != null ? { by: parseAccessRef(write.by).base } : {}),
          ...(write.grantId != null ? { grantId: parseAccessRef(write.grantId).base } : {}),
          ...(related.length > 0 ? { related } : {}),
          ...(write.changed != null ? { changed: write.changed } : {})
        }
      }
    }, action);
  } catch (err) {
    logger.error(`Audit record "${action}" of access ${write.access.id} not written for ${userId}`, err);
  }
}

/**
 * `deleteAccessChain`, recorded: one record naming the access and what went
 * with it. A deletion that fails once the access is gone is recorded too.
 */
export async function deleteAccessChainRecorded (user: DeletionUser, params: DeletionParams, write: AccessWrite): Promise<Awaited<ReturnType<typeof deleteAccessChain>>> {
  const before = await liveAccess(user, params.id);
  const gone: string[] = [];
  let outcome: Awaited<ReturnType<typeof deleteAccessChain>>;
  try {
    outcome = await deleteAccessChain(user, { ...params, onDeleted: (ids) => { gone.push(...ids); } });
  } catch (err) {
    if (before != null && (gone.length > 0 || await liveAccess(user, params.id) == null)) {
      await recordAccessWrite(user.id, 'accesses.deleted', { ...write, access: before, related: gone });
    }
    throw err;
  }
  if (outcome.deleted && outcome.accessToDelete != null) {
    await recordAccessWrite(user.id, 'accesses.deleted', {
      ...write,
      access: outcome.accessToDelete,
      related: outcome.relatedDeletions.map((r) => r.id)
    });
  }
  return outcome;
}

/** The live access, or null (deleted, or it cannot be read). */
async function liveAccess (user: DeletionUser, id: string): Promise<AccessRef | null> {
  try {
    const storageLayer = await getStorageLayer();
    return await fromCallback((cb: NodeCallback) =>
      storageLayer.accesses.findOne(user, { id }, { projection: { calls: 0 } }, cb)) as AccessRef | null;
  } catch {
    return null;
  }
}

/** What the access is for, from the stamps only the server writes. */
function kindOf (access: AccessRef): { kind?: string } {
  const clientData = access.clientData as {
    cmc?: { role?: unknown };
    delegation?: { kind?: unknown };
    oauth?: { grantOf?: unknown; dataGrantId?: unknown };
  } | null | undefined;
  const stamp = clientData?.cmc?.role ?? clientData?.delegation?.kind;
  if (typeof stamp === 'string' && /^[a-z][a-z-]{0,31}$/.test(stamp)) return { kind: stamp };
  // Stamped on a session, and on what a session creates.
  if (clientData?.oauth?.dataGrantId != null) return { kind: access.type === 'app' ? 'oauth-session' : 'oauth-session-child' };
  if (clientData?.oauth?.grantOf != null) return { kind: 'oauth-grant' };
  return {};
}
