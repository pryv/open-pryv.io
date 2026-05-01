/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

const util = require('util');

function log (...args: any[]) {
  for (let i = 0; i < args.length; i++) {
    console.log(util.inspect(args[i], { depth: 12, colors: true }));
  }
}

function stack (start = 0, length = 100) {
  const e = new Error();
  return e.stack.split('\n').filter(l => l.indexOf('node_modules') < 0).slice(start + 1, start + length + 1);
}

function logstack (...args: any[]) {
  log(...args, stack(2, 4));
}

module.exports = {
  logstack,
  log,
  stack
};

(global as any).$$ = logstack;
