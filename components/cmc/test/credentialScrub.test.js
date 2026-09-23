/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — content token-removal tests.
 *
 * [CMCSCRUB] covers hasCredential + scrubCredentials, the shared definition
 * of "what counts as a credential in a CMC record" used by the dispatch loop
 * and by bin/cmc-scrub-credentials.js.
 */

const assert = require('node:assert/strict');
const { hasCredential, scrubCredentials } = require('../src/credentialScrub.ts');

const WITH_TOKEN = 'https://tok-grant@recipient.example.com/';
const NO_TOKEN = 'https://recipient.example.com/';

describe('[CMCSCRUB] cmc/credentialScrub', () => {
  describe('[CMCSCRUB-H] hasCredential', () => {
    it('[CSCR1] finds a token in capabilityUrl and in acceptedBy.apiEndpoint', () => {
      assert.equal(hasCredential({ capabilityUrl: WITH_TOKEN }), true);
      assert.equal(hasCredential({ acceptedBy: { apiEndpoint: WITH_TOKEN } }), true);
      assert.equal(hasCredential({ capabilityUrl: NO_TOKEN, acceptedBy: { apiEndpoint: WITH_TOKEN } }), true);
    });

    it('[CSCR2] is false for content that carries no token', () => {
      assert.equal(hasCredential({ capabilityUrl: NO_TOKEN }), false);
      assert.equal(hasCredential({ acceptedBy: { apiEndpoint: NO_TOKEN } }), false);
      assert.equal(hasCredential({ apiEndpoint: NO_TOKEN }), false);
      assert.equal(hasCredential({ dataGrantAccessId: 'acc-1', from: { username: 'bob' } }), false);
    });

    it('[CSCR9] finds a token in a back-channel record\'s top-level apiEndpoint', () => {
      // `consent/back-channel-cmc` is peer-delivered into `:_cmc:inbox`, which
      // apps poll; its apiEndpoint is the COUNTERPARTY's back-channel token.
      assert.equal(hasCredential({ apiEndpoint: WITH_TOKEN }), true);
    });

    it('[CSCR3] tolerates missing, null and oddly-shaped content', () => {
      assert.equal(hasCredential(null), false);
      assert.equal(hasCredential(undefined), false);
      assert.equal(hasCredential({}), false);
      assert.equal(hasCredential({ capabilityUrl: 'not a url' }), false);
      assert.equal(hasCredential({ capabilityUrl: 42 }), false);
      assert.equal(hasCredential({ acceptedBy: 'a string, not an object' }), false);
      assert.equal(hasCredential({ acceptedBy: { apiEndpoint: null } }), false);
    });
  });

  describe('[CMCSCRUB-S] scrubCredentials', () => {
    it('[CSCR4] strips both fields and leaves everything else alone', () => {
      const content = {
        status: 'completed',
        capabilityUrl: 'https://Tok@example.com/',
        acceptedBy: { apiEndpoint: WITH_TOKEN },
        dataGrantAccessId: 'acc-1',
        from: { username: 'provider-a', host: 'example.com' },
      };
      const cleaned = scrubCredentials(content);
      assert.deepEqual(cleaned, {
        status: 'completed',
        capabilityUrl: 'https://example.com/',
        acceptedBy: { apiEndpoint: NO_TOKEN },
        dataGrantAccessId: 'acc-1',
        from: { username: 'provider-a', host: 'example.com' },
      });
    });

    it('[CSCR10] strips a back-channel record and keeps its routing fields', () => {
      const cleaned = scrubCredentials({
        status: 'completed',
        from: { username: 'provider-a', host: 'example.com' },
        apiEndpoint: WITH_TOKEN,
        remoteChatStreamId: ':_cmc:apps:my-app:chats:provider-a',
        remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:provider-a',
        appCode: 'my-app',
      });
      assert.deepEqual(cleaned, {
        status: 'completed',
        from: { username: 'provider-a', host: 'example.com' },
        apiEndpoint: NO_TOKEN,
        remoteChatStreamId: ':_cmc:apps:my-app:chats:provider-a',
        remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:provider-a',
        appCode: 'my-app',
      });
    });

    it('[CSCR5] keeps the other keys of acceptedBy', () => {
      const cleaned = scrubCredentials({
        acceptedBy: { apiEndpoint: WITH_TOKEN, username: 'bob', host: 'b.example.com' },
      });
      assert.deepEqual(cleaned.acceptedBy,
        { apiEndpoint: NO_TOKEN, username: 'bob', host: 'b.example.com' });
    });

    it('[CSCR6] returns null when there is nothing to remove, so a caller can skip the write', () => {
      assert.equal(scrubCredentials({ capabilityUrl: NO_TOKEN }), null);
      assert.equal(scrubCredentials({ dataGrantAccessId: 'acc-1' }), null);
      assert.equal(scrubCredentials(null), null);
      assert.equal(scrubCredentials({}), null);
    });

    it('[CSCR7] does not mutate its input', () => {
      const content = { capabilityUrl: WITH_TOKEN, acceptedBy: { apiEndpoint: WITH_TOKEN } };
      scrubCredentials(content);
      assert.equal(content.capabilityUrl, WITH_TOKEN);
      assert.equal(content.acceptedBy.apiEndpoint, WITH_TOKEN);
    });

    it('[CSCR8] is idempotent: scrubbing a scrubbed record is a no-op', () => {
      const once = scrubCredentials({ capabilityUrl: WITH_TOKEN });
      assert.equal(scrubCredentials(once), null);
    });
  });
});
