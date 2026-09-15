/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Account-delegation plugin — data-access layer.
 *
 * Reads and writes the delegation relationship substrate through the mall
 * (streams + events + accesses), NEVER through the api-server routes. This is
 * deliberate: the Phase-1 guard hooks reject every `:_delegation:*` write that
 * arrives over the generic routes, so the ONLY legitimate writer is the plugin
 * itself, reaching storage directly here — exactly the pattern the
 * cross-account-messaging plugin uses for its own internal namespace.
 *
 * Pure module: every function takes a `mall` (and optional clock/id-gen) so the
 * orchestration and its tests can inject fakes. No api-server imports, no
 * module-level singletons.
 */

import * as C from './constants.ts';
import type { AnchorContent, MirrorContent } from './model.ts';

// ------------------------------------------------------------------ mall shape

type StreamCreateParams = { id: string; parentId?: string | null; name: string; clientData?: Record<string, unknown> };
type EventLike = {
  id?: string;
  streamIds?: string[];
  type: string;
  time?: number;
  content: Record<string, unknown>;
};
type AccessCreateParams = {
  type: string;
  name: string;
  permissions?: Array<{ streamId: string; level: string }>;
  clientData?: Record<string, unknown>;
  expires?: number | null;
};
type AccessRow = {
  id: string;
  token?: string;
  apiEndpoint?: string;
  expires?: number | null;
  clientData?: { delegation?: Record<string, unknown> } | null;
};

