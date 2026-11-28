/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { PLATFORM_TRAIL_USER_ID } from 'storages/interfaces/auditStorage/AuditStorage.ts';

const CONSTANTS = {
  STORE_PREFIX: ':_audit:',
  ACCESS_STREAM_ID_PREFIX: 'access-',
  ACTION_STREAM_ID_PREFIX: 'action-',
  EVENT_TYPE_VALID: 'audit-log/pryv-api',
  EVENT_TYPE_ERROR: 'audit-log/pryv-api-error',
  /**
   * The id the audit storage keeps this core's platform trail under: the
   * stored records of the audited calls without an account of this core
   * (`WITHOUT_USER_METHODS`). Not an account.
   */
  PLATFORM_TRAIL_USER_ID
};

Object.freeze(CONSTANTS);

export default CONSTANTS;
export { CONSTANTS };
