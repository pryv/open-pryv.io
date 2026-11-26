/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { readAdminConfig, setupPageUrl, portalUrl } from './config.ts';
import {
  readSetupState, claimFreshPending, recordLegacyReady, installSetupCode, mintSetupCode, pendingSetupCode
} from './setupState.ts';
import type { AdminStore } from './store.ts';
import type { MintedCode } from './setupState.ts';

/**
 * The setup step of the master process boot (never the workers).
 *
 * - No `setup/state` yet, and the platform already in use (an account, or
 *   another core registered) or this boot joining a cluster: written `ready`
 *   (legacy), no code. A platform upgraded with unchanged config sees no
 *   change.
 * - No `setup/state` on a platform not in use: this core claims `pending`
 *   (first writer wins, so one core of a platform does it) and mints the
 *   setup code, or installs `setup.codeHash` when the operator supplied one.
 *   The minted code is printed once in a marked block on stdout (unless
 *   `setup.printCode: false`) and written to `<config dir>/setup-code.txt`
 *   (mode 0600) when that is possible. It is never logged otherwise.
 * - `pending` already: nothing is minted (the code survives restarts; it
 *   cannot be printed again since only its hash is kept). A new
 *   `setup.codeHash` value replaces the pending code.
 * - `ready`: a leftover `setup-code.txt` is deleted.
 */

type ConfigReader = { get: (key: string) => unknown };

type FsLike = Pick<typeof nodeFs, 'writeFileSync' | 'chmodSync' | 'unlinkSync' | 'existsSync'>;

export type SetupBootDeps = {
  db: AdminStore;
  config: ConfigReader;
  coreId: string;
  /** This boot joins an existing cluster: never mints. */
  joining: boolean;
  /** True when the platform already holds an account or another core. */
  platformInUse: () => Promise<boolean>;
  /** Where `setup-code.txt` goes; null: not written. */
  configDir: string | null;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  /** Where the one setup block is printed (stdout). */
  print: (text: string) => void;
  now?: () => number;
  fs?: FsLike;
};

export type SetupBootAction = 'legacy' | 'minted' | 'supplied' | 'pending' | 'ready';
export type SetupBootResult = { state: 'pending' | 'ready'; action: SetupBootAction; codeFile: string | null };

export const SETUP_CODE_FILE = 'setup-code.txt';
const REPLACE_HINT = 'replace it with `node bin/admin.js setup-code --new` or POST /system/admin/setup/code (admin key)';

export async function runSetupBoot (deps: SetupBootDeps): Promise<SetupBootResult> {
  const now = deps.now ?? Date.now;
  const fs = deps.fs ?? nodeFs;
  const cfg = readAdminConfig(deps.config);
  const codeFile = deps.configDir != null ? nodePath.join(deps.configDir, SETUP_CODE_FILE) : null;

  let state = await readSetupState(deps.db);
  if (state == null) {
    if (deps.joining || await deps.platformInUse()) {
      state = await recordLegacyReady(deps.db, { coreId: deps.coreId, now: now() });
      if (state.state === 'ready') {
        removeCodeFile(fs, codeFile, deps.warn);
        deps.log(state.via === 'legacy'
          ? '[setup] existing platform: setup state recorded as ready, no setup code issued (claim the first administrator role with a claim code)'
          : '[setup] setup state: ready');
        return { state: 'ready', action: state.via === 'legacy' ? 'legacy' : 'ready', codeFile: null };
      }
    } else if (await claimFreshPending(deps.db, { coreId: deps.coreId, now: now() })) {
      if (cfg.setup.codeHash != null) {
        return await installSupplied(deps, cfg.setup.codeHash, cfg.setup.codeTtlMs, now());
      }
      const minted = await mintSetupCode(deps.db, { coreId: deps.coreId, ttlMs: cfg.setup.codeTtlMs, now: now() });
      if (minted == null) throw new Error('setup state changed while minting the setup code');
      const written = writeCodeFile(fs, codeFile, minted, deps);
      if (cfg.setup.printCode) {
        deps.print(setupBlock(minted, deps.config, written));
      } else {
        deps.log('[setup] setup code minted, not printed (setup.printCode: false)' +
          (written != null ? `; it is in ${written}` : ''));
        if (written == null) deps.warn(`[setup] the setup code could not be saved and is not printed: ${REPLACE_HINT}`);
      }
      return { state: 'pending', action: 'minted', codeFile: written };
    } else {
      state = await readSetupState(deps.db);
    }
  }

  if (state == null || state.state === 'ready') {
    removeCodeFile(fs, codeFile, deps.warn);
    return { state: 'ready', action: 'ready', codeFile: null };
  }

  // pending
  if (cfg.setup.codeHash != null && !deps.joining && state.suppliedCodeHash !== cfg.setup.codeHash) {
    return await installSupplied(deps, cfg.setup.codeHash, cfg.setup.codeTtlMs, now());
  }
  const pending = await pendingSetupCode(deps.db);
  if (pending != null) {
    deps.log(`[setup] setup is pending: a setup code issued at ${iso(pending.createdAt)} is valid until ${iso(pending.expiresAt)}; ` +
      `it cannot be shown again (only its hash is kept): ${REPLACE_HINT}` + pageHint(deps.config));
  } else {
    removeCodeFile(fs, codeFile, deps.warn);
    deps.warn('[setup] setup is pending and no setup code is valid (expired, used or replaced): mint one with `node bin/admin.js setup-code --new`, or POST /system/admin/setup/code (admin key)');
  }
  return { state: 'pending', action: 'pending', codeFile: null };
}

