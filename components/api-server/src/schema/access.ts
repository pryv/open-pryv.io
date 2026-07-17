/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * JSON Schema specification for accesses.
 */

const Action = require('./Action.ts');
const helpers = require('./helpers.ts');
const object = helpers.object;
const array = helpers.array;
const string = helpers.string;

type AccessSchemaShape = {
  id: string;
  anyOf: unknown[];
  alterableProperties?: string[];
};

function accessSchema (action: string): AccessSchemaShape {
  if (action === Action.STORE) { action = Action.READ; } // read items === stored items

  const base: Record<string, unknown> & { properties: Record<string, unknown> } = object({
    token: string({ minLength: 1 }),
    apiEndpoint: string({ minLength: 1 }),
    name: string({ minLength: 1 }),
    permissions: permissions(action),
    lastUsed: helpers.number(),
    // Routable de-identifying alias substituted for the username in this
    // access's apiEndpoint and access-info. Read-only (set via randomAlias).
    alias: string({ minLength: 1, nullable: true }),
    integrity: string({ nullable: true })
  }, {
    additionalProperties: false
  });
  helpers.addTrackingProperties(base);

  // explicitly forbid 'id' on create
  if (action !== Action.CREATE) {
    base.properties.id = string();
  }

  // explicitly forbid 'calls' on anything but store (purely internal)
  if (action === Action.STORE) {
    base.properties.calls = object({});
  }

  const personal = structuredClone(base);
  Object.assign(personal.properties, {
    type: string({ enum: ['personal'] })
  });

  const app = structuredClone(base);
  Object.assign(app.properties, {
    type: string({ enum: ['app'] }),
    deviceName: string()
  });

  const shared = structuredClone(base);
  Object.assign(shared.properties, {
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

      // Opt-in: mint a platform-unique routable alias for this access so its
      // apiEndpoint hides the real username (de-identification). Input-only;
      // the resolved value is returned in the `alias` property.
      app.properties.randomAlias = helpers.boolean();
      shared.properties.randomAlias = helpers.boolean();

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

  const res: AccessSchemaShape = {
    id: helpers.getTypeURI('access', action),
    anyOf: [personal, app, shared]
  };

  // whitelist for properties that can be updated
  if (action === Action.UPDATE) {
    res.alterableProperties = [
      'name', 'deviceName', 'permissions', 'expireAfter', 'expires', 'clientData'];
  }

  return res;
}

// Enum values come from the permission-lexicon single point so schema
// validation can never drift from the business-layer semantics.
const { PERMISSION_LEVEL_VALUES, FEATURE_SETTING_VALUES } =
  require('business/src/accesses/permissionSet.ts');
const permissionLevel = string({ enum: [...PERMISSION_LEVEL_VALUES] });
const featureSetting = string({ enum: [...FEATURE_SETTING_VALUES] });

function permissions (action: string): unknown {
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
  if (action === Action.CREATE || action === Action.UPDATE) {
    // accept additional props for the app authorization process.
    // UPDATE matches CREATE since 2026-05-26 (was strict-only) so a caller
    // can pipe `checkApp.checkedPermissions` (which carries these fields
    // because checkApp uses Action.CREATE) straight into accesses.update
    // without stripping them client-side. The server-side cleanup mirror
    // in accesses.update's middleware chain drops them before persisting
    // (same as the existing create cleanup) so wire-format symmetry does
    // not change what gets stored.
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
}

// Callable schema with helper functions attached as properties.
// Consumers can either call the default export directly or reach for the
// helpers via either `require('./access.ts').permissions(action)` or
// `require('./access.ts').default.permissions(action)`.
type AccessSchema = typeof accessSchema & {
  permissions: typeof permissions,
  permissionLevel: typeof permissionLevel,
  featureSetting: typeof featureSetting
};
const accessSchemaWithProps: AccessSchema = Object.assign(accessSchema, {
  permissions,
  permissionLevel,
  featureSetting
});

export default accessSchemaWithProps;
export { permissions, permissionLevel, featureSetting };
