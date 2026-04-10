/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

require('test-helpers/src/api-server-tests-config');
require('api-server/test/unit/test-helper');
const assert = require('node:assert');
const net = require('node:net');

const tcpPubsub = require('../src/tcp_pubsub');
const { getConfig } = require('@pryv/boiler');

describe('[NPUB] TcpPublisher', () => {
  let rawSocket;
  let port;

  before(async () => {
    const config = await getConfig();
    port = config.get('tcpBroker:port');
    await tcpPubsub.init();
  });

  // Connect a raw TCP client and subscribe to 'foobar'
  beforeEach((done) => {
    rawSocket = net.createConnection({ port, host: '127.0.0.1' }, () => {
      // Wait for welcome, then subscribe
      // handled by data listener below
    });
    let buffer = '';
    let welcomed = false;
    rawSocket._testMsgs = [];
    rawSocket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        const msg = JSON.parse(line);
        if (msg.t === 'welcome' && !welcomed) {
          welcomed = true;
          // Subscribe to 'foobar'
          rawSocket.write(JSON.stringify({ t: 'sub', scope: 'foobar' }) + '\n');
          // Small delay to let subscription register
          setTimeout(done, 50);
        } else if (msg.t === 'msg') {
          rawSocket._testMsgs.push(msg);
        }
      }
    });
  });

  afterEach(() => {
    if (rawSocket) rawSocket.destroy();
  });

  it('[S386] should construct', async () => {
    await tcpPubsub.init();
  });

  it('[I21M] delivers messages to "USERNAME"', (done) => {
    // Override the data handler to check for the message
    const check = setInterval(() => {
      const msgs = rawSocket._testMsgs;
      if (msgs.length > 0) {
        clearInterval(check);
        assert.deepStrictEqual(msgs[0].event, 'onTestMessage');
        done();
      }
    }, 50);
    tcpPubsub.deliver('foobar', 'onTestMessage');
  });
});
