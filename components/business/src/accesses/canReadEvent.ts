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
    if (await access.isStreamForbiddenForReading(streamId)) return false;
  }

  const [storeId] = storeDataUtils.parseStoreIdAndStoreItemId(streamIds[0]);
  const forced = access.getForcedStreamsGetEventsStreamIds(storeId);
  if (forced != null && forced.length > 0) {
    const inStoreIds = streamIds.map((id) => storeDataUtils.parseStoreIdAndStoreItemId(id)[1]);
    for (const forcedId of forced) {
      let within = false;
      for (const id of inStoreIds) {
        if (await access.isStreamWithin(storeId, id, forcedId)) { within = true; break; }
      }
      if (!within) return false;
    }
  }

  for (const streamId of streamIds) {
    if (await access.canGetEventsOnStream(streamId, 'local')) return true;
  }
  return false;
}

export { canReadEvent };
export default canReadEvent;
