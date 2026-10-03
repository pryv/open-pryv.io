/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { hostedSiteNames } from './hostedSites.ts';

type ConfigReader = { get: (key: string) => unknown };

/**
 * Whether the first label of the Host names a user (`alice.pryv.me`), so that
 * the username-rewriter (middleware `subdomainToPath`) must run. In dnsLess
 * mode the username is always in the path and the host is the core's own
 * public name, whose first label may well look like a username
 * (`api-core1.example.com`): rewriting it would turn `/alice/events` into
 * `/api-core1/alice/events`. The API server and the HFS worker must agree.
 */
function usernameInHost (config: ConfigReader): boolean {
  return !config.get('dnsLess:isActive');
}

/**
 * Host first labels that are never usernames when `usernameInHost`: the core's
 * own subdomain in multi-core mode, the distribution's reserved service names
 * (reg, access, mfa), operator `dns.staticEntries` names, and hosted-site names.
 */
function ignoredUsernameSubdomains (config: ConfigReader): string[] {
  const coreId = config.get('core:id') as string | undefined;
  const ignored: string[] = coreId && coreId !== 'single' ? [coreId] : [];
  for (const name of ['reg', 'access', 'mfa']) {
    if (!ignored.includes(name)) ignored.push(name);
  }
  const staticEntries = (config.get('dns:staticEntries') || {}) as Record<string, unknown>;
  for (const name of Object.keys(staticEntries)) {
    if (!ignored.includes(name)) ignored.push(name);
  }
  for (const name of hostedSiteNames(config)) {
    if (!ignored.includes(name)) ignored.push(name);
  }
  return ignored;
}

export { usernameInHost, ignoredUsernameSubdomains };
