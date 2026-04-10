/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const helpers = require('api-server/src/schema/helpers');
const string = helpers.string;
const boolean = helpers.boolean;
const array = helpers.array;

module.exports = {
  id: 'systemStreamsSchema',
  type: 'object',
  additionalProperties: true,
  properties: {
    id: string({ minLength: 2 }),
    name: string({ minLength: 2 }),
    isIndexed: boolean({ nullable: false }),
    isUnique: boolean({ nullable: false }),
    isShown: boolean({ nullable: false }),
    isEditable: boolean({ nullable: false }),
    isRequiredInValidation: boolean({ nullable: false }),
    type: string({ pattern: '^[a-z0-9-]+\/[a-z0-9-]+$' }), /* eslint-disable-line no-useless-escape */
    parentId: string({ minLength: 2, nullable: true }),
    default: {},
    children: array({ $ref: 'systemStreamsSchema' }, { nullable: true })
  },
  required: ['id', 'type']
};
