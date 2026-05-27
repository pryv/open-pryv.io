/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification for users.
 */

const Action = require('./Action.ts');
const helpers = require('./helpers.ts');

export default function (action: any) {
  const schema: any = {
    id: helpers.getTypeURI('user', action),
    type: 'object',
    additionalProperties: false,
    properties: {
      username: helpers.username,
      email: helpers.email,
      language: helpers.language,
      appId: helpers.string(),
      referer: helpers.string({ nullable: true }),
      invitationToken: helpers.string({ nullable: true }),
      storageUsed: helpers.object({
        dbDocuments: helpers.number(),
        attachedFiles: helpers.number()
      }, { required: ['dbDocuments', 'attachedFiles'] })
    }
  };

  // explicitly forbid 'id' on create
  if (action !== Action.CREATE) {
    schema.properties.id = helpers.string();
  }

  // only accept password hash on create (request from registration-server) (and store of course)
  if (action === Action.CREATE || action === Action.STORE) {
    schema.properties.passwordHash = helpers.string();
  }

  switch (action) {
    case Action.READ:
      schema.required = ['id', 'username', 'email', 'language'];
      break;
    case Action.STORE:
      schema.required = ['id', 'username', 'email', 'language', 'storageUsed'];
      schema.additionalProperties = true;
      break;
    case Action.CREATE:
      schema.required = ['username', 'passwordHash', 'email', 'language'];
      break;
  }

  return schema;
};
