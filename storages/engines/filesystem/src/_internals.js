/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files use require('./_internals') instead of host require() calls.
 */
const registry = {};

module.exports = {
  set (name, value) { registry[name] = value; },
  get userLocalDirectory () { return registry.userLocalDirectory; },
  get getLogger () { return registry.getLogger; },
  get config () { return registry.config; }
};
