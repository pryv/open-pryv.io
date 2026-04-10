/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * Lists the possible object actions affecting schema definitions.
 */

const Action = module.exports = {
  CREATE: 'create',
  /**
   * To describe what is actually stored in the DB.
   */
  STORE: 'store',
  READ: 'read',
  UPDATE: 'update'
};
Object.freeze(Action);
