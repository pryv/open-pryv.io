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
const Validator = require('z-schema'); const validator = new Validator({
  breakOnFirstError: false
});
/**
 * Validates the object against the JSON-schema definition.
 *
 * @param object
 * @param schema
 * @param callback
 */
exports.validate = validator.validate.bind(validator);
/**
 * Validates the given JSON-schema definition.
 *
 * @param schema
 * @param callback
 */
exports.validateSchema = validator.validateSchema.bind(validator);
/**
 * To use after using validate synchronuously
 */
exports.getLastError = validator.getLastError.bind(validator);
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
//
// Example:
//
//   const object = { a: 'true', 'b': '2343', c: 'foobar' };
//   const types = { a: 'boolean', b: 'number' }
//   tryCoerceStringValues(object, types)
//
//   // object is now
//   {
//     a: true,
//     b: 2343,
//     c: 'foobar'
//   }
//
/**
 * @param {{
 *     [x: string]: unknown;
 *   }} object
 * @param {{
 *     [x: string]: string;
 *   }} settings
 * @returns {void}
 */
function tryCoerceStringValues (object, settings) {
  for (const key of Object.keys(settings)) {
    const type = settings[key];
    const value = object[key];
    // Do not touch null, undefined or things that aren't a string.
    if (value == null) { continue; }
    if (typeof value !== 'string') { continue; }
    // Obtain new value from coercion.
    object[key] = tryCoerceValue(value, type);
  }
  function tryCoerceValue (value, type) {
    // Cannot declare these inside the case, because javascript.
    let newNumber;
    // DEFENSIVE Do not touch null, undefined or things that aren't a string.
    // Yes, we have done this above, this  time we refine types for the flow
    // checker.
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
    // assert: type not in ['boolean', 'number', 'array']
    //  (since we're returning early above)
    // Unknown type, leave the value as it is.
    return value;
  }
}
exports.tryCoerceStringValues = tryCoerceStringValues;
