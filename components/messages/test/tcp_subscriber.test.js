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
const { getConfig } = require('@pryv/boiler');

const tcpPubsub = require('../src/tcp_pubsub');

describe('[NSUB] TcpSubscriber', () => {
  let port;

  before(async () => {
    const config = await getConfig();
    port = config.get('tcpBroker:port');
  });

  it('[DMMP] should construct', async () => {
    await tcpPubsub.init();
  });

  async function subscriber (scope, msgs) {
    const stub = {
      _emit: function (eventName, payload) {
        msgs.push(eventName);
      }
    };
    return await tcpPubsub.subscribe(scope, stub);
  }

  // Helper: create a raw TCP client that can publish
  function createRawClient () {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        socket.removeListener('error', reject);
      });
      socket.once('error', reject);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          const msg = JSON.parse(line);
          if (msg.t === 'welcome') {
            resolve(socket);
          }
        }
      });
    });
  }

  describe('[NS01] when subscribed to "foobar"', () => {
    let msgs;
    let rawClient;
    let tcpSub;

    beforeEach(async () => {
      msgs = [];
      if (tcpSub) {
        tcpSub.unsubscribe();
      }
      tcpSub = await subscriber('foobar', msgs);
    });

    beforeEach(async () => {
      rawClient = await createRawClient();
    });

    afterEach(() => {
      if (rawClient) rawClient.destroy();
    });

    describe('[NS02] subscribe("USERNAME")', () => {
      it('[4MAI] accepts messages from USERNAME.sok1 and dispatches them to sinks', async () => {
        rawClient.write(JSON.stringify({ t: 'pub', scope: 'foobar', event: 'onTestMessage', payload: '' }) + '\n');
        while (msgs.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.deepStrictEqual(msgs, ['onTestMessage']);
      });

      it('[47BP] ignores messages from other users', async () => {
        rawClient.write(JSON.stringify({ t: 'pub', scope: 'barbaz', event: 'onTestMessage1', payload: '' }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 100));
        rawClient.write(JSON.stringify({ t: 'pub', scope: 'foobar', event: 'onTestMessage2', payload: '' }) + '\n');
        while (msgs.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.deepStrictEqual(msgs, ['onTestMessage2']);
      });
    });

    describe('[NS03] unsubscribe()', function () {
      this.timeout(1000);

      it('[L49E] should unsubscribe from TCP broker', async () => {
        rawClient.write(JSON.stringify({ t: 'pub', scope: 'foobar', event: 'onTestMessage1', payload: '' }) + '\n');
        while (msgs.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        tcpSub.unsubscribe();
        rawClient.write(JSON.stringify({ t: 'pub', scope: 'foobar', event: 'onTestMessage2', payload: '' }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.deepStrictEqual(msgs, ['onTestMessage1']);
      });
    });
  });
});
