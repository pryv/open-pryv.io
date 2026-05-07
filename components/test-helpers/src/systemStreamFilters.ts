/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from "node:fs";


/**
 * Static helpers to filter system streams/events from API responses.
 * No dependency on accountStreams — uses prefix-based detection only.
 */

const PRYV_PREFIX = ':_system:';
const CUSTOMER_PREFIX = ':system:';

/**
 * Returns true if the streamId is a system stream (private or customer prefix).
 * @param streamId
 */
function isSystemStreamId (streamId) {
  return streamId.startsWith(PRYV_PREFIX) || streamId.startsWith(CUSTOMER_PREFIX);
}

/**
 * Remove events that belong to system streams from an events array.
 * @param events
 */
function removeSystemEvents (events) {
  return events.filter(e =>
    !e.streamIds?.some(id => isSystemStreamId(id))
  );
}

/**
 * Separate events into normal events and system stream events.
 * @param events
 */
function separateSystemEvents (events) {
  const normal = [];
  const system = [];
  for (const e of events) {
    if (e.streamIds?.some(id => isSystemStreamId(id))) {
      system.push(e);
    } else {
      normal.push(e);
    }
  }
  return { events: normal, systemEvents: system };
}

/**
 * Remove system streams (root-level) from a streams array.
 * Filters out any stream whose id starts with a system prefix.
 * @param streams
 */
function removeSystemStreams (streams) {
  return streams.filter(s => !isSystemStreamId(s.id));
}

/**
 * Adds private system stream prefix to a stream id.
 * Test-only — simple concatenation, no validation.
 * @param id
 */
function addPrivatePrefixToStreamId (id) {
  return PRYV_PREFIX + id;
}

/**
 * Adds customer system stream prefix to a stream id.
 * Test-only — simple concatenation, no validation.
 * @param id
 */
function addCustomerPrefixToStreamId (id) {
  return CUSTOMER_PREFIX + id;
}

export {
  PRYV_PREFIX,
  CUSTOMER_PREFIX,
  isSystemStreamId,
  removeSystemEvents,
  separateSystemEvents,
  removeSystemStreams,
  addPrivatePrefixToStreamId,
  addCustomerPrefixToStreamId
};
