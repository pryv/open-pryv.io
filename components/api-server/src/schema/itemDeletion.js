/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const helpers = require('./helpers');

/**
 * JSON Schema specification for item deletions.
 */
module.exports = helpers.object({
  id: helpers.string(),
  deleted: helpers.number(),
  integrity: helpers.string()
}, {
  id: 'itemDeletion',
  required: ['id'],
  additionalProperties: false
});
