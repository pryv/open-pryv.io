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
import { formerUsernames } from 'business/src/series/namespace.ts';
import { isAddressAliasShape } from 'business/src/users/aliasShape.ts';
import { bindableAddressAliases } from '../../methods/helpers/addressAliases.ts';
import { canonicalStreamId } from 'mall/src/helpers/storeDataUtils.ts';
import { withSessionSelfRevoke, accessesRepo, samePermissionKeys, SESSION_NAME_PREFIX, DERIVED_DEVICE_PREFIX } from './types.ts';
import { notifyScopedAccessChange, releaseAliasesIfUnused, deleteAccessChain } from '../../methods/helpers/accessDeletion.ts';
import { effectiveSessionPermissions } from '../../methods/helpers/oauthSessionReconcile.ts';
import { reindexAccessNonFatal, tombstoneAccessesNonFatal } from 'platform/src/accessIndex.ts';
import { getExtension, frozenGrantState } from 'oauth2/src/extension.ts';
import { getClient as getOAuthClient, issuedBeforeClientRevoke } from 'oauth2/src/storage.ts';
import { isMetadataClientKey, metadataClientStamp } from 'oauth2/src/clientMetadataId.ts';
import type { MetadataClientStamp } from 'oauth2/src/clientMetadataId.ts';
import * as storages from 'storages';
import { isDeepStrictEqual } from 'node:util';

