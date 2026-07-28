/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Telemetry choke-point tests.
 *
 * These are the filter proof for the emitted surface: they do not check
 * that we *wrote down* an allow-list, they ask the component that enforces
 * it what it decided, for both the accepted and the refused case. A test
 * that only asserted refusals could pass while the emitter dropped
 * everything, so each block also pins something that must get through.
 *
 *   [OBS1] allowed metric + attributes are accepted
 *   [OBS2] an unknown attribute key is refused
 *   [OBS3] an unregistered method id is refused
 *   [OBS4] an invalid status class is refused
 *   [OBS5] an unregistered error code is refused
 *   [OBS6] fuzz: arbitrary injected keys/values never pass validation
 *   [OBSA] error message is never emitted, class + frames are
 *   [OBSB] absolute paths are rewritten repository-relative
 *   [OBSC] non-Error thrown values degrade safely
 *   [OBSD] recorded calls aggregate into counters + histogram
 *   [OBSE] a refused datapoint increments telemetry.dropped with a reason
 *   [OBSF] 4xx is counted but not reported; 5xx is reported
 *   [OBSG] the OTLP payload carries only allow-listed keys
 *   [OBSH] a failing backend never throws into the caller
 */

const assert = require('node:assert');

const schema = require('business/src/observability/schema.ts');
const emitter = require('business/src/observability/emitter.ts');
const observability = require('business/src/observability/index.ts');
const { sanitizeError } = require('business/src/observability/sanitizeError.ts');
const { classify, allErrorCodes } = require('business/src/observability/errorRegistry.ts');
const { buildMetricsPayload, buildLogsPayload } = require('business/src/observability/otlp.ts');

const METHOD_IDS = ['events.get', 'events.create', 'auth.login'];

/** Collect what the emitter would have sent, instead of sending it. */
function captureSink () {
  const sent = [];
  return {
    sent,
    send: async function (url, body) { sent.push({ url, body }); }
  };
}

function initEmitter (sink) {
  observability.init({
    endpoint: 'https://otlp.example.test',
    headers: { 'api-key': 'secret-value' },
    serviceName: 'open-pryv.io (test)',
    serviceVersion: '2.0.0',
    instanceId: 'core-test.example.com',
    worker: '1',
    methodIds: METHOD_IDS,
    flushIntervalMs: 3600000, // never fires during a test; flush() is explicit
    send: sink.send
  });
}

