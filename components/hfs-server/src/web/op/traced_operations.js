/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// A small class that helps clean up the tracing code in the controller code
// above.
//

class TracedOperations {
  ongoingOps;

  context;
  constructor (context) {
    this.ongoingOps = new Map();
    this.context = context;
  }

  /**
   * @param {string} name
   * @param {any} opts
   * @returns {void}
   */
  start (name, opts) {
    const ongoing = this.ongoingOps;
    const ctx = this.context;
    const span = ctx.childSpan(name, opts);
    ongoing.set(name, span);
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  finish (name) {
    const ongoing = this.ongoingOps;
    const span = ongoing.get(name);
    if (span == null) { throw new Error(`Tried to finish span '${name}', but no such ongoing span.`); }
    span.finish();
  }
}
module.exports = TracedOperations;
