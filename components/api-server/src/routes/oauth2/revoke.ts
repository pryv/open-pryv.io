/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 glue: `revokeChain`, the collapse of a refresh chain on detected
 * refresh-token reuse, without a MethodContext: delete the durable
 * data-grant + all live oauth session accesses for (user, client) + their
 * descendants through the accesses.delete teardown, invalidate the access
 * cache cluster-wide, then best-effort notify the counterparty app.
 */

import { createRequire } from 'node:module';
import type { DataGrant, GlueEnv } from './types.ts';
const require = createRequire(import.meta.url);

const oauth2 = require('oauth2');
const { peerFetch } = require('business/src/outbound/peerFetch.ts');
const { parseAccessRef } = require('business/src/accesses/refs.ts');
const cache = require('cache').default;
const { pubsub } = require('messages');
const { fromCallback } = require('utils');
// The teardown accesses.delete uses (webhooks, aliases, index, scrub, cache).
const { deleteAccessChain, accessChainIds } = require('../../methods/helpers/accessDeletion.ts');
// CMC back-channel revoke notify: pure DI HTTP sender, no MethodContext needed.
const { outbound: cmcOutbound } = require('cmc');
const cmcRelationshipKey = require('cmc/src/relationshipKey.ts');
const { selfIdentityHost } = require('../../methods/helpers/selfIdentityHost.ts');
const { accessesRepo } = require('./types.ts');

