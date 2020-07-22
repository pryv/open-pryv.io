// @flow

var Validator = require('z-schema'),
    validator = new Validator();

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
function tryCoerceStringValues(
  object: { [string]: mixed }, 
  settings: { [string]: string }
) {
  for (const key of Object.keys(settings)) {
    const type = settings[key];
    const value = object[key];
    
    // Do not touch null, undefined or things that aren't a string.
    if (value == null) continue; 
    if (typeof value !== 'string') continue; 

    // Obtain new value from coercion. 
    object[key] = tryCoerceValue(value, type);
  }
  
  function tryCoerceValue(value: mixed, type: string): mixed {
    // Cannot declare these inside the case, because javascript. 
    let newNumber;
    
    // DEFENSIVE Do not touch null, undefined or things that aren't a string.
    // Yes, we have done this above, this  time we refine types for the flow
    // checker. 
    if (value == null) return value; 
    if (typeof value !== 'string') return value; 
  
    switch (type) {
      case 'boolean': 
        if (value.toLowerCase() == 'true') return true; 
        if (value.toLowerCase() == 'false') return false; 
  
        return value; 
  
      case 'number':
        newNumber = Number(value);
  
        if (isNaN(newNumber)) return value; 
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
