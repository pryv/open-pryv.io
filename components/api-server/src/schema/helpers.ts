/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/**
 * Helpers for defining schemas.
 */

const USERNAME_MIN_LENGTH = 5;
const USERNAME_MAX_LENGTH = 60;
const USERNAME_REGEXP_STR = '^[a-z0-9]' +
                            '[a-z0-9-]{' + (USERNAME_MIN_LENGTH - 2) + ',' + (USERNAME_MAX_LENGTH - 2) + '}' +
                            '[a-z0-9]$';

export { USERNAME_MIN_LENGTH };
export { USERNAME_MAX_LENGTH };
export { USERNAME_REGEXP_STR };

/**
 * Gets the full core type URI for the given type name and action (read, create, etc.)
 *
 */
export const getTypeURI = function (name, action) {
  return 'pryv.core.' + name + (action ? '-' + action : '');
};

/**
 * Returns an 'object' schema definition with the given properties definition.
 *
 * @param options Extra properties to merge into the returned object definition
 */
export const object = function (propertiesDef, options) {
  return Object.assign(getBaseSchema('object', options), { properties: propertiesDef });
};

/**
 * Returns an 'array' schema definition with the given items definition.
 *
 * @param options Extra properties to merge into the returned array definition
 */
export const array = function (itemsDef, options) {
  return Object.assign(getBaseSchema('array', options), { items: itemsDef });
};

/**
 * Returns a 'string' schema definition.
 *
 * @param options Extra properties to merge into the returned object definition
 */
export const string = getBaseSchema.bind(null, 'string');

const _nullSchema = getBaseSchema.bind(null, 'null');
export { _nullSchema as null };

/// NOTE (similarly as in service-register):
///   We do very little verification on the outer form of the addresses here
///   for two reasons :
///
///   a) Our clients might want to store a different kind of address in this
///     field, one that doesn't look like an email address.
///   b) Validating emails is hard _and_ useless:
///     https://hackernoon.com/the-100-correct-way-to-validate-email-addresses-7c4818f24643
///
export const email = getBaseSchema('string', { maxLength: 300 });

export const language = getBaseSchema('string', { maxLength: 5, minLength: 1 });

/**
 * Returns a 'number' schema definition.
 *
 * @param options Extra properties to merge into the returned object definition
 */
export const number = getBaseSchema.bind(null, 'number');

/**
 * Returns a 'boolean' schema definition.
 *
 * @param options Extra properties to merge into the returned object definition
 */
export const boolean = getBaseSchema.bind(null, 'boolean');

/**
 * Global username rule
 */

export const username = getBaseSchema('string', { pattern: USERNAME_REGEXP_STR });

export { getBaseSchema };

function getBaseSchema (type, options) {
  const result = {
    type: [type]
  };

  if (options != null) {
    if (options.nullable === true) {
      result.type.push('null');
    }
    // We omit 'nullable' since we handled this particular option just above
    const { nullable: _omit, ...opt } = options;
    Object.assign(result, opt);
  }
  return result;
}

/**
 * Adds `created`, `createdBy`, `modified`, `modifiedBy` property definitions to the given schema.
 *
 */
export const addTrackingProperties = function (schema) {
  schema.properties.created = { type: 'number' };
  schema.properties.createdBy = { type: 'string' };
  schema.properties.modified = { type: 'number' };
  schema.properties.modifiedBy = { type: 'string' };
};
