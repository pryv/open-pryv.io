/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 glue: session accesses, written and read storage-direct on this
 * core (the user is gone at /token time, so no MethodContext is available).
 *
 * Shared mint path `mintAccessDirect`, used by:
 *   - the session minted at /oauth2/authorize/accept (grants.ts), under the
 *     consent grant just created or updated through the API
 *   - mintRefreshedAccess (refresh_token grant: the chain is bound to the
 *     durable data-grant, re-read at every rotation)
 *   - mintClientAccess (client_credentials grant: no end-user; the app
 *     account IS the principal; secret verified by the grant)
 * Both are safe storage-direct inserts (no widening of authority: scope,
 * user, permission shape all server-controlled).
 *
 * Also: the code-exchange read-back (`resolveAccess`), the orphan removal
 * (`revokeAccessLocal`), the DPoP binding (`bindAccessDpop`), the user id /
 * username resolution and the subject a registry client sees.
 */

import type { DataGrant, GlueEnv } from './types.ts';
// Use @paralleldrive/cuid2 (a production dependency): the codebase migrated off
// the old `cuid`, which is a devDependency and is pruned by `--omit=dev` builds.
import { createId as cuid } from '@paralleldrive/cuid2';
import { parseAccessRef } from 'business/src/accesses/refs.ts';
import cache from 'cache';
import { pubsub, USERNAME_BASED_ACCESSES_CHANGED } from 'messages';
import { fromCallback, ApiEndpoint } from 'utils';
import { getUsersLocalIndex } from 'storage';
import { withSessionSelfRevoke, accessesRepo } from './types.ts';
import { notifyScopedAccessChange } from '../../methods/helpers/accessDeletion.ts';
import { effectiveSessionPermissions } from '../../methods/helpers/oauthSessionReconcile.ts';
import { reindexAccessNonFatal, tombstoneAccessesNonFatal } from 'platform/src/accessIndex.ts';

