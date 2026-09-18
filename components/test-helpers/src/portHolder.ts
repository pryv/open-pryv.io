/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

// A test that cannot bind its port fails with a bare `EADDRINUSE`, which reads
// like a defect in the code under test. It usually is not: another checkout on
// the same machine, or a dev server started by hand, is holding the canonical
// port. Name the holder in the failure so the next reader knows in seconds.

import { execSync } from 'node:child_process';

type PortHolder = { pid: number, command: string };

/** Processes listening on `port`, as reported by `lsof` (empty when none or unavailable). */
function portHolders (port: number | string): PortHolder[] {
  let pids = '';
  try {
    pids = execSync('lsof -ti :' + port, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) {
    return []; // no listener, or lsof unavailable
  }
  const holders: PortHolder[] = [];
  for (const pidStr of pids.trim().split('\n').filter(Boolean)) {
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) continue;
    let command = '(unknown)';
    try {
      command = execSync('ps -o command= -p ' + pid, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (e) { continue; } // exited between the two calls
    holders.push({ pid, command });
  }
  return holders;
}

/**
 * One line naming what holds `port`, for a failure message. `settingHint` names
 * the config key to move this suite's port to, when the holder is legitimate.
 */
function portHolderHint (port: number | string, settingHint: string): string {
  const holders = portHolders(port);
  const who = holders.length > 0
    ? holders.map((h) => 'pid ' + h.pid + ': ' + h.command).join(', ')
    : 'no listener found now (it may have exited, or lsof is unavailable)';
  return 'port ' + port + ' is held by another process (' + who + '). ' +
    'This is a port collision, not a failure of the code under test: another checkout ' +
    'or a hand-started server on this machine is using the canonical port. Free it, or ' +
    'give this workspace its own port via ' + settingHint + '.';
}

/** Wrap a bind error with the holder hint; other errors pass through unchanged. */
function describeBindError (err: Error & { code?: string }, port: number | string, settingHint: string): Error {
  if (err == null || err.code !== 'EADDRINUSE') return err;
  const described: Error & { code?: string } = new Error(err.message + ' — ' + portHolderHint(port, settingHint));
  described.code = err.code;
  return described;
}

export { portHolders, portHolderHint, describeBindError };