async function installSupplied (deps: SetupBootDeps, codeHash: string, ttlMs: number, now: number): Promise<SetupBootResult> {
  const installed = await installSetupCode(deps.db, { codeHash, coreId: deps.coreId, ttlMs, now, supplied: true });
  if (installed == null) return { state: 'ready', action: 'ready', codeFile: null };
  deps.log(`[setup] setup is pending: the operator-supplied setup code (setup.codeHash) is valid until ${iso(installed.expiresAt)}` + pageHint(deps.config));
  return { state: 'pending', action: 'supplied', codeFile: null };
}

function iso (ms: number): string {
  return new Date(ms).toISOString();
}

/** The addresses where setup can be done: the built-in page (always), the portal when configured. */
export function setupAddresses (config: ConfigReader): { page: string[]; portal: string | null } {
  const page: string[] = [];
  const url = setupPageUrl(config);
  if (url != null) page.push(url);
  const ip = config.get('http:ip');
  const port = config.get('http:port');
  if (typeof ip === 'string' && ip !== '' && port != null) {
    const host = ip === '0.0.0.0' || ip === '::' ? '<this host>' : (ip.includes(':') ? `[${ip}]` : ip);
    const direct = `http://${host}:${port}/system/setup/`;
    if (!page.includes(direct)) page.push(direct);
  }
  return { page, portal: portalUrl(config) };
}

function pageHint (config: ConfigReader): string {
  const { page, portal } = setupAddresses(config);
  const where = [...page, ...(portal != null ? [portal] : [])];
  return where.length > 0 ? ` (setup page: ${where.join(' or ')})` : '';
}

/** The one marked block that shows a minted setup code. */
export function setupBlock (minted: MintedCode, config: ConfigReader, codeFile: string | null): string {
  const { page, portal } = setupAddresses(config);
  const rule = '='.repeat(72);
  const lines = [
    '',
    rule,
    '  PRYV SETUP CODE: one-time, valid until ' + iso(minted.expiresAt),
    '',
    '      ' + minted.display,
    '',
    '  Enter it on the built-in setup page of this core:',
    ...page.map((u) => '      ' + u),
    ...(portal != null ? ['  or in the administration portal:', '      ' + portal] : []),
    ...(codeFile != null ? ['  Also saved in ' + codeFile + ' (mode 0600, deleted once setup is done).'] : []),
    '  Lost it? ' + REPLACE_HINT + '.',
    rule,
    ''
  ];
  return lines.join('\n') + '\n';
}

function writeCodeFile (fs: FsLike, codeFile: string | null, minted: MintedCode, deps: SetupBootDeps): string | null {
  if (codeFile == null) return null;
  try {
    const { page, portal } = setupAddresses(deps.config);
    const text = [
      'Pryv setup code (one-time, valid until ' + iso(minted.expiresAt) + '):',
      minted.display,
      '',
      'Setup page: ' + [...page, ...(portal != null ? [portal] : [])].join(' or '),
      ''
    ].join('\n');
    // Created anew (never rewritten in place), so it is 0600 from its first byte.
    if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);
    fs.writeFileSync(codeFile, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(codeFile, 0o600);
    return codeFile;
  } catch (err) {
    deps.warn(`[setup] could not write ${codeFile}: ${(err as Error).message}`);
    return null;
  }
}

function removeCodeFile (fs: FsLike, codeFile: string | null, warn: (msg: string) => void): void {
  if (codeFile == null) return;
  try {
    if (fs.existsSync(codeFile)) fs.unlinkSync(codeFile);
  } catch (err) {
    warn(`[setup] could not delete the stale ${codeFile}: ${(err as Error).message}`);
  }
}
