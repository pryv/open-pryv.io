// @flow

import type {EventType, PropertyType, Validator, Content} from './interfaces';
import type {ValueType} from './value_types';

type JSONSchema = {
  type: string, 
}

const bluebird = require('bluebird');
const assert = require('assert');

const value_types = require('./value_types');

// A basic type like 'mass/kg'. In high frequency data, this must be stored
// using the column name 'value'.
// 
class BasicType implements EventType {
  _schema: JSONSchema; 
  _outerType: string; 
  _innerType: ValueType; 
  
  /** 
   * Construct a basic type. 
   * 
   * @param outerType {string} Type name such as 'mass/kg'
   * @param schema {JSONSchema} Schema to verify content against. 
   */
  constructor(outerType: string, schema: JSONSchema) {
    this._schema = schema; 
    
    this._outerType = outerType; 
    this._innerType = value_types(schema.type);
  }
  
  typeName(): string {
    return this._outerType; 
  }
  
  requiredFields() {
    return ['value'];
  }
  optionalFields() {
    return [];
  }
  fields() {
    return this.requiredFields();
  }
  
  forField(name: string): PropertyType {
    // NOTE BasicType only represents types that are not composed of multiple 
    // fields. So the name MUST be 'value' here. 
    assert.ok(name === 'value');
    
    return this._innerType;
  }
  
  isSeries(): false {
    return false; 
  }
  
  callValidator(
    validator: Validator, 
    content: Content
  ): Promise<Content> {
    return bluebird.try(() => {
      // Perform coercion into target type first. Then verify using the 
      // validator. This saves us one roundtrip. 
      const value = this._innerType.coerce(content);
      
      return validator.validateWithSchema(value, this._schema);
    });
  }
}

module.exports = BasicType;
