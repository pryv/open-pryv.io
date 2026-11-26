/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The removal of an OAuth session access that never reached its client, in a
 * module of its own: the OAuth glue (routes/oauth2/sessions.ts) and the
 * master's periodic sweep (bin/master.js) both load it, and the master loads
 * only what it runs.
 */

import { createHash } from 'node:crypto';
import cache from 'cache';
import { pubsub, USERNAME_BASED_ACCESSES_CHANGED } from 'messages';
import { fromCallback } from 'utils';
import { getLogger } from '@pryv/boiler';
import { tombstoneAccessesNonFatal } from 'platform/src/accessIndex.ts';
import { releaseAliasesIfUnused } from './accessDeletion.ts';
import type { DataGrant } from '../../routes/oauth2/types.ts';

/** An OAuth session access of a client, as a code or refresh row names it. */
type SessionRef = { userId: string; username: string; accessId: string; clientId: string };

type SessionUser = { id: string; username: string };
type AccessesRepository = {
  findOne: (user: SessionUser, query: Record<string, unknown>, opts: unknown, cb: (err: unknown, found: DataGrant | null) => void) => void;
  delete: (user: SessionUser, query: Record<string, unknown>, cb: (err: unknown) => void) => void;
};

function accessesOf (storageLayer: unknown, caller: string): AccessesRepository {
  const repo = (storageLayer as { accesses?: AccessesRepository })?.accesses;
  if (repo == null) throw new Error(caller + ': storageLayer.accesses unavailable');
  return repo;
}

/**
 * The OAuth session access `accessId` of `clientId`, or null. Only such an
 * access qualifies: a code row names an access by id, and must not be able to
 * reach any other access of the user.
 */
async function findOAuthSessionAccessIn (storageLayer: unknown, userId: string, username: string, accessId: string, clientId: string): Promise<DataGrant | null> {
  const accessesRepository = accessesOf(storageLayer, 'oauth2');
  const access = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
    accessesRepository.findOne({ id: userId, username }, { id: accessId }, null, cb));
  if (access == null || access.type !== 'app' || access.name !== 'oauth:' + clientId) return null;
  return access;
}

/**
 * Remove an OAuth session access from this core's storage: the session
 * pre-minted at /accept when its code exchange fails after the code was
 * consumed, a session a refresh could not hand over, and the session behind
 * an authorization code that expired without being exchanged (the master's
 * periodic sweep). One body for all of them, so each leaves the same trace:
 * the breach-scope index keeps the access as deleted, the alias is released
 * when this session was its last holder, the account's socket clients are
 * told. A session that never reached its client has no webhook and created
 * nothing, so nothing cascades. Not recorded in the audit trail (see
 * accessWriteAudit.ts).
 * @returns false when no such session access exists.
 */
async function revokeOAuthSessionLocal (storageLayer: unknown, { userId, username, accessId, clientId }: SessionRef): Promise<boolean> {
  const accessesRepository = accessesOf(storageLayer, 'oauth2.revokeAccessLocal');
  const access = await findOAuthSessionAccessIn(storageLayer, userId, username, accessId, clientId);
  if (access == null) return false;
  const user = { id: userId, username };
  await fromCallback((cb: (e: unknown, r?: unknown) => void) => accessesRepository.delete(user, { id: accessId }, cb));
  // The cache validates tokens on `expires` only, never `deleted`.
  cache.unsetUserData(userId);
  // The mint indexed it: the breach-scope index keeps it as deleted.
  await tombstoneAccessesNonFatal(username, [access as Parameters<typeof tombstoneAccessesNonFatal>[1][number]], Date.now() / 1000);
  // Its alias is the grant's: kept while the grant (or another session)
  // still carries it, released if this session was its last holder. The
  // access is gone already and nothing retries the release: a failure is
  // logged with the alias's hash, so the reservation can be found.
  if (typeof access.alias === 'string') {
    try {
      await releaseAliasesIfUnused(user, [access.alias]);
    } catch (err: unknown) {
      getLogger('oauth2:session-removal').warn('the alias of a removed OAuth session was not released', {
        userId,
        accessId,
        aliasHash: createHash('sha256').update(access.alias).digest('hex').slice(0, 16),
        error: String((err as Error)?.message ?? err),
      });
    }
  }
  pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
  return true;
}

export { findOAuthSessionAccessIn, revokeOAuthSessionLocal };
export type { SessionRef };
