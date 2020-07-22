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
