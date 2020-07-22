// @flow

/** Error thrown when the coercion of a value into a type fails. 
 */
class InputTypeError extends Error { }
module.exports.InputTypeError = InputTypeError; 

/** Error thrown when you try to `TypeRepository#lookup` a type that doesn't
 * exist in Pryv. 
 */
class TypeDoesNotExistError extends Error { } 
module.exports.TypeDoesNotExistError = TypeDoesNotExistError; 