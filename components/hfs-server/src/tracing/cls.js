/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
const logger = require('@pryv/boiler').getLogger('cls');
const { createNamespace } = require('cls-hooked');
const CLS_TRACE_SPAN = 'rootSpan';
const session = createNamespace('tracing/cls');
// Continuation Local Storage, built on top of cls-hooked, which implements the
// basic mechanism. This is just used to type the use and to render the actual
// technique opaque to our code.
//

class Cls {
  /**
   * @param {Span} span
   * @returns {void}
   */
  setRootSpan (span) {
    if (session.active == null) { return; }
    let roots = session.get(CLS_TRACE_SPAN);
    if (roots == null) {
      logger.debug('No existing roots array, installing...');
      roots = [];
      session.set(CLS_TRACE_SPAN, roots);
    }
    logger.debug('push', span.operationName);
    roots.push(span);
    hookSpanFinish(roots, span);
  }

  /**
   * @returns {any}
   */
  getRootSpan () {
    if (session.active == null) { return null; }
    const roots = session.get(CLS_TRACE_SPAN);
    if (roots == null || roots.length <= 0) { return null; }
    // assert: roots is Array<Span>.
    const lastSpan = roots[roots.length - 1];
    logger.debug('current root is', lastSpan && lastSpan.operationName);
    return lastSpan;
  }

  /**
   * @param {express$Request} req
   * @param {express$Response} res
   * @param {express$NextFunction} next
   * @returns {any}
   */
  startExpressContext (req, res, next) {
    return session.runAndReturn(() => {
      session.bindEmitter(req);
      session.bindEmitter(res);
      return next();
    });
  }
}
// Monkey patchs `span`#finish with poppingFinish.
//
/**
 * @param {Array<Span>} roots
 * @param {Span} span
 * @returns {void}
 */
function hookSpanFinish (roots, span) {
  const oldMethod = span.finish;
  span.finish = poppingFinish;

  // Method that we monkey patch in lieu of Span#finish. Just making sure that
  // the _first_ finish called on a span also removes it from the stack of roots.
  //
  function poppingFinish () {
    // At this point, roots will either a) not contain span anymore (we have
    // removed it already) or b) it will contain `span` at some index i.
    const i = roots.indexOf(span);
    if (i >= 0) {
      // b)
      logger.debug('Closing span, removing from root.', span.operationName, i, roots.map((el) => el.operationName));
      // i is some index into roots; all the spans after i were created after
      // it and should be `span`s children. Since we know that `span` is
      // completed, remove it and all the children from the array; the next
      // span created will have the span earlier than `span` as parent.
      const removed = roots.splice(i, roots.length);
      const leftOpen = removed.slice(1);
      for (const removedSpan of leftOpen.reverse()) {
        // NOTE This will terminate, since we've already removed the spans from
        //  the roots array, thus provoking case a) above.
        removedSpan.finish();
      }
    }
    logger.debug('oldMethod', span.operationName);
    oldMethod.call(span);
  }
}
module.exports = new Cls();
