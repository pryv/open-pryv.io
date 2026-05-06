/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';

/** Error thrown when the coercion of a value into a type fails.
 */
class InputTypeError extends Error {
}
/** Error thrown when you try to `TypeRepository#lookup` a type that doesn't
 * exist in Pryv.
 * @extends Error
 */
class TypeDoesNotExistError extends Error {
}
export { InputTypeError, TypeDoesNotExistError };
