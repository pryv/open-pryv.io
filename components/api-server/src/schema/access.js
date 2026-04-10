/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/**
 * JSON Schema specification for accesses.
 */

const Action = require('./Action');
const helpers = require('./helpers');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;
const _ = require('lodash');

/**
 * @param {Action} action
 */
exports = module.exports = function (action) {
  if (action === Action.STORE) { action = Action.READ; } // read items === stored items

  const base = object({
    token: string({ minLength: 1 }),
    apiEndpoint: string({ minLength: 1 }),
    name: string({ minLength: 1 }),
    permissions: permissions(action),
    lastUsed: helpers.number(),
    integrity: string({ nullable: true })
  }, {
    additionalProperties: false
  });
  helpers.addTrackingProperties(base);

  // explicitly forbid 'id' on create TODO: ignore it instead
  if (action !== Action.CREATE) {
    base.properties.id = string();
  }

  // explicitly forbid 'calls' on anything but store (purely internal)
  if (action === Action.STORE) {
    base.properties.calls = object({});
  }

  const personal = structuredClone(base);
  _.extend(personal.properties, {
    type: string({ enum: ['personal'] })
  });

  const app = structuredClone(base);
  _.extend(app.properties, {
    type: string({ enum: ['app'] }),
    deviceName: string()
  });

  const shared = structuredClone(base);
  _.extend(shared.properties, {
    type: string({ enum: ['shared'] }),
    deviceName: helpers.null()
  });

  switch (action) {
    case Action.READ:
      personal.required = ['id', 'token', 'name', 'type',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      app.required = ['id', 'token', 'name', 'type', 'permissions',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      shared.required = ['id', 'token', 'name', 'type', 'permissions',
        'created', 'createdBy', 'modified', 'modifiedBy'];
      break;

    case Action.CREATE:
      personal.required = ['name'];
      app.required = ['name', 'permissions'];
      shared.required = ['name', 'permissions'];

      // Allow expireAfter to set expiry on new access
      app.properties.expireAfter = helpers.number();
      shared.properties.expireAfter = helpers.number();

      // Allow to attach clientData to new access
      personal.properties.clientData = helpers.object({});
      app.properties.clientData = helpers.object({});
      shared.properties.clientData = helpers.object({});

      break;

    case Action.UPDATE:
      // Allow expireAfter to set expiry on access
      app.properties.expireAfter = helpers.number();
      app.properties.expires = helpers.null();

      shared.properties.expireAfter = helpers.number();
      shared.properties.expires = helpers.null();

      // Allow to attach clientData to access
      personal.properties.clientData = helpers.object({}, { nullable: true });
      app.properties.clientData = helpers.object({}, { nullable: true });
      shared.properties.clientData = helpers.object({}, { nullable: true });

      break;
  }

  const res = {
    id: helpers.getTypeURI('access', action),
    anyOf: [personal, app, shared]
  };

  // whitelist for properties that can be updated
  if (action === Action.UPDATE) {
    res.alterableProperties = [
      'name', 'deviceName', 'permissions', 'expireAfter', 'expires', 'clientData'];
  }

  return res;
};

const permissionLevel = exports.permissionLevel = string({ enum: ['read', 'contribute', 'manage', 'create-only', 'none'] });

const featureSetting = exports.featureSetting = string({ enum: ['forbidden'] });

const permissions = exports.permissions = function (action) {
  const streamPermission = object({
    streamId: {
      type: ['string', 'null']
    },
    level: permissionLevel
  }, {
    id: 'streamPermission',
    additionalProperties: false,
    required: ['streamId', 'level']
  });
  if (action === Action.CREATE) {
    // accept additional props for the app authorization process
    streamPermission.properties.defaultName = string({ pattern: '\\w+' /* not empty */ });
    streamPermission.properties.name = string();
  }

  const featurePermission = object({
    feature: string(),
    setting: featureSetting
  }, {
    id: 'featurePermission',
    additionalProperties: false,
    required: ['feature', 'setting']
  });

  return array({
    oneOf: [streamPermission, featurePermission]
  });
};
