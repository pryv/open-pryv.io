/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * OAuth2 glue: the durable consent records (data-grants) and the session
 * minted at /oauth2/authorize/accept.
 *
 * Two kinds of grant, created and updated through the API on the user's
 * behalf (consent record, history, validation):
 *   - CMC (app-account clients): the CMC data-grant, created by a real
 *     `consent/accept-cmc` on the first authorization, joined on
 *     re-authorization;
 *   - registry clients: a data-grant named after the client, with no expiry.
 * The short-TTL session is then minted from the user's granted subset.
 */

import type { ConsentTrigger } from '../consentPoll.ts';
import type { Ctx, CmcOffer, DataGrant, GlueEnv } from './types.ts';
import type { Permission } from 'business/src/types/public.ts';
import { mergeStreamPermissions, PermissionMergeConflictError, stripConsentAnnotations } from 'business/src/accesses/permissionSet.ts';
// Tree-aware consent guard: closes the hierarchical-masking gap that the
// pure entry-subset check (checkConsentGrant, run at /accept) cannot see.
import { assertGrantedWithinOffer } from 'business/src/accesses/consentEffectiveGuard.ts';
// The teardown accesses.delete uses (webhooks, aliases, index, scrub, cache).
import { deleteAccessChain } from '../../methods/helpers/accessDeletion.ts';
// Wire ids carry a version serial; storage reads by the base id.
import { parseAccessRef } from 'business/src/accesses/refs.ts';
// Outcome-driven CMC consent poll: keys on the trigger's terminal status so a
// transient data-grant about to be rolled back on a peer refusal is never
// observed as a success. See consentPoll.ts.
import { awaitConsentOutcome } from '../consentPoll.ts';
import { withSessionSelfRevoke, samePermissionKeys } from './types.ts';
import { effectiveSessionPermissions } from '../../methods/helpers/oauthSessionReconcile.ts';

/** Trigger-scope parent for OAuth-driven CMC accepts on the user's account. */
const OAUTH_CMC_PARENT = ':_cmc:apps:oauth';

/** Registry clients: identity of the durable consent record (one per user and client). */
const REGISTRY_GRANT_PREFIX = 'oauth-grant:';
const REGISTRY_GRANT_DEVICE = 'oauth-grant';

/** The session-side helpers the grants need (see sessions.ts). */
type SessionHelpers = {
  mintAccessDirect: (params: {
    userId: string;
    username: string;
    clientId: string;
    permissions: Array<Record<string, unknown>>;
    expiresAt: number;
    dataGrantAccessId?: string;
  }) => Promise<{ accessId: string; accessToken: string; apiEndpoint: string }>;
  setGrantOf: (userId: string, username: string, grantId: string, clientId: string) => Promise<void>;
};

