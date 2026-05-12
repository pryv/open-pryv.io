/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('assert');
const valueTypes = require('./value_types.ts').default;
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
  constructor (outerType: any, schema: any) {
    this._schema = schema;
    this._outerType = outerType;
    this._innerType = valueTypes(schema.type);
  }

  typeName () {
    return this._outerType;
  }

  requiredFields () {
    return ['value'];
  }

  optionalFields () {
    return [];
  }

  fields () {
    return this.requiredFields();
  }

  forField (name: any) {
    // NOTE BasicType only represents types that are not composed of multiple
    // fields. So the name MUST be 'value' here.
    assert.ok(name === 'value');
    return this._innerType;
  }

  isSeries () {
    return false;
  }

  async callValidator (validator: any, content: any) {
    // Perform coercion into target type first. Then verify using the
    // validator. This saves us one roundtrip.
    const value = this._innerType.coerce(content);
    return validator.validateWithSchema(value, this._schema);
  }
}
export default BasicType;
export { BasicType };
type JSONSchema = {
  type: string;
};
