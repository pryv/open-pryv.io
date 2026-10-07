/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

type Warning = { name: string; args: unknown[] };
type LoggerProto = { warn: (...args: unknown[]) => void; _name: () => string };

/**
 * Record every boiler `warn` call made in this process (all loggers share one
 * prototype) until `restore()` is called. The calls still reach the log.
 */
function captureWarnings (): { warnings: Warning[]; restore: () => void } {
  const { getLogger } = require('@pryv/boiler');
  const proto = Object.getPrototypeOf(getLogger('capture-warnings')) as LoggerProto;
  const original = proto.warn;
  const warnings: Warning[] = [];
  proto.warn = function (this: LoggerProto, ...args: unknown[]) {
    warnings.push({ name: this._name(), args });
    return original.apply(this, args);
  };
  return { warnings, restore () { proto.warn = original; } };
}

export { captureWarnings };