export function createRevoke (env: GlueEnv) {
  const { config, storageLayer, logger } = env;

  async function revokeChain ({ userId, username, clientId, dataGrantAccessId }: {
    userId: string; username: string; clientId: string; dataGrantAccessId?: string;
  }): Promise<void> {
    const accessesRepository = accessesRepo(storageLayer, 'oauth2.revokeChain');
    const user = { id: userId, username };

    // 1. Read the data-grant head BEFORE deleting (need clientData.cmc for the
    //    notify). Raw null-tolerant findOne, NOT readDataGrantHead, which throws
    //    on exactly the deleted/expired state a revoke must tolerate.
    let dataGrant: DataGrant | null = null;
    if (dataGrantAccessId != null) {
      const base = parseAccessRef(dataGrantAccessId).base;
      dataGrant = await fromCallback((cb: (e: unknown, r: DataGrant | null) => void) =>
        accessesRepository.findOne(user, { id: base }, null, cb));
    }

    // 2. Delete through the teardown accesses.delete uses (accessDeletion.ts):
    //    webhooks stopped, aliases released, breach-scope index tombstoned,
    //    credential URLs scrubbed, cache busted per token. The data-grant goes
    //    first and takes the sessions minted under it with their sub-accesses
    //    (a stolen session can mint shared sub-accesses; leaving them alive =
    //    incomplete revoke); then any live session of this client still left
    //    (minted under another grant of the client, or before sessions named
    //    their grant), with its own sub-accesses.
    if (dataGrant != null && typeof dataGrant.id === 'string' && dataGrant.deleted == null) await deleteOrForce(dataGrant.id);
    for (const id of await liveSessionIds()) await deleteOrForce(id);

    async function liveSessionIds (): Promise<string[]> {
      const sessions: DataGrant[] = (await fromCallback((cb: (e: unknown, r: DataGrant[] | null) => void) =>
        accessesRepository.find(user, { type: 'app', name: 'oauth:' + clientId, deleted: null }, null, cb))) ?? [];
      return sessions.map((s) => s.id).filter((id): id is string => typeof id === 'string');
    }
    // A failing side effect (a webhook store error) must not leave the chain
    // alive: fall back to the bare soft-delete of the whole chain (the access,
    // what it manages, the grant's sessions and what they created).
    async function deleteOrForce (id: string): Promise<void> {
      try {
        await deleteAccessChain(user, { id });
      } catch (err: unknown) {
        logger.warn('oauth2.revokeChain: teardown of ' + id + ' failed, soft-deleting its chain bare', err);
        let ids = [id];
        try { ids = await accessChainIds(user, id); } catch (readErr: unknown) {
          logger.warn('oauth2.revokeChain: could not read the chain of ' + id + ', soft-deleting it alone', readErr);
        }
        for (const chainId of ids) {
          await fromCallback((cb: (e: unknown) => void) => accessesRepository.delete(user, { id: chainId }, cb));
        }
      }
    }

    // 3. Cache invalidation (MANDATORY): the cache validates a token on `expires`
    //    only, never `deleted`, so soft-deleted rows keep validating from cache.
    //    unsetUserData clears every access-logic for the user cluster-wide,
    //    covering a row the bare fallback above deleted.
    cache.unsetUserData(userId);
    pubsub.notifications.emit(username, pubsub.USERNAME_BASED_ACCESSES_CHANGED);
    await oauth2.emitAudit('oauth.token.revoked', { clientId, userId, reason: 'refresh-token reuse detected' });

    // 5. CMC back-channel notify (best-effort). The peer ENFORCES an inbound
    //    revoke it accepts (handleIncomingRevoke tears down the back-channel
    //    access it holds), which is what a user-initiated revoke does too: the
    //    data-grant deleted above held this side's only pointer to that access.
    //    apiEndpoint is null until the app completed the back-channel handshake
    //    → skip quietly; delivery failure never rolls back.
    const cmcCd = dataGrant?.clientData?.cmc;
    const apiEndpoint = cmcCd?.counterparty?.apiEndpoint ?? cmcCd?.backChannelApiEndpoint;
    if (dataGrant != null && typeof apiEndpoint === 'string' && apiEndpoint.length > 0) {
      // Same content as a user-initiated revoke (cmc handleRevoke): `accessId`
      // is required by the revoke content schema and `reason` is a localized
      // object, so the peer's inbox accepts the write; the correlation ids let
      // the peer match THIS relationship.
      const revokeContent: Record<string, unknown> = {
        accessId: dataGrant.id,
        from: { username, host: selfHost(username) },
        reason: { en: 'Refresh-token reuse was detected; this consent was revoked.' },
      };
      for (const key of ['appCode', 'offerEventId', 'acceptEventId', 'inviteEventId'] as const) {
        const value = (cmcCd as Record<string, unknown> | undefined)?.[key];
        if (typeof value === 'string') revokeContent[key] = value;
      }
      const revokedScope = cmcRelationshipKey.scopeOfAccess(dataGrant);
      if (typeof revokedScope === 'string') revokeContent.scopeStreamId = revokedScope;
      try {
        // postToPeer returns a discriminated union: it does NOT throw on an HTTP
        // or network failure, so check the result explicitly (the catch only sees
        // apiEndpoint-parse throws). Best-effort: a failed notify never rolls back.
        const delivery = await cmcOutbound.postToPeer({
          apiEndpoint,
          path: 'events',
          body: { streamIds: [':_cmc:inbox'], type: 'consent/revoke-cmc', content: revokeContent },
          deps: { fetch: peerFetch, timeoutMs: 15000, logger },
        });
        if (delivery != null && delivery.ok === false) {
          logger.warn('oauth2.revokeChain: CMC revoke notify not delivered', delivery);
        }
      } catch (err: unknown) { logger.warn('oauth2.revokeChain: CMC revoke notify failed', err); }
    } else {
      logger.debug('oauth2.revokeChain: data-grant has no counterparty apiEndpoint, CMC notify skipped');
    }
  }

  // Self-identity host for the CMC notify `from`, derived like
  // cmcSelfIdentityFor. The per-user `{username}` template (DNS-per-user
  // deploys) resolves to the real name, not a literal placeholder.
  function selfHost (username: string): string {
    return selfIdentityHost(config, username);
  }

  return { revokeChain };
}
