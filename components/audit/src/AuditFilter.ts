/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const validation = require('./validation.ts');

const {
  ALL_METHODS,
  AUDITED_METHODS,
  WITH_USER_METHODS
} = require('./ApiMethods.ts');

class AuditFilter {
  /**
   * Map with items:
   * method.id => { syslog: true, storage: true } if any of them is audited
   * method.id => false if none is audited
   */
  filter: any;

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
    const methodsFullFilter: any = {};
    for (let i = 0; i < ALL_METHODS.length; i++) {
      const m = ALL_METHODS[i];
      let methodFilter: any = {};
      if (syslogFilter.methods[m]) methodFilter.syslog = true;
      if (storageFilter.methods[m]) methodFilter.storage = true;
      if (Object.keys(methodFilter).length === 0) methodFilter = false;
      methodsFullFilter[m] = methodFilter;
    }

    this.filter = { methods: methodsFullFilter };

    function buildIncludeMap (baseMethods: any, include: any, exclude: any) {
      include = expandAggregates(include);
      exclude = expandAggregates(exclude);

      if (isOnlyIncludeUsed(include, exclude)) {
        // only include
        if (hasAll(include)) {
          return buildMap(baseMethods);
        } else {
          return buildMap(baseMethods.filter((m: any) => include.includes(m)));
        }
      } else if (isOnlyExcludeUsed(include, exclude)) {
        // only exclude
        if (hasAll(exclude)) {
          return {};
        } else {
          return buildMap(baseMethods.filter((m: any) => !exclude.includes(m)));
        }
      } else {
        // both included and excluded
        return buildMap(
          baseMethods
            .filter((m: any) => include.includes(m))
            .filter((m: any) => !exclude.includes(m))
        );
      }
    }

    function isOnlyIncludeUsed (include: any, exclude: any) {
      return include.length > 0 && exclude.length === 0;
    }
    function isOnlyExcludeUsed (include: any, exclude: any) {
      return exclude.length > 0 && include.length === 0;
    }
    function hasAll (methods: any) {
      return methods.includes('all');
    }
    function expandAggregates (methods: any) {
      let expandedMethods: any[] = [];
      methods.forEach((m: any) => {
        if (!isAggregate(m)) {
          expandedMethods.push(m);
        } else {
          expandedMethods = expandedMethods.concat(expandAggregate(m));
        }
      });
      return expandedMethods;

      function isAggregate (m: any) {
        const parts = m.split('.');
        if (parts.length !== 2) return false;
        if (parts[1] !== 'all') return false;
        return true;
      }
      function expandAggregate (aggregateMethod: any) {
        const resource = aggregateMethod.split('.')[0];
        const expandedMethod: any[] = [];
        ALL_METHODS.forEach((m: any) => {
          if (m.startsWith(resource + '.')) expandedMethod.push(m);
        });
        return expandedMethod;
      }
    }
    /**
     * Builds a map with an { i => true } entry for each array element
     */
    function buildMap (array: any) {
      const map: any = {};
      array.forEach((i: any) => {
        map[i] = true;
      });
      return map;
    }
  }

  /**
   * Returns { syslog?: true, storage?: true } if at least one of them is audited
   * otherwise, returns false
   * @param method - the method name. Ex.: events.get
   */
  isAudited (method: any) {
    return this.filter.methods[method];
  }
}
export default AuditFilter;
export { AuditFilter };
