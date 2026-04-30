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

import type {} from 'node:fs';

const registry: Record<string, any> = {};

module.exports = {
  set (name: string, value: any): void { registry[name] = value; },
  get userLocalDirectory (): any { return registry.userLocalDirectory; },
  get getLogger (): (name: string) => any { return registry.getLogger; },
  get config (): any { return registry.config; }
};
