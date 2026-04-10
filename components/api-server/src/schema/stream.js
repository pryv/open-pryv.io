/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification for event streams.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const boolean = helpers.boolean;

/**
 * @param {Action} action
 * @param {Boolean} ignoreChildren Whether to ignore `children` property
 * @param {String} refToStreamSchema
 */
module.exports = function (action, ignoreChildren, refToStreamSchema) {
  const schema = {
    id: helpers.getTypeURI('stream', action),
    type: 'object',
    additionalProperties: false,
    properties: {
      id: string({ minLength: 1 }),
      name: string({ minLength: 1 }),
      parentId: string({ nullable: true, minLength: 1 }),
      clientData: object({}, { nullable: true }),
      trashed: boolean({ nullable: true }),
      // ignored except on READ, accepted to simplify interaction with client frameworks
      children: array({ $ref: refToStreamSchema || '#' }, { nullable: true }),
      childrenHidden: boolean({ nullable: true })
    }
  };

  helpers.addTrackingProperties(schema, action);

  switch (action) {
    case Action.READ:
      schema.required = ['id', 'name', 'parentId',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      if (!ignoreChildren) {
        schema.required.push('children');
      }
      break;
    case Action.STORE:
      schema.required = ['id', 'name', 'parentId',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      break;
    case Action.CREATE:
      schema.required = ['name'];
      break;
    case Action.UPDATE:
      // whitelist for properties that can be updated
      schema.alterableProperties = ['name', 'parentId',
        'clientData', 'trashed'];
      break;
  }

  return schema;
};
