/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const path = require('path');
const fs = require('fs');

// An extension is configured by entering a path to a nodejs module into the
// configuration file. It is then loaded by the server and executed in place
// when the extension functionality is needed. See customAuthStepFn for an
// example of an extension.
//

class Extension {
  path;
  fn;

  constructor (path, fn) {
    this.path = path;
    this.fn = fn;
  }
}

// Loads extensions from a `defaultFolder` or from the path indicated in
// the configuration file.
//

class ExtensionLoader {
  defaultFolder;

  constructor (defaultFolder) {
    this.defaultFolder = defaultFolder;
  }

  // Tries loading the extension identified by name. This will try to load from
  // below `defaultFolder` first, by appending '.js' to `name`.
  //
  /**
   * @param {string} name
   * @returns {Extension}
   */
  load (name) {
    // not explicitly specified —> try to load from default folder
    const defaultModulePath = path.join(this.defaultFolder, name + '.js');
    // If default location doesn't contain a module, give up.
    if (!fs.existsSync(defaultModulePath)) { return null; }
    // assert: file `defaultModulePath` has existed just before
    return this.loadFrom(defaultModulePath);
  }

  // Tries loading an extension from path. Throws an error if not successful.
  //
  /**
   * @param {string} path
   * @returns {Extension}
   */
  loadFrom (path) {
    try {
      const fn = require(path);
      if (typeof fn !== 'function') { throw new Error(`Not a function (${typeof fn})`); }
      return new Extension(path, fn);
    } catch (err) {
      throw new Error(`Cannot load function module @'${path}': ${err.message}`);
    }
  }
}
module.exports = {
  ExtensionLoader,
  Extension
};

/** @typedef {() => void} ExtensionFunction */
