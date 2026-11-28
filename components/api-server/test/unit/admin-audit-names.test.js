/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * [ADAN] what the records of administration acts may name: a username only
 * through the keys that are replaced by its keyed hash, a part of one (a
 * search prefix) as `true`; and no record part, as the callers write them,
 * holds a key that looks like a name, an address or a secret the scrub does
 * not handle.
 */

const COMPONENTS = path.resolve(__dirname, '../../../');
const KEY = Buffer.alloc(32, 7).toString('base64');
const config = { get: (k) => (k === 'accountErasure:ledger:hmacKey' ? KEY : null) };

describe('[ADAN] account names in administration records', function () {
  const { scrubAccountNames, ACCOUNT_NAME_KEYS, ACCOUNT_NAME_PART_KEYS } = require('business/src/admin/accountNames.ts');

  it('[ADAN1] a username becomes its keyed hash with the key id; a search prefix becomes true; other keys are kept', () => {
    const out = scrubAccountNames({ username: 'Adan-Name', delegateUsername: 'adan-delegate', search: 'ada', relId: 'rel-1' }, config);
    assert.deepStrictEqual(Object.keys(out).sort(), ['delegateUsernameHash', 'hashKeyId', 'relId', 'search', 'usernameHash']);
    assert.match(out.usernameHash, /^[0-9a-f]{64}$/);
    assert.strictEqual(out.usernameHash, scrubAccountNames({ username: 'adan-name' }, config).usernameHash, 'the name in any case');
    assert.strictEqual(out.search, true);
    assert.ok(!JSON.stringify(out).includes('ada"') && !JSON.stringify(out).includes('Adan-Name'));
    assert.deepStrictEqual(scrubAccountNames({ search: '' }, config), { search: '' }, 'an empty search said nothing');
    assert.deepStrictEqual(scrubAccountNames({ search: ['a', 'b'] }, config), { search: true });
  });

  // Mutation caught: a caller recording `{ email }` or `{ name }` in a target or
  // a diff (the scrub knows `username`, `delegateUsername` and `search` only).
  it('[ADAN2] the record parts written by the administration routes and methods hold no other key that looks like a name, an address or a secret', () => {
    const SENSITIVE = /name|email|mail|token|code|password|secret/i;
    // Keys whose value is never an account name nor a secret.
    const ALLOWED = new Set([
      ...Object.keys(ACCOUNT_NAME_KEYS), ...ACCOUNT_NAME_PART_KEYS,
      'hostname', // a certificate's hostname
      'namespace' // an external-id namespace
    ]);
    const CALLS = /\b(setAuditDetails|setRouteAct|setAdminAct|recordAdminAct|auditTarget)\(/g;
    const roots = ['api-server/src/routes', 'api-server/src/methods', 'business/src/auth'].map((r) => path.join(COMPONENTS, r));
    const files = roots.flatMap(function walk (dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
    });
    const found = [];
    let calls = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(CALLS)) {
        // The call's arguments, up to the matching parenthesis.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < text.length; end++) {
          const c = text[end];
          if (c === '(' || c === '{' || c === '[') depth++;
          else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) break; }
        }
        // (A declaration reads `name (`, a call `name(`: only calls match.)
        const args = text.slice(m.index + m[0].length, end);
        calls++;
        const keys = [...args.matchAll(/([A-Za-z_$][\w$]*)\s*:(?!:)/g), ...args.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)].map((k) => k[1]);
        for (const k of keys) {
          if (SENSITIVE.test(k) && !ALLOWED.has(k)) found.push(path.relative(COMPONENTS, file) + ': ' + k);
        }
      }
    }
    assert.ok(calls > 20, 'the scan finds the callers (' + calls + ')');
    assert.deepStrictEqual([...new Set(found)], [], 'keys to scrub or to allow on purpose');
  });
});
