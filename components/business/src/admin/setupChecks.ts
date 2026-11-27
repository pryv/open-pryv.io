/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { describeAdminConfig, adminMfaRequired, portalUrl } from './config.ts';
import { deriveHostnames } from '../acme/deriveHostnames.ts';

/**
 * The checks summary of the setup step "Checks": read-only, from the
 * configuration and the state the caller reads (certificates, migrations).
 * It tells in particular what blocks DNS delegation and certificate issuance,
 * which is what an operator needs when the portal cannot be reached yet.
 *
 * `blocking`: setup can finish, but the platform will not serve as configured
 * until it is fixed. `warn`: worth fixing. `info`: what is configured.
 * No secret value is ever part of a check.
 */

type ConfigReader = { get: (key: string) => unknown };

export type SetupCheckStatus = 'ok' | 'info' | 'warn' | 'blocking';
export type SetupCheck = { id: string; status: SetupCheckStatus; title: string; detail: string };

export type SetupChecksInput = {
  config: ConfigReader;
  /** Certificates in the platform store (hostnames and expiry), or null when not readable. */
  certificates: Array<{ hostname?: string; expiresAt?: number }> | null;
  /** Migrations not applied yet, or null when not readable. */
  pendingMigrations: number | null;
  now: number;
};

const DAY_MS = 24 * 3600 * 1000;

function str (v: unknown): string | null {
  return typeof v === 'string' && v !== '' && v !== 'REPLACE ME' ? v : null;
}

function isHttps (url: string | null): boolean {
  return url != null && url.toLowerCase().startsWith('https://');
}

