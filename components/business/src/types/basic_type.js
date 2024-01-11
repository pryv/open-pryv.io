/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
