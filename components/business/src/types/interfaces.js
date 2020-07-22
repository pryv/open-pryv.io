// @flow

// Event type: One of two, simple or complex. If it is simple, then the only 
// 'property' that needs to be given is called 'value'. If not simple, then 
// some fields are required and some optional. Call `forField` with a valid
// field name to get a property type. 
// 
export interface EventType {
  // Returns this types official name ('mass/kg'). 
  // 
  typeName(): string; 
  
  // Returns a type to use for coercion of field named `name`.
  // 
  forField(name: string): PropertyType; 
  
  // Returns a list of required fields in no particular order (a Set).
  // 
  requiredFields(): Array<string>; 
  
  // Returns a list of optional fields in no particular order. 
  // 
  optionalFields(): Array<string>; 
  
  // Returns a list of all fields, optional and mandatory. 
  // 
  fields(): Array<string>; 
  
  // Returns true if this type represents a series of another type. 
  // 
  isSeries(): boolean; 

  // Call the validator with this types schema. 
  // 
  callValidator(
    validator: Validator, 
    content: Content
  ): Promise<Content>;
}

// A single property of a type has a type that can be applied to incoming
// values.  
// 
export interface PropertyType {
  // Coerces the value given into this type. If the input value cannot be
  // coerced, an error will be thrown. 
  // 
  // @throws {InputTypeError} Type after coercion must be valid for this column.
  //
  coerce(value: any): any; 
}

export interface Validator {
  
  // Validate `content` using the JSON schema `schema`. If needed, perform 
  // value coercion to allow the content to pass verification. Coerced value
  // is returned in the promise. 
  //
  validateWithSchema(
    content: Content, schema: any)
    : Promise<Content>;
}

export type Content = Object | string | number | boolean;