export function setupChecks (input: SetupChecksInput): SetupCheck[] {
  const { config } = input;
  const checks: SetupCheck[] = [];
  const add = (id: string, status: SetupCheckStatus, title: string, detail: string) => checks.push({ id, status, title, detail });

  // --- configuration of administration --- //
  const adminProblems = describeAdminConfig(config).problems;
  if (adminProblems.length > 0) {
    add('config', 'blocking', 'Administration configuration', adminProblems.map((p) => p.message).join('; '));
  } else {
    add('config', 'ok', 'Administration configuration', 'portal, setup and administrator session keys are valid.');
  }

  // --- topology and public address --- //
  const dnsLess = config.get('dnsLess:isActive') === true;
  const publicUrl = str(config.get('dnsLess:publicUrl'));
  const domain = str(config.get('dns:domain'));
  const coreUrl = str(config.get('core:url'));
  if (dnsLess) {
    if (publicUrl == null) {
      add('topology', 'blocking', 'Public address', 'dnsLess is on but dnsLess.publicUrl is not set: apps and the portal cannot address this platform.');
    } else {
      add('topology', isHttps(publicUrl) ? 'ok' : 'warn', 'Public address',
        `dnsLess: the API is served at ${publicUrl}` + (isHttps(publicUrl) ? '.' : ' (not HTTPS: browsers and apps expect HTTPS in production).'));
    }
  } else if (domain == null) {
    add('topology', 'blocking', 'Public address', 'Neither dnsLess.publicUrl (dnsLess) nor dns.domain is set: the platform has no public address.');
  } else {
    add('topology', 'info', 'Public address', `DNS topology: accounts are served at https://<username>.${domain}/` + (coreUrl != null ? `, this core at ${coreUrl}.` : '.'));
  }

  // --- DNS delegation (DNS topology) --- //
  if (!dnsLess && domain != null) {
    if (config.get('dns:active') === true) {
      const publicIp = str(config.get('dns:publicIp'));
      const coreIp = str(config.get('core:ip'));
      const answerIp = publicIp ?? coreIp;
      if (answerIp == null) {
        add('dns', 'blocking', 'DNS delegation', 'The embedded DNS server is on but neither dns.publicIp nor core.ip is set: it has no address to answer for this core, and certificate issuance is skipped.');
      } else {
        add('dns', 'info', 'DNS delegation',
          `At the registrar of ${domain}, the NS records must name this core's DNS server (glue address ${answerIp}); until the delegation is in place, ${domain} and its subdomains do not resolve and the DNS-01 certificate cannot be issued.`);
      }
      const port = Number(config.get('dns:port'));
      if (Number.isFinite(port) && port !== 53) {
        add('dns-port', 'warn', 'DNS port', `dns.port is ${port}: resolvers query port 53, so port 53 (UDP and TCP) of the public address must reach it (for example a Docker mapping 53:${port}).`);
      }
    } else {
      add('dns', 'info', 'DNS delegation', `DNS is served outside this core: ${domain} and *.${domain} must resolve to this core (or the proxy in front of it).`);
    }
  }

  // --- certificates --- //
  if (config.get('letsEncrypt:enabled') === true) {
    let derived: { commonName: string; challenge: string } | null = null;
    try {
      derived = deriveHostnames(config) as { commonName: string; challenge: string };
    } catch (err) {
      add('certificates', 'blocking', 'Certificates', `letsEncrypt is on but no hostname can be derived from the topology: ${(err as Error).message}`);
    }
    const atRestKey = config.get('letsEncrypt:atRestKey');
    if (typeof atRestKey !== 'string' || atRestKey === '' || atRestKey === 'REPLACE ME') {
      add('certificates-key', 'blocking', 'Certificate storage key', 'letsEncrypt.atRestKey is not set: certificates cannot be stored.');
    }
    if (derived != null) {
      const certs = input.certificates;
      const how = derived.challenge === 'dns-01'
        ? 'issued with a DNS-01 challenge, which needs the DNS delegation above to work'
        : 'issued with an HTTP-01 challenge, which needs port 80 of this host reachable from the internet';
      if (certs == null) {
        add('certificates', 'warn', 'Certificates', `${derived.commonName}: ${how}; the certificate list could not be read.`);
      } else if (certs.length === 0) {
        add('certificates', 'warn', 'Certificates', `No certificate issued yet for ${derived.commonName} (${how}).`);
      } else {
        const soonest = Math.min(...certs.map((c) => typeof c.expiresAt === 'number' ? c.expiresAt : Infinity));
        const days = Number.isFinite(soonest) ? Math.round((soonest - input.now) / DAY_MS) : null;
        add('certificates', days != null && days < 7 ? 'warn' : 'ok', 'Certificates',
          `${certs.length} certificate(s) stored` + (days != null ? `, the first expiring in ${days} day(s).` : '.'));
      }
    }
  } else {
    add('certificates', 'info', 'Certificates', 'letsEncrypt is off: TLS is terminated by this core\'s http.ssl settings or by a proxy in front of it.');
  }

  // --- migrations --- //
  if (input.pendingMigrations == null) {
    add('migrations', 'warn', 'Storage migrations', 'The migration status could not be read.');
  } else if (input.pendingMigrations > 0) {
    add('migrations', 'warn', 'Storage migrations', `${input.pendingMigrations} migration(s) not applied yet (see GET /system/migrations-status).`);
  } else {
    add('migrations', 'ok', 'Storage migrations', 'The storage schema is up to date.');
  }

  // --- first administrator --- //
  add('mfa', 'info', 'Second factor', adminMfaRequired(config)
    ? 'MFA is on: the first administrator signs in with a second factor (TOTP, enabled during setup if needed).'
    : 'MFA is off for administrators: they sign in with a password only.');
  const cfg = describeAdminConfig(config).value;
  add('registration', 'info', 'Registration while setup is pending', cfg.setup.registrationWhilePending === 'closed'
    ? 'Closed: only the first administrator\'s account can be created, from this setup.'
    : 'Open: anyone can register before setup is finished.');
  const portal = portalUrl(config);
  add('portal', 'info', 'Administration portal', portal != null
    ? `Configured at ${portal} (${cfg.portal.site != null ? `hosted site '${cfg.portal.site}'` : 'outside the platform, portal.url'}).`
    : 'No portal configured (portal.site and portal.url are null): this built-in page and the command line cover setup.');
  add('admin-key', 'info', 'Admin key scope', cfg.adminAccessKeyScope === 'break-glass'
    ? 'break-glass: the admin key reaches only the break-glass routes; administration goes through administrator sessions.'
    : 'full: the admin key still authenticates every /system route (auth.adminAccessKeyScope).');
  return checks;
}
