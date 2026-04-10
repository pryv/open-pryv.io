/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

require('test-helpers/src/api-server-tests-config');
const { pubsub } = require('messages');

const assert = require('node:assert');

describe('[PRMV] Pubsub removers', function () {
  it('[LVNK] remover works', done => {
    const removable = pubsub.notifications.onAndGetRemovable('toto', messageReceived);
    let titiReceived = false;
    pubsub.notifications.emit('toto', 'titi');

    function messageReceived (msg) {
      assert.strictEqual(msg, 'titi');
      titiReceived = true;
      removable();
      pubsub.notifications.emit('toto', 'tata'); // should not be received
    }

    setTimeout(() => {
      assert.strictEqual(titiReceived, true, 'should have recived titi message');
      done();
    }, 50);
  });
});
