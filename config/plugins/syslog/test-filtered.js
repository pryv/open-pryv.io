/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Test Plugin for syslog
 *
 * Process {userId} {event} to create a message.
 * Filter message by returning "null" when event.content.skip is true
 */

/**
 * @param {string} userId
 * @param {PryvEvent} event
 * @returns {Object} - {level: .. , message: ... }  or null to skip
 */
module.exports = function (userId, event) {
  if (event.content.skip) {
    return null;
  }
  return {
    level: 'notice',
    message: userId + ' TEST FILTERED ' + event.content.message
  };
};
