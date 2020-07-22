/**
 * Utilities for storage queries.
 */

/**
 * Applies the given state parameter to the given query object.
 *
 * @param {Object} query
 * @param {String} state "default", "trashed" or "all"
 * @returns {Object} The query object
 */
exports.applyState = function (query, state) {
  query = query || {};
  switch (state) {
  case 'trashed':
    query.trashed = true;
    break;
  case 'all':
    break;
  default:
    query.trashed = null;
  }
  return query;
};

exports.noDeletions = function (query) {
  query.deleted = null;
  return query;
};
