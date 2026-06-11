/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import type { Logger } from '@pryv/boiler';

/**
 * Engine-local internals registry.
 * Populated by the engine entry point's init() from barrel-provided values.
 * All engine files import { _internals } from './_internals.ts'.
 */

export interface S3EngineConfig {
  endpoint?: string | null;
  region?: string;
  bucket: string;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

const registry: Record<string, unknown> = {};

const _internals = {
  set (name: string, value: unknown): void { registry[name] = value; },
  get getLogger (): (name: string) => Logger { return registry.getLogger as (name: string) => Logger; },
  get config (): S3EngineConfig { return registry.config as S3EngineConfig; }
};

export { _internals };
