/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const APIError = require('errors').APIError;
const errors = require('errors').factory;
const Result = require('./Result.ts').default;
const { getConfigSync, getLogger } = require('@pryv/boiler');

const logger = getLogger('api');

type AuditModule = { default?: { validApiCall (ctx: unknown, result: unknown): Promise<void> }; validApiCall? (ctx: unknown, result: unknown): Promise<void> } & { validApiCall (ctx: unknown, result: unknown): Promise<void> };
type MethodContext = { methodId: string; tracing: { startSpan (n: string, tags?: Record<string, unknown>, parent?: string): void; finishSpan (n: string): void; setError (n: string, err: unknown): void }; username?: string; [k: string]: unknown };

let audit: AuditModule, throwIfMethodIsNotDeclared: (id: string) => void, isAuditActive: boolean;

// When storing full events.get request instead of streaming it, the maximum
// array size before returning an error.
const RESULT_TO_OBJECT_MAX_ARRAY_SIZE = 100000;

// The string used as wildcard for method id filters. Must be 1-character long.
const WILDCARD = '*';

// Result is imported as a value (require().default); MethodContext
// was a JSDoc-only namespaced reference. `any` for both at the type level:
// the registry holds heterogeneous middleware whose param types vary per
// method chain (contravariance makes a common signature impossible).
/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous middleware registry (see above) */
type ApiCallback = (err?: Error | null, result?: any | null) => unknown;
type ApiFunction = string | ((context: any, params: any, result: any, next: ApiCallback) => unknown);
/* eslint-enable @typescript-eslint/no-explicit-any */
type Filter = {
  idFilter: string;
  fns: Array<ApiFunction>;
};

/**
 * Maps each API method's implementation as a chain of functions (akin to
 * middleware) to its id. Handles method calls coming from HTTP or web sockets.
 */
class API {
  /**
   * Each key is a method id, each value is the array of functions implementing it.
   */
  map;

  filters: Filter[];

  constructor () {
    this.map = new Map();
    this.filters = [];
    const config = getConfigSync();
    isAuditActive = config.get('audit:active') as boolean;
    if (isAuditActive) {
      audit = require('audit').default;
      throwIfMethodIsNotDeclared =
      require('audit/src/ApiMethods.ts').throwIfMethodIsNotDeclared;
    }
  }

  // -------------------------------------------------------------- registration

  /**
   * Registers the given function(s) or other registered method(s) with the
   * given method id. The given function(s) will be appended, in order, to the
   * list of previously registered functions. A list of functions registered
   * under a method id can be inserted by using its method id as argument.
   *
   * The method id can end with a '*' wildcard, in which case the function(s)
   * will apply to all method ids that match.
   *
   * Example use:
   *
   * - `api.register('resources.*', commonFn)`
   * - `api.register('resources.get', fn1, fn2, ...)`
   * - `api.register('events.start', fn1, 'events.create', ...)`
   *
   */
  register (id: string, ...fns: ApiFunction[]) {
    if (isAuditActive) { throwIfMethodIsNotDeclared(id); }

    const methodMap = this.map;
    const wildcardAt = id.indexOf(WILDCARD);

    // Is this a full method id, without wildcards?
    if (wildcardAt === -1) {
      // Do we need to initialize this method id?
      // if (! methodMap.has(id)) {
      const methodFns: ApiFunction[] = [];
      methodMap.set(id, methodFns);

      // prepend with matching filters registered earlier, if any
      this.applyMatchingFilters(id);
      // }

      // assert: methodMap.has(id)
      const idMethodFns = methodMap.get(id);
      if (idMethodFns == null) { throw new Error('AF: methodMap must contain id at this point.'); }

      // append registered functions
      for (const fn of fns) {
        // Syntax allows strings in the function list, which means that the
        // implementation from that method needs to be copied over.
        //
        if (typeof fn !== 'function') {
          // If this is not a function, it MUST be a string.

          if (typeof fn !== 'string') { throw new Error('AF: backrefs must be in string form.'); }

          const backrefId = fn;
          if (!methodMap.has(backrefId)) { throw new Error('Trying to use undefined API method as shortcut.'); }

          const backrefMethods = methodMap.get(backrefId);
          if (backrefMethods == null) { throw new Error('AF: must have method list here'); }

          idMethodFns.push(...backrefMethods);
        } else {
          idMethodFns.push(fn);
        }
      }
    } else {
      // assert: wildcardAt >= 0
      if (wildcardAt !== id.length - 1) { throw new Error('Wildcard is only allowed as suffix.'); }

      const filter = {
        idFilter: id,
        fns
      };
      this.applyToMatchingIds(filter);

      // save filter for applying to methods registered later
      this.filters.push(filter);
    }
  }