type MallLike = {
  streams: {
    create: (userId: string, params: StreamCreateParams) => Promise<unknown>;
    delete?: (userId: string, params: { id: string }) => Promise<unknown>;
  };
  events: {
    create: (userId: string, params: Partial<EventLike>) => Promise<EventLike>;
    get: (userId: string, params?: Record<string, unknown>) => Promise<EventLike[]>;
    update: (userId: string, params: Record<string, unknown>) => Promise<unknown>;
    delete?: (userId: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  accesses: {
    create: (userId: string, params: AccessCreateParams) => Promise<AccessRow>;
    get: (userId: string, params?: Record<string, unknown>) => Promise<AccessRow[]>;
    update?: (userId: string, params: Record<string, unknown>) => Promise<unknown>;
    delete?: (userId: string, params: { id: string }) => Promise<unknown>;
  };
};

// -------------------------------------------------------------- parent streams

/**
 * Idempotently ensure the two plugin-owned parent streams exist for a user:
 * `:_delegation:` (reserved root) and `:_delegation:_internal`, plus the
 * per-role parents (`:delegates` on B, `:controlled` on A). Safe to call before
 * any write; tolerates already-exists.
 */
async function ensureParents (mall: MallLike, userId: string): Promise<void> {
  await ignoreExists(mall.streams.create(userId, {
    id: C.NS, parentId: null, name: 'Account delegation',
  }));
  await ignoreExists(mall.streams.create(userId, {
    id: C.NS_INTERNAL, parentId: C.NS, name: 'Account delegation (internal)',
  }));
  await ignoreExists(mall.streams.create(userId, {
    id: C.delegatesStreamId(), parentId: C.NS_INTERNAL, name: 'Delegates',
  }));
  await ignoreExists(mall.streams.create(userId, {
    id: C.controlledStreamId(), parentId: C.NS_INTERNAL, name: 'Controlled accounts',
  }));
}

// --------------------------------------------------------------------- anchors

/** All anchor events (B-side) for a user. */
async function listAnchors (mall: MallLike, userId: string): Promise<EventLike[]> {
  const events = await mall.events.get(userId, {
    streams: [C.delegatesStreamId()],
    types: [C.ET_ANCHOR],
    limit: 1000,
  });
  return (events || []).filter((e) => e?.type === C.ET_ANCHOR);
}

async function findAnchorByDelegate (mall: MallLike, userId: string, delegateUsername: string): Promise<EventLike | null> {
  const target = String(delegateUsername).toLowerCase();
  const anchors = await listAnchors(mall, userId);
  for (const a of anchors) {
    const content = a.content as AnchorContent | undefined;
    if (content?.delegate?.username?.toLowerCase() === target) return a;
  }
  return null;
}

async function findAnchorByRelId (mall: MallLike, userId: string, relId: string): Promise<EventLike | null> {
  const anchors = await listAnchors(mall, userId);
  return anchors.find((a) => (a.content as AnchorContent | undefined)?.relId === relId) ?? null;
}

async function createAnchor (mall: MallLike, userId: string, content: AnchorContent, now: () => number): Promise<EventLike> {
  await ensureParents(mall, userId);
  return mall.events.create(userId, {
    streamIds: [C.delegatesStreamId()],
    type: C.ET_ANCHOR,
    time: now(),
    content: content as unknown as Record<string, unknown>,
  });
}

async function updateAnchorContent (mall: MallLike, userId: string, anchor: EventLike, patch: Partial<AnchorContent>): Promise<void> {
  const content = { ...(anchor.content || {}), ...patch };
  await mall.events.update(userId, { ...anchor, content });
}

async function deleteAnchor (mall: MallLike, userId: string, anchor: EventLike): Promise<void> {
  if (mall.events.delete == null || anchor?.id == null) return;
  await ignoreNotFound(mall.events.delete(userId, { id: anchor.id }));
}

// --------------------------------------------------------------------- mirrors

async function listMirrors (mall: MallLike, userId: string): Promise<EventLike[]> {
  const events = await mall.events.get(userId, {
    streams: [C.controlledStreamId()],
    types: [C.ET_MIRROR],
    limit: 1000,
  });
  return (events || []).filter((e) => e?.type === C.ET_MIRROR);
}

async function findMirrorByControlled (mall: MallLike, userId: string, controlledUsername: string): Promise<EventLike | null> {
  const target = String(controlledUsername).toLowerCase();
  const mirrors = await listMirrors(mall, userId);
  for (const m of mirrors) {
    const content = m.content as MirrorContent | undefined;
    if (content?.controlled?.username?.toLowerCase() === target) return m;
  }
  return null;
}

async function findMirrorByRelId (mall: MallLike, userId: string, relId: string): Promise<EventLike | null> {
  const mirrors = await listMirrors(mall, userId);
  return mirrors.find((m) => (m.content as MirrorContent | undefined)?.relId === relId) ?? null;
}

async function createMirror (mall: MallLike, userId: string, content: MirrorContent, now: () => number): Promise<EventLike> {
  await ensureParents(mall, userId);
  return mall.events.create(userId, {
    streamIds: [C.controlledStreamId()],
    type: C.ET_MIRROR,
    time: now(),
    content: content as unknown as Record<string, unknown>,
  });
}

async function updateMirrorContent (mall: MallLike, userId: string, mirror: EventLike, patch: Partial<MirrorContent>): Promise<void> {
  const content = { ...(mirror.content || {}), ...patch };
  await mall.events.update(userId, { ...mirror, content });
}

async function deleteMirror (mall: MallLike, userId: string, mirror: EventLike): Promise<void> {
  if (mall.events.delete == null || mirror?.id == null) return;
  await ignoreNotFound(mall.events.delete(userId, { id: mirror.id }));
}

// -------------------------------------------------------------------- accesses

/**
 * Mint a plugin-managed marker access. The access carries NO stream
 * permissions: authorization for the controlled-side methods keys entirely on
 * the forge-protected `clientData.delegation` marker plus the anchor state, not
 * on stream reach (§ the controlled-side method authorizes on the marker).
 * Returns the storage row (with token + apiEndpoint attached by the mall
 * accesses adapter).
 */
async function mintMarkerAccess (mall: MallLike, userId: string, params: {
  name: string;
  clientDataDelegation: Record<string, unknown>;
  expires?: number | null;
}): Promise<AccessRow> {
  return mall.accesses.create(userId, {
    type: 'shared',
    name: params.name,
    permissions: [],
    clientData: { delegation: params.clientDataDelegation },
    expires: params.expires ?? null,
  });
}

/** Find a delegation-marker access by relId + kind. */
async function findMarkerAccess (mall: MallLike, userId: string, relId: string, kind: string): Promise<AccessRow | null> {
  const list = await mall.accesses.get(userId, {});
  for (const a of (list || [])) {
    const d = a?.clientData?.delegation as { kind?: string; relId?: string } | undefined;
    if (d != null && d.kind === kind && d.relId === relId) return a;
  }
  return null;
}

async function deleteAccessById (mall: MallLike, userId: string, accessId: string): Promise<void> {
  if (mall.accesses.delete == null) return;
  await ignoreNotFound(mall.accesses.delete(userId, { id: accessId }));
}

// -------------------------------------------------------------------- helpers

async function ignoreExists<T> (p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err: unknown) {
    const e = err as { id?: string; data?: { id?: string }; message?: string };
    const id = e?.id || e?.data?.id;
    if (id === 'item-already-exists' || id === 'duplicate') return undefined;
    const msg = String(e?.message || err).toLowerCase();
    if (msg.includes('already exists') || msg.includes('duplicate')) return undefined;
    throw err;
  }
}

async function ignoreNotFound<T> (p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err: unknown) {
    const e = err as { id?: string; data?: { id?: string }; message?: string };
    const id = e?.id || e?.data?.id;
    if (id === 'unknown-resource' || id === 'unknown-referenced-resource') return undefined;
    const msg = String(e?.message || err).toLowerCase();
    if (msg.includes('not found') || msg.includes('unknown')) return undefined;
    throw err;
  }
}

export type { MallLike, EventLike, AccessRow };
export {
  ensureParents,
  listAnchors,
  findAnchorByDelegate,
  findAnchorByRelId,
  createAnchor,
  updateAnchorContent,
  deleteAnchor,
  listMirrors,
  findMirrorByControlled,
  findMirrorByRelId,
  createMirror,
  updateMirrorContent,
  deleteMirror,
  mintMarkerAccess,
  findMarkerAccess,
  deleteAccessById,
};
