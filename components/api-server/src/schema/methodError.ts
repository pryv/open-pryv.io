/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * JSON Schema specification of methods errors.
 * Error objects are usually found in property `error` of method results.
 */

const __ex_id = 'error';
export { __ex_id as id };
const __ex_type = 'object';
export { __ex_type as type };
const __ex_additionalProperties = false;
export { __ex_additionalProperties as additionalProperties };
const __ex_properties = {
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
        // `$ref: '#'` is the root self-reference, equivalent to z-schema's
        // `$ref: '#error'` (which targets the schema's own `id: 'error'`).
        // ajv-draft-04 doesn't auto-treat id-strings as in-document anchors;
        // root self-ref is the portable form.
        $ref: '#'
      }
    }
  };
export { __ex_properties as properties };
const __ex_required = ['id', 'message'];
export { __ex_required as required };
