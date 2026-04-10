/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const CONSTANTS = {
  STORE_PREFIX: ':_audit:',
  ACCESS_STREAM_ID_PREFIX: 'access-',
  ACTION_STREAM_ID_PREFIX: 'action-',
  EVENT_TYPE_VALID: 'audit-log/pryv-api',
  EVENT_TYPE_ERROR: 'audit-log/pryv-api-error'
};

Object.freeze(CONSTANTS);

module.exports = CONSTANTS;
