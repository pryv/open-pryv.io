/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
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
 * 
 */
// @flow

import type {PropertyType} from './interfaces';

// Type of an actual value. 
export interface ValueType extends PropertyType { } 

const R = require('ramda');

const errors = require('./errors');

// A value of type 'number'.
// 
class NumberType implements ValueType {
  coerce(value: any): number {
    switch (R.type(value)) {
      case 'String': 
        return this.coerceString(value);
      case 'Number':
        return value; 
    }
    
    throw new errors.InputTypeError(`Unknown outer type (${R.type(value)}).`);
  }
  
  coerceString(str: string) {
    const reNumber = /^\d+(\.\d+)?$/;
    if (! reNumber.test(str)) {
      throw new errors.InputTypeError(`Doesn't look like a valid number: '${str}'.`); 
    }
    
    return Number.parseFloat(str);
  }
}

class StringType implements ValueType {
  coerce(value: any): string {
    return '' + value; 
  }
}

class NullType implements ValueType {
  coerce(/* value: any */): null {
    return null; 
  }
}

function produceInner(type: string): ValueType {
  switch (type) {
    case 'number': return new NumberType(); 
    case 'string': return new StringType(); 
    case 'null': return new NullType(); 
  }
  
  throw new Error(`Unknown inner type: '${type}'.`);
}

module.exports = produceInner;
