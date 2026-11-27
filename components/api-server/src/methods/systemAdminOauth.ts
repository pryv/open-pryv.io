/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type { ResultBag } from './_types.ts';
import type { AdminSubject } from 'middleware/src/adminAuth.ts';
import type { AdminPermission } from 'business/src/admin/permissions.ts';
import { auditAs, actorOf, auditAdminAct, setAuditDetails, inActorTrail, wrap } from './helpers/adminAudit.ts';
import type { AdminAuditContext } from './helpers/adminAudit.ts';
import { activeGrants, ROLE_PERMISSIONS } from 'business/src/admin/roles.ts';
import type { Role } from 'business/src/admin/roles.ts';
import { SCOPE_PLATFORM, hostingsOf, scopeCoversRegions } from 'business/src/admin/scopes.ts';
import { factory as errors } from 'errors';
import { ready } from '@pryv/boiler';
import * as storages from 'storages';
import type { OAuthClient } from 'oauth2/src/storage.ts';
import type { PlatformDB } from '../../../../storages/interfaces/platformStorage/PlatformDB.ts';
import { getClient, listClientIds } from 'oauth2/src/clientRegistry.ts';
import {
  resolveClientValidation, reviewStands, validationDigest, readPublisher, listPublishers, decidePublisher,
  PublisherDecisionError, PUBLISHER_STATUSES, publisherIdProblem, publisherRegionsProblem, reviewReasonProblem
} from 'oauth2/src/clientValidation.ts';
import type { PublisherRecord } from 'oauth2/src/clientValidation.ts';
import { approveClient, withdrawReview, setClientStatus, inReviewQueue, ClientReviewError } from 'oauth2/src/clientReview.ts';
import type { ReviewOutcome } from 'oauth2/src/clientReview.ts';
import { computeThumbprint, validatePublicJwk } from 'oauth2/src/jwks.ts';

/**
 * Methods of the OAuth client and publisher review (routes in
 * routes/system-admin-oauth.ts, method ids declared in
 * audit/src/apiMethods/adminOauth.ts). Audit steps:
 * methods/helpers/adminAudit.ts. The acts themselves are the ones the CLI
 * runs (oauth2/src/clientReview.ts, `decidePublisher`).
 *
 *   system.oauthClients.list         the clients (queue: those waiting for a reviewer)
 *   system.oauthClients.get          one client as `show` prints it, its level, digest and trail
 *   system.oauthClients.approve      validate it as reviewed (the digest shown) and approve held changes
 *   system.oauthClients.unvalidate   withdraw a developer's client app review
 *   system.oauthClients.suspend      suspend it
 *   system.oauthClients.resume       resume it
 *   system.publishers.list           the publisher rows
 *   system.publishers.get            one publisher row and its trail
 *   system.publishers.set            a decision about a publisher
 *
 * Region rule: the gate checked the route's permission; a method then keeps
 * to the rows covered by the caller's replicated grants that hold that
 * permission (`scopeCoversRegions`: scope `platform`, or `region:<r>` covering
 * every region the row lists; a row listing no region needs `platform`).
 * Local grants never give these permissions. The admin key (scope `full`)
 * acts at scope `platform`. A row out of reach answers 404, as a missing one.
 *
 * Each act is recorded in the platform trail with `{ target, diff }`, in the
 * acting administrator's own trail, and in the trail of the client's owner
 * (`oauth.client.reviewed`) or of the publisher (`oauth.publisher.reviewed`)
 * when that account is on this core.
 */

type ConfigReader = { get: (key: string) => unknown };
type OauthContext = AdminAuditContext & { adminSubject?: AdminSubject };

const CLIENT_ID_MAX_LENGTH = 1024;
const ORIGINS = ['operator', 'metadata-document', 'developer'];
const STATUSES = ['active', 'suspended', 'review'];

/**
 * The scopes of the caller's grants that give `permission` (empty: none). A
 * session: its replicated grants whose role holds it, provided this core's
 * gate gives it (the local policy may withhold it). The admin key: `platform`.
 */
