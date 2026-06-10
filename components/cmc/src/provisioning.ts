/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — auto-provisioning of reserved parent streams on user creation.
 *
 * The five reserved parents (`:_cmc:`, `:_cmc:inbox`, `:_cmc:apps`,
 * `:_cmc:_internal`, `:_cmc:_internal:retries`) must auto-exist on every
 * user account so that:
 *   - User code can `streams.create({parentId: ':_cmc:apps'})` for
 *     organizational app roots.
 *   - Plugin code can `events.create` into `:_cmc:_internal:retries`
 *     for the retry queue.
 *
 * Per-app sub-trees (`:_cmc:apps:<app-code>:chats:*` /
 * `:_cmc:apps:<app-code>:<...>:collectors:*`) are NOT pre-provisioned —
 * the plugin creates them on demand at acceptance time, nested under
 * whichever stream the trigger event was written to. Same for the
 * per-capability streams under `:_cmc:_internal:offer:*` /
 * `:_cmc:_internal:responses:*`.
 *
 * This is called from the user-creation flow in business/src/users/
 * repository.ts. The streams are created via the mall directly,
 * bypassing the api-server middleware chain (otherwise the reserved-root
 * hook would reject creation of its own parents).
 *
 * Idempotent: catches "already exists" errors so re-provisioning is safe
 * (e.g. running on existing users for backfill).
 */

const C = require('./constants.ts');

type StreamCreateParams = {
  id: string;
  parentId: string | null;
  name: string;
  clientData?: Record<string, unknown>;
  createdBy?: string;
  modifiedBy?: string;
  [k: string]: unknown;
};

type Mall = {
  streams: {
    create (userId: string, params: StreamCreateParams): Promise<unknown>;
    getOne?: (userId: string, params: Record<string, unknown>) => Promise<unknown>;
  };
};

type ProvisionLogger = {
  debug: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
};

/**
 * Tree of reserved parents, ordered so children's parents always exist
 * by the time the child is created.
 */
const RESERVED_TREE: Array<{ id: string; parentId: string | null; name: string }> = [
  { id: C.NS, parentId: null, name: 'CMC' },
  { id: C.NS_INBOX, parentId: C.NS, name: 'CMC inbox' },
  { id: C.NS_APPS, parentId: C.NS, name: 'CMC apps' },
  { id: C.NS_INTERNAL, parentId: C.NS, name: 'CMC plugin-internal' },
  { id: C.NS_INTERNAL_RETRIES, parentId: C.NS_INTERNAL, name: 'CMC retry queue' },
];

function isAlreadyExistsError (err: unknown): boolean {
  if (err == null) return false;
  const e = err as { message?: string; id?: string; data?: { id?: string } };
  const msg = String(e.message || err);
  if (msg.includes('already exists') || msg.includes('item-already-exists')) return true;
  if (e.id === 'item-already-exists') return true;
  if (e.data?.id === 'item-already-exists') return true;
  // mall throws APIError with id; be tolerant of multiple shapes.
  return false;
}

/**
 * Create the seven CMC reserved parent streams for the given user.
 * Each create is wrapped to ignore "already exists" so the function
 * is idempotent. Returns the list of stream-ids that were newly created
 * (does not include ids that were already present).
 */
async function provisionUserStreams (params: {
  mall: Mall;
  userId: string;
  accessId?: string;
  logger?: ProvisionLogger;
}): Promise<string[]> {
  const { mall, userId, accessId, logger } = params;
  const created: string[] = [];

  for (const stream of RESERVED_TREE) {
    const payload: StreamCreateParams = {
      id: stream.id,
      parentId: stream.parentId,
      name: stream.name,
      clientData: {
        cmc: { kind: 'reserved-parent', autoProvisioned: true },
      },
    };
    if (accessId != null) {
      payload.createdBy = accessId;
      payload.modifiedBy = accessId;
    }
    try {
      await mall.streams.create(userId, payload);
      created.push(stream.id);
      logger?.debug?.('cmc: provisioned reserved parent stream', { userId, streamId: stream.id });
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        logger?.debug?.('cmc: reserved parent already present', { userId, streamId: stream.id });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn?.('cmc: failed to provision reserved parent stream', {
        userId,
        streamId: stream.id,
        error: message,
      });
      throw err;
    }
  }

  return created;
}

export {
  RESERVED_TREE,
  provisionUserStreams,
  isAlreadyExistsError,
};