/** What a derived session (token exchange) is derived from (`subjectCreated`: seconds). */
type DerivedFrom = { subjectClientId: string; subjectAccessId: string; subjectCreated?: number };

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
  // change it. A session minted for a resource server records it
  // (`audience`: the data API refuses such a session while
  // `oauth:audienceBoundSessions` is on); a derived session records the
  // subject session it was exchanged for (`exchange`).
  function sessionClientData (dataGrantAccessId: string, chainPermissions: Array<Record<string, unknown>>, dpopJkt?: string,
    more: { audience?: string; exchange?: DerivedFrom; client?: MetadataClientStamp | null } = {}): Record<string, unknown> {
    return {
      oauth: {
        dataGrantId: parseAccessRef(dataGrantAccessId).base,
        chain: chainOf(chainPermissions),
        ...(typeof more.audience === 'string' && more.audience.length > 0 ? { audience: more.audience } : {}),
        ...(more.client != null ? { client: more.client } : {}),
        ...(more.exchange != null
          ? {
              exchange: {
                subjectClientId: more.exchange.subjectClientId,
                subjectAccessId: more.exchange.subjectAccessId,
                ...(typeof more.exchange.subjectCreated === 'number' ? { subjectCreated: more.exchange.subjectCreated } : {}),
              },
            }
          : {}),
      },
      ...(dpopJkt != null ? { dpop: { jkt: dpopJkt } } : {}),
    };
  }

  // The chain's consent as stored: lexicon fields only (no consent or display
  // annotation, no display name), and never the session's selfRevoke override.
  function chainOf (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const p of permissions ?? []) {
      if (typeof p?.streamId === 'string' && typeof p.level === 'string') out.push({ streamId: canonicalStreamId(p.streamId), level: p.level });
      else if (typeof p?.feature === 'string' && typeof p.setting === 'string') out.push({ feature: p.feature, setting: p.setting });
    }
    return out;
  }

  // One spelling per stream in what a session row stores, notifies and
  // indexes (`:local:a` is `a`), as accesses.create writes it.
  function canonicalPermissions (permissions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return permissions.map((p) => (typeof p?.streamId === 'string' ? { ...p, streamId: canonicalStreamId(p.streamId) } : p));
  }

  // What a session holds, as its STORED row says it, without the session's
  // selfRevoke override: the one input of the scope echo at the code
  // exchange, at refresh and at introspection (never the code row's consent,
  // never the loaded access view, which adds the audit and account entries).
  function storedSessionPermissions (permissions: Array<Record<string, unknown>> | null | undefined): Array<Record<string, unknown>> {
    return canonicalPermissions((permissions ?? []).filter((p) => p?.feature !== 'selfRevoke'));
  }

  async function mintAccessDirect ({ userId, username, clientId, permissions: rawPermissions, expiresAt, dpopJkt, dataGrantAccessId, chainPermissions, alias, audience, deviceName, exchange }: {
    userId: string;
    username: string;
    clientId: string;
    permissions: Array<Record<string, unknown>>;
    expiresAt: number;
    dpopJkt?: string;
    dataGrantAccessId?: string;
    /** Required with `dataGrantAccessId`: the chain's consent (see sessionClientData). */
    chainPermissions?: Array<Record<string, unknown>>;
    /**
     * The grant's alias, when the grant is aliased: the session carries it
     * (its apiEndpoint, access-info and the only name it may be used at are
     * the alias, never the username). Held by the grant: deleting a session
     * releases nothing while the grant or another session still holds it.
     */
    alias?: string | null;
    /** A session of a grant: the resource server the authorization named. */
    audience?: string;
    /** The row's device name; default: a fresh `oauth-session-<cuid>`. */
    deviceName?: string;
    /** A session of a grant: the subject session it is derived from (token exchange). */
    exchange?: DerivedFrom;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string }> {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('mintAccessDirect: username required');
    }
    if (dataGrantAccessId != null && !Array.isArray(chainPermissions)) {
      throw new Error('mintAccessDirect: a session of a grant needs its chain permissions');
    }
    if (dataGrantAccessId == null && (audience != null || exchange != null)) {
      throw new Error('mintAccessDirect: an audience or an exchange belongs to a session of a grant');
    }
    const permissions = canonicalPermissions(rawPermissions);
    // A session of a metadata-document client's grant (not a derived one) is
    // stamped with the client's display fields, as the client row says now.
    const client = dataGrantAccessId != null && exchange == null ? await metadataClientStampOf(clientId) : null;
    const accessesRepository = accessesRepo(storageLayer, 'mintAccessDirect');
    // Millisecond precision, like every other access (timestamp.now()): the
    // client-revoke check compares `created` with a revoke epoch in ms, so a
    // time rounded down to the second would put a session minted just after a
    // revoke (same second) before it, and refuse it as revoked.
    const now = Date.now() / 1000;
    const newToken = accessesRepository.generateToken();
    const newAccessRow: Record<string, unknown> = {
      type: 'app',
      name: SESSION_NAME_PREFIX + clientId,
      deviceName: deviceName ?? 'oauth-session-' + cuid(),
      token: newToken,
      permissions,
      created: now,
      createdBy: 'system',
      modified: now,
      modifiedBy: 'system',
      expires: Math.floor(expiresAt / 1000),
      ...(typeof alias === 'string' && alias.length > 0 ? { alias } : {}),
      // Sender-constrained sessions carry the key thumbprint the
      // resource layer checks the per-request proof against.
      ...(dataGrantAccessId != null
        ? {
            clientData: sessionClientData(dataGrantAccessId, chainPermissions!, dpopJkt, {
              ...(audience != null ? { audience } : {}),
              ...(exchange != null ? { exchange } : {}),
              client,
            }),
          }
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
            // Same builder accesses.create uses: the alias when the row has one.
            apiEndpoint: ApiEndpoint.buildForAccess({ alias: newAccessRow.alias as string | undefined, token: newAccess.token }, username),
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
  // The server-owned `clientData.oauth` of a consent grant (accesses.create
  // and accesses.update refuse it) is written storage-direct, merged into the
  // rest of clientData, with the integrity hash recomputed. `change` returns
  // the new `oauth` sub-object, or null to leave the row untouched.
  // ---------------------------------------------------------------------
  async function updateGrantOauth (userId: string, username: string, grantId: string, caller: string,
    change: (oauth: Record<string, unknown>) => Record<string, unknown> | null): Promise<void> {
    const accessesRepository = accessesRepo(storageLayer, caller);
    const user = { id: userId, username };
    const base = parseAccessRef(grantId).base;
    const grant = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne(user, { id: base }, null, cb));
    if (grant == null) throw new Error(caller + ': grant not found: ' + grantId);
    const existing: Record<string, unknown> = (grant.clientData != null && typeof grant.clientData === 'object')
      ? { ...grant.clientData }
      : {};
    const oauth = change({ ...((existing.oauth as Record<string, unknown> | undefined) ?? {}) });
    if (oauth == null) return;
    await fromCallback((cb: (e: unknown, r?: unknown) => void) =>
      accessesRepository.updateOne(user, { id: base },
        { clientData: { ...existing, oauth }, modified: Date.now() / 1000 }, cb));
    cache.unsetUserData(userId);
  }

  // setGrantOf: stamp `clientData.oauth.grantOf` on a registry client's
  // consent grant.
  async function setGrantOf (userId: string, username: string, grantId: string, clientId: string): Promise<void> {
    await updateGrantOauth(userId, username, grantId, 'oauth2.setGrantOf', (oauth) => ({ ...oauth, grantOf: clientId }));
  }

  // The display stamp of a metadata-document client (`clientData.oauth.client`:
  // name, host, url), from its row as it stands; null for any other client.
  // A snapshot: what the account app names the connected app by, the row key
  // (`oauth:url~…`) being no name.
  async function metadataClientStampOf (clientId: string): Promise<MetadataClientStamp | null> {
    if (!isMetadataClientKey(clientId)) return null;
    const platform = storages.platformDB as Parameters<typeof getOAuthClient>[0] | null | undefined;
    if (platform == null) return null;
    return metadataClientStamp(await getOAuthClient(platform, clientId));
  }

  // setGrantClient: stamp (again, at each consent) a metadata-document
  // client's grant with its display fields; written only when they changed.
  async function setGrantClient (userId: string, username: string, grantId: string, clientId: string): Promise<void> {
    const stamp = await metadataClientStampOf(clientId);
    if (stamp == null) return;
    await updateGrantOauth(userId, username, grantId, 'oauth2.setGrantClient', (oauth) =>
      (isDeepStrictEqual(oauth.client, stamp) ? null : { ...oauth, client: stamp }));
  }

  // setGrantState: the grant's state after a consent, under the extension's
  // name in `clientData.oauth.extensionData` (on the grant only, never on a
  // session). Replaces the previous one; `undefined` removes it. Not written
  // when unchanged.
  async function setGrantState (userId: string, username: string, grantId: string, name: string, value: unknown): Promise<void> {
    await updateGrantOauth(userId, username, grantId, 'oauth2.setGrantState', (oauth) => {
      const current = (oauth.extensionData != null && typeof oauth.extensionData === 'object')
        ? { ...(oauth.extensionData as Record<string, unknown>) }
        : {};
      if (isDeepStrictEqual(current[name], value)) return null;
      if (value === undefined) delete current[name];
      else current[name] = value;
      const next = { ...oauth };
      if (Object.keys(current).length === 0) delete next.extensionData;
      else next.extensionData = current;
      return next;
    });
  }

  // The state the installed extension stored on `grant`, if any.
  function grantStateOf (grant: DataGrant): unknown {
    const name = getExtension()?.name;
    if (name == null) return undefined;
    const data = grant.clientData?.oauth?.extensionData;
    if (data == null || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, name)) return undefined;
    return frozenGrantState(data[name]);
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
  // addressAliasesOf: the names, other than the current username, a consent
  // of `clientId` may bind in a per-user OAuth resource
  // (`https://<name>.<domain>/...`): the account's address aliases no access
  // holds, and the one this client's grant holds (a re-authorization at the
  // same address); from this core's users index, never from the request. An
  // address alias another grant holds, an access's alias and a former
  // username are none of them.
  // ---------------------------------------------------------------------
  async function addressAliasesOf (userId: string, clientId?: string): Promise<string[]> {
    const username = await resolveUsername(userId);
    if (username == null) return [];
    return await bindableAddressAliases({ id: userId, username }, clientId ?? null);
  }

  // ---------------------------------------------------------------------
  // formerUsernamesOf: the usernames the account had before a rename and
  // still holds (a renamed account keeps its former name as an alias, so its
  // former address keeps routing to it), from this core's users index: the
  // aliases minus the minted ones (`r-` shape, never a username) and minus
  // the current username (the series helper's reading of the same index).
  // Read by the token exchange only: an authorization made at a former
  // address keeps exchanging; a new consent there is refused. Residual (fails
  // closed): a username of the exact minted shape, registered before that
  // shape was refused, is taken for an access alias once it is a former name,
  // so a chain made at that address stops exchanging after the rename.
  // ---------------------------------------------------------------------
  async function formerUsernamesOf (userId: string, username: string): Promise<string[]> {
    return await formerUsernames(await getUsersLocalIndex(), userId, username);
  }

  // ---------------------------------------------------------------------
  // Refresh: the chain is bound to the durable data-grant; re-read it
  // (revoked → typed throw the grant maps to invalid_grant) and mint from
  // its CURRENT permissions (scope-updates propagate).
  // ---------------------------------------------------------------------
  async function mintRefreshedAccess ({ userId, username, clientId, expiresAt, dataGrantAccessId, permissions, jkt, audience }: {
    userId: string;
    username: string;
    clientId: string;
    scope: string[];
    expiresAt: number;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
    jkt?: string;
    audience?: string;
  }): Promise<{ accessId: string; accessToken: string; apiEndpoint: string; permissions: Array<Record<string, unknown>>; subject: string; aliased: boolean; grantState?: unknown }> {
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
    const minted = await mintAccessDirect({
      userId,
      username,
      clientId,
      permissions: withSessionSelfRevoke(effective),
      expiresAt,
      dataGrantAccessId,
      chainPermissions: permissions,
      alias: dataGrant.alias,
      ...(jkt != null ? { dpopJkt: jkt } : {}),
      ...(audience != null ? { audience } : {}),
    });
    // The scope echo reads what the session row stores (minus the override).
    return { ...minted, ...grantSubject(dataGrant, userId), permissions: storedSessionPermissions(effective) };
  }

  // ---------------------------------------------------------------------
  // The id a registry client sees for the user: the user's stable internal
  // id (never the username), or the alias of the consent data-grant when the
  // grant is aliased. Null when the grant is gone.
  // ---------------------------------------------------------------------
  // With it, the grant's state (registry clients; advisory, see the oauth2
  // extension contract).
  function grantSubject (grant: DataGrant, userId: string): { subject: string; aliased: boolean; grantState?: unknown } {
    const aliased = typeof grant.alias === 'string' && grant.alias.length > 0;
    return { subject: aliased ? grant.alias as string : userId, aliased, grantState: grantStateOf(grant) };
  }

  async function resolveGrantSubject ({ userId, username, dataGrantAccessId }: {
    userId: string; username: string; dataGrantAccessId: string;
  }): Promise<{ subject: string; aliased: boolean; grantState?: unknown } | null> {
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
  }): Promise<{ accessToken: string; apiEndpoint: string; permissions: Array<Record<string, unknown>> } | null> {
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null || access.deleted != null || typeof access.token !== 'string') return null;
    if (typeof access.expires === 'number' && access.expires <= Date.now() / 1000) return null;
    // Same builder accesses.create uses, so the exchange returns what /accept minted.
    return {
      accessToken: access.token,
      apiEndpoint: ApiEndpoint.buildForAccess(access as { alias?: string | null; token?: string }, username),
      permissions: storedSessionPermissions(access.permissions),
    };
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
    // Its alias is the grant's: kept while the grant (or another session)
    // still carries it, released if this session was its last holder.
    if (typeof access.alias === 'string') await releaseAliasesIfUnused(user, [access.alias]);
    pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
  }

  // ---------------------------------------------------------------------
  // retireSession: a refresh rotation retires the session its chain backed
  // until then. The row expires `oauth:refreshRetireGraceSeconds` from now
  // (clamped to [0, accessTokenTTL]) instead of living out its lifetime:
  // requests in flight finish, and what the session created survives as on
  // a natural expiry (no deletion, no history, no notification). Skipped for
  // a row already gone or expiring within the grace.
  // ---------------------------------------------------------------------
  async function retireSession ({ userId, username, accessId, clientId }: {
    userId: string; username: string; accessId: string; clientId: string;
  }): Promise<boolean> {
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null || access.deleted != null) return false;
    const until = Math.floor(Date.now() / 1000) + retireGraceSeconds();
    if (typeof access.expires === 'number' && access.expires <= until) return false;
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.retireSession');
    // `modified` makes the integrity-aware updateOne recompute the row hash.
    await fromCallback((cb: (e: unknown, r?: unknown) => void) =>
      accessesRepository.updateOne({ id: userId, username }, { id: accessId }, { expires: until, modified: Date.now() / 1000 }, cb));
    // The access cache validates on `expires`: drop the cached copy.
    cache.unsetUserData(userId);
    return true;
  }

  function retireGraceSeconds (): number {
    const ttl = Number(env.config.get('oauth:accessTokenTTL') ?? 3600);
    const raw = Number(env.config.get('oauth:refreshRetireGraceSeconds') ?? 60);
    const grace = Number.isFinite(raw) ? raw : 60;
    return Math.min(Math.max(0, Math.floor(grace)), Number.isFinite(ttl) ? ttl : 3600);
  }

  // ---------------------------------------------------------------------
  // Token exchange (RFC 8693). The subject session is re-read on its home
  // core (live, not itself derived, its grant live); the derived session is
  // a session of the same grant, named after the resource server, one per
  // (subject session, resource server): the identity (type, name,
  // deviceName) is unique among rows not deleted (expired ones included), so
  // a repeated exchange finds it and answers its token while it lives, and of
  // two concurrent first exchanges the second insert fails on the slot and
  // reuses the first's row. An expired row, or one created at or before the
  // resource server's revoke epoch, is deleted and replaced: an expired
  // credential is never brought back.
  // ---------------------------------------------------------------------
  async function liveSubjectRow (userId: string, username: string, accessId: string, clientId: string): Promise<DataGrant | null> {
    const access = await findOAuthSessionAccess(userId, username, accessId, clientId);
    if (access == null || access.deleted != null || typeof access.token !== 'string') return null;
    if (typeof access.expires !== 'number' || access.expires <= Date.now() / 1000) return null;
    const oauth = access.clientData?.oauth;
    if (typeof oauth?.dataGrantId !== 'string' || oauth.exchange != null) return null;
    return access;
  }

  async function readSubjectSession ({ userId, accessId, clientId, dataGrantAccessId }: {
    userId: string; accessId: string; clientId: string; dataGrantAccessId?: string;
  }): Promise<{
    username: string;
    created: number;
    expires: number;
    permissions: Array<Record<string, unknown>>;
    subject: string;
    aliased: boolean;
    grantState?: unknown;
    apiBase: string;
    addressAliases: string[];
    formerUsernames: string[];
  } | null> {
    const username = await resolveUsername(userId);
    if (username == null) return null;
    const access = await liveSubjectRow(userId, username, accessId, clientId);
    if (access == null) return null;
    let grant: DataGrant;
    try {
      // The session row names its grant (authoritative over the index row's copy).
      grant = await readDataGrantHead(userId, username, access.clientData?.oauth?.dataGrantId ?? dataGrantAccessId!);
    } catch (err: unknown) {
      if ((err as { code?: string } | null)?.code === 'data-grant-revoked') return null;
      throw err;
    }
    const s = grantSubject(grant, userId);
    return {
      username,
      created: typeof access.created === 'number' ? access.created : 0,
      expires: access.expires as number,
      permissions: storedSessionPermissions(access.permissions),
      ...s,
      // No credential in it; the alias when the grant is aliased.
      apiBase: ApiEndpoint.build(s.aliased ? s.subject : username, undefined),
      // The address alias the grant adopted, if any: its sessions' address.
      addressAliases: s.aliased && isAddressAliasShape(s.subject) ? [s.subject] : [],
      formerUsernames: await formerUsernamesOf(userId, username),
    };
  }

  async function findDerivedSession (userId: string, username: string, clientId: string, subjectAccessId: string): Promise<DataGrant | null> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.findDerivedSession');
    // Live head rows (not deleted), expired ones included: an expired row
    // still holds the identity slot.
    const row = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
      accessesRepository.findOne({ id: userId, username },
        { type: 'app', name: SESSION_NAME_PREFIX + clientId, deviceName: DERIVED_DEVICE_PREFIX + subjectAccessId }, null, cb));
    if (row == null || row.deleted != null || typeof row.token !== 'string') return null;
    if (row.clientData?.oauth?.exchange?.subjectAccessId !== subjectAccessId) return null;
    return row;
  }

  // The derived row follows its subject on reuse: the subject's permissions
  // when a re-cut changed them in between, and a later expiry (never an
  // earlier one, so a lagging exchange never shortens a token another
  // instance holds; never past the bound, which is at most the subject's).
  // The webhooks of the row are not re-scoped here: this runs only when a
  // re-cut raced the exchange, and the re-cut rewrites the row (webhooks
  // included) itself.
  async function touchDerivedSession (userId: string, username: string, row: DataGrant, subject: DataGrant, expiresAt: number): Promise<number> {
    const update: Record<string, unknown> = {};
    const subjectPermissions = canonicalPermissions(subject.permissions ?? []);
    const permissionsChanged = !samePermissionKeys(row.permissions ?? [], subjectPermissions);
    if (permissionsChanged) update.permissions = subjectPermissions;
    const current = typeof row.expires === 'number' ? row.expires : 0;
    const expires = Math.max(current, Math.floor(expiresAt / 1000));
    if (expires > current) update.expires = expires;
    if (Object.keys(update).length === 0) return current;
    const modified = Date.now() / 1000;
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.touchDerivedSession');
    // `modified` makes the integrity-aware updateOne recompute the row hash.
    await fromCallback((cb: (e: unknown, r?: unknown) => void) =>
      accessesRepository.updateOne({ id: userId, username }, { id: row.id }, { ...update, modified }, cb));
    // The access cache validates on `expires` and holds the permissions.
    cache.unsetUserData(userId);
    // The breach-scope index row carries the expiry too.
    await reindexAccessNonFatal(username, { id: row.id, type: 'app', expires, modified });
    if (permissionsChanged) {
      notifyScopedAccessChange(username, { id: row.id, type: 'app', permissions: subjectPermissions as Array<{ streamId?: string }> }, 'update');
      pubsub.notifications.emit(username, USERNAME_BASED_ACCESSES_CHANGED);
    }
    return expires;
  }

  /**
   * A found derived row may be answered again: alive, and made after the
   * resource server's revoke epoch and its clock margin (the data API refuses
   * a session within it).
   */
  function reusableDerived (row: DataGrant, notBefore: number | null): boolean {
    if (typeof row.expires !== 'number' || row.expires <= Date.now() / 1000) return false;
    return notBefore == null || (typeof row.created === 'number' && !issuedBeforeClientRevoke(row.created * 1000, notBefore));
  }

  function subjectInactive (): Error {
    const gone = new Error('the subject session is no longer live') as Error & { code: string };
    gone.code = 'subject-inactive';
    return gone;
  }

  async function issueDerivedSession ({ userId, username, clientId, subjectAccessId, subjectClientId, expiresAt, notBefore }: {
    userId: string; username: string; clientId: string; subjectAccessId: string; subjectClientId: string; expiresAt: number; notBefore: number | null;
  }): Promise<{ accessId: string; accessToken: string; expires: number; reused: boolean }> {
    const user = { id: userId, username };
    const subject = await liveSubjectRow(userId, username, subjectAccessId, subjectClientId);
    if (subject == null) throw subjectInactive();
    let row = await findDerivedSession(userId, username, clientId, subjectAccessId);
    if (row != null && !reusableDerived(row, notBefore)) {
      // Expired, or made before the resource server's revoke epoch: deleted
      // as any session is (its index row ends, what it created goes with it),
      // which frees the slot for a new one.
      await deleteAccessChain(user, { id: row.id });
      row = null;
    }
    if (row == null) {
      const oauth = subject.clientData!.oauth!;
      let minted: { accessId: string; accessToken: string } | null = null;
      try {
        // The subject's reach exactly (its stored permissions, the session
        // selfRevoke override re-applied), under the same grant and chain,
        // with its alias; no audience (it is meant for the data API), no
        // DPoP binding. The subject's creation is recorded: the data API
        // compares the subject client's revoke epoch with it.
        minted = await mintAccessDirect({
          userId,
          username,
          clientId,
          permissions: withSessionSelfRevoke(subject.permissions ?? []),
          expiresAt,
          dataGrantAccessId: oauth.dataGrantId!,
          chainPermissions: Array.isArray(oauth.chain) ? oauth.chain : storedSessionPermissions(subject.permissions),
          alias: subject.alias,
          deviceName: DERIVED_DEVICE_PREFIX + subjectAccessId,
          exchange: { subjectClientId, subjectAccessId, ...(typeof subject.created === 'number' ? { subjectCreated: subject.created } : {}) },
        });
      } catch (err: unknown) {
        // A concurrent first exchange won the slot: reuse its row.
        if (!isDuplicateSlot(err)) throw err;
        row = await findDerivedSession(userId, username, clientId, subjectAccessId);
        if (row == null || !reusableDerived(row, notBefore)) throw err;
      }
      if (minted != null) {
        // The subject read again: a deletion of the subject, or a re-cut of
        // its grant, that ran between the check above and the insert has not
        // seen the new row. Gone: the new row goes too. Re-cut: the new row
        // follows the subject.
        const after = await liveSubjectRow(userId, username, subjectAccessId, subjectClientId);
        if (after == null) {
          await deleteAccessChain(user, { id: minted.accessId });
          throw subjectInactive();
        }
        const fresh: DataGrant = {
          id: minted.accessId,
          token: minted.accessToken,
          permissions: canonicalPermissions(withSessionSelfRevoke(subject.permissions ?? [])),
          expires: Math.floor(expiresAt / 1000),
        };
        const expires = await touchDerivedSession(userId, username, fresh, after, expiresAt);
        return { accessId: minted.accessId, accessToken: minted.accessToken, expires, reused: false };
      }
    }
    const expires = await touchDerivedSession(userId, username, row!, subject, expiresAt);
    return { accessId: row!.id, accessToken: row!.token as string, expires, reused: true };
  }

  function isDuplicateSlot (err: unknown): boolean {
    const isDuplicateIndex = (err as { isDuplicateIndex?: unknown } | null)?.isDuplicateIndex;
    return typeof isDuplicateIndex === 'function' && isDuplicateIndex.call(err, 'deviceName') === true;
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
    setGrantClient,
    setGrantState,
    resolveAccountUserId,
    resolveUsername,
    addressAliasesOf,
    mintRefreshedAccess,
    resolveGrantSubject,
    bindAccessDpop,
    resolveAccess,
    revokeAccessLocal,
    retireSession,
    storedSessionPermissions,
    findOAuthSessionAccess,
    grantSubject,
    mintClientAccess,
    readSubjectSession,
    issueDerivedSession,
  };
}
