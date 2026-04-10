/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const bluebird = require('bluebird');
const assert = require('assert');
const valueTypes = require('./value_types');
// A basic type like 'mass/kg'. In high frequency data, this must be stored
// using the column name 'value'.
//

class BasicType {
  _schema;

  _outerType;

  _innerType;
  /**
   * Construct a basic type.
   *
   * @param outerType {string} Type name such as 'mass/kg'
   * @param schema {JSONSchema} Schema to verify content against.
   */
  constructor (outerType, schema) {
    this._schema = schema;
    this._outerType = outerType;
    this._innerType = valueTypes(schema.type);
  }

  /**
   * @returns {string}
   */
  typeName () {
    return this._outerType;
  }

  /**
   * @returns {string[]}
   */
  requiredFields () {
    return ['value'];
  }

  /**
   * @returns {any[]}
   */
  optionalFields () {
    return [];
  }

  /**
   * @returns {string[]}
   */
  fields () {
    return this.requiredFields();
  }

  /**
   * @param {string} name
   * @returns {any}
   */
  forField (name) {
    // NOTE BasicType only represents types that are not composed of multiple
    // fields. So the name MUST be 'value' here.
    assert.ok(name === 'value');
    return this._innerType;
  }

  /**
   * @returns {false}
   */
  isSeries () {
    return false;
  }

  /**
   * @param {Validator} validator
   * @param {Content} content
   * @returns {Promise<any>}
   */
  callValidator (validator, content) {
    return bluebird.try(() => {
      // Perform coercion into target type first. Then verify using the
      // validator. This saves us one roundtrip.
      const value = this._innerType.coerce(content);
      return validator.validateWithSchema(value, this._schema);
    });
  }
}
module.exports = BasicType;

/**
 * @typedef {{
 *   type: string;
 * }} JSONSchema
 */
