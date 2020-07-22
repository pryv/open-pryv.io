// @flow

const async = require('async');
const APIError = require('components/errors').APIError;
const errors = require('components/errors').factory;
const Result = require('./Result');
const _ = require('lodash');

// When storing full events.get request instead of streaming it, the maximum
// array size before returning an error.
const RESULT_TO_OBJECT_MAX_ARRAY_SIZE = 100000;

// The string used as wildcard for method id filters. Must be 1-character long.
const WILDCARD = '*';

type Filter = {
  idFilter: string, 
  fns: Array<ApiFunction>, 
}
type ApiFunction = string | 
  (context: MethodContext, params: Object, result: Result, next: ApiCallback) => mixed; 

export type ApiCallback = 
  (err: ?Error, result: ?Result) => mixed;

import type { MethodContext } from 'components/model';

// Maps each API method's implementation as a chain of functions (akin to
// middleware) to its id. Handles method calls coming from HTTP or web sockets.
// 
class API {
  // Each key is a method id, each value is the array of functions implementing
  // it. 
  map: Map<string, Array<ApiFunction>>;
  
  filters: Array<Filter>;
  
  constructor() {
    this.map = new Map(); 
    this.filters = []; 
  }
  
  // -------------------------------------------------------------- registration

  // Registers the given function(s) or other registered method(s) with the
  // given method id. The given function(s) will be appended, in order, to the
  // list of previously registered functions. A list of functions registered
  // under a method id can be inserted by using its method id as argument.
  // 
  // The method id can end with a '*' wildcard, in which case the function(s)
  // will apply to all method ids that match.
  // 
  // Example use:
  // 
  // - `api.register('resources.*', commonFn)`
  // - `api.register('resources.get', fn1, fn2, ...)`
  // - `api.register('events.start', fn1, 'events.create', ...)`
  // 
  register(id: string, ...fns: Array<ApiFunction>) {
    const methodMap = this.map; 
    const wildcardAt = id.indexOf(WILDCARD);
    
    // Is this a full method id, without wildcards?
    if (wildcardAt === -1) {
      // Do we need to initialize this method id?
      if (! methodMap.has(id)) {
        const methodFns = []; 
        methodMap.set(id, methodFns);
        
        // prepend with matching filters registered earlier, if any
        this.applyMatchingFilters(id);
      }
      
      // assert: methodMap.has(id)
      const idMethodFns = methodMap.get(id);
      if (idMethodFns == null) 
        throw new Error('AF: methodMap must contain id at this point.');
      
      // append registered functions
      for (const fn of fns) {
        // Syntax allows strings in the function list, which means that the 
        // implementation from that method needs to be copied over. 
        // 
        if (! _.isFunction(fn)) {
          // If this is not a function, it MUST be a string. 
          
          if (typeof fn !== 'string')
            throw new Error('AF: backrefs must be in string form.');
            
          const backrefId = fn; 
          if (! methodMap.has(backrefId))
            throw new Error('Trying to use undefined API method as shortcut.');
            
          const backrefMethods = methodMap.get(backrefId);
          if (backrefMethods == null)
            throw new Error('AF: must have method list here');
            
          idMethodFns.push(...backrefMethods);
        }
        else {
          // assert: _.isFunction(fn)
          idMethodFns.push(fn);
        }
      }
    } 
    else {
      // assert: wildcardAt >= 0
      if (wildcardAt !== id.length - 1) 
        throw new Error('Wildcard is only allowed as suffix.');
      
      const filter = {
        idFilter: id,
        fns: fns
      };
      this.applyToMatchingIds(filter);
      
      // save filter for applying to methods registered later
      this.filters.push(filter);
    }
  }
  
  // Searches for filters that match `id` and applies them. 
  // 
  applyMatchingFilters(id: string) {
    const filters = this.filters; 
    
    for (const filter of filters) {
      this.applyIfMatches(filter, id);
    }
  }

  // Searches for existing methods that are matched by this filter. 
  // 
  applyToMatchingIds(filter: Filter) {
    const methodMap = this.map; 
    
    for (const id of methodMap.keys()) {
      this.applyIfMatches(filter, id);
    }
  }
  
  // If `filter` matches/applies to `id`, appends the filter functions to the
  // list of functions of `id`. 
  // 
  applyIfMatches(filter: Filter, id: string) {
    if (matches(filter.idFilter, id)) {
      const methodMap = this.map; 
      const methodList = methodMap.get(id);
      
      if (methodList == null)
        throw new Error('AF: method list for this id must not be null.');
      
      methodList.push(...filter.fns);
    }
  }

  // ------------------------------------------------------------ handling calls
  
  call(id: string, context: MethodContext, params: mixed, callback: ApiCallback) {
    const methodMap = this.map; 
    const methodList = methodMap.get(id);
    
    if (methodList == null) 
      return callback(errors.invalidMethod(id), null);
    
    // Instrument the context with the method that was called. 
    if (context != null)
      context.calledMethodId = id; 
      
    const result = new Result({arrayLimit: RESULT_TO_OBJECT_MAX_ARRAY_SIZE});
    async.forEachSeries(methodList, function (currentFn, next) {
      try {
        currentFn(context, params, result, next);
      } catch (err) {
        next(err);
      }
    }, function (err) {
      if (err != null) {
        return callback(err instanceof APIError ? 
          err : 
          errors.unexpectedError(err));
      }
      
      callback(null, result);
    });
  }

  // ----------------------------------------------------------- call statistics 
  
  getMethodKeys(): Array<string> {
    const methodMap = this.map; 
    
    return Array.from(methodMap.keys()); 
  }
}

module.exports = API;

function matches(idFilter: string, id: string) {
  // i.e. check whether the given id starts with the given filter without the
  // wildcard
  const filterWithoutWildcard = idFilter.slice(0, -1);
  return id.startsWith(filterWithoutWildcard);
}


