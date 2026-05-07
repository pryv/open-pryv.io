/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./helpers.ts');

/**
 * JSON Schema specification for item deletions.
 */
const itemDeletion = helpers.object({
  id: helpers.string(),
  deleted: helpers.number(),
  integrity: helpers.string()
}, {
  id: 'itemDeletion',
  required: ['id'],
  additionalProperties: false
});
export default itemDeletion;
