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

type JSONSchema = { type: string };
type InnerType = { coerce: (value: unknown) => unknown };
type ValidatorLike = { validateWithSchema: (value: unknown, schema: JSONSchema) => Promise<unknown> | unknown };

class BasicType {
  _schema: JSONSchema;

  _outerType: string;

  _innerType: InnerType;
  /**
   * Construct a basic type.
   *
   * @param outerType {string} Type name such as 'mass/kg'
   * @param schema {JSONSchema} Schema to verify content against.
   */
  constructor (outerType: string, schema: JSONSchema) {
    this._schema = schema;
    this._outerType = outerType;
    this._innerType = valueTypes(schema.type);
  }

  typeName (): string {
    return this._outerType;
  }

  requiredFields (): string[] {
    return ['value'];
  }

  optionalFields (): string[] {
    return [];
  }

  fields (): string[] {
    return this.requiredFields();
  }

  forField (name: string): InnerType {
    // NOTE BasicType only represents types that are not composed of multiple
    // fields. So the name MUST be 'value' here.
    assert.ok(name === 'value');
    return this._innerType;
  }

  isSeries (): boolean {
    return false;
  }

  async callValidator (validator: ValidatorLike, content: unknown): Promise<unknown> {
    // Perform coercion into target type first. Then verify using the
    // validator. This saves us one roundtrip.
    const value = this._innerType.coerce(content);
    return validator.validateWithSchema(value, this._schema);
  }
}
export default BasicType;
export { BasicType };
