/**
 * Lists the possible object actions affecting schema definitions.
 */

var Action = module.exports = {
  CREATE: 'create',
  /**
   * To describe what is actually stored in the DB.
   */
  STORE: 'store',
  READ: 'read',
  UPDATE: 'update'
};
Object.freeze(Action);