export function createGrants (env: GlueEnv, sessions: SessionHelpers) {
  const { apiCall } = env;

  // Idempotent streams.create: swallows "already exists" only.
  async function ensureStream (context: Ctx, id: string, parentId: string, name: string): Promise<void> {
    try {
      await apiCall(context, 'streams.create', { id, parentId, name });
    } catch (err: unknown) {
      const e = err as { id?: string; data?: { id?: string } } | null;
      const errId = e?.id ?? e?.data?.id;
      if (errId === 'item-already-exists') return;
      throw err;
    }
  }

  // The durable consent record for a granular OAuth grant is the CMC
  // data-grant on the user's account, keyed by the offer event id.
  async function findDataGrantByOffer (context: Ctx, offerEventId: string): Promise<DataGrant | null> {
    const result = await apiCall(context, 'accesses.get', {});
    for (const a of (result?.accesses ?? [])) {
      const cmcCd = a?.clientData?.cmc;
      if (cmcCd?.role === 'counterparty' && cmcCd?.offerEventId === offerEventId) return a;
    }
    return null;
  }

  // The durable CMC data-grant of a granular grant: created through a real
  // `consent/accept-cmc` on the first authorization, reused and widened on
  // re-authorization (see createAccess).
  async function ensureCmcGrant (context: Ctx, clientId: string, offer: CmcOffer,
    grantedPermissions: Array<Record<string, unknown>>): Promise<DataGrant> {
    let dataGrant: DataGrant | null = null;
    if (offer.offerEventId != null) {
      dataGrant = await findDataGrantByOffer(context, offer.offerEventId);
    }
    if (dataGrant == null) {
      // First authorization: drive the real CMC accept. The plugin's
      // dispatch is fire-and-forget w.r.t. the events.create response,
      // so poll for the data-grant (keyed by the accept event id the
      // plugin stamps on it) while watching the trigger for failure.
      const scopeStreamId = OAUTH_CMC_PARENT + ':' + clientId;
      await ensureStream(context, OAUTH_CMC_PARENT, ':_cmc:apps', 'OAuth2 grants');
      await ensureStream(context, scopeStreamId, OAUTH_CMC_PARENT, clientId);
      const created = await apiCall(context, 'events.create', {
        streamIds: [scopeStreamId],
        type: 'consent/accept-cmc',
        content: {
          capabilityUrl: offer.capabilityUrl,
          grantedPermissions,
        },
      });
      const acceptEventId = created?.event?.id;
      if (typeof acceptEventId !== 'string') {
        throw new Error('oauth2.createAccess: consent accept trigger was not created');
      }
      // Key on the trigger's TERMINAL status, never on the mere presence of
      // the data-grant. handleAccept creates the grant BEFORE delivering the
      // accept to the peer and rolls it back on a 4xx refusal, so trusting a
      // grant the instant it appears could mint an OAuth access against a
      // consent that is about to be refused (an invalidated / consumed link).
      // The dispatch stamps `status: 'completed'` (+ dataGrantAccessId) on
      // success and `status: 'failed'` (+ failure) on refusal; resolve the
      // grant only once the trigger says completed.
      dataGrant = await awaitConsentOutcome<DataGrant>({
        getTrigger: async () => {
          const trigger = await apiCall(context, 'events.getOne', { id: acceptEventId });
          return (trigger?.event?.content ?? {}) as ConsentTrigger;
        },
        resolveDataGrant: async (trigger) => {
          const all = await apiCall(context, 'accesses.get', {});
          const list: DataGrant[] = all?.accesses ?? [];
          // Prefer the id the dispatch stamped; fall back to the acceptEventId
          // match for robustness if the stamp is somehow absent.
          if (typeof trigger.dataGrantAccessId === 'string') {
            const byId = list.find((a) => a?.id === trigger.dataGrantAccessId);
            if (byId != null) return byId;
          }
          return list.find((a) =>
            a?.clientData?.cmc?.role === 'counterparty' &&
            a?.clientData?.cmc?.acceptEventId === acceptEventId) ?? null;
        },
        // Success now waits for the FULL accept delivery round-trip (the
        // trigger reaches `completed` only after the peer answers), so the
        // deadline MUST exceed the outbound per-attempt delivery timeout
        // (cmc outbound DEFAULT_TIMEOUT_MS = 15s) with margin. A shorter
        // budget would turn a slow-but-successful peer (10-15s: cold
        // container, cross-region) into a 500 for a consent that then
        // completes in the background.
        deadlineMs: 25_000,
        sleepMs: 100,
        describe: 'acceptEventId=' + acceptEventId,
      });
    } else {
      // Re-authorization: join this consent into the data-grant, stream by
      // stream (never narrows: the user manages narrowing via consent
      // scope-update / access update). A stream granted at another level
      // gets the level covering both; when no level covers exactly both
      // (`read` and `create-only`), the consent is refused rather than
      // granting a capability nobody consented to.
      const currentPermissions = dataGrant.permissions ?? [];
      const merged = mergeStreamPermissions(currentPermissions, grantedPermissions, 'join');
      if (merged.conflicts.length > 0) throw new PermissionMergeConflictError(merged.conflicts);
      if (!samePermissionKeys(currentPermissions, merged.permissions)) {
        const updated = await apiCall(context, 'accesses.update', {
          id: dataGrant.id,
          update: { permissions: merged.permissions },
        });
        if (updated?.access != null) dataGrant = updated.access;
      }
    }
    return dataGrant!;
  }

  // A registry client (no app account, no CMC): the durable consent record
  // is a data-grant named after the client, found again by that identity on
  // re-authorization, with no expiry: it lives until the user withdraws it.
  // The app sees the user's stable internal id as the subject (an aliased
  // grant, a pseudonym, is refused before this point on this core).
  // /accept decides the grant's permissions after the consent (`next`: the
  // composed consent, see the oauth2 component); without them (a direct
  // call), the consent is joined into the grant, never narrowing. A
  // re-authorization that switches between the two subject modes (the user
  // acknowledged it at /accept) withdraws the old grant first (its sessions
  // die, its alias is released, its refresh chains end), then a new grant is
  // made.
  async function registryGrantFor (context: Ctx, clientId: string,
    grantedPermissions: Array<Record<string, unknown>>, wantAlias: boolean,
    next: Array<Record<string, unknown>> | undefined): Promise<DataGrant> {
    let current = await findRegistryGrant(context, clientId);
    if (current != null && (typeof current.alias === 'string' && current.alias.length > 0) !== wantAlias) {
      await deleteAccessChain({ id: context.user.id, username: context.user.username }, { id: parseAccessRef(current.id).base });
      current = null;
    }
    let permissions: Array<Record<string, unknown>>;
    if (next != null) {
      permissions = next;
    } else if (current == null) {
      permissions = stripConsentAnnotations(grantedPermissions as unknown as Parameters<typeof stripConsentAnnotations>[0]) as unknown as Array<Record<string, unknown>>;
    } else {
      const merged = mergeStreamPermissions(current.permissions ?? [], grantedPermissions, 'join');
      if (merged.conflicts.length > 0) throw new PermissionMergeConflictError(merged.conflicts);
      permissions = merged.permissions;
    }
    // A changed grant re-cuts its live sessions: accesses.update does it
    // (reconcileSessionsOfGrant), for this write as for the owner's own.
    return await ensureRegistryGrant(context, clientId, current, permissions, wantAlias);
  }

  // The user's current grant for a registry client, read only (no repair
  // write): what the consent screen composes with the request.
  async function readRegistryGrant ({ session, clientId }: {
    session: { _context?: unknown; [key: string]: unknown }; clientId: string;
  }): Promise<{ permissions: Array<Record<string, unknown>>; aliased: boolean } | null> {
    const context = session._context as Ctx | undefined;
    if (context == null) throw new Error('oauth2.readRegistryGrant: session missing _context');
    const grant = await findRegistryGrant(context, clientId, { repair: false });
    if (grant == null) return null;
    return {
      permissions: grant.permissions ?? [],
      aliased: typeof grant.alias === 'string' && grant.alias.length > 0,
    };
  }

  // Create the registry grant with `permissions`, or bring the current one to
  // exactly `permissions` (written only when the entry set differs). The
  // caller decides the final set.
  async function ensureRegistryGrant (context: Ctx, clientId: string, current: DataGrant | null,
    permissions: Array<Record<string, unknown>>, wantAlias: boolean): Promise<DataGrant> {
    let grant = current;
    if (grant == null) {
      try {
        const created = await apiCall(context, 'accesses.create', {
          type: 'app',
          name: REGISTRY_GRANT_PREFIX + clientId,
          deviceName: REGISTRY_GRANT_DEVICE,
          permissions,
          ...(wantAlias ? { randomAlias: true } : {}),
        });
        if (created?.access == null || typeof created.access.id !== 'string') {
          throw new Error('oauth2.createAccess: accesses.create returned no data-grant');
        }
        // `clientData.oauth` is server-owned: written storage-direct.
        await sessions.setGrantOf(context.user.id, context.user.username, created.access.id, clientId);
        return created.access;
      } catch (err: unknown) {
        // A concurrent first consent may have won the (type, name, deviceName) slot.
        grant = await findRegistryGrant(context, clientId);
        if (grant == null) throw err;
      }
    }
    if (!samePermissionKeys(grant.permissions ?? [], permissions)) {
      const updated = await apiCall(context, 'accesses.update', {
        id: grant.id,
        update: { permissions },
      });
      if (updated?.access != null) grant = updated.access;
    }
    return grant;
  }

  // The grant's identity is (type, name, deviceName), unique among live
  // accesses; `clientData.oauth.grantOf` confirms it and is written again
  // when missing (a grant whose stamp did not land, after a failure between
  // the create and the stamp). Consequence: an app access the owner creates by
  // hand with that name and deviceName is adopted as the grant (only the
  // owner can create one: app tokens create shared accesses only).
  // An expired grant (the owner may put an expiry on it) still holds the
  // (type, name, deviceName) slot: on a consent (`repair`) it is withdrawn
  // (its sessions and chains go with it) so a fresh one can be made; a
  // read-only lookup treats it as absent.
  async function findRegistryGrant (context: Ctx, clientId: string, opts: { repair?: boolean } = {}): Promise<DataGrant | null> {
    const result = await apiCall(context, 'accesses.get', { includeExpired: true });
    let grant = (result?.accesses ?? []).find((a) =>
      a?.type === 'app' && a?.name === REGISTRY_GRANT_PREFIX + clientId &&
      a?.deviceName === REGISTRY_GRANT_DEVICE) ?? null;
    if (grant != null && typeof grant.expires === 'number' && grant.expires <= Date.now() / 1000) {
      if (opts.repair !== false) {
        await deleteAccessChain({ id: context.user.id, username: context.user.username }, { id: parseAccessRef(grant.id).base });
      }
      grant = null;
    }
    if (grant != null && opts.repair !== false && grant.clientData?.oauth?.grantOf !== clientId) {
      await sessions.setGrantOf(context.user.id, context.user.username, grant.id, clientId);
    }
    return grant;
  }

  // ---------------------------------------------------------------------
  // createAccess: ensures the durable consent record (CMC data-grant or
  // registry grant) then mints the short-TTL OAuth session access under
  // the resolved user. The session mirrors EXACTLY this consent's granted
  // subset; the data-grant is the consent ceiling that revocation and
  // scope-update govern.
  // ---------------------------------------------------------------------
  async function createAccess ({ session, clientId, expiresAt, offer, grantedPermissions, grantPermissions }: {
    session: { userId: string; username: string; _context?: Ctx };
    clientId: string;
    scope: string[];
    expiresAt: number;
    offer?: CmcOffer | { kind: 'synthesised'; permissions: Array<Record<string, unknown>> };
    grantedPermissions?: Array<Record<string, unknown>>;
    grantPermissions?: Array<Record<string, unknown>>;
    subjectChange?: unknown;
  }): Promise<{
    accessId: string;
    accessToken: string;
    apiEndpoint: string;
    dataGrantAccessId?: string;
    permissions?: Array<Record<string, unknown>>;
  }> {
    const context = session._context;
    if (context == null) {
      throw new Error('oauth2.createAccess: session missing _context (resolveUser did not run?)');
    }

    if (offer == null || !Array.isArray(grantedPermissions) || grantedPermissions.length === 0) {
      throw new Error('oauth2.createAccess: a granular consent grant (offer + grantedPermissions) is required');
    }

    // Effective-permission guard (hierarchical-masking class). /accept
    // already ran the pure entry-subset check; here, with the user's
    // stream tree available, verify the granted subset does not WIDEN the
    // offer at any stream (a dropped restrictive descendant re-inheriting a
    // broader ancestor). Reject as a consent error the endpoint maps to 400.
    const eff = await assertGrantedWithinOffer({
      userId: context.user.id,
      granted: grantedPermissions as unknown as Permission[],
      offered: offer.permissions as unknown as Permission[],
    });
    if (!eff.ok) {
      const e = new Error(
        'granted permissions widen the offer under the stream hierarchy: ' +
        JSON.stringify(eff.violations)) as Error & { code: string };
      e.code = 'consent-widens-offer';
      throw e;
    }

    const registry = (offer as { kind?: string }).kind === 'synthesised';
    const dataGrant = registry
      ? await registryGrantFor(context, clientId, grantedPermissions, (offer as { randomAlias?: boolean }).randomAlias === true, grantPermissions)
      : await ensureCmcGrant(context, clientId, offer as CmcOffer, grantedPermissions);

    // The minted row additionally carries the session selfRevoke override
    // (see withSessionSelfRevoke); the CHAIN keeps the granted subset
    // verbatim (returned `permissions` below), so the refresh-time
    // intersection with the data-grant stays exact.
    const permissions: Array<Record<string, unknown>> = grantedPermissions;
    // A registry session starts as its refreshes will continue: the granted
    // subset under the grant as it now stands (its forbidden features, the
    // core's default ones included, and the owner's narrower entries in the
    // stream tree).
    let sessionPermissions: Array<Record<string, unknown>> = permissions;
    if (registry) {
      const eff = await effectiveSessionPermissions(context.user.id, dataGrant as unknown as Record<string, unknown>, permissions);
      if (eff.hasReach) sessionPermissions = eff.permissions;
    }

    // Minted storage-direct, like the refreshed sessions: the session
    // carries the server-owned `clientData.oauth` link to its grant (the API
    // refuses that key), no stream is created from its permissions, and it
    // is recorded as created by the system. The consent itself was recorded
    // above, through the API, on the grant.
    const minted = await sessions.mintAccessDirect({
      userId: context.user.id,
      username: context.user.username,
      clientId,
      permissions: withSessionSelfRevoke(sessionPermissions),
      expiresAt,
      dataGrantAccessId: dataGrant.id,
    });
    return {
      ...minted,
      dataGrantAccessId: dataGrant.id,
      permissions,
    };
  }

  return { createAccess, readRegistryGrant };
}