  /**
   * Searches for filters that match `id` and applies them.
   *
   */
  applyMatchingFilters (id: string) {
    const filters = this.filters;

    for (const filter of filters) {
      this.applyIfMatches(filter, id);
    }
  }

  /**
   * Searches for existing methods that are matched by this filter.
   *
   */
  applyToMatchingIds (filter: Filter) {
    const methodMap = this.map;

    for (const id of methodMap.keys()) {
      this.applyIfMatches(filter, id);
    }
  }

  /**
   * If `filter` matches/applies to `id`, appends the filter functions to the
   * list of functions of `id`.
   *
   */
  applyIfMatches (filter: Filter, id: string) {
    if (matches(filter.idFilter, id)) {
      const methodMap = this.map;
      const methodList = methodMap.get(id);
      if (methodList == null) { throw new Error('AF: method list for this id must not be null.'); }
      methodList.push(...filter.fns);
    }
  }

  // ------------------------------------------------------------ handling calls

  call (context: MethodContext, params: unknown, callback: ApiCallback) {
    const methodId = context.methodId;
    const methodMap = this.map;
    const methodList = methodMap.get(methodId);

    if (methodList == null) { return callback(errors.invalidMethod(methodId), null); }

    const tracing = context.tracing;
    const tags = context.username != null ? {} : { username: context.username };
    const apiSpanName = 'api:' + methodId;
    tracing.startSpan(apiSpanName, tags);

    const result = new Result({
      arrayLimit: RESULT_TO_OBJECT_MAX_ARRAY_SIZE,
      tracing
    });

    let unanmedCount = 0;
    let i = 0;
    function runNextMethod (err?: unknown) {
      if (err != null) return finalize(err);
      if (i >= methodList.length) return finalize(null);
      const currentFn = methodList[i++];
      // -- Tracing by Function
      const fnName = 'fn:' + (currentFn.name || methodId + '.unamed' + unanmedCount++);
      tracing.startSpan(fnName, {}, apiSpanName);
      // The chain advances exactly once per function. A rejected promise is a
      // second way to fail, so both routes funnel through this guard: without
      // it, a function that calls next() and then rejects would advance twice.
      let advanced = false;
      const nextCloseSpan = function (err?: unknown) {
        if (advanced) return;
        advanced = true;
        if (err != null) tracing.setError(fnName, err);
        tracing.finishSpan(fnName);
        if (err != null) result.closeTracing(); // close open span for result that was left open
        runNextMethod(err);
      };
      try {
        const returned = currentFn(context, params, result, nextCloseSpan);
        // An async function that throws AFTER an await rejects rather than
        // throwing synchronously, so the catch below never sees it. Unobserved,
        // next() is never called and the request hangs forever with no response.
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(returned).then(null, function (err: unknown) {
            if (advanced) {
              // The chain already moved on; surface the late failure rather than
              // dropping it, but do not advance a second time.
              logger.warn('API method ' + methodId + ' / ' + fnName +
                ' rejected after the chain advanced', err);
              return;
            }
            nextCloseSpan(err);
          });
        }
      } catch (err) {
        nextCloseSpan(err);
      }
    }
    function finalize (err: unknown) {
      if (err != null) {
        tracing.setError(apiSpanName, err);
        tracing.finishSpan(apiSpanName);
        return callback(err instanceof APIError ? err : errors.unexpectedError(err));
      }
      if (isAuditActive) {
        result.onEnd(async function () {
          await audit.validApiCall(context, result);
        });
      }
      tracing.finishSpan(apiSpanName);
      callback(null, result);
    }
    runNextMethod();
  }

  // ----------------------------------------------------------- call statistics

  getMethodKeys () {
    const methodMap = this.map;
    return Array.from(methodMap.keys());
  }
}

export default API;
export { API };
function matches (idFilter: string, id: string): boolean {
  // i.e. check whether the given id starts with the given filter without the
  // wildcard
  const filterWithoutWildcard = idFilter.slice(0, -1);
  return id.startsWith(filterWithoutWildcard);
}
