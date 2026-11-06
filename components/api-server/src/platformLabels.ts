/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * The host labels the platform answers itself, never an account's: this
 * core's id, the service names (`reg`, `access`, `mfa`), this core's
 * `dns.staticEntries` names and hosted sites (from the configuration), and
 * every name the platform routes (core ids, static entries and issuer labels
 * of every core, runtime DNS records, hosted sites of every core: see
 * `Platform.isNameRoutedByPlatform`). One predicate for every reader: the
 * username-rewriter skips these labels, and a per-user OAuth audience never
 * names an address under one.
 *
 * Memory only (the platform keeps its names refreshed), no I/O. Before the
 * platform is initialised it answers from the configuration alone.
 */

import { ignoredUsernameSubdomains } from 'business/src/usernameSubdomains.ts';
import { platform } from 'platform';

type ConfigReader = { get: (key: string) => unknown };

/** The predicate for a configuration (read at each call: cheap, and current). */
export function platformRoutedLabels (config: ConfigReader): (label: string) => boolean {
  return function isPlatformRoutedLabel (label: string): boolean {
    if (typeof label !== 'string' || label === '') return false;
    const lower = label.toLowerCase();
    if (ignoredUsernameSubdomains(config).some((n) => String(n).toLowerCase() === lower)) return true;
    return platform.isNameRoutedByPlatform(lower);
  };
}
