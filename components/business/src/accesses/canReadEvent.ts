/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import * as accountStreams from '../system-streams/index.ts';
import { CONTAINER_STREAM_ID as EMAILS_ROOT } from '../emails/constants.ts';
import { isCmcInternalStreamId } from 'cmc/src/constants.ts';
import { isDelegationInternalStreamId } from 'delegation/src/constants.ts';
import { storeDataUtils } from 'mall';

/**
 * Whether an access may read one event fetched by id.
 *
 * Single-event reads (events.getOne, attachments, previews, HF series) must
 * not reach an event that events.get would hide from the same access. For a
 * non-personal access the event is refused when any of its streams:
 *   - is a hidden account stream,
 *   - is in the emails container,
 *   - is in a plugin-internal subtree,
 *   - is governed by a `none` / `create-only` grant (own or inherited);
 * and, when the access carries forced streams, unless the event sits in each
 * of them. Otherwise at least one stream must be readable.
 * A personal access reads everything but hidden account streams.
 */

export type CanReadEventAccess = {
  isPersonal: () => boolean;
  canGetEventsOnStream: (streamId: string, storeId: string) => Promise<boolean>;
  isStreamForbiddenForReading: (fullStreamId: string) => Promise<boolean>;
  isStreamWithin: (storeId: string, streamId: string, ancestorId: string) => Promise<boolean>;
  getForcedStreamsGetEventsStreamIds: (storeId: string) => string[] | null | undefined;
};
type EventLike = { streamIds?: string[] | null };

function isEmailsStream (streamId: string): boolean {
  return streamId === ':_emails' || streamId.startsWith(EMAILS_ROOT);
}

function isPluginInternalStream (streamId: string): boolean {
  return isCmcInternalStreamId(streamId) || isDelegationInternalStreamId(streamId);
}

async function canReadEvent (access: CanReadEventAccess, event: EventLike): Promise<boolean> {
  const streamIds = event?.streamIds;
  if (!Array.isArray(streamIds) || streamIds.length === 0) return false;
  const hidden: string[] = accountStreams.hiddenStreamIds ?? [];
  if (streamIds.some((id) => hidden.includes(id))) return false;
  if (access.isPersonal()) return true;

  for (const streamId of streamIds) {
    if (isEmailsStream(streamId) || isPluginInternalStream(streamId)) return false;
  }
  if (await isEventHiddenByGrants(access, streamIds)) return false;

  for (const streamId of streamIds) {
    if (await access.canGetEventsOnStream(streamId, 'local')) return true;
  }
  return false;
}

/**
 * Whether the access's grants hide an event with these streams, whatever its
 * other streams grant: a stream withholds reading (`none` / `create-only`), or
 * the access carries forced streams and the event is outside one of them.
 * The write methods (events.update, events.delete, events.deleteAttachment)
 * refuse such an event the way events.getOne does, so an access cannot read,
 * change or delete by id an event it cannot read. Always false for a
 * personal access.
 */
async function isEventHiddenByGrants (
  access: Pick<CanReadEventAccess, 'isPersonal' | 'isStreamForbiddenForReading' | 'getForcedStreamsGetEventsStreamIds' | 'isStreamWithin'>,
  streamIds: readonly string[]
): Promise<boolean> {
  if (access.isPersonal()) return false;
  if (await hasStreamForbiddenForReading(access, streamIds)) return true;
  return await isOutsideForcedStreams(access, streamIds);
}

/**
 * Whether an access carrying forced streams (accesses migrated from v1 tag
 * permissions) is kept away from an event: for each store the event's
 * streams belong to, the event must be within each forced stream of that
 * store, through one of its streams in that store. False when the access has
 * none.
 */
async function isOutsideForcedStreams (
  access: Pick<CanReadEventAccess, 'getForcedStreamsGetEventsStreamIds' | 'isStreamWithin'>,
  streamIds: readonly string[]
): Promise<boolean> {
  const inStoreIdsByStore = new Map<string, string[]>();
  for (const id of streamIds) {
    const [storeId, inStoreId] = storeDataUtils.parseStoreIdAndStoreItemId(id);
    const list = inStoreIdsByStore.get(storeId);
    if (list == null) inStoreIdsByStore.set(storeId, [inStoreId]);
    else list.push(inStoreId);
  }
  for (const [storeId, inStoreIds] of inStoreIdsByStore) {
    const forced = access.getForcedStreamsGetEventsStreamIds(storeId);
    if (forced == null || forced.length === 0) continue;
    for (const forcedId of forced) {
      let within = false;
      for (const id of inStoreIds) {
        if (await access.isStreamWithin(storeId, id, forcedId)) { within = true; break; }
      }
      if (!within) return true;
    }
  }
  return false;
}

/**
 * Whether any of the given streams is governed by a grant that withholds
 * reading (`none` / `create-only`, own or inherited). Callers check for a
 * personal access first (`isEventHiddenByGrants`).
 */
async function hasStreamForbiddenForReading (
  access: Pick<CanReadEventAccess, 'isStreamForbiddenForReading'>,
  streamIds: readonly string[]
): Promise<boolean> {
  for (const streamId of streamIds) {
    if (await access.isStreamForbiddenForReading(streamId)) return true;
  }
  return false;
}

/**
 * Whether a stream sits where only the personal access reads: the emails
 * container or a plugin-internal subtree. For records that name only the
 * stream (stream deletion records).
 */
function isStreamOutOfNonPersonalReach (streamId: string): boolean {
  return isEmailsStream(streamId) || isPluginInternalStream(streamId);
}

export { canReadEvent, isEventHiddenByGrants, isStreamOutOfNonPersonalReach };
export default canReadEvent;
