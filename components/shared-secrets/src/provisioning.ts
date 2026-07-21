/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Shared secrets — lazy provisioning of the reserved namespace.
 *
 * The root and each per-access substream are created on first use rather than
 * at account creation, so existing accounts pick the feature up without a
 * migration. Provisioning must therefore be reachable from **every** path that
 * touches the namespace, reads included: a consumer whose first action is a
 * listing would otherwise get `unknown-referenced-resource` forever, because
 * the read that needs the stream is also the thing refusing to create it. (The
 * CMC namespace shipped that exact gap and had to be fixed after a live
 * integration hit it.)
 *
 * Creates go through `mall.streams.create` directly, bypassing the api-server
 * middleware — the guards that reject hand-made writes into this namespace
 * would otherwise reject the plugin provisioning its own parents.
 */

import * as C from './constants.ts';

type StreamCreateParams = {
  id: string;
  parentId: string | null;
  name: string;
  clientData?: Record<string, unknown>;
  createdBy?: string;
  modifiedBy?: string;
};

type MallStreamsOnly = {
  streams: { create (userId: string, params: StreamCreateParams): Promise<unknown> };
};

type ProvisionLogger = {
  debug?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
};

function isAlreadyExistsError (err: unknown): boolean {
  if (err == null) return false;
  const e = err as { message?: string; id?: string; data?: { id?: string } };
  const msg = String(e.message || err);
  if (msg.includes('already exists') || msg.includes('item-already-exists')) return true;
  if (e.id === 'item-already-exists') return true;
  if (e.data?.id === 'item-already-exists') return true;
  return false;
}

/**
 * Ensure the reserved root exists, plus the substream of `accessId` when given.
 * Idempotent: "already exists" is the normal outcome and is not an error.
 * Returns the ids actually created.
 */
async function ensureStreams (params: {
  mall: MallStreamsOnly;
  userId: string;
  accessId?: string | null;
  logger?: ProvisionLogger;
}): Promise<string[]> {
  const { mall, userId, accessId, logger } = params;
  const wanted: StreamCreateParams[] = [
    { id: C.NS, parentId: null, name: 'Shared secrets' }
  ];
  if (accessId != null) {
    wanted.push({
      id: C.streamIdForAccess(accessId),
      parentId: C.NS,
      name: 'Shared secrets of ' + accessId
    });
  }

  const created: string[] = [];
  for (const stream of wanted) {
    const payload: StreamCreateParams = {
      ...stream,
      clientData: { sharedSecrets: { kind: 'reserved', autoProvisioned: true } }
    };
    if (accessId != null) {
      payload.createdBy = accessId;
      payload.modifiedBy = accessId;
    }
    try {
      await mall.streams.create(userId, payload);
      created.push(stream.id);
      logger?.debug?.('shared-secrets: provisioned stream', { userId, streamId: stream.id });
    } catch (err) {
      if (isAlreadyExistsError(err)) continue;
      logger?.warn?.('shared-secrets: failed to provision stream', {
        userId,
        streamId: stream.id,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }
  return created;
}

/** Every stream id a `streams` query parameter references, in any of its shapes. */
function collectQueriedStreamIds (streams: unknown, into: string[] = []): string[] {
  if (streams == null) return into;
  if (typeof streams === 'string') {
    into.push(streams);
    return into;
  }
  if (Array.isArray(streams)) {
    for (const entry of streams) collectQueriedStreamIds(entry, into);
    return into;
  }
  if (typeof streams === 'object') {
    const q = streams as Record<string, unknown>;
    if (typeof q.streamId === 'string') into.push(q.streamId);
    for (const key of ['any', 'all', 'not']) {
      if (q[key] != null) collectQueriedStreamIds(q[key], into);
    }
  }
  return into;
}

/** True when a `streams` query parameter reaches into this namespace. */
function queryTouchesNamespace (streams: unknown): boolean {
  return collectQueriedStreamIds(streams).some((id) => C.isSharedSecretStreamId(id));
}

export { ensureStreams, collectQueriedStreamIds, queryTouchesNamespace, isAlreadyExistsError };
export type { MallStreamsOnly, ProvisionLogger, StreamCreateParams };