export function createSessions (env: GlueEnv) {
  const { storageLayer } = env;

  // Live head row of the durable data-grant, or a typed throw when the
  // consent has been revoked. Storage keeps the head row queryable by
  // the composite ref's base id (serial bumps rotate the wire id only).
  async function readDataGrantHead (userId: string, username: string, dataGrantAccessId: string): Promise<DataGrant> {
    const accessesRepository = accessesRepo(storageLayer, 'readDataGrantHead');
    const base = parseAccessRef(dataGrantAccessId).base;
    const head: DataGrant | null = await new Promise((resolve, reject) => {
      accessesRepository.findOne({ id: userId, username }, { id: base }, null,
        (err: unknown, found: DataGrant | null) => (err != null ? reject(err) : resolve(found)));
    });
    // Not rounded: `expires` carries sub-second precision, and a "now" rounded
    // down to the second would keep a just-expired grant alive up to 1 s.
    const nowSeconds = Date.now() / 1000;
    if (head == null || head.deleted != null ||
        (typeof head.expires === 'number' && head.expires <= nowSeconds)) {
      const revoked = new Error('consent data-grant revoked or expired') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    return head;
  }

  // A session access names the consent data-grant it was minted under, so
  // deleting that grant deletes the session with it (accessDeletion.ts)
  // instead of leaving it valid until its own expiry, and carries its chain's
  // consent (`chain`: what the user granted, as the refresh row holds it), so
  // a change of the grant re-cuts it to what its next refresh would mint
  // (oauthSessionReconcile.ts). Written only here; accesses.update refuses to
  // change it.
  function sessionClientData (dataGrantAccessId: string, chainPermissions: Array<Record<string, unknown>>, dpopJkt?: string): Record<string, unknown> {
    return {
      oauth: { dataGrantId: parseAccessRef(dataGrantAccessId).base, chain: chainOf(chainPermissions) },
      ...(dpopJkt != null ? { dpop: { jkt: dpopJkt } } : {}),
    };
  }

  // The chain's consent as stored: lexicon fields only (no consent or display
  // annotation, no display name), and never the session's selfRevoke override.
  function chainOf (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const p of permissions ?? []) {
      if (typeof p?.streamId === 'string' && typeof p.level === 'string') out.push({ streamId: p.streamId, level: p.level });
      else if (typeof p?.feature === 'string' && typeof p.setting === 'string') out.push({ feature: p.feature, setting: p.setting });
    }
    return out;
  }

  async function mintAccessDirect ({ userId, username, clientId, permissions, expiresAt, dpopJkt, dataGrantAccessId, chainPermissions }: {
    userId: string;
    username: string;
    clientId: string;
    permissions: Array<Record<string, unknown>>;
    expiresAt: number;
    dpopJkt?: string;
    dataGrantAccessId?: string;
    /** Required with `dataGrantAccessId`: the chain's consent (see sessionClientData). */
    chainPermissions?: Array<Record<string, unknown>>;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    if (dataGrantAccessId != null && !Array.isArray(chainPermissions)) {
      throw new Error('mintAccessDirect: a session of a grant needs its chain permissions');
    }
    const accessesRepository = accessesRepo(storageLayer, 'mintAccessDirect');
    // Millisecond precision, like every other access (timestamp.now()): the
    // client-revoke check compares `created` with a revoke epoch in ms, so a
    // time rounded down to the second would put a session minted just after a
    // revoke (same second) before it, and refuse it as revoked.
    const now = Date.now() / 1000;
    const newToken = accessesRepository.generateToken();
    const newAccessRow: Record<string, unknown> = {
      type: 'app',
      name: 'oauth:' + clientId,
      deviceName: 'oauth-session-' + cuid(),
      token: newToken,
      permissions,
      created: now,
      createdBy: 'system',
      modified: now,
      modifiedBy: 'system',
      expires: Math.floor(expiresAt / 1000),
      // Sender-constrained sessions carry the key thumbprint the
      // resource layer checks the per-request proof against.
      ...(dataGrantAccessId != null
        ? { clientData: sessionClientData(dataGrantAccessId, chainPermissions!, dpopJkt) }
        : (dpopJkt != null ? { clientData: { dpop: { jkt: dpopJkt } } } : {})),
    };
    const minted: { accessId: string; accessToken: string; apiEndpoint: string } = await new Promise((resolve, reject) => {
      accessesRepository.insertOne({ id: userId, username }, newAccessRow,
        (err: unknown, newAccess: { id?: unknown; token?: unknown } | null) => {
          if (err != null) return reject(err);
          if (newAccess == null || typeof newAccess.id !== 'string' || typeof newAccess.token !== 'string') {
            return reject(new Error('mintAccessDirect: accesses.insertOne returned no usable access'));
          }
          resolve({
            accessId: newAccess.id,
            accessToken: newAccess.token,
            apiEndpoint: ApiEndpoint.build(username, newAccess.token),
          });
        });
    });
    // What accesses.create does after its insert: the access-change
    // notifications (coarse and scoped) and the breach-scope index row.
    pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
    notifyScopedAccessChange(username, { id: minted.accessId, type: 'app', permissions }, 'create');
    await reindexAccessNonFatal(username, { ...newAccessRow, id: minted.accessId });
    return minted;
  }

  // ---------------------------------------------------------------------
  // setGrantOf: stamp `clientData.oauth.grantOf` on a registry client's
  // consent grant. `clientData.oauth` is server-owned (accesses.create and
  // accesses.update refuse it), so it is written storage-direct, merged into
  // the rest of clientData, with the integrity hash recomputed.
  // ---------------------------------------------------------------------
  async function setGrantOf (userId: string, username: string, grantId: string, clientId: string): Promise<void> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.setGrantOf');
    const user = { id: userId, username };
    const base = parseAccessRef(grantId).base;
    const grant = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne(user, { id: base }, null, cb));
    if (grant == null) throw new Error('oauth2.setGrantOf: grant not found: ' + grantId);
    const existing: Record<string, unknown> = (grant.clientData != null && typeof grant.clientData === 'object')
      ? { ...grant.clientData }
      : {};
    const oauth = { ...((existing.oauth as Record<string, unknown> | undefined) ?? {}), grantOf: clientId };
    await fromCallback((cb: (e: unknown, r?: unknown) => void) =>
      accessesRepository.updateOne(user, { id: base },
        { clientData: { ...existing, oauth }, modified: Date.now() / 1000 }, cb));
    cache.unsetUserData(userId);
  }

  // ---------------------------------------------------------------------
  // resolveAccountUserId: App account's username → its userId. Needed
  // by client_credentials to target the app's own per-user storage.
  // ---------------------------------------------------------------------
  async function resolveAccountUserId (username: string): Promise<string | null> {
    if (typeof username !== 'string' || username.length === 0) return null;
    const usersIndex = await getUsersLocalIndex();
    const id = await usersIndex.getUserId(username);
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  // ---------------------------------------------------------------------
  // resolveUsername: userId → canonical username, from this core's local
  // index. OAuth2 code / refresh rows carry the user id only (PlatformDB is
  // replicated and must not hold usernames); null when the user is gone.
  // ---------------------------------------------------------------------
  async function resolveUsername (userId: string): Promise<string | null> {
    if (typeof userId !== 'string' || userId.length === 0) return null;
    const usersIndex = await getUsersLocalIndex();
    const name = await usersIndex.getUsername(userId);
    return typeof name === 'string' && name.length > 0 ? name : null;
  }

  // ---------------------------------------------------------------------
  // Refresh: the chain is bound to the durable data-grant; re-read it
  // (revoked → typed throw the grant maps to invalid_grant) and mint from
  // its CURRENT permissions (scope-updates propagate).
  // ---------------------------------------------------------------------
  async function mintRefreshedAccess ({ userId, username, clientId, expiresAt, dataGrantAccessId, permissions, jkt }: {
    userId: string;
    username: string;
    clientId: string;
    scope: string[];
    expiresAt: number;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
    jkt?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string; permissions: Array<Record<string, unknown>>; subject: string; aliased: boolean }> {
    if (dataGrantAccessId == null || !Array.isArray(permissions) || permissions.length === 0) {
      const revoked = new Error('refresh chain carries no consent data-grant binding') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    const dataGrant = await readDataGrantHead(userId, username, dataGrantAccessId);
    // Session grant ∩ data-grant's CURRENT permissions, stream by stream,
    // completed with the stream tree: consent narrowing propagates on refresh
    // (a stream narrowed from `contribute` to `read` is kept at `read`),
    // widening needs a fresh consent, and the grant's forbidden features
    // always reach the session.
    const { permissions: effective, hasReach } =
      await effectiveSessionPermissions(userId, dataGrant as Record<string, unknown>, permissions);
    if (!hasReach) {
      const revoked = new Error('consent no longer covers any of this grant\'s permissions') as Error & { code: string };
      revoked.code = 'data-grant-revoked';
      throw revoked;
    }
    // Session selfRevoke override AFTER the intersection: the intersection
    // compares the chain's granted subset against the data-grant verbatim;
    // the override only shapes the minted session row.
    const minted = await mintAccessDirect({ userId, username, clientId, permissions: withSessionSelfRevoke(effective), expiresAt, dataGrantAccessId, chainPermissions: permissions, ...(jkt != null ? { dpopJkt: jkt } : {}) });
    return { ...minted, ...grantSubject(dataGrant, userId), permissions: effective };
  }

  // ---------------------------------------------------------------------
  // The id a registry client sees for the user: the user's stable internal
  // id (never the username), or the alias of the consent data-grant when the
  // grant is aliased. Null when the grant is gone.
  // ---------------------------------------------------------------------
  function grantSubject (grant: DataGrant, userId: string): { subject: string; aliased: boolean } {
    const aliased = typeof grant.alias === 'string' && grant.alias.length > 0;
    return { subject: aliased ? grant.alias as string : userId, aliased };
  }

  async function resolveGrantSubject ({ userId, username, dataGrantAccessId }: {
    userId: string; username: string; dataGrantAccessId: string;
  }): Promise<{ subject: string; aliased: boolean } | null> {
    try {
      const head = await readDataGrantHead(userId, username, dataGrantAccessId);
      return grantSubject(head, userId);
    } catch (err: unknown) {
      if ((err as { code?: string } | null)?.code === 'data-grant-revoked') return null;
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // bindAccessDpop: stamp the DPoP key thumbprint onto the access that
  // was pre-minted at /authorize/accept (the proof only appears at
  // /token). Storage-direct read-merge-update so other clientData
  // survives, then cluster-wide cache invalidation: the resource layer
  // must see the binding on the very next request.
  // ---------------------------------------------------------------------
  async function bindAccessDpop ({ userId, username, accessId, jkt }: {
    userId: string; username: string; accessId: string; jkt: string;
  }): Promise<void> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.bindAccessDpop');
    const user = { id: userId, username };
    const access = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne(user, { id: accessId }, null, cb));
    if (access == null) throw new Error('oauth2.bindAccessDpop: access not found: ' + accessId);
    const existingClientData: Record<string, unknown> = (access.clientData != null && typeof access.clientData === 'object')
      ? { ...access.clientData }
      : {};
    // Pass `modified` so the integrity-aware updateOne recomputes the
    // tamper-evidence hash over the post-update row itself (it skips the
    // recompute when `modified` is absent): hand-computing the hash here
    // would have to replicate the storage layer's canonicalization.
    await fromCallback((cb: (e: unknown, r?: unknown) => void) =>
      accessesRepository.updateOne(user, { id: accessId },
        { clientData: { ...existingClientData, dpop: { jkt } }, modified: Date.now() / 1000 }, cb));
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
  }

  // ---------------------------------------------------------------------
  // resolveAccess / revokeAccessLocal: the authorization_code exchange
  // reads back the access pre-minted at /accept (the code row carries its
  // id, not its token, since the platform store is replicated to every
  // core), and deletes it when the exchange fails after the code was
  // consumed. Storage-direct on this core, which is the issuing core.
  // ---------------------------------------------------------------------
  // Only an OAuth session access of that client qualifies: a code row names an
  // access by id, and must not be able to reach any other access of the user.
  async function findOAuthSessionAccess (userId: string, username: string, accessId: string, clientId: string): Promise<DataGrant | null> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2');
    const access = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne({ id: userId, username }, { id: accessId }, null, cb));
    if (access == null || access.type !== 'app' || access.name !== 'oauth:' + clientId) return null;
    return access;
  }

  async function resolveAccess ({ userId, username, accessId, clientId }: {
    userId: string; username: string; accessId: string; clientId: string;
  }): Promise<{ accessToken: string; apiEndpoint: string } | null> {
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null || access.deleted != null || typeof access.token !== 'string') return null;
    if (typeof access.expires === 'number' && access.expires <= Date.now() / 1000) return null;
    // Same builder accesses.create uses, so the exchange returns what /accept minted.
    return { accessToken: access.token, apiEndpoint: ApiEndpoint.buildForAccess(access as { alias?: string | null; token?: string }, username) };
  }

  async function revokeAccessLocal ({ userId, username, accessId, clientId }: {
    userId: string; username: string; accessId: string; clientId: string;
  }): Promise<void> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.revokeAccessLocal');
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null) return;
    const user = { id: userId, username };
    await fromCallback((cb: (e: unknown, r?: unknown) => void) => accessesRepository.delete(user, { id: accessId }, cb));
    // The cache validates tokens on `expires` only, never `deleted`.
    cache.unsetUserData(userId);
    // The mint indexed it: the breach-scope index keeps it as deleted.
    await tombstoneAccessesNonFatal(username, [access as Parameters<typeof tombstoneAccessesNonFatal>[1][number]], Date.now() / 1000);
    pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
  }

  async function mintClientAccess ({ userId, username, clientId, expiresAt }: {
    userId: string; username: string; clientId: string; scope: string[]; expiresAt: number;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    // SECURITY POSTURE (by design, not a scope leak): client_credentials
    // acts as the app ITSELF on the app's OWN account (the client row's `accountUserId`),
    // which the app already fully controls by owning it. The minted access is
    // therefore `*/manage` on that one account: NOT an end-user's data and
    // NOT cross-account. The `scope` argument is DELIBERATELY ignored here:
    // for this grant the registered scope tokens are opaque advertisement
    // labels (subset-checked in the grant handler), they do NOT restrict the
    // minted authority. Operators who need a sandboxed server-to-server token
    // (least privilege below the account owner) should provision a separate,
    // narrowly-scoped account rather than expect `scope` to constrain this
    // grant.
    return mintAccessDirect({
      userId,
      username,
      clientId,
      permissions: [{ streamId: '*', level: 'manage' }],
      expiresAt,
    });
  }

  return {
    readDataGrantHead,
    sessionClientData,
    mintAccessDirect,
    setGrantOf,
    resolveAccountUserId,
    resolveUsername,
    mintRefreshedAccess,
    resolveGrantSubject,
    bindAccessDpop,
    resolveAccess,
    revokeAccessLocal,
    mintClientAccess,
  };
}
