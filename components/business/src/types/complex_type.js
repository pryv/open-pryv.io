/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const assert = require('assert');
const _ = require('lodash');
const valueTypes = require('./value_types');
// A complex type like 'position/wgs84' that has several subfields.
//

class ComplexType {
  _schema;

  _outerType;
  constructor (outerType, schema) {
    // We only handle this kind of schema
    assert.ok(schema.type === 'object');
    // Complex types have a list of required fields and a schema for the object
    // properties:
    assert.ok(schema.required != null, 'Type Schema must have a list of required fields.');
    assert.ok(schema.properties != null, 'Type Schema must have a properties object.');
    this._schema = schema;
    this._outerType = outerType;
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
    if (this._schema.required == null) { throw new Error('Type Schema must have a list of required fields.'); }
    return this._schema.required;
  }

  /**
   * @returns {any}
   */
  optionalFields () {
    const requiredKeys = this.requiredFields();
    const allKeys = this.fields();
    return _.reject(allKeys, (el) => requiredKeys.indexOf(el) >= 0);
  }

  /**
   * @returns {string[]}
   */
  fields () {
    if (this._schema.properties == null) { throw new Error('Type Schema must have a properties object.'); }
    return Object.keys(this._schema.properties);
  }

  /**
   * @param {string} name
   * @returns {any}
   */
  forField (name) {
    const PATH_SEPARATOR = '.';
    const parts = name.split(PATH_SEPARATOR);
    if (parts.length <= 0) { throw new Error(`Cannot resolve field, path is empty for '${name}'.`); }
    const schema = this._schema;
    const outerType = this._outerType;
    let properties = schema.properties;
    while (parts.length > 0) {
      const lookupField = parts.shift();
      if (properties == null || typeof properties !== 'object') { throw new Error('AF: schema postulates an object here.'); }
      const isSafeForAccess = properties[lookupField] != null && {}.propertyIsEnumerable.call(properties, lookupField);
      if (!isSafeForAccess) { throw new Error(`This type (${outerType}) has no such field (${name} @ ${lookupField})`); }
      const fieldDescriptor = properties[lookupField];
      const fieldType = fieldDescriptor.type;
      if (fieldType !== 'object') {
        if (parts.length === 0) { return valueTypes(fieldType); } else { throw new Error(`forField can only retrieve leaf (value) types (${name} @ ${lookupField})`); }
      }
      // assert: fieldType === 'object'
      const fieldProperties = fieldDescriptor.properties;
      if (fieldProperties == null) { throw new Error('AF: object type needs to have a properties object.'); }
      // Adjust loop invariant: properties contains the properties in which to
      // look up the next name.
      properties = fieldProperties;
    }
    // NOTE the above loop should terminate early, returning a value type. If
    //  it doesn't (and reaches this point), we consider that condition an error.
    //  (You probably didn't specify a full path to a value type).
    throw new Error('Field names must encode the full path up to a value type.');
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
    // NOTE We don't currently perform coercion on leaf types of complex
    // named types. We could though - and this is where we would do it.
    return validator.validateWithSchema(content, this._schema);
  }
}
module.exports = ComplexType;

/**
 * @typedef {{
 *   type: string;
 *   properties?: {};
 *   required?: Array<string>;
 * }} JSONSchema
 */
