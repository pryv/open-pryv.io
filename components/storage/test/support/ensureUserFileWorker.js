/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Child process for [ERMK]: `userLocalDirectory.ensureUserFile` in a fresh
 * process (no in-process erased mark, as after a restart or in another
 * worker). argv: <userId> <fileName>. Prints `{ ok, path }` or
 * `{ ok: false, code }` as its last line.
 */

import 'test-helpers/src/api-server-tests-config.ts';
import { userLocalDirectory } from 'storage';

const [userId, fileName] = process.argv.slice(2);
await userLocalDirectory.init();
let result;
try {
  result = { ok: true, path: await userLocalDirectory.ensureUserFile(userId, fileName) };
} catch (err) {
  if (err?.code == null) throw err;
  result = { ok: false, code: err.code };
}
process.stdout.write('\n' + JSON.stringify(result) + '\n');
process.exit(0);
