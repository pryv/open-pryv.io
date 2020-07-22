// @flow

import type {EventType, PropertyType, Validator, Content} from './interfaces';

type JSONSchema = {
  type: string, 
  properties?: {}, 
  required?: Array<string>,
}

const assert = require('assert');
const R = require('ramda');

const value_types = require('./value_types');

// A complex type like 'position/wgs84' that has several subfields. 
// 
class ComplexType implements EventType {
  _schema: JSONSchema;
  _outerType: string; 
  
  constructor(outerType: string, schema: JSONSchema) {
    // We only handle this kind of schema
    assert.ok(schema.type === 'object'); 
    
    // Complex types have a list of required fields and a schema for the object
    // properties: 
    assert.ok(schema.required != null, 
      'Type Schema must have a list of required fields.'); 
    assert.ok(schema.properties != null, 
      'Type Schema must have a properties object.');   
    
    this._schema = schema; 
    this._outerType = outerType;
  }
  
  typeName() {
    return this._outerType;
  }
  
  requiredFields() {
    if (this._schema.required == null) 
      throw new Error('Type Schema must have a list of required fields.');
      
    return this._schema.required; 
  }
  optionalFields() {
    const requiredKeys = this.requiredFields();
    const allKeys = this.fields(); 
    
    return R.reject(
      (el) => R.indexOf(el, requiredKeys) >= 0,
      allKeys);
  }
  fields(): Array<string> {
    if (this._schema.properties == null) 
      throw new Error('Type Schema must have a properties object.');
    return Object.keys(this._schema.properties); 
  }
  
  forField(name: string): PropertyType {
    const PATH_SEPARATOR = '.';
    const parts = name.split(PATH_SEPARATOR);
    
    if (parts.length <= 0) 
      throw new Error(`Cannot resolve field, path is empty for '${name}'.`);
    
    const schema = this._schema;
    const outerType = this._outerType;
    
    let properties = schema.properties; 
    while (parts.length > 0) {
      let lookupField = parts.shift();
      
      if (properties == null || typeof properties !== 'object') 
        throw new Error('AF: schema postulates an object here.');
      
      const isSafeForAccess = 
        properties.hasOwnProperty(lookupField) &&
        properties.propertyIsEnumerable(lookupField);
      if (! isSafeForAccess)
        throw new Error(`This type (${outerType}) has no such field (${name} @ ${lookupField})`);
        
      const fieldDescriptor = properties[lookupField];
      const fieldType = fieldDescriptor.type; 
      
      if (fieldType !== 'object') {
        if (parts.length === 0)
          return value_types(fieldType);
        else
          throw new Error(`forField can only retrieve leaf (value) types (${name} @ ${lookupField})`);
      }
        
      // assert: fieldType === 'object'
      const fieldProperties = fieldDescriptor.properties;
      if (fieldProperties == null)
        throw new Error('AF: object type needs to have a properties object.');
        
      // Adjust loop invariant: properties contains the properties in which to 
      // look up the next name. 
      properties = fieldProperties;
    }
    
    // NOTE the above loop should terminate early, returning a value type. If 
    //  it doesn't (and reaches this point), we consider that condition an error. 
    //  (You probably didn't specify a full path to a value type).
    throw new Error('Field names must encode the full path up to a value type.');
  }
  
  isSeries(): false {
    return false; 
  }
  
  callValidator(
    validator: Validator, 
    content: Content
  ): Promise<Content> {
    // NOTE We don't currently perform coercion on leaf types of complex
    // named types. We could though - and this is where we would do it. 
    return validator.validateWithSchema(content, this._schema);
  }
}

module.exports = ComplexType;