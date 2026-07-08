/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import util from 'util';

function log (...args: unknown[]) {
  for (let i = 0; i < args.length; i++) {
    console.log(util.inspect(args[i], { depth: 12, colors: true }));
  }
}

function stack (start = 0, length = 100) {
  const e = new Error();
  return (e.stack ?? '').split('\n').filter(l => l.indexOf('node_modules') < 0).slice(start + 1, start + length + 1);
}

function logstack (...args: unknown[]) {
  log(...args, stack(2, 4));
}

export { logstack, log, stack };

// dev-time global $$ shortcut. Intentional escape hatch for ad-hoc debugging.
declare global {
  // eslint-disable-next-line no-var
  var $$: typeof logstack | undefined;
}
global.$$ = logstack;
