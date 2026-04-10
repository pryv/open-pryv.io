/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
// Unit test for type repository

require('test-helpers/src/api-server-tests-config');
const assert = require('node:assert');
const { TypeRepository } = require('../../src/types');

describe('[TYPR] business.types.TypeRepository', function () {
  let repository;
  beforeEach(() => {
    repository = new TypeRepository();
  });
  describe('[TY01] type list update', function () {
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
        assert.match(err.message, /Could not update event types/);
      }
    });
  });
  describe('[TY02] basic types like mass/kg', function () {
    it('[EEWV] should be known', function () {
      assert.strictEqual(repository.isKnown('mass/kg'), true);
    });
    it('[J0CJ] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('mass/kg');
      assert.deepStrictEqual(eventType.requiredFields(), ['value']);
      assert.deepStrictEqual(eventType.optionalFields(), []);
      assert.deepStrictEqual(eventType.fields(), ['value']);
      const fieldType = eventType.forField('value');
      assert.strictEqual(fieldType.coerce('1234'), 1234);
      assert.strictEqual(fieldType.coerce(1234), 1234);
    });
    it('[8WI1] should throw when conversion fails', function () {
      const eventType = repository.lookup('mass/kg');
      const fieldType = eventType.forField('value');
      assert.throws(() => fieldType.coerce({}), Error);
    });
    it('[WKCS] should coerce to number during validation', function () {
      const eventType = repository.lookup('mass/kg');
      const validator = repository.validator();
      return eventType
        .callValidator(validator, '123')
        .then((val) => assert.strictEqual(val, 123));
    });
  });
  describe('[TY03] boolean type boolean/bool', function () {
    it('[E2Y1] should be known', function () {
      assert.strictEqual(repository.isKnown('boolean/bool'), true);
    });
    it('[8FHU] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('boolean/bool');
      assert.deepStrictEqual(eventType.requiredFields(), ['value']);
      assert.deepStrictEqual(eventType.optionalFields(), []);
      assert.deepStrictEqual(eventType.fields(), ['value']);
      const fieldType = eventType.forField('value');
      assert.strictEqual(fieldType.coerce('true'), true);
      assert.strictEqual(fieldType.coerce(true), true);
      assert.strictEqual(fieldType.coerce('false'), false);
      assert.strictEqual(fieldType.coerce(false), false);
    });
    it('[8U3U] should coerce to boolean during validation', function () {
      const eventType = repository.lookup('boolean/bool');
      const validator = repository.validator();
      return eventType
        .callValidator(validator, 'true')
        .then((val) => assert.strictEqual(val, true));
    });
  });
  describe('[TY04] complex types like position/wgs84', function () {
    it('[05LA] should be known', function () {
      assert.strictEqual(repository.isKnown('position/wgs84'), true);
    });
    it('[0QZ3] should return a complex type instance', function () {
      const eventType = repository.lookup('position/wgs84');
      assert.deepStrictEqual(eventType.requiredFields(), ['latitude', 'longitude']);
      assert.deepStrictEqual(eventType.optionalFields(), [
        'altitude',
        'horizontalAccuracy',
        'verticalAccuracy',
        'speed',
        'bearing'
      ]);
      assert.deepStrictEqual(eventType.fields(), [
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
  describe('[TY05] complex types on several levels like message/facebook', () => {
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
      assert.deepStrictEqual(type.requiredFields(), ['id', 'message']);
    });
  });
  describe('[TY06] placeholder types like picture/attached', () => {
    it('[78HI] should be known', function () {
      assert.strictEqual(repository.isKnown('picture/attached'), true);
    });
    it('[85BQ] should return a type instance allowing conversion', function () {
      const eventType = repository.lookup('picture/attached');
      assert.deepStrictEqual(eventType.requiredFields(), ['value']);
      assert.deepStrictEqual(eventType.optionalFields(), []);
      assert.deepStrictEqual(eventType.fields(), ['value']);
      // The type 'null' ignores content submitted to it and stores a 'null'
      // in the content field.
      const fieldType = eventType.forField('value');
      assert.strictEqual(fieldType.coerce('some value'), null);
      assert.strictEqual(fieldType.coerce(132136), null);
    });
  });
  describe('[TY07] series types like series:mass/kg', function () {
    it('[SQNQ] should be known', function () {
      assert.strictEqual(repository.isKnown('series:position/wgs84'), true);
      assert.strictEqual(repository.isKnown('series:mass/kg'), true);
    });
    it('[IR3B] should inform about fields correctly', function () {
      const eventType = repository.lookup('series:mass/kg');
      assert.deepStrictEqual(eventType.requiredFields(), ['deltaTime', 'value']);
      assert.deepStrictEqual(eventType.optionalFields(), []);
      assert.deepStrictEqual(eventType.fields(), ['deltaTime', 'value']);
    });
  });
  describe('[TY08] validate()', function () {
    it("[VK9J] should accept an array as a known type's event content", async () => {
      await repository.tryUpdate('file://test/fixtures/event-types.json');
      const event = { content: [1, 2, 3], type: 'pryv-test/array-num' };
      repository.validate(event);
    });
  });
});
describe('[TYPV] business.types.TypeValidator', function () {
  let repository;
  beforeEach(() => {
    repository = new TypeRepository();
  });
  it('[AE3Q] should be produced via a type repository', function () {
    const validator = repository.validator();
    assert.strictEqual(validator.constructor.name, 'TypeValidator');
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
