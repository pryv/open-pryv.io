/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const validation = require('./validation');

const {
  ALL_METHODS,
  AUDITED_METHODS,
  WITH_USER_METHODS
} = require('./ApiMethods');

class AuditFilter {
  /**
   * Map with items:
   * method.id => { syslog: true, storage: true } if any of them is audited
   * method.id => false if none is audited
   */
  filter;

  /**
   * Builds the syslogFilter & storageFilter maps used by the filter.
   * Throws an error if the config audit:syslog:filter & audit:storage:filter parameters are invalid
   */
  constructor (
    params = {
      syslogFilter: { methods: { include: ['all'], exclude: [] } },
      storageFilter: { methods: { include: ['all'], exclude: [] } }
    }
  ) {
    const syslogFilterParam = params.syslogFilter;
    const storageFilterParam = params.storageFilter;

    validation.filter(syslogFilterParam);
    validation.filter(storageFilterParam);

    const syslogFilter = {
      methods: buildIncludeMap(
        AUDITED_METHODS,
        syslogFilterParam.methods.include,
        syslogFilterParam.methods.exclude
      )
    };
    const storageFilter = {
      methods: buildIncludeMap(
        WITH_USER_METHODS,
        storageFilterParam.methods.include,
        storageFilterParam.methods.exclude
      )
    };
    const methodsFullFilter = {};
    for (let i = 0; i < ALL_METHODS.length; i++) {
      const m = ALL_METHODS[i];
      let methodFilter = {};
      if (syslogFilter.methods[m]) methodFilter.syslog = true;
      if (storageFilter.methods[m]) methodFilter.storage = true;
      if (Object.keys(methodFilter).length === 0) methodFilter = false;
      methodsFullFilter[m] = methodFilter;
    }

    this.filter = { methods: methodsFullFilter };

    function buildIncludeMap (baseMethods, include, exclude) {
      include = expandAggregates(include);
      exclude = expandAggregates(exclude);

      if (isOnlyIncludeUsed(include, exclude)) {
        // only include
        if (hasAll(include)) {
          return buildMap(baseMethods);
        } else {
          return buildMap(baseMethods.filter(m => include.includes(m)));
        }
      } else if (isOnlyExcludeUsed(include, exclude)) {
        // only exclude
        if (hasAll(exclude)) {
          return {};
        } else {
          return buildMap(baseMethods.filter(m => !exclude.includes(m)));
        }
      } else {
        // both included and excluded
        return buildMap(
          baseMethods
            .filter(m => include.includes(m))
            .filter(m => !exclude.includes(m))
        );
      }
    }

    function isOnlyIncludeUsed (include, exclude) {
      return include.length > 0 && exclude.length === 0;
    }
    function isOnlyExcludeUsed (include, exclude) {
      return exclude.length > 0 && include.length === 0;
    }
    function hasAll (methods) {
      return methods.includes('all');
    }
    function expandAggregates (methods) {
      let expandedMethods = [];
      methods.forEach(m => {
        if (!isAggregate(m)) {
          expandedMethods.push(m);
        } else {
          expandedMethods = expandedMethods.concat(expandAggregate(m));
        }
      });
      return expandedMethods;

      function isAggregate (m) {
        const parts = m.split('.');
        if (parts.length !== 2) return false;
        if (parts[1] !== 'all') return false;
        return true;
      }
      function expandAggregate (aggregateMethod) {
        const resource = aggregateMethod.split('.')[0];
        const expandedMethod = [];
        ALL_METHODS.forEach(m => {
          if (m.startsWith(resource + '.')) expandedMethod.push(m);
        });
        return expandedMethod;
      }
    }
    /**
     * Builds a map with an { i => true } entry for each array element
     * @param {Array<*>} array
     */
    function buildMap (array) {
      const map = {};
      array.forEach(i => {
        map[i] = true;
      });
      return map;
    }
  }

  /**
   * Returns { syslog?: true, storage?: true } if at least one of them is audited
   * otherwise, returns false
   * @param {*} method - the method name. Ex.: events.get
   */
  isAudited (method) {
    return this.filter.methods[method];
  }
}
module.exports = AuditFilter;
