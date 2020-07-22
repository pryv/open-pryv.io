/**
 * JSON Schema specification for users.
 */

var Action = require('./Action'),
    helpers = require('./helpers');

/**
 * @param {Action} action
 */
module.exports = function (action) {
  var schema = {
    id: helpers.getTypeURI('user', action),
    type: 'object',
    additionalProperties: false,
    properties: {
      'username': helpers.string({pattern: '^[a-z0-9][a-z0-9\\-]{3,21}[a-z0-9]$'}),
      'email': helpers.email,
      'language': helpers.language,
      storageUsed: helpers.object({
        dbDocuments: helpers.number(),
        attachedFiles: helpers.number()
      }, {required: [ 'dbDocuments', 'attachedFiles' ]})
    }
  };

  // explicitly forbid 'id' on create
  if (action !== Action.CREATE) {
    schema.properties.id = helpers.string();
  }

  // only accept password hash on create (request from registration-server) (and store of course)
  if (action === Action.CREATE || action === Action.STORE) {
    schema.properties.passwordHash = helpers.string();
  }

  switch (action) {
  case Action.READ:
    schema.required = [ 'id', 'username', 'email', 'language' ];
    break;
  case Action.STORE:
    schema.required = [ 'id', 'username', 'passwordHash', 'email', 'language', 'storageUsed' ];
    break;
  case Action.CREATE:
    schema.required = [ 'username', 'passwordHash', 'email', 'language' ];
    break;
  }

  return schema;
};
