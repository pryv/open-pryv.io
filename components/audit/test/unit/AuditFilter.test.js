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
/* global validation, assert, apiMethods, AuditFilter */

describe('AuditFilter', () => {
  function buildFilter (include = ['all'], exclude = []) {
    return {
      methods: {
        include,
        exclude
      }
    };
  }
  describe('validation', () => {
    it('[3QJJ] must accept an existing method', () => {
      const method = 'events.get';
      assert.isTrue(apiMethods.AUDITED_METHODS_MAP[method]);
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.isNull(e); }
    });
    it('[YIDZ] must accept a valid method aggregator', () => {
      const method = 'events.all';
      const parts = method.split('.');
      assert.isAbove(apiMethods.AUDITED_METHODS.filter(m => m.startsWith(parts[0])).length, 0);
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.isNull(e); }
    });
    it('[74RS] must accept "all"', () => {
      const method = 'all';
      try {
        validation.filter(buildFilter([method]));
      } catch (e) { assert.isNull(e); }
    });
    it('[P6WW] must throw an error when providing a malformed filter', () => {
      try { validation.filter({ notMethods: { include: [], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
      try { validation.filter({ methods: { somethign: [], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
      try { validation.filter({ methods: { include: [12], exclude: [] } }); assert.fail('must throw'); } catch (e) {}
    });
    it('[GFCE] must throw an error when providing an unexisting method', () => {
      try {
        validation.filter(buildFilter(['doesntexist']));
        assert.fail('must refuse an unexisting method');
      } catch (e) { assert.exists(e); }
    });
    it('[GY6E] must throw an error when providing an invalid aggregate method', () => {
      try {
        validation.filter(buildFilter(['something.all']));
        assert.fail('must throw an error');
      } catch (e) { assert.exists(e); }
    });
  });

  describe('initialization', () => {
    it('[H8RB] must expand aggregate methods', () => {
      const filter = new AuditFilter({ syslogFilter: buildFilter(), storageFilter: buildFilter(['events.all']) });
      apiMethods.AUDITED_METHODS.forEach(m => {
        const auditChannels = filter.isAudited(m);
        assert.isTrue(auditChannels.syslog);
        if (m.startsWith('events.')) assert.isTrue(auditChannels.storage);
      });
    });
  });
});
