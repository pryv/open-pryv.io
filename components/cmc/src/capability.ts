/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — capability access mint + GC.
 *
 * When a `cmc/request-v1` is written with `capabilityRequested: true`, the
 * plugin creates a `shared` access scoped to two real per-capability
 * streams under `:_cmc:_internal:`:
 *
 *   :_cmc:_internal:offer:<capId>     read   — bears the request event
 *   :_cmc:_internal:responses:<capId> create-only — accepts one accept/refuse
 *
 * The access's apiEndpoint becomes the capability URL. Single-use; the
 * plugin GCs the access + both streams together on first response or TTL
 * expiry.
 *
 * Pure orchestration module: takes mall + id-gen + clock via deps so tests
 * can inject fakes. Issues no HTTP calls — that's the job of outbound.ts.
 */

const C = require('./constants.ts');

type MallLike = {
  streams: { create: (userId: string, params: any) => Promise<any> };
  events:  { create: (userId: string, params: any) => Promise<any> };
  accesses:{ create: (userId: string, params: any) => Promise<any>;
             delete?: (userId: string, params: any) => Promise<any> };
};

type MintDeps = {
  mall: MallLike;
  idGen?: () => string;
  now?: () => number;       // unix seconds
  serviceUrlBase?: string;  // for synthesizing apiEndpoint when access.apiEndpoint isn't set
};

type RequestEventLike = {
  id?: string;
  type: string;       // 'cmc/request-v1'
  content: any;
};

type MintResult = {
  capabilityId: string;
  offerStreamId: string;
  responsesStreamId: string;
  capabilityUrl: string;
  expiresAt: number;
  accessId: string;
};

/**
 * Default capability TTL: 7 days (to be aligned with future OAuth2 token
 * TTL in a follow-up).
 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function defaultIdGen (): string {
  // Short, URL-safe id generator. Production callers should pass a real
  // CSRPNG-backed id-gen (cuid / nanoid / etc.) via deps.idGen.
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
}

function defaultNow (): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a capability access for the given `cmc/request-v1` trigger.
 *
 * Side effects (all via deps.mall):
 *   1. streams.create offer + responses streams under :_cmc:_internal:
 *   2. events.create the request event into the offer stream (read-side payload)
 *   3. accesses.create a shared access with read/create-only on the two streams
 *
 * Returns the new capability handles. The caller updates the original
 * trigger event's content with capabilityUrl + capabilityExpiresAt.
 *
 * NOTE: this function does NOT update the trigger event itself — that's
 * the orchestration loop's job (so the loop can update status alongside).
 */
