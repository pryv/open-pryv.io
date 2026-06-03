/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const path = require('path');
const fs = require('fs');

// An extension is configured by entering a path to a nodejs module into the
// configuration file. It is then loaded by the server and executed in place
// when the extension functionality is needed. See customAuthStepFn for an
// example of an extension.
//

type ExtensionFunction = (...args: unknown[]) => unknown;

class Extension {
  path: string;
  fn: ExtensionFunction;

  constructor (path: string, fn: ExtensionFunction) {
    this.path = path;
    this.fn = fn;
  }
}

// Loads extensions from a `defaultFolder` or from the path indicated in
// the configuration file.
//

class ExtensionLoader {
  defaultFolder: string;

  constructor (defaultFolder: string) {
    this.defaultFolder = defaultFolder;
  }

  // Tries loading the extension identified by name. This will try to load from
  // below `defaultFolder` first, by appending '.js' to `name`.
  //
  load (name: string): Extension | null {
    // not explicitly specified —> try to load from default folder
    const defaultModulePath = path.join(this.defaultFolder, name + '.js');
    // If default location doesn't contain a module, give up.
    if (!fs.existsSync(defaultModulePath)) { return null; }
    // assert: file `defaultModulePath` has existed just before
    return this.loadFrom(defaultModulePath);
  }

  // Tries loading an extension from path. Throws an error if not successful.
  //
  loadFrom (path: string): Extension {
    try {
      const fn = require(path);
      if (typeof fn !== 'function') { throw new Error(`Not a function (${typeof fn})`); }
      return new Extension(path, fn);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot load function module @'${path}': ${message}`);
    }
  }
}
export { ExtensionLoader, Extension };