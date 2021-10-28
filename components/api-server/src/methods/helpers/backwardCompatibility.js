/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE 
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE 
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL 
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER 
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, 
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE 
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 * 
 * SPDX-License-Identifier: BSD-3-Clause
 */
//@flow

const SystemStreamsSerializer = require('business/src/system-streams/serializer');
const { getConfigUnsafe } = require('@pryv/boiler');

import type { Event } from 'business/src/events';
import type { Stream } from 'business/src/streams';
import type { Permission } from 'business/src/accesses';
import type { MethodContext } from 'business';
import type { ApiCallback } from 'api-server/src/API';
import type { StreamQueryWithStoreId } from 'business/src/events';
import type { GetEventsParams } from './eventsGetUtils';
import type Result from '../../Result';

const OLD_PREFIX: string = '.';

// loaded lazily from config using loadTagConfigIfNeeded()
let TAG_ROOT_STREAMID: ?string;
let TAG_PREFIX: ?string;
let TAG_PREFIX_LENGTH: ?number;
let isTagBackwardCompatibilityActive: ?boolean;

loadTagConfigIfNeeded();

function loadTagConfigIfNeeded(): void {
  if (TAG_PREFIX != null) return; // only testing this one as all 3 values are set together
  const config = getConfigUnsafe(true);
  TAG_PREFIX = config.get('backwardCompatibility:tags:streamIdPrefix');
  TAG_ROOT_STREAMID = config.get('backwardCompatibility:tags:rootStreamId');
  TAG_PREFIX_LENGTH = TAG_PREFIX.length;
  isTagBackwardCompatibilityActive = config.get('backwardCompatibility:tags:isActive');
}

function convertStreamIdsToOldPrefixOnResult(event: Event) {
  let count = 0;
  if (event.streamIds == null) return;
  const newStreamIds = event.streamIds.map((streamId) => {
    if (SystemStreamsSerializer.isSystemStreamId(streamId)) {
      count++;
      return changeToOldPrefix(streamId);
    }
  });
  if (count > 0) { // we cannot ensure integrity
    delete event.integrity;
    event.streamIds = newStreamIds;
  }
}

function changeMultipleStreamIdsPrefix(streamIds: Array<string>, toOldPrefix: boolean = true): Array<string> {
  const changeFunction: string => string = toOldPrefix ? replaceWithOldPrefix : replaceWithNewPrefix;

  const oldStyleStreamIds: Array<string> = [];
  for (const streamId of streamIds) {
    oldStyleStreamIds.push(changeFunction(streamId));
  }
  return oldStyleStreamIds;
}

function changePrefixIdForStreams(streams: Array<Stream>, toOldPrefix: boolean = true): Array<Stream> {
  const changeFunction: string => string = toOldPrefix ? replaceWithOldPrefix : replaceWithNewPrefix;

  for (const stream of streams) {
    stream.id = changeFunction(stream.id);
    if (stream.parentId != null) stream.parentId = changeFunction(stream.parentId);
  }
  return streams;
}

function replaceWithOldPrefix(streamId: string): string {
  if (SystemStreamsSerializer.isSystemStreamId(streamId)) {
    return changeToOldPrefix(streamId);
  } else {
    return streamId;
  }
}

function changeToOldPrefix(streamId: string): string {
  return OLD_PREFIX + SystemStreamsSerializer.removePrefixFromStreamId(streamId);
}

function replaceWithNewPrefix(streamId: string): string {
  const streamIdWithoutPrefix: string = removeOldPrefix(streamId);
  if (SystemStreamsSerializer.isCustomerSystemStreamId(streamIdWithoutPrefix)) return SystemStreamsSerializer.addCustomerPrefixToStreamId(streamIdWithoutPrefix);
  if (SystemStreamsSerializer.isPrivateSystemStreamId(streamIdWithoutPrefix)) return SystemStreamsSerializer.addPrivatePrefixToStreamId(streamIdWithoutPrefix);
  return streamIdWithoutPrefix;

  function removeOldPrefix(streamId: string): string {
    if (streamId.startsWith(OLD_PREFIX)) return streamId.substr(1);
    return streamId;
  }
}

function changeStreamIdsPrefixInStreamQuery(
  isStreamIdPrefixBackwardCompatibilityActive: boolean,
  context: MethodContext,
  params: GetEventsParams,
  result: Result,
  next: ApiCallback
): ?Function {
  if (! isStreamIdPrefixBackwardCompatibilityActive || context.disableBackwardCompatibility) return next();
  const streamsQueries: Array<StreamQueryWithStoreId> = params.arrayOfStreamQueriesWithStoreId;
  const oldStyleStreamsQueries: Array<StreamQueryWithStoreId> = [];
  for (const streamsQuery of streamsQueries) {
    const oldStyleStreamQuery = {};
    for (const [prop: string, streamIds: Array<string>] of Object.entries(streamsQuery)) {
      if (prop === 'storeId') {
        oldStyleStreamQuery[prop] = streamIds; // hack
      } else {
        oldStyleStreamQuery[prop] = changeMultipleStreamIdsPrefix(streamIds, false);
      }
    }
    oldStyleStreamsQueries.push(oldStyleStreamQuery);
  }
  params.arrayOfStreamQueriesWithStoreId = oldStyleStreamsQueries;
  next();
}

function changeStreamIdsInPermissions(permissions: Array<Permission>, toOldPrefix: boolean = true): Array<Permission> {
  const changeFunction: string => string = toOldPrefix ? replaceWithOldPrefix : replaceWithNewPrefix;
  const oldStylePermissions: Array<Permission> = [];

  for (const permission of permissions) {
    permission.streamId = changeFunction(permission.streamId);
    oldStylePermissions.push(permission);
  }
  return oldStylePermissions;
}

/**
 * Replaces the tags in an event with streamIds with the corresponding prefix
 * Deletes the tags.
 */
function replaceTagsWithStreamIds(event: Event): Event {
  if (event.tags == null) return event;
  for (const tag: string of event.tags) {
    event.streamIds.push(TAG_PREFIX + tag);
  }
  delete event.tags;
  return event;
}

/**
 * put back tags in events, taken from its streamIds
 */
function putOldTags(event: Event): Event {
  // if (event.tags != null) console.log('WOW, should not have anymore tags in the storage');
  event.tags = [];
  for (const streamId: string of event.streamIds) {
    if (isTagStreamId(streamId)) {
      event.tags.push(removeTagPrefix(streamId));
    }
  }
  return event;
}

function removeTagPrefix(streamId: string): string {
  return streamId.slice(TAG_PREFIX_LENGTH);
}

function isTagStreamId(streamId: string): boolean {
  return streamId.startsWith(TAG_PREFIX);
}

module.exports = {
  changeMultipleStreamIdsPrefix,
  changeStreamIdsPrefixInStreamQuery,
  changePrefixIdForStreams,
  replaceWithNewPrefix,
  changeStreamIdsInPermissions,
  TAG_ROOT_STREAMID,
  TAG_PREFIX,
  replaceTagsWithStreamIds,
  putOldTags,
  convertStreamIdsToOldPrefixOnResult,
}