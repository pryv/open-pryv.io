/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// Shared structural types for the CMC plugin modules.

type LogFn = (...args: unknown[]) => void;
// All methods optional: callers use `logger?.warn?.(...)` style throughout.
type CmcLogger = { debug?: LogFn; warn?: LogFn; info?: LogFn; error?: LogFn };

export type { LogFn, CmcLogger };