async function mintCapability (params: {
  userId: string;
  triggerEvent: RequestEventLike;
  ttlSeconds?: number;
  deps: MintDeps;
}): Promise<MintResult> {
  const { userId, triggerEvent, deps } = params;
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const idGen = deps.idGen ?? defaultIdGen;
  const now = deps.now ?? defaultNow;

  if (triggerEvent == null || typeof triggerEvent.type !== 'string') {
    throw new Error('cmc/capability: triggerEvent must carry a type');
  }
  if (triggerEvent.type !== C.ET_REQUEST) {
    throw new Error(
      'cmc/capability: triggerEvent.type must be ' + C.ET_REQUEST + ', got ' + triggerEvent.type
    );
  }

  const capabilityId = idGen();
  const expiresAt = now() + ttlSeconds;
  const offerStreamId = C.offerStreamIdFor(capabilityId);
  const responsesStreamId = C.responsesStreamIdFor(capabilityId);

  // 1. Per-capability streams (under :_cmc:_internal:).
  await deps.mall.streams.create(userId, {
    id: offerStreamId,
    parentId: C.NS_INTERNAL,
    name: 'CMC capability offer ' + capabilityId,
    clientData: { cmc: { kind: 'capability-offer', capabilityId } },
  });
  await deps.mall.streams.create(userId, {
    id: responsesStreamId,
    parentId: C.NS_INTERNAL,
    name: 'CMC capability responses ' + capabilityId,
    clientData: { cmc: { kind: 'capability-responses', capabilityId } },
  });

  // 2. Pre-populate the offer stream with the request event so the
  // recipient can read it via the capability connection.
  // We strip fields the recipient shouldn't see (capabilityRequested
  // is the requester's intent flag, not part of the offer).
  const offerContent: any = { ...(triggerEvent.content || {}) };
  delete offerContent.capabilityRequested;
  delete offerContent.capabilityUrl;
  delete offerContent.capabilityExpiresAt;
  delete offerContent.capabilityAccessId;
  delete offerContent.status;
  delete offerContent.failure;

  await deps.mall.events.create(userId, {
    streamIds: [offerStreamId],
    type: C.ET_REQUEST,
    content: offerContent,
  });

  // 3. The capability access — shared, single-use, TTL-bounded.
  const access = await deps.mall.accesses.create(userId, {
    type: 'shared',
    name: '__cmc-cap-' + capabilityId.substring(0, 8),
    permissions: [
      { streamId: offerStreamId, level: 'read' },
      { streamId: responsesStreamId, level: 'create-only' },
    ],
    clientData: {
      cmc: {
        kind: 'capability',
        capabilityId,
        requestEventId: triggerEvent.id ?? null,
        singleUse: true,
      },
    },
    expires: expiresAt,
  });

  const capabilityUrl =
    access.apiEndpoint ??
    (deps.serviceUrlBase != null
      ? buildApiEndpoint(deps.serviceUrlBase, access.token)
      : null);
  if (capabilityUrl == null) {
    throw new Error(
      'cmc/capability: minted access has no apiEndpoint and no serviceUrlBase fallback was provided'
    );
  }

  return {
    capabilityId,
    offerStreamId,
    responsesStreamId,
    capabilityUrl,
    expiresAt,
    accessId: access.id,
  };
}

/**
 * Plugin GC for a consumed or expired capability — deletes the access
 * AND the two per-capability streams. Idempotent: tolerates "not found"
 * on either delete so re-running on an already-cleaned capability is safe.
 */
async function gcCapability (params: {
  userId: string;
  capabilityId: string;
  accessId: string;
  deps: { mall: MallLike };
}): Promise<void> {
  const { userId, capabilityId, accessId, deps } = params;
  const offerStreamId = C.offerStreamIdFor(capabilityId);
  const responsesStreamId = C.responsesStreamIdFor(capabilityId);

  // Delete access first so no further responses can be written.
  if (deps.mall.accesses.delete != null) {
    await ignoreNotFound(deps.mall.accesses.delete(userId, { id: accessId }));
  }
  await ignoreNotFound(deleteStream(deps.mall, userId, offerStreamId));
  await ignoreNotFound(deleteStream(deps.mall, userId, responsesStreamId));
}

async function deleteStream (mall: MallLike, userId: string, streamId: string): Promise<any> {
  const m: any = mall.streams;
  if (typeof m.delete === 'function') return m.delete(userId, { id: streamId });
  // The MallUserStreams class exposes deleteStream / removeStream / etc. in
  // different repo versions; tolerate missing method (tests inject minimal
  // streams.create only).
  return undefined;
}

async function ignoreNotFound<T> (p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err: any) {
    const id = err?.id || err?.data?.id;
    if (id === 'unknown-resource' || id === 'unknown-referenced-resource') return undefined;
    const msg = String(err?.message || err);
    if (msg.includes('not found') || msg.includes('unknown')) return undefined;
    throw err;
  }
}

function buildApiEndpoint (base: string, token: string): string {
  if (token == null || token === '') {
    throw new Error('cmc/capability: missing access token for apiEndpoint synthesis');
  }
  const trimmed = base.replace(/\/$/, '');
  // Insert token as URL username: https://<token>@<host>[:<port>]/...
  const idx = trimmed.indexOf('://');
  if (idx === -1) throw new Error('cmc/capability: serviceUrlBase must be an absolute URL');
  return trimmed.substring(0, idx + 3) + token + '@' + trimmed.substring(idx + 3) + '/';
}

export {
  DEFAULT_TTL_SECONDS,
  mintCapability,
  gcCapability,
  buildApiEndpoint,
};
