/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Backed by the in-house jsonValidator (ajv-draft-04 under the hood,
// z-schema-shaped errors on the surface). See
// components/utils/src/jsonValidator.js. business/src/types.js and the
// test-side validators still use z-schema directly — those will follow in
// a subsequent step once this site stabilises in production.
const createValidator = require('utils').jsonValidator;
const validator = createValidator({ breakOnFirstError: false });

/**
 * Validates the object against the JSON-schema definition.
 *
 * @param object
 * @param schema
 * @param callback
 */
exports.validate = validator.validate;
/**
 * Validates the given JSON-schema definition.
 *
 * @param schema
 * @param callback
 */
exports.validateSchema = validator.validateSchema;
/**
 * To use after using validate synchronuously
 */
exports.getLastError = validator.getLastError;

// Tries to type-coerce properties of the given `object` according to the
// settings. Iterates in shallow manner over the keys of `settings`, coercing
// the values of the same key in `object` to the type indicated by the value
// from `settings`.
//
// Properties in `object` that have no corresponding type in `settings` are left
// alone. If a value cannot be coerced to the target type, it is left alone.
// Values that are not a string in `object` will not be touched.
//
// Allowed types are 'boolean', 'number' and 'array'.
function tryCoerceStringValues (object, settings) {
  for (const key of Object.keys(settings)) {
    const type = settings[key];
    const value = object[key];
    if (value == null) { continue; }
    if (typeof value !== 'string') { continue; }
    object[key] = tryCoerceValue(value, type);
  }
  function tryCoerceValue (value, type) {
    let newNumber;
    if (value == null) { return value; }
    if (typeof value !== 'string') { return value; }
    switch (type) {
      case 'boolean':
        if (value.toLowerCase() === 'true') { return true; }
        if (value.toLowerCase() === 'false') { return false; }
        return value;
      case 'number':
        newNumber = Number(value);
        if (isNaN(newNumber)) { return value; }
        return newNumber;
      case 'array':
        return [value];
    }
    return value;
  }
}
exports.tryCoerceStringValues = tryCoerceStringValues;
