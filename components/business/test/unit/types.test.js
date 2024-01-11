/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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

// Unit test for type repository

const should = require('should');
const chai = require('chai');
const assert = chai.assert;
const { TypeRepository } = require('../../src/types');
const { getConfig } = require('@pryv/boiler');

let isOpenSource = false;

describe('business.types.TypeRepository', function () {
  before(async () => {
    isOpenSource = (await getConfig()).get('openSource:isActive');
  });
  let repository;
  beforeEach(() => {
    repository = new TypeRepository();
  });
  describe('type list update', function () {
    const sourceURL = 'https://pryv.github.io/event-types/flat.json';
    it('[WMDW] should work (must be called manually)', async function () {
      // NOTE This test uses an internet URL. If internet is down, it will
      // not work. Much like Pryv in general, also because of this function.
      await repository.tryUpdate(sourceURL);
    });
    it('[6VL6] should fail gracefully', async function () {
      try {
        await repository.tryUpdate('bahbahblacksheep');
      } catch (err) {
        should(err.message).match(/Could not update event types/);
      }
    });
  });
  describe('basic types like mass/kg', function () {
    it('[EEWV] should be known', function () {
      should(repository.isKnown('mass/kg')).be.true();
    });
    it('[J0CJ] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('mass/kg');
      should(eventType.requiredFields()).be.eql(['value']);
      should(eventType.optionalFields()).be.eql([]);
      should(eventType.fields()).be.eql(['value']);
      const fieldType = eventType.forField('value');
      should(fieldType.coerce('1234')).be.eql(1234);
      should(fieldType.coerce(1234)).be.eql(1234);
    });
    it('[8WI1] should throw when conversion fails', function () {
      const eventType = repository.lookup('mass/kg');
      const fieldType = eventType.forField('value');
      should.throws(() => fieldType.coerce({}), Error);
    });
    it('[WKCS] should coerce to number during validation', function () {
      const eventType = repository.lookup('mass/kg');
      const validator = repository.validator();
      return eventType
        .callValidator(validator, '123')
        .then((val) => should(val).be.eql(123));
    });
  });
  describe('boolean type boolean/bool', function () {
    it('[E2Y1] should be known', function () {
      should(repository.isKnown('boolean/bool')).be.true();
    });
    it('[8FHU] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('boolean/bool');
      should(eventType.requiredFields()).be.eql(['value']);
      should(eventType.optionalFields()).be.eql([]);
      should(eventType.fields()).be.eql(['value']);
      const fieldType = eventType.forField('value');
      should(fieldType.coerce('true')).be.eql(true);
      should(fieldType.coerce(true)).be.eql(true);
      should(fieldType.coerce('false')).be.eql(false);
      should(fieldType.coerce(false)).be.eql(false);
    });
    it('[8U3U] should coerce to boolean during validation', function () {
      const eventType = repository.lookup('boolean/bool');
      const validator = repository.validator();
      return eventType
        .callValidator(validator, 'true')
        .then((val) => should(val).be.eql(true));
    });
  });
  describe('complex types like position/wgs84', function () {
    it('[05LA] should be known', function () {
      should(repository.isKnown('position/wgs84')).be.true();
    });
    it('[0QZ3] should return a complex type instance', function () {
      const eventType = repository.lookup('position/wgs84');
      should(eventType.requiredFields()).be.eql(['latitude', 'longitude']);
      should(eventType.optionalFields()).be.eql([
        'altitude',
        'horizontalAccuracy',
        'verticalAccuracy',
        'speed',
        'bearing'
      ]);
      should(eventType.fields()).be.eql([
        'latitude',
        'longitude',
        'altitude',
        'horizontalAccuracy',
        'verticalAccuracy',
        'speed',
        'bearing'
      ]);
    });
  });
  describe('complex types on several levels like message/facebook', () => {
    let type;
    beforeEach(() => {
      type = repository.lookup('message/facebook');
    });
    it('[D0GT] should return the correct value type for all fields', () => {
      assert.strictEqual(type.forField('id').coerce('123'), '123');
    });
    it('[3BC9] should return the correct value type for optional fields', () => {
      assert.strictEqual(type.forField('source').coerce('123'), '123');
    });
    it('[IVPF] should resolve nested fields', () => {
      const inner = type.forField('from.name');
      assert.strictEqual(inner.coerce('123'), '123');
    });
    it('[5PMM] does NOT handle requiredFields fully yet: only surface requirements are returned', () => {
      assert.deepEqual(type.requiredFields(), ['id', 'message']);
    });
  });
  describe('placeholder types like picture/attached', () => {
    it('[78HI] should be known', function () {
      assert.isTrue(repository.isKnown('picture/attached'));
    });
    it('[85BQ] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('picture/attached');
      assert.deepEqual(eventType.requiredFields(), ['value']);
      assert.deepEqual(eventType.optionalFields(), []);
      assert.deepEqual(eventType.fields(), ['value']);
      // The type 'null' ignores content submitted to it and stores a 'null'
      // in the content field.
      const fieldType = eventType.forField('value');
      assert.deepEqual(fieldType.coerce('some value'), null);
      assert.deepEqual(fieldType.coerce(132136), null);
    });
  });
  describe('series types like series:mass/kg', function () {
    before(function (done) {
      if (isOpenSource) { this.skip(); }
      done();
    });
    it('[SQNQ] should be known', function () {
      should(repository.isKnown('series:position/wgs84')).be.true();
      should(repository.isKnown('series:mass/kg')).be.true();
    });
    it('[IR3B] should inform about fields correctly', function () {
      const eventType = repository.lookup('series:mass/kg');
      should(eventType.requiredFields()).be.eql(['deltaTime', 'value']);
      should(eventType.optionalFields()).be.eql([]);
      should(eventType.fields()).be.eql(['deltaTime', 'value']);
    });
  });
  describe('validate()', function () {
    it("[VK9J] should accept an array as a known type's event content", async () => {
      await repository.tryUpdate('file://test/fixtures/event-types.json');
      const event = { content: [1, 2, 3], type: 'pryv-test/array-num' };
      repository.validate(event);
    });
  });
});
describe('business.types.TypeValidator', function () {
  let repository;
  beforeEach(() => {
    repository = new TypeRepository();
  });
  it('[AE3Q] should be produced via a type repository', function () {
    const validator = repository.validator();
    should(validator.constructor.name).be.eql('TypeValidator');
  });
  it('[JT1F] should validate simple types', function () {
    const validator = repository.validator();
    const schema = { type: 'number' };
    return validator.validateWithSchema(1234, schema);
  });
  it('[QIVH] should validate complex types', function () {
    const validator = repository.validator();
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'string' }
      }
    };
    const value = {
      a: 1234,
      b: 'string'
    };
    return validator.validateWithSchema(value, schema);
  });
});
