/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification of methods errors.
 * Error objects are usually found in property `error` of method results.
 */

module.exports = {
  id: 'error',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string'
    },
    message: {
      type: 'string'
    },
    data: {
      type: ['string', 'object', 'array']
    },
    subErrors: {
      type: 'array',
      items: {
        $ref: '#error'
      }
    }
  },
  required: ['id', 'message']
};
