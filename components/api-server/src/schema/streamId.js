/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
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
 * @param {string} streamId
 * @returns {string}
 */
function findForbiddenChar (streamId) {
  for (let i = 0; i < streamId.length; i++) {
    const char = streamId[i];
    if (forbiddenCharsMap[char]) { return char; }
  }
  return null;
}
/**
 * Tests stream id for validity at creation
 * @param {string} streamId
 * @returns {boolean}
 */
function isStreamIdValidForCreation (streamId) {
  const regexp = new RegExp(STREAMID_AT_CREATION_REGEXP_STR);
  return regexp.test(streamId);
}
module.exports = {
  findForbiddenChar,
  isStreamIdValidForCreation,
  STREAMID_AT_CREATION_REGEXP_STR
};
