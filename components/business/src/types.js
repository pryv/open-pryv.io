/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
// @flow

// TypeRepository is the repository for all Pryv event types. It allows access
// to coercion and validation. 

import type { EventType, Content }  from './types/interfaces';

const lodash = require('lodash');
const superagent = require('superagent');
const bluebird = require('bluebird');
const ZSchemaValidator = require('z-schema');

let defaultTypes = require('./types/event-types.default.json');

const errors = require('./types/errors');
const InfluxRowType = require('./types/influx_row_type');
const BasicType = require('./types/basic_type');
const ComplexType = require('./types/complex_type');

const SERIES_PREFIX = 'series:';

// Returns true if the name given refers to a series type. Currently this means
// that the name starts with SERIES_PREFIX. 
// 
function isSeriesType(name: string): boolean {
  return name.startsWith(SERIES_PREFIX);
}

// A validator that can check values against a types JSON Schema. 
// 
class TypeValidator {

  // Validates the given event type against its schema. 
  // 
  validate(type: EventType, content: Content): Promise<Content> {
    return type.callValidator(this, content);
  }

  validateWithSchema(
    content: Content,
    schema: any
  ): Promise<Content> {
    return bluebird.try(() => {
      const validator = new ZSchemaValidator();

      return bluebird
        .fromCallback(
          (cb) => validator.validate(content, schema, cb))
        .then(() => content);
    });
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
  // Returns true if the type given by `name` is known by Pryv. To be known, 
  // it needs to be part of our standard types list that we load on startup
  // (#tryUpdate). 
  // 
  isKnown(name: string): boolean {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      return this.isKnown(leafTypeName);
    }

    return defaultTypes.types.hasOwnProperty(name);
  }

  // Lookup a leaf type by name. A leaf type is either simple ('mass/kg') or 
  // complex ('position/wgs84'). Leaf types are listed in 
  // `event-types.default.json`. 
  // 
  lookupLeafType(name: string): EventType {
    if (!this.isKnown(name)) throw new errors.TypeDoesNotExistError(
      `Type '${name}' does not exist in this Pryv instance.`);

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
  lookup(name: string) {
    if (isSeriesType(name)) {
      const leafTypeName = name.slice(SERIES_PREFIX.length);
      const leafType = this.lookupLeafType(leafTypeName);

      return new InfluxRowType(leafType);
    }

    // assert: Not a series type, must be a leaf type. 
    return this.lookupLeafType(name);
  }

  // Produces a validator instance. 
  //
  validator(): TypeValidator {
    return new TypeValidator();
  }

  // Tries to update the stored type definitions with a file found on the 
  // internet. 
  // 
  tryUpdate(sourceURL: string, apiVersion: string): Promise<void> {
    function unavailableError(err) {
      throw new Error(
        'Could not update event types from ' + sourceURL +
        '\nError: ' + err.message);
    }
    function invalidError(err) {
      throw new Error(
        'Invalid event types schema returned from ' + sourceURL +
        '\nErrors: ' + err.errors);
    }

    const USER_AGENT_PREFIX: string = 'Pryv.io/';

    return superagent
      .get(sourceURL)
      .set('User-Agent', USER_AGENT_PREFIX + apiVersion)
      .catch(unavailableError)
      .then((res) => {
        const validator = new ZSchemaValidator();
        const schema = res.body;

        return bluebird.try(() => {
          if (!validator.validateSchema(schema))
            return invalidError(validator.lastReport);

          // Overwrite defaultTypes with the merged list of type schemata. 
          defaultTypes = lodash.merge(defaultTypes, schema);
        });
      });
  }
}

module.exports = {
  TypeRepository: TypeRepository,
  InfluxRowType: InfluxRowType,
  isSeriesType: isSeriesType,
  errors: errors,
};

export type { InfluxRowType };

