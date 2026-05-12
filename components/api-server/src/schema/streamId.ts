/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * List of characters that are forbbidden in streamIds
 */
const forbiddenCharsMap = {
  '"': true,
  '\0': true,
  '\b': true,
  '\t': true,
  '\n': true,
  '\r': true,
  '\x1a': true,
  "'": true,
  '\\': true
};
const STREAMID_AT_CREATION_REGEXP_STR = '^[a-z0-9-]{1,100}';
/**
 * Find forbidden character for 'streams' or 'permission.streamId'
 */
function findForbiddenChar (streamId: any) {
  for (let i = 0; i < streamId.length; i++) {
    const char = streamId[i];
    if ((forbiddenCharsMap as any)[char]) { return char; }
  }
  return null;
}
/**
 * Tests stream id for validity at creation
 */
function isStreamIdValidForCreation (streamId: any) {
  const regexp = new RegExp(STREAMID_AT_CREATION_REGEXP_STR);
  return regexp.test(streamId);
}
export { findForbiddenChar, isStreamIdValidForCreation, STREAMID_AT_CREATION_REGEXP_STR };