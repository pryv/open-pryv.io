/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification for events.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const number = helpers.number;
const boolean = helpers.boolean;

/**
 * @param {Action} action
 */
exports = module.exports = function (action) {
  // read items === stored items
  if (action === Action.STORE) {
    action = Action.READ;
  }

  const schema = object({
    id: string(),
    time: number(),
    duration: number({ nullable: true }),
    streamIds: array(string(), { nullable: false, minItems: 1 }),
    type: string({ pattern: '^(series:)?[a-z0-9-]+/[a-z0-9-]+$' }),
    content: {},
    description: string({ nullable: true }),
    clientData: object({}, { nullable: true }),
    trashed: boolean({ nullable: true }),
    integrity: string({ nullable: true })
  }, {
    id: helpers.getTypeURI('event', action),
    additionalProperties: false
  });

  helpers.addTrackingProperties(schema, action);

  if (action !== Action.CREATE) {
    schema.properties.id = string();
  }

  if (action === Action.CREATE) {
    // Accept either: a system-stream id (e.g. ":system:foo"),
    // a legacy cuid v1/v2 id (^c + 24 chars, 25 total), or a
    // cuid2 id (24 lowercase alphanumeric, first char a letter).
    // The colon is not a regex special character, so it doesn't need escaping.
    // ajv compiles patterns with the `u` (unicode) flag, which rejects the
    // `\:` escape z-schema used to tolerate. Plain `:` works in both worlds.
    schema.properties.id.pattern = '(?=^:[a-z0-9-]+:)(^:[a-z0-9-]+:[a-z0-9A-Z-]{1,256})|(^c[a-z0-9-]{24}$)|(^[a-z][a-z0-9]{23}$)';
    // only allow "files" (raw file data) on create; no further checks as it's
    // created internally
    schema.properties.files = array(object({}));
  }

  // forbid attachments except on read and update (ignored for the latter)
  if (action === Action.READ) {
    schema.properties.attachments = exports.attachments;
  } else if (action === Action.UPDATE) {
    schema.properties.attachments = { type: 'array' };
    // whitelist for properties that can be updated
    schema.alterableProperties = ['streamIds', 'time', 'duration', 'type',
      'content', 'references', 'description', 'clientData', 'trashed'];
  }

  switch (action) {
    case Action.READ:
      schema.required = ['id', 'streamIds', 'time', 'type',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      break;
    case Action.CREATE:
      schema.required = ['type', 'streamIds'];
      break;
  }

  return schema;
};

exports.attachments = array(object({
  id: string(),
  fileName: string(),
  type: string(),
  size: number(),
  readToken: string(),
  integrity: string()
}, {
  required: ['id', 'fileName', 'type', 'size', 'readToken'],
  additionalProperties: false
}));
