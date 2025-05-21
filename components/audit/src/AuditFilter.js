/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
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