describe('[OBS] observability choke point', function () {
  afterEach(function () {
    observability._reset();
  });

  describe('[OBS-V] schema validation', function () {
    beforeEach(function () {
      schema.registerMethodIds(METHOD_IDS);
      schema.registerErrorCodes(allErrorCodes());
    });

    it('[OBS1] accepts an allow-listed metric with allow-listed attributes', function () {
      const result = schema.validateMetric(schema.METRICS.CALLS,
        { 'method.id': 'events.get', 'status.class': '2xx' }, 1);
      assert.strictEqual(result.ok, true, 'a legitimate datapoint must pass');
    });

    it('[OBS2] refuses an attribute key that is not on the list', function () {
      const result = schema.validateMetric(schema.METRICS.CALLS,
        { 'method.id': 'events.get', username: 'alice' }, 1);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, schema.DROP_REASONS.UNKNOWN_ATTRIBUTE);
    });

    it('[OBS3] refuses a method id that is not in the registry', function () {
      const result = schema.validateMetric(schema.METRICS.CALLS,
        { 'method.id': 'alice@example.com', 'status.class': '2xx' }, 1);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, schema.DROP_REASONS.UNKNOWN_METHOD_ID);
    });

    it('[OBS4] refuses a status class outside the enum', function () {
      const result = schema.validateMetric(schema.METRICS.CALLS,
        { 'method.id': 'events.get', 'status.class': '/users/alice' }, 1);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, schema.DROP_REASONS.INVALID_STATUS_CLASS);
    });

    it('[OBS5] refuses an error code outside the registry', function () {
      const result = schema.validateMetric(schema.METRICS.ERRORS,
        { 'method.id': 'events.get', 'error.code': 'ENOENT /var/pryv/users/alice' }, 1);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, schema.DROP_REASONS.UNKNOWN_ERROR_CODE);
    });

    it('[OBS6] fuzz: injected keys and values never validate', function () {
      const keys = ['url', 'request.uri', 'user', 'username', 'email', 'token',
        'authorization', 'password', 'peer.hostname', 'message', 'error.message',
        'streamId', 'eventId', 'body', 'query'];
      const values = ['alice', 'https://core.example.com/alice/events?auth=tok',
        '/var/pryv/users/alice/attachments/x.pdf', 'Bearer abc123',
        'alice@example.com', "'; DROP TABLE events; --"];
      for (const key of keys) {
        for (const value of values) {
          const attrs = { 'method.id': 'events.get' };
          attrs[key] = value;
          const result = schema.validateMetric(schema.METRICS.CALLS, attrs, 1);
          assert.strictEqual(result.ok, false,
            'key "' + key + '" must never validate (value "' + value + '")');
        }
      }
      // And the legitimate shape still passes, so this cannot pass by
      // refusing everything.
      assert.strictEqual(
        schema.validateMetric(schema.METRICS.CALLS,
          { 'method.id': 'events.get', 'status.class': '5xx' }, 1).ok,
        true);
    });
  });

  describe('[OBS-S] error sanitizing', function () {
    it('[OBSA] never emits the message, keeps class and frames', function () {
      const err = new Error("ENOENT: no such file, open '/var/pryv/users/alice/secret.json'");
      const sanitized = sanitizeError(err);
      assert.strictEqual(sanitized.errorClass, 'Error');
      assert.ok(sanitized.frames.length > 0, 'frames must survive');
      const joined = sanitized.frames.join('\n');
      assert.ok(!joined.includes('alice'), 'no message content may appear in frames');
      assert.ok(!joined.includes('ENOENT'), 'no message content may appear in frames');
    });

    it('[OBSB] rewrites absolute paths to repository-relative', function () {
      const err = new Error('boom');
      const sanitized = sanitizeError(err);
      for (const frame of sanitized.frames) {
        // A frame either references a repository-relative path or a node:
        // internal. An absolute filesystem path must never survive.
        if (frame.includes('node:')) continue;
        assert.ok(!/[( ]\/[^)]*\.(ts|js)/.test(frame),
          'absolute path leaked in frame: ' + frame);
      }
      assert.ok(sanitized.frames.some(function (f) { return f.includes('observability.test.js'); }),
        'the test frame should still be identifiable');
    });

    it('[OBSC] degrades safely on non-Error values', function () {
      assert.strictEqual(sanitizeError('a string').errorClass, 'String');
      assert.strictEqual(sanitizeError(null).errorClass, 'Unknown');
      assert.strictEqual(sanitizeError(42).errorClass, 'Number');
      assert.deepStrictEqual(sanitizeError(null).frames, []);
    });
  });

  describe('[OBS-E] emitter behaviour', function () {
    it('[OBSD] aggregates calls into counters and a duration histogram', async function () {
      const sink = captureSink();
      initEmitter(sink);
      observability.recordApiCall('events.get', 12);
      observability.recordApiCall('events.get', 30);
      observability.recordApiCall('auth.login', 5);

      const buffered = emitter._buffered();
      const calls = buffered.counters['api.method.calls'];
      const getSeries = calls.find(function (p) { return p.attributes['method.id'] === 'events.get'; });
      assert.strictEqual(getSeries.value, 2, 'two events.get calls aggregate into one series');
      assert.strictEqual(getSeries.attributes['status.class'], '2xx');
      const histogram = buffered.histograms['api.method.duration'];
      const getHistogram = histogram.find(function (p) { return p.attributes['method.id'] === 'events.get'; });
      assert.strictEqual(getHistogram.count, 2);
      assert.strictEqual(getHistogram.sum, 42);
    });

    it('[OBSE] counts a refused datapoint under telemetry.dropped', function () {
      const sink = captureSink();
      initEmitter(sink);
      // `system.unknown` is not in the registered vocabulary.
      observability.recordApiCall('system.unknown', 10);
      const dropped = emitter._buffered().counters['telemetry.dropped'];
      assert.ok(dropped != null && dropped.length === 1, 'the drop must be counted');
      assert.strictEqual(dropped[0].attributes.reason, schema.DROP_REASONS.UNKNOWN_METHOD_ID);
      assert.strictEqual(emitter._buffered().counters['api.method.calls'], undefined,
        'nothing may be recorded for a refused id');
    });

    it('[OBSF] counts a 4xx but only reports 5xx and unexpected', function () {
      const sink = captureSink();
      initEmitter(sink);
      const clientError = Object.assign(new Error('bad token'), {
        id: 'invalid-access-token', httpStatus: 401
      });
      const serverError = Object.assign(new Error('boom'), {
        id: 'unexpected-error', httpStatus: 500
      });
      observability.recordApiCall('events.get', 3, clientError);
      observability.recordApiCall('events.create', 7, serverError);

      const buffered = emitter._buffered();
      const errorCounts = buffered.counters['api.method.errors'];
      assert.strictEqual(errorCounts.length, 2, 'both failures are counted');
      assert.strictEqual(buffered.errors.length, 1, 'only the server fault is reported');
      assert.strictEqual(buffered.errors[0].code, 'unexpected-error');
      assert.strictEqual(buffered.errors[0].attributes['method.id'], 'events.create');
    });

    it('[OBSG] the OTLP payload carries only allow-listed keys', async function () {
      const sink = captureSink();
      initEmitter(sink);
      observability.recordApiCall('events.get', 12);
      observability.recordApiCall('events.create', 9, Object.assign(new Error('x'), {
        id: 'unexpected-error', httpStatus: 500
      }));
      await observability.flush();

      assert.strictEqual(sink.sent.length, 2, 'metrics and logs are sent separately');
      const metricsCall = sink.sent.find(function (s) { return s.url.endsWith('/v1/metrics'); });
      const logsCall = sink.sent.find(function (s) { return s.url.endsWith('/v1/logs'); });
      assert.ok(metricsCall != null && logsCall != null);

      const allowedDataKeys = new Set(['method.id', 'status.class', 'error.code', 'reason']);
      const resourceMetric = metricsCall.body.resourceMetrics[0];
      for (const attribute of resourceMetric.resource.attributes) {
        assert.ok(schema.RESOURCE_ATTRIBUTES.includes(attribute.key),
          'unexpected resource attribute: ' + attribute.key);
      }
      for (const metric of resourceMetric.scopeMetrics[0].metrics) {
        assert.ok(Object.values(schema.METRICS).includes(metric.name),
          'unexpected metric name: ' + metric.name);
        const points = (metric.sum || metric.histogram).dataPoints;
        for (const point of points) {
          for (const attribute of point.attributes) {
            assert.ok(allowedDataKeys.has(attribute.key),
              'unexpected datapoint attribute: ' + attribute.key);
          }
        }
      }

      const record = logsCall.body.resourceLogs[0].scopeLogs[0].logRecords[0];
      assert.strictEqual(record.body.stringValue, 'unexpected-error',
        'the record body is the code, never a message');
      const errorKeys = record.attributes.map(function (a) { return a.key; });
      for (const key of errorKeys) {
        assert.ok(schema.ERROR_ATTRIBUTES.includes(key) || key === 'error.stack',
          'unexpected error attribute: ' + key);
      }
    });

    it('[OBSH] a failing backend never throws into the caller', async function () {
      observability.init({
        endpoint: 'https://otlp.example.test',
        headers: {},
        serviceName: 'x',
        serviceVersion: '1',
        instanceId: 'y',
        worker: '1',
        methodIds: METHOD_IDS,
        flushIntervalMs: 3600000,
        send: async function () { throw new Error('backend down'); }
      });
      observability.recordApiCall('events.get', 4);
      await observability.flush(); // must resolve, not reject
      const dropped = emitter._buffered().counters['telemetry.dropped'];
      assert.ok(dropped != null, 'the send failure must be counted');
      assert.strictEqual(dropped[0].attributes.reason, schema.DROP_REASONS.SEND_FAILED);
    });
  });

  describe('[OBS-R] error registry', function () {
    it('[OBSI] maps known ids, falls back to unknown, derives the status class', function () {
      const known = classify(Object.assign(new Error('x'), {
        id: 'invalid-access-token', httpStatus: 401
      }));
      assert.strictEqual(known.code, 'invalid-access-token');
      assert.strictEqual(known.statusClass, '4xx');
      assert.strictEqual(known.reportable, false);

      const foreign = classify(Object.assign(new Error('x'), {
        id: 'something-we-never-declared', httpStatus: 400
      }));
      assert.strictEqual(foreign.code, 'unknown', 'an undeclared id must not travel');
      assert.strictEqual(foreign.reportable, true, 'unclassifiable failures are worth seeing');

      // A plain throw has no status: treated as a server fault.
      const bare = classify(new Error('x'));
      assert.strictEqual(bare.statusClass, '5xx');
      assert.strictEqual(bare.reportable, true);
    });
  });

  describe('[OBS-P] payload builders', function () {
    it('[OBSJ] emit nothing when there is nothing to send', function () {
      assert.deepStrictEqual(buildMetricsPayload({
        counters: {}, histograms: {}, startTimeMs: 0, endTimeMs: 1, resourceAttributes: {}
      }), {});
      assert.deepStrictEqual(buildLogsPayload({ errors: [], resourceAttributes: {} }), {});
    });
  });
});
