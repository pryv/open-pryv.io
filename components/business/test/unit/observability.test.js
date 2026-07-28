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
 *   [OBSR] cleartext is allowed to host-local collectors, refused beyond them
 *   [OBSS] the emitter itself refuses a cleartext remote endpoint at startup
 */

const assert = require('node:assert');

const schema = require('business/src/observability/schema.ts');
const emitter = require('business/src/observability/emitter.ts');
const observability = require('business/src/observability/index.ts');
const sanitizeErrorModule = require('business/src/observability/sanitizeError.ts');
const { sanitizeError } = sanitizeErrorModule;
const { classify, allErrorCodes, messageFor } = require('business/src/observability/errorRegistry.ts');
const { buildMetricsPayload, buildLogsPayload } = require('business/src/observability/otlp.ts');
const { isHostLocal, endpointRefusal } = require('business/src/observability/endpointPolicy.ts');
const { startFromEnv, ENV } = require('business/src/observability/startup.ts');

const METHOD_IDS = ['events.get', 'events.create', 'auth.login'];

/** One fixed throw site, so repeated reports share a stack. */
function sharedFault () {
  return Object.assign(new Error('boom'), { id: 'unexpected-error', httpStatus: 500 });
}

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

    it('[OBSB] emits repository-relative frames and nothing else', function () {
      const err = new Error('boom');
      const sanitized = sanitizeError(err);
      for (const frame of sanitized.frames) {
        assert.ok(schema.SAFE_FRAME.test(frame), 'frame outside the grammar: ' + frame);
      }
      assert.ok(sanitized.frames.some(function (f) { return f.includes('observability.test.js'); }),
        'the test frame should still be identifiable');
    });

    it('[OBSB2] discards every path outside the repository, in both URL and bare form', function () {
      // The `file://` form is what V8 emits throughout this ESM codebase,
      // and it is what an earlier deny-list version let through.
      const err = new Error('secret message');
      err.stack = [
        'Error: secret message',
        '    at Context.<anonymous> (file://' + process.cwd() + '/components/api-server/src/API.ts:210:5)',
        '    at handler (' + process.cwd() + '/components/business/src/x.ts:1:1)',
        '    at loadESM (node:internal/process/esm_loader:34:7)',
        '    at Module._compile (file:///Users/someone/.nvm/versions/node/v24.0.0/lib/foo/index.js:9:9)',
        '    at readFile (/home/alice-patient-data/plugins/custom.js:3:3)',
        '    at evil (/etc/passwd:1:1)'
      ].join('\n');
      const sanitized = sanitizeError(err);
      const joined = sanitized.frames.join('\n');

      assert.ok(!joined.includes('someone'), 'home-directory account name leaked: ' + joined);
      assert.ok(!joined.includes('alice-patient-data'), 'external path leaked: ' + joined);
      assert.ok(!joined.includes('/etc/passwd'), 'external path leaked: ' + joined);
      assert.ok(!joined.includes('secret message'), 'message leaked into frames');
      assert.ok(!joined.includes(process.cwd()), 'absolute repository path leaked: ' + joined);
      // Kept: the two in-repo frames plus the node internal, so this
      // cannot pass by discarding everything.
      assert.ok(joined.includes('components/api-server/src/API.ts:210:5'));
      assert.ok(joined.includes('components/business/src/x.ts:1:1'));
      assert.ok(joined.includes('node:internal/process/esm_loader:34:7'));
      assert.ok(joined.includes(sanitizeErrorModule.EXTERNAL_FRAME),
        'external frames are replaced by a placeholder, not dropped silently');
      for (const frame of sanitized.frames) {
        assert.ok(schema.SAFE_FRAME.test(frame), 'frame outside the grammar: ' + frame);
      }
    });

    it('[OBSB3] bounds function names, so a dynamically-keyed function cannot carry text', function () {
      const err = new Error('x');
      const inRepo = process.cwd() + '/components/business/src/x.ts:1:1';
      err.stack = [
        'Error: x',
        '    at alice@example.com (' + inRepo + ')',
        // A charset bound would accept this: it is only letters and spaces.
        '    at alice smith payload data (' + inRepo + ')',
        // Legitimate V8 shapes that must SURVIVE, so this cannot pass by
        // rejecting every name.
        '    at Object.<anonymous> (' + inRepo + ')',
        '    at new UserRepository (' + inRepo + ')',
        '    at async Server.registerApiMethods (' + inRepo + ')'
      ].join('\n');
      const joined = sanitizeError(err).frames.join('\n');
      assert.ok(!joined.includes('alice@example.com'), 'unsafe function name leaked');
      assert.ok(!joined.includes('alice smith'), 'free-text function name leaked: ' + joined);
      assert.ok(joined.includes('Object.<anonymous>'), 'legitimate V8 name was rejected');
      assert.ok(joined.includes('new UserRepository'), 'legitimate V8 name was rejected');
      assert.ok(joined.includes('async Server.registerApiMethods'), 'legitimate V8 name was rejected');
    });

    it('[OBSB4] rejects relative paths that walk out of the repository', function () {
      // A path that is already relative is not rewritten, so `..` segments
      // would otherwise leave the repo while still looking repo-relative.
      // Found by cross-model review, not by the original sweep.
      const err = new Error('x');
      err.stack = [
        'Error: x',
        '    at f (../../Users/someone/secret/x.js:1:1)',
        '    at g (../../../etc/secrets/x.js:2:2)',
        '    at h (components/business/src/x.ts:3:3)'
      ].join('\n');
      const joined = sanitizeError(err).frames.join('\n');
      assert.ok(!joined.includes('..'), 'a parent-directory segment survived: ' + joined);
      assert.ok(!joined.includes('someone'), 'an out-of-repo path survived: ' + joined);
      assert.ok(!joined.includes('etc/secrets'), 'an out-of-repo path survived: ' + joined);
      assert.ok(joined.includes('components/business/src/x.ts:3:3'),
        'the legitimate in-repo frame must survive');
      // And the schema backstop refuses it independently of the sanitizer.
      assert.strictEqual(
        schema.validateFrames('at f (../../Users/someone/secret/x.js:1:1)').ok, false);
      assert.strictEqual(
        schema.validateFrames('at h (components/business/src/x.ts:3:3)').ok, true);
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

    it('[OBSK] aggregates repeated faults into one counted record, with no per-occurrence time', function () {
      const sink = captureSink();
      initEmitter(sink);
      const makeError = () => Object.assign(new Error('boom'), {
        id: 'unexpected-error', httpStatus: 500
      });
      // Same fault site three times: one record, count 3.
      for (let i = 0; i < 3; i++) {
        emitter.reportError(sharedFault(), 'unexpected-error', 'events.get');
      }
      emitter.reportError(makeError(), 'unexpected-error', 'events.create');

      const errors = emitter._buffered().errors;
      assert.strictEqual(errors.length, 2, 'grouped by fault, not by occurrence');
      const grouped = errors.find(function (e) { return e.attributes['method.id'] === 'events.get'; });
      assert.strictEqual(grouped.count, 3);
      // A buffered record must carry no time field at all — asserting on the
      // real shape rather than on one guessed property name, so this cannot
      // pass just because nothing is called `timeMs`.
      for (const record of errors) {
        const timeKeys = Object.keys(record).filter(function (k) { return /time|stamp|date|ms$/i.test(k); });
        assert.deepStrictEqual(timeKeys, [],
          'no per-occurrence time may be retained (found ' + timeKeys.join(',') + '): it is the correlation handle');
      }
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
      assert.strictEqual(record.body.stringValue, messageFor('unexpected-error'),
        'the body is the hard-coded message for the code, never the thrown message');
      assert.ok(!record.body.stringValue.includes('x'.repeat(1)) ||
        record.body.stringValue === messageFor('unexpected-error'));
      const errorKeys = record.attributes.map(function (a) { return a.key; });
      for (const key of errorKeys) {
        assert.ok(schema.ERROR_ATTRIBUTES.includes(key),
          'unexpected error attribute: ' + key);
      }
      // The interval boundary, shared by every record in the batch.
      const metricPoint = resourceMetric.scopeMetrics[0].metrics[0];
      const metricEnd = (metricPoint.sum || metricPoint.histogram).dataPoints[0].timeUnixNano;
      assert.strictEqual(record.timeUnixNano, metricEnd,
        'error records carry the interval boundary, not an occurrence time');
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

  describe('[OBS-G] the guarantee, asserted at the boundary', function () {
    beforeEach(function () {
      schema.registerMethodIds(METHOD_IDS);
      schema.registerErrorCodes(allErrorCodes());
    });

    it('[OBSL] a stack that escapes the sanitizer is refused by the schema', function () {
      // Simulates a future regression in sanitizeError: the validator is
      // the backstop, so an unsafe frame must not reach the wire even if
      // the sanitizer produced it.
      const unsafe = 'at x (/home/alice/secret/plugin.js:1:1)';
      const result = schema.validateErrorAttributes({
        'error.code': 'unexpected-error', 'error.stack': unsafe
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, schema.DROP_REASONS.UNSAFE_FRAME);
      // A legitimate stack still passes.
      assert.strictEqual(schema.validateErrorAttributes({
        'error.code': 'unexpected-error',
        'error.stack': 'at f (components/business/src/x.ts:1:1)\nat <external>'
      }).ok, true);
    });

    it('[OBSM] the emitter refuses to build a report around an unsafe stack', function () {
      const sink = captureSink();
      initEmitter(sink);

      // Positive: a safe stack is reported.
      const safe = new Error('x');
      safe.stack = 'Error: x\n    at f (components/business/src/x.ts:1:1)';
      emitter.reportError(safe, 'unexpected-error', 'events.get');
      assert.strictEqual(emitter._buffered().errors.length, 1, 'the safe case is reported');

      // Negative, exercised through reportError rather than only at schema
      // level: a stack the sanitizer would never produce (simulating a
      // future regression in it) must be refused and counted, not sent.
      const unsafe = new Error('y');
      unsafe.stack = 'Error: y\n    at f (/home/alice/secret/plugin.js:1:1)';
      const before = emitter._buffered().errors.length;
      emitter.reportError({
        constructor: { name: 'Error' },
        stack: unsafe.stack,
        // Bypass the sanitizer by handing the emitter a pre-broken frame:
        // reportError sanitizes, so we assert the end state either way.
        id: 'unexpected-error'
      }, 'unexpected-error', 'events.get');
      const after = emitter._buffered().errors;
      const leaked = JSON.stringify(after);
      assert.ok(!leaked.includes('/home/alice'),
        'an out-of-repo path reached a buffered report: ' + leaked);
      assert.ok(after.length >= before, 'sanity: the buffer did not shrink');
    });

    it('[OBSN] resource attributes are bounded, service name included', function () {
      assert.strictEqual(schema.validateResource({
        'service.name': 'open-pryv.io (example.com)',
        'service.instance.id': 'core-euc1',
        'service.worker': '1',
        'service.version': '2.0.0'
      }).ok, true);
      // An operator pasting a subject's details into the app name.
      assert.strictEqual(schema.validateResource({
        'service.name': 'alice@example.com'
      }).ok, false, 'an email-shaped service name must not pass');
      assert.strictEqual(schema.validateResource({ 'user.name': 'alice' }).ok, false);
    });

    it('[OBSQ] the reporting interval is operator-settable and clamped', function () {
      // It is the only lever on the low-traffic correlation residual, and
      // the documentation promises operators can widen it — so the knob
      // must exist, and must not be settable to a value fine enough to
      // make individual activity observable.
      assert.strictEqual(emitter.clampInterval(undefined), emitter.DEFAULT_FLUSH_INTERVAL_MS);
      assert.strictEqual(emitter.DEFAULT_FLUSH_INTERVAL_MS, 300000, 'default is 5 minutes');
      assert.strictEqual(emitter.clampInterval(600000), 600000, 'a wider interval is honoured');
      assert.strictEqual(emitter.clampInterval(1000), emitter.MIN_FLUSH_INTERVAL_MS,
        'too fine is clamped up');
      assert.strictEqual(emitter.clampInterval(99999999), emitter.MAX_FLUSH_INTERVAL_MS);
      assert.strictEqual(emitter.clampInterval(Number.NaN), emitter.DEFAULT_FLUSH_INTERVAL_MS);
    });

    it('[OBSO] a rejected resource drops the whole batch rather than sending it', async function () {
      const sink = captureSink();
      observability.init({
        endpoint: 'https://otlp.example.test',
        headers: {},
        serviceName: 'alice@example.com', // invalid on purpose
        serviceVersion: '2.0.0',
        instanceId: 'core-test',
        worker: '1',
        methodIds: METHOD_IDS,
        flushIntervalMs: 3600000,
        send: sink.send
      });
      observability.recordApiCall('events.get', 5);
      await observability.flush();
      assert.strictEqual(sink.sent.length, 0, 'nothing may be sent under an invalid resource');
    });
  });

  describe('[OBS-W] end-to-end wire sweep', function () {
    it('[OBSP] no identifier survives to the serialized payload, from the real entry point', async function () {
      const sink = captureSink();
      initEmitter(sink);

      // Every string here is something that must never reach a backend.
      // They are pushed through the SAME entry point API.call uses, in
      // every position an attacker or an unlucky code path could put them.
      const secrets = [
        'alice', 'alice@example.com', 'cjqz8k1f20000abcd1234efgh',
        'https://core.example.com/alice/events?auth=tok-secret',
        '/var/pryv/users/alice/attachments/scan.pdf',
        'Bearer tok-secret', 'tok-secret', 'my-private-stream',
        'patient-record-42', 'password123'
      ];

      const err = new Error(
        "ENOENT: open '/var/pryv/users/alice/attachments/scan.pdf' for alice@example.com " +
        'token Bearer tok-secret stream my-private-stream patient-record-42 password123'
      );
      err.id = 'unexpected-error';
      err.httpStatus = 500;
      // Custom properties of the shapes Node and our own code attach.
      err.path = '/var/pryv/users/alice/attachments/scan.pdf';
      err.hostname = 'alice.example.com';
      err.address = '10.0.0.4';
      err.username = 'alice';
      err.url = 'https://core.example.com/alice/events?auth=tok-secret';
      err.streamId = 'my-private-stream';
      err.data = { email: 'alice@example.com', password: 'password123' };

      // A legitimate call, a server fault, and an attempt to smuggle a
      // username in through the method-id position.
      observability.recordApiCall('events.get', 12);
      observability.recordApiCall('events.create', 40, err);
      observability.recordApiCall('alice@example.com', 5);
      observability.recordError(err, 'events.get');

      await observability.flush();

      assert.ok(sink.sent.length > 0, 'something must have been sent, or this proves nothing');
      const wire = JSON.stringify(sink.sent);
      for (const secret of secrets) {
        assert.ok(!wire.includes(secret),
          'LEAK: "' + secret + '" reached the wire payload:\n' + wire);
      }
      // Positive controls: the payload is real and useful, so the sweep
      // above cannot be passing because nothing was emitted.
      assert.ok(wire.includes('events.get'), 'legitimate method ids must survive');
      assert.ok(wire.includes('unexpected-error'), 'the error code must survive');
      assert.ok(wire.includes('api.method.calls'), 'metrics must survive');
      assert.ok(wire.includes('error.stack'), 'a stack must survive');
      // And the smuggled method id was refused, not silently accepted.
      assert.ok(wire.includes(schema.DROP_REASONS.UNKNOWN_METHOD_ID),
        'the refusal must be visible as a counted drop');
    });
  });

  describe('[OBS-T] transport policy', function () {
    it('[OBSR] permits cleartext to host-local collectors and refuses it beyond them', function () {
      // The deployment this exists for: a collector sidecar reached across
      // the container bridge. Never leaves the host, so it needs no cert.
      const local = [
        'http://localhost:4318', 'http://127.0.0.1:4318', 'http://127.5.0.1:4318',
        'http://otel.localhost:4318', 'http://172.17.0.1:4318', 'http://172.31.255.254:4318',
        'http://10.1.2.3:4318', 'http://192.168.1.10:4318', 'http://169.254.10.9:4318',
        'http://[::1]:4318', 'http://[fe80::1]:4318', 'http://[fd00::1]:4318'
      ];
      for (const url of local) {
        assert.strictEqual(endpointRefusal(url), null, 'must accept ' + url);
      }

      // Anything routable from off the network still needs TLS. 172.15 and
      // 172.32 sit just outside RFC1918, which is where an off-by-one in the
      // range check would show up.
      const remote = [
        'http://otlp.example.test:4318', 'http://8.8.8.8:4318',
        'http://172.15.0.1:4318', 'http://172.32.0.1:4318',
        'http://11.0.0.1:4318', 'http://[2001:db8::1]:4318'
      ];
      for (const url of remote) {
        assert.match(endpointRefusal(url) || '', /not host-local/, 'must refuse ' + url);
      }

      // https is fine wherever it points; a malformed URL is refused as such.
      assert.strictEqual(endpointRefusal('https://otlp.example.test'), null);
      assert.match(endpointRefusal('not-a-url') || '', /not a valid URL/);
      assert.match(endpointRefusal('ftp://otlp.example.test') || '', /unsupported protocol/);

      // The predicate is decided on the address, not on a name that merely
      // looks local.
      assert.strictEqual(isHostLocal('localhost.example.test'), false);
    });

    it('[OBSS] the emitter refuses a cleartext remote endpoint at startup', function () {
      // The configuration path is not the only way in: PlatformDB and the
      // environment both reach here without the CLI, so the emitter has to
      // enforce the rule itself or it is not enforced at all.
      const base = {
        [ENV.ENABLED]: 'true',
        [ENV.SERVICE_NAME]: 'open-pryv.io (test)',
        NODE_ENV: 'production'
      };
      const remote = startFromEnv({
        methodIds: METHOD_IDS,
        serviceVersion: '2.0.0',
        env: { ...base, [ENV.ENDPOINT]: 'http://otlp.example.test' }
      });
      assert.strictEqual(remote.activated, false);
      assert.match(remote.reason, /not host-local/);

      // And it does not refuse the supported sidecar shape.
      const sidecar = startFromEnv({
        methodIds: METHOD_IDS,
        serviceVersion: '2.0.0',
        env: { ...base, [ENV.ENDPOINT]: 'http://172.17.0.1:4318' }
      });
      assert.strictEqual(sidecar.activated, true, sidecar.reason);
      observability._reset();
    });
  });

  describe('[OBS-P] payload builders', function () {
    it('[OBSJ] emit nothing when there is nothing to send', function () {
      assert.deepStrictEqual(buildMetricsPayload({
        counters: {}, histograms: {}, startTimeMs: 0, endTimeMs: 1, resourceAttributes: {}
      }), {});
      assert.deepStrictEqual(buildLogsPayload({
        errors: [], intervalEndMs: 1, resourceAttributes: {}
      }), {});
    });
  });
});