export function reviewScopes (subject: AdminSubject | undefined, permission: AdminPermission, now: number = Date.now()): string[] {
  if (subject == null || !subject.permissions.has(permission)) return [];
  if (subject.kind === 'key') return [SCOPE_PLATFORM];
  if (subject.kind !== 'session' || subject.role == null) return [];
  return activeGrants(subject.role, now)
    .filter((g) => (ROLE_PERMISSIONS[g.role as Role] as readonly string[]).includes(permission))
    .map((g) => g.scope);
}

/** Whether one of `scopes` covers every region of `regions` (no regions: `platform` only). */
export function coversRegions (scopes: readonly string[], regions: readonly string[] | null | undefined, config: ConfigReader): boolean {
  const hostings = hostingsOf(config);
  return scopes.some((s) => scopeCoversRegions(s, regions, hostings));
}

function unknownParams (params: Record<string, unknown>, known: readonly string[]) {
  const extra = Object.keys(params).filter((k) => !known.includes(k));
  return extra.length > 0 ? errors.invalidParametersFormat('Unknown parameter(s): ' + extra.join(', ') + '.', { parameters: extra }) : null;
}

/** The key material of an inline key set, as `show` prints it: per key, its id, type, curve, algorithm and RFC 7638 thumbprint. */
function keysView (jwks: unknown): unknown {
  const keys = (jwks as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return jwks;
  return {
    keys: keys.map((k: Record<string, unknown> | null) => {
      let thumbprint: string;
      try {
        thumbprint = computeThumbprint(validatePublicJwk(k));
      } catch {
        thumbprint = '(unrecognized key)';
      }
      return {
        ...(k?.kid != null ? { kid: k.kid } : {}),
        ...(typeof k?.kty === 'string' ? { kty: k.kty } : {}),
        ...(typeof k?.crv === 'string' ? { crv: k.crv } : {}),
        ...(typeof k?.alg === 'string' ? { alg: k.alg } : {}),
        thumbprint
      };
    })
  };
}

/** A capability URL without its token (the userinfo), which grants access by itself. */
function maskedCapabilityUrl (url: unknown): unknown {
  if (typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    if (u.username === '' && u.password === '') return url;
    u.username = '(set)';
    u.password = '';
    return u.toString();
  } catch {
    return '(set)';
  }
}

/** The client row as answered: no secret hash (said set), keys by thumbprint, capability tokens masked. */
export function clientRowView (client: OAuthClient): Record<string, unknown> {
  const view: Record<string, unknown> = { ...client };
  if (client.clientSecretHash != null) view.clientSecretHash = '(set)';
  if (client.previousSecretHash != null) view.previousSecretHash = '(set)';
  if (client.jwks != null) view.jwks = keysView(client.jwks);
  if (client.cmcOffers != null && typeof client.cmcOffers === 'object') {
    view.cmcOffers = Object.fromEntries(Object.entries(client.cmcOffers).map(([name, offer]) =>
      [name, { ...(offer as object), capabilityUrl: maskedCapabilityUrl((offer as { capabilityUrl?: unknown })?.capabilityUrl) }]));
  }
  return view;
}

function displayName (client: OAuthClient): unknown {
  return client.name ?? client.clientName ?? null;
}

export default async function (systemAPI: { register: (...args: unknown[]) => void }): Promise<void> {
  const config = await ready();
  const platform = (): PlatformDB => storages.platformDB as PlatformDB;

  async function reviewOf (client: OAuthClient) {
    const stands = reviewStands(client);
    return {
      validation: await resolveClientValidation(platform(), config, client),
      digest: validationDigest(client),
      reviewStands: stands,
      inQueue: inReviewQueue(client, stands)
    };
  }

  async function clientAnswer (client: OAuthClient) {
    return { client: clientRowView(client), ...(await reviewOf(client)) };
  }

  /** The client when the caller's grants holding `permission` reach it, else null. */
  async function reachableClient (context: OauthContext, clientId: unknown, permission: AdminPermission): Promise<OAuthClient | null> {
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > CLIENT_ID_MAX_LENGTH) return null;
    const client = await getClient(platform(), clientId);
    if (client == null) return null;
    return coversRegions(reviewScopes(context.adminSubject, permission), client.regions, config) ? client : null;
  }

  function reasonParam (params: Record<string, unknown>, required: boolean) {
    if (params.reason == null && !required) return { ok: true as const, reason: null };
    const problem = reviewReasonProblem(params.reason);
    if (problem != null) return { ok: false as const, error: errors.invalidParametersFormat('`reason` ' + problem + '.', { reason: params.reason }) };
    return { ok: true as const, reason: params.reason as string };
  }

  function reviewError (err: unknown, clientId: string) {
    if (!(err instanceof ClientReviewError)) throw err;
    switch (err.code) {
      case 'unknown-client': return errors.unknownResource('oauth client', clientId);
      case 'stale-digest': return errors.staleResource('oauth client', { clientId, digest: err.data.digest });
      case 'digest-required': return errors.invalidParametersFormat('`digest` (the review digest shown for the client) is required.', { clientId });
      default: return errors.invalidOperation('The client "' + clientId + '" ' + err.message + '.', { clientId, ...err.data });
    }
  }

  /** What the trails record of a client act. */
  async function recordClientAct (context: OauthContext, act: string, outcome: ReviewOutcome, reason: string | null, digest?: string) {
    const levelBefore = (await resolveClientValidation(platform(), config, outcome.before)).level;
    const levelAfter = (await resolveClientValidation(platform(), config, outcome.client)).level;
    const diff: Record<string, unknown> = {
      from: { status: outcome.before.status ?? 'active', level: levelBefore },
      to: { status: outcome.client.status ?? 'active', level: levelAfter },
      reason: reason ?? act,
      changed: outcome.changed
    };
    if (digest != null) diff.digest = digest;
    setAuditDetails(context, { target: { clientId: outcome.client.clientId }, diff });
    const owner = outcome.client.origin === 'developer' ? outcome.client.owner?.userId : undefined;
    if (outcome.changed && owner != null) {
      await auditAdminAct(owner, 'oauth.client.reviewed', { clientId: outcome.client.clientId, act, by: actorOf(context.adminSubject), ...diff });
    }
  }

  // --- Clients --- //

  systemAPI.register('system.oauthClients.list',
    auditAs('subject'),
    wrap(async (context: OauthContext, params, result: ResultBag) => {
      const bad = unknownParams(params, ['queue', 'origin', 'status']);
      if (bad != null) return bad;
      const { queue, origin, status } = params;
      if (queue != null && !['true', 'false', true, false].includes(queue as string | boolean)) {
        return errors.invalidParametersFormat('`queue` must be true or false.', { queue });
      }
      if (origin != null && !ORIGINS.includes(origin as string)) return errors.invalidParametersFormat('`origin` must be one of: ' + ORIGINS.join(', ') + '.', { origin });
      if (status != null && !STATUSES.includes(status as string)) return errors.invalidParametersFormat('`status` must be one of: ' + STATUSES.join(', ') + '.', { status });
      const onlyQueue = queue === true || queue === 'true';
      const scopes = reviewScopes(context.adminSubject, 'oauthClients:read');
      const clients = [];
      for (const id of await listClientIds(platform())) {
        let c: OAuthClient | null;
        try {
          c = await getClient(platform(), id);
        } catch {
          continue; // an unreadable row
        }
        if (c == null || !coversRegions(scopes, c.regions, config)) continue;
        if (origin != null && (c.origin ?? 'operator') !== origin) continue;
        if (status != null && (c.status ?? 'active') !== status) continue;
        const review = await reviewOf(c);
        if (onlyQueue && !review.inQueue) continue;
        clients.push({
          clientId: c.clientId,
          kind: c.kind ?? 'app-account',
          origin: c.origin ?? 'operator',
          ...(c.owner != null ? { owner: c.owner } : {}),
          name: displayName(c),
          status: c.status ?? 'active',
          ...(Array.isArray(c.regions) && c.regions.length > 0 ? { regions: c.regions } : {}),
          updatedAt: c.updatedAt,
          ...review
        });
      }
      result.clients = clients;
    }));

  systemAPI.register('system.oauthClients.get',
    auditAs('subject'),
    wrap(async (context: OauthContext, params, result: ResultBag) => {
      const client = await reachableClient(context, params.clientId, 'oauthClients:read');
      if (client == null) return errors.unknownResource('oauth client', params.clientId as string);
      Object.assign(result, await clientAnswer(client));
    }));

  /** A review act on a client: params checked, the row reached by region, the act done under the same check, recorded. */
  function clientAct (act: 'approve' | 'unvalidate' | 'suspend' | 'resume', known: string[], reasonRequired: boolean,
    run: (clientId: string, opts: { by: string; note: string | null; allow: (row: OAuthClient) => boolean }, params: Record<string, unknown>) => Promise<ReviewOutcome>) {
    return wrap(async (context: OauthContext, params, result: ResultBag) => {
      const bad = unknownParams(params, ['clientId', 'reason', ...known]);
      if (bad != null) return bad;
      const clientId = params.clientId as string;
      // A refused act is recorded with what it was on too.
      if (typeof clientId === 'string' && clientId.length <= CLIENT_ID_MAX_LENGTH) setAuditDetails(context, { target: { clientId } });
      // Out of reach answers as missing, before any parameter is judged.
      if (await reachableClient(context, clientId, 'oauthClients:review') == null) return errors.unknownResource('oauth client', clientId);
      const reason = reasonParam(params, reasonRequired);
      if (!reason.ok) return reason.error;
      const scopes = reviewScopes(context.adminSubject, 'oauthClients:review');
      let outcome: ReviewOutcome;
      try {
        outcome = await run(clientId, {
          by: actorOf(context.adminSubject),
          note: reason.reason,
          // The row is judged again as the act reads it.
          allow: (row) => coversRegions(scopes, row.regions, config)
        }, params);
      } catch (err) {
        return reviewError(err, clientId);
      }
      await recordClientAct(context, act, outcome, reason.reason, typeof params.digest === 'string' ? params.digest : undefined);
      Object.assign(result, await clientAnswer(outcome.client), { changed: outcome.changed });
    });
  }

  systemAPI.register('system.oauthClients.approve',
    auditAs('subject'),
    clientAct('approve', ['digest'], false, (clientId, opts, params) => {
      if (params.digest != null && typeof params.digest !== 'string') throw new ClientReviewError('digest-required', 'digest must be a string');
      return approveClient(platform(), clientId, { ...opts, digest: params.digest as string | undefined, approveChanges: true });
    }),
    inActorTrail());

  systemAPI.register('system.oauthClients.unvalidate',
    auditAs('subject'),
    clientAct('unvalidate', [], true, (clientId, opts) => withdrawReview(platform(), clientId, opts)),
    inActorTrail());

  systemAPI.register('system.oauthClients.suspend',
    auditAs('subject'),
    clientAct('suspend', [], true, (clientId, opts) => setClientStatus(platform(), clientId, { ...opts, status: 'suspended' })),
    inActorTrail());

  systemAPI.register('system.oauthClients.resume',
    auditAs('subject'),
    clientAct('resume', [], false, (clientId, opts) => setClientStatus(platform(), clientId, { ...opts, status: 'active' })),
    inActorTrail());

  // --- Publishers --- //

  function publisherView (userId: string, row: PublisherRecord, withLog: boolean) {
    const { statusLog, ...rest } = row;
    return { userId, ...rest, ...(withLog ? { statusLog: statusLog ?? [] } : {}) };
  }

  systemAPI.register('system.publishers.list',
    auditAs('subject'),
    wrap(async (context: OauthContext, params, result: ResultBag) => {
      const bad = unknownParams(params, ['status']);
      if (bad != null) return bad;
      if (params.status != null && !PUBLISHER_STATUSES.includes(params.status as string)) {
        return errors.invalidParametersFormat('`status` must be one of: ' + PUBLISHER_STATUSES.join(', ') + '.', { status: params.status });
      }
      const scopes = reviewScopes(context.adminSubject, 'publishers:read');
      result.publishers = (await listPublishers(platform()))
        .filter(({ row }) => coversRegions(scopes, row.regions, config) && (params.status == null || row.status === params.status))
        .map(({ userId, row }) => publisherView(userId, row, false));
    }));

  systemAPI.register('system.publishers.get',
    auditAs('subject'),
    wrap(async (context: OauthContext, params, result: ResultBag) => {
      const userId = params.userId as string;
      const row = publisherIdProblem(userId) == null ? await readPublisher(platform(), userId) : null;
      if (row == null || !coversRegions(reviewScopes(context.adminSubject, 'publishers:read'), row.regions, config)) {
        return errors.unknownResource('publisher', userId);
      }
      result.publisher = publisherView(userId, row, true);
    }));

  systemAPI.register('system.publishers.set',
    auditAs('subject'),
    wrap(async (context: OauthContext, params, result: ResultBag) => {
      const bad = unknownParams(params, ['userId', 'status', 'displayName', 'regions', 'reason']);
      if (bad != null) return bad;
      const userId = params.userId as string;
      const idProblem = publisherIdProblem(userId);
      if (idProblem != null) return errors.invalidParametersFormat('The publisher id (an account id) ' + idProblem + '.', { userId });
      setAuditDetails(context, { target: { publisherUserId: userId } });
      const scopes = reviewScopes(context.adminSubject, 'publishers:review');
      // A stored row: its regions must be in reach (a row out of reach answers
      // as missing, before any parameter is judged). No row yet: the regions
      // it is created with (none given: every region, scope platform).
      const allow = (row: PublisherRecord | null) => row != null
        ? coversRegions(scopes, row.regions, config)
        : coversRegions(scopes, (params.regions as string[] | null | undefined) ?? null, config);
      const existing = await readPublisher(platform(), userId);
      if (existing != null && !allow(existing)) return errors.unknownResource('publisher', userId);
      if (!PUBLISHER_STATUSES.includes(params.status as string)) {
        return errors.invalidParametersFormat('`status` must be one of: ' + PUBLISHER_STATUSES.join(', ') + '.', { status: params.status });
      }
      if (params.regions !== undefined) {
        if (params.regions !== null) {
          const problem = publisherRegionsProblem(params.regions);
          if (problem != null) return errors.invalidParametersFormat('`regions` ' + problem + '.', { regions: params.regions });
        }
        // The regions it is left in must be in reach too (null: every region, scope platform).
        if (!coversRegions(scopes, params.regions as string[] | null, config)) {
          return errors.invalidParametersFormat('`regions`: a decision may only leave the publisher in regions the reviewer covers.', { regions: params.regions });
        }
      }
      if (existing == null && !allow(null)) {
        return errors.invalidParametersFormat('`regions` is required: a publisher without regions is decided at scope platform.', { userId });
      }
      const reason = reasonParam(params, true);
      if (!reason.ok) return reason.error;
      let decided: Awaited<ReturnType<typeof decidePublisher>>;
      try {
        decided = await decidePublisher(platform(), userId, {
          status: params.status as string,
          displayName: params.displayName as string | null | undefined,
          regions: params.regions as string[] | null | undefined,
          reason: reason.reason as string,
          by: actorOf(context.adminSubject),
          allow
        });
      } catch (err) {
        if (!(err instanceof PublisherDecisionError)) throw err;
        if (err.code === 'unknown-publisher') return errors.unknownResource('publisher', userId);
        return errors.invalidParametersFormat(err.message + '.', { userId });
      }
      const diff = { from: { status: decided.before?.status ?? 'absent' }, to: { status: decided.row.status }, reason: reason.reason };
      setAuditDetails(context, { target: { publisherUserId: userId }, diff });
      await auditAdminAct(userId, 'oauth.publisher.reviewed', { publisherUserId: userId, by: actorOf(context.adminSubject), ...diff });
      result.publisher = publisherView(userId, decided.row, true);
    }),
    inActorTrail());
}
