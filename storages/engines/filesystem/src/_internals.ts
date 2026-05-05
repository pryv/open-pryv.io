/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files import { _internals } from './_internals'.
 */

const registry: Record<string, any> = {};

const _internals = {
  set (name: string, value: any): void { registry[name] = value; },
  get userLocalDirectory (): any { return registry.userLocalDirectory; },
  get getLogger (): (name: string) => any { return registry.getLogger; },
  get config (): any { return registry.config; }
};

export { _internals };
