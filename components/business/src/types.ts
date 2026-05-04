/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

const fs = require('fs');
const { deepMerge, fromCallback, jsonValidator } = require('utils');
let defaultTypes = require('./types/event-types.default.json');
const errors = require('./types/errors');
const SeriesRowType = require('./types/series_row_type');
const BasicType = require('./types/basic_type');
const ComplexType = require('./types/complex_type');
const SERIES_PREFIX = 'series:';
// Returns true if the name given refers to a series type. Currently this means
// that the name starts with SERIES_PREFIX.
//
/**
 * @param {string} name
 * @returns {boolean}
 */
function isSeriesType (name) {
  return name.startsWith(SERIES_PREFIX);
}
// A validator that can check values against a types JSON Schema.
//

class TypeValidator {
  // Validates the given event type against its schema.
  //
  /**
   * @param {EventType} type
   * @param {Content} content
   * @returns {Promise<any>}
   */
  validate (type, content) {
    return type.callValidator(this, content);
  }

  /**
   * @param {Content} content
   * @param {any} schema
   * @returns {Promise<any>}
   */
  async validateWithSchema (content, schema) {
    const validator = jsonValidator();
    await new Promise<void>((resolve, reject) => {
      validator.validate(content, schema, (err) => err ? reject(err) : resolve());
    });
    return content;
  }
}
// A repository of types that Pryv knows about. Currently, this is seeded from
// 'types/event-types.default.json' in this component. Also, once the server
// is running, a list is downloaded from the internet (pryv.com) that will
// extend the built in types.
//
// There are several different kind of types:
//
//  * 'leaf' types, which form the types you would use in vanilla events, such
//    as 'mass/kg' or 'picture/attached'.
//  * 'series' types, which describe a sequence of individual data points, each
//    data point being of the same leaf type.
//
// Leaf types are further divided into 'complex' types and 'basic' types.
// Complex types are objects with attributes, each attribute being itself either
// of a complex or a basic type. E.g. 'message/email'.
//
// Basic types are 'number', 'string' and others. These are the types of a
// single element of data.
//
// Synopsis:
//
//    const repo = new TypeRepository();
//    await repo.tryUpdate(someUrl);
//
//    const type = repo.lookup('mass/kg');
//    const seriesType = repo.lookup('series:mass/kg');
//

class TypeRepository {
  _validator;
  constructor () {
    this._validator = jsonValidator();
  }

  /**
   * Simple version of validate - to be used
   *
   * In api-server, use only:
   * - isSeriesType()
   * - isKnown()
   * - validate()
   *
   * The old path: lookup(), then validator() are too heavy
   * @param {Event} event
   * @returns {Promise<any>}
   */
  async validate (event) {
    const content = event.content != null ? event.content : null;
    const schema = defaultTypes.types[event.type];
    if (schema == null) { throw new Error(`Event type validation was used on the unknown type "${event.type}".`); }
    return fromCallback((cb) => this._validator.validate(content, schema, cb))
      .then(() => content);
  }

  // Returns true if the type given by `name` is known by Pryv. To be known,
  // it needs to be part of our standard types list that we load on startup
  // (#tryUpdate).
  //
  /**
   * @param {string} name
   * @returns {boolean}
   */
  isKnown (name) {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      return this.isKnown(leafTypeName);
    }
    return defaultTypes.types[name] != null;
  }

  // Lookup a leaf type by name. A leaf type is either simple ('mass/kg') or
  // complex ('position/wgs84'). Leaf types are listed in
  // `event-types.default.json`.
  //
  /**
   * @param {string} name
   * @returns {any}
   */
  lookupLeafType (name) {
    if (!this.isKnown(name)) { throw new errors.TypeDoesNotExistError(`Type '${name}' does not exist in this Pryv instance.`); }
    const typeSchema = defaultTypes.types[name];
    if (typeSchema.type === 'object') {
      return new ComplexType(name, typeSchema);
    }
    return new BasicType(name, typeSchema);
  }

  // Lookup a Pryv Event Type by name. To check if a type exists, use
  // `#isKnown`. Pryv types are either leaf types ('mass/kg', 'position/wgs84')
  // or series types ('series:LEAFTYPE').
  //
  // @throw {TypeDoesNotExistError} when name doesn't refer to a built in type.
  //
  /**
   * @param {string} name
   * @returns {any}
   */
  lookup (name) {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      const leafType = this.lookupLeafType(leafTypeName);
      return new SeriesRowType(leafType);
    }
    // assert: Not a series type, must be a leaf type.
    return this.lookupLeafType(name);
  }

  // Produces a validator instance.
  //
  /**
   * @returns {TypeValidator}
   */
  validator () {
    return new TypeValidator();
  }

  // Tries to update the stored type definitions with a file found on the
  // internet.
  //
  /**
   * @param {string} sourceURL
   * @param {string} apiVersion
   * @returns {Promise<void>}
   */
  async tryUpdate (sourceURL, apiVersion) {
    function unavailableError (err) {
      throw new Error('Could not update event types from ' +
                sourceURL +
                '\nError: ' +
                err.message);
    }
    function invalidError (err) {
      throw new Error('Invalid event types schema returned from ' +
                sourceURL +
                '\nErrors: ' +
                err.errors);
    }
    const FILE_PROTOCOL = 'file://';
    function isFileUrl (url) {
      return url.startsWith(FILE_PROTOCOL);
    }
    function removeFileProtocol (url) {
      return url.substring(FILE_PROTOCOL.length);
    }
    let eventTypesDefinition;
    try {
      if (isFileUrl(sourceURL)) {
        // used for tests
        const filePath = removeFileProtocol(sourceURL);
        eventTypesDefinition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } else {
        const USER_AGENT_PREFIX = 'Pryv.io/';
        const res = await fetch(sourceURL, {
          headers: { 'User-Agent': USER_AGENT_PREFIX + apiVersion }
        });
        if (!res.ok) {
          throw new Error(`Event types fetch failed: HTTP ${res.status} ${res.statusText}`);
        }
        eventTypesDefinition = await res.json();
      }
    } catch (err) {
      unavailableError(err);
    }
    const validator = this._validator;
    if (!validator.validateSchema(eventTypesDefinition)) { return invalidError(validator.lastReport); }
    // Overwrite defaultTypes with the merged list of type schemata.
    defaultTypes = deepMerge(defaultTypes, eventTypesDefinition);
  }
}
module.exports = {
  TypeRepository,
  SeriesRowType,
  isSeriesType,
  errors
};
