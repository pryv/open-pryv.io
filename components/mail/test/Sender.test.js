/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const assert = require('node:assert');

require('test-helpers/src/api-server-tests-config');

const Sender = require('../src/Sender');
const Template = require('../src/Template');

describe('[MAILSEND] Sender', () => {
  it('[MSND1] delegates renderAndSend to template.executeSend with a SendOperation wrapping recipient + substitutions', async () => {
    const sendCalls = [];
    const deliveryService = {
      async send (payload) { sendCalls.push(payload); return { accepted: [payload.message.to.address] }; },
      async templateExists () { return true; }
    };
    const sender = new Sender(deliveryService);
    const template = new Template('welcome-email', 'en', async () => true);
    const recipient = { name: 'Alice', email: 'alice@example.com' };
    const substitutions = { username: 'alice' };

    await sender.renderAndSend(template, substitutions, recipient);

    assert.strictEqual(sendCalls.length, 1);
    const [payload] = sendCalls;
    assert.deepStrictEqual(payload.message.to, { name: 'Alice', address: 'alice@example.com' });
    assert.strictEqual(payload.template, 'welcome-email/en');
    assert.deepStrictEqual(payload.locals, { username: 'alice' });
  });
});
