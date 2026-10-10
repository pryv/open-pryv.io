/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert');
const { inspect } = require('node:util');
const superagent = require('superagent');
const Application = require('../../src/application.ts').default;

// The body parser answers a malformed batch before the token is read, while
// the Authorization header still holds the Basic form: the trace line must
// not print it.
describe('[HFRT] HFS request trace', function () {
  let application, server;
  before(async () => {
    application = new Application();
    await application.init();
    server = application.server;
    await server.start();
  });
  after(() => {
    server.stop();
    application.context.metadata.close();
  });

  it('[HFRT1] a malformed batch sent with Basic auth is traced without the token', async function () {
    const token = 'tok-hfrt1-basic';
    const proto = Object.getPrototypeOf(require('@pryv/boiler').getLogger('log-capture'));
    const original = proto.log;
    const lines = [];
    proto.log = function (level, msg, ...rest) {
      lines.push({ level, name: this._name(), text: String(msg) + ' ' + inspect(rest, { depth: 8 }) });
      return original.call(this, level, msg, ...rest);
    };
    let status;
    try {
      const res = await superagent.post(new URL('/alice/series/batch', server.baseUrl).toString())
        .set('Authorization', 'Basic ' + Buffer.from(token + ':').toString('base64'))
        .set('Content-Type', 'application/json')
        .send('{bad')
        .ok(() => true);
      status = res.status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      proto.log = original;
    }
    assert.strictEqual(status, 400);
    const traces = lines.filter((l) => l.name.endsWith('request-trace'));
    assert.ok(traces.some((l) => l.text.includes('/alice/series/batch')), inspect(lines));
    assert.deepStrictEqual(lines.filter((l) => l.text.includes(token)), []);
  });
});
