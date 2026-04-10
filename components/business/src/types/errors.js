/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
/** Error thrown when the coercion of a value into a type fails.
 */
class InputTypeError extends Error {
}
module.exports.InputTypeError = InputTypeError;
/** Error thrown when you try to `TypeRepository#lookup` a type that doesn't
 * exist in Pryv.
 * @extends Error
 */
class TypeDoesNotExistError extends Error {
}
module.exports.TypeDoesNotExistError = TypeDoesNotExistError;
