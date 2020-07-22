var helpers = require('./helpers');

/**
 * JSON Schema specification for item deletions.
 */
module.exports = helpers.object({
  id: helpers.string(),
  deleted: helpers.number()
}, {
  id: 'itemDeletion',
  required: ['id'],
  additionalProperties: false
});
