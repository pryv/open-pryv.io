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
/**
 * Helpers for defining schemas.
 */

const _ = require('lodash');

const USERNAME_MIN_LENGTH = 5;
const USERNAME_MAX_LENGTH = 60;
const USERNAME_REGEXP_STR = '^[a-z0-9]' +
                            '[a-z0-9-]{' + (USERNAME_MIN_LENGTH - 2) + ',' + (USERNAME_MAX_LENGTH - 2) + '}' +
                            '[a-z0-9]$';

exports.USERNAME_MIN_LENGTH = USERNAME_MIN_LENGTH;
exports.USERNAME_MAX_LENGTH = USERNAME_MAX_LENGTH;
exports.USERNAME_REGEXP_STR = USERNAME_REGEXP_STR;

/**
 * Gets the full core type URI for the given type name and action (read, create, etc.)
 *
 * @param {String} name
 * @param {String} action
 */
exports.getTypeURI = function (name, action) {
  return 'pryv.core.' + name + (action ? '-' + action : '');
};

/**
 * Returns an 'object' schema definition with the given properties definition.
 *
 * @param {Object} propertiesDef
 * @param {Object} options Extra properties to merge into the returned object definition
 */
exports.object = function (propertiesDef, options) {
  return _.extend(getBaseSchema('object', options), { properties: propertiesDef });
};

/**
 * Returns an 'array' schema definition with the given items definition.
 *
 * @param {Object} itemsDef
 * @param {Object} options Extra properties to merge into the returned array definition
 */
exports.array = function (itemsDef, options) {
  return _.extend(getBaseSchema('array', options), { items: itemsDef });
};

/**
 * Returns a 'string' schema definition.
 *
 * @param {Object} options Extra properties to merge into the returned object definition
 */
exports.string = getBaseSchema.bind(null, 'string');

exports.null = getBaseSchema.bind(null, 'null');

/// NOTE (similarly as in service-register):
///   We do very little verification on the outer form of the addresses here
///   for two reasons :
///
///   a) Our clients might want to store a different kind of address in this
///     field, one that doesn't look like an email address.
///   b) Validating emails is hard _and_ useless:
///     https://hackernoon.com/the-100-correct-way-to-validate-email-addresses-7c4818f24643
///
exports.email = getBaseSchema('string', { maxLength: 300 });

exports.language = getBaseSchema('string', { maxLength: 5, minLength: 1 });

/**
 * Returns a 'number' schema definition.
 *
 * @param {Object} options Extra properties to merge into the returned object definition
 */
exports.number = getBaseSchema.bind(null, 'number');

/**
 * Returns a 'boolean' schema definition.
 *
 * @param {Object} options Extra properties to merge into the returned object definition
 */
exports.boolean = getBaseSchema.bind(null, 'boolean');

/**
 * Global username rule
 */

exports.username = getBaseSchema('string', { pattern: USERNAME_REGEXP_STR });

exports.getBaseSchema = getBaseSchema;

function getBaseSchema (type, options) {
  const result = {
    type: [type]
  };

  if (options != null) {
    if (options.nullable === true) {
      result.type.push('null');
    }
    // We omit 'nullable' since we handled this particular option just above
    const opt = _.omit(options, 'nullable');
    _.extend(result, opt);
  }
  return result;
}

/**
 * Adds `created`, `createdBy`, `modified`, `modifiedBy` property definitions to the given schema.
 *
 * @param {Object} schema
 */
exports.addTrackingProperties = function (schema) {
  schema.properties.created = { type: 'number' };
  schema.properties.createdBy = { type: 'string' };
  schema.properties.modified = { type: 'number' };
  schema.properties.modifiedBy = { type: 'string' };
};
