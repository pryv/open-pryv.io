/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files import { _internals } from './_internals.ts'.
 */

type Logger = { debug?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
type UserLocalDirectoryLike = { ensureUserDirectory: (userId: string) => Promise<string> };
type ConfigLike = { get: (key: string) => unknown };

const registry: Record<string, unknown> = {};

const _internals = {
  set (name: string, value: unknown): void { registry[name] = value; },
  get userLocalDirectory (): UserLocalDirectoryLike { return registry.userLocalDirectory as UserLocalDirectoryLike; },
  get getLogger (): (name: string) => Logger { return registry.getLogger as (name: string) => Logger; },
  get config (): ConfigLike { return registry.config as ConfigLike; }
};

export { _internals };
