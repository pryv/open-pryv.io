/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import type {} from 'node:fs';


/**
 * Plan 35 Phase 3 — thin wrapper around `acme-client` for the two
 * operations we actually need: create an ACME account, issue / renew a
 * cert. Stateless — no PlatformDB, no file I/O, no scheduling.
 *
 * Why wrap at all? `acme-client`'s API is small but we want:
 *   1. A stable input / output shape our renewer code can depend on
 *      even if `acme-client` refactors its internals.
 *   2. Injectable `acmeLib` so unit tests can exercise our glue without
 *      talking to a real ACME server.
 *   3. Direct output in the {certPem, chainPem, keyPem, issuedAt,
 *      expiresAt} shape PlatformDB's `setCertificate()` expects — we
 *      parse validity dates from the PEM up front.
 *
 * This module matches the pattern validated in `spike/level2-acme.js`
 * (which issued a real staging wildcard cert end-to-end), just
 * re-factored as two clean functions.
 */

const { splitCertChain, parseValidity } = require('./certUtils');

const DIRECTORY_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const DIRECTORY_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

/**
 * Create a new ACME account. Runs ONCE per cluster — the returned
 * `{accountKey, accountUrl}` pair is persisted (PlatformDB in our
 * case) and reused on every subsequent cert issuance. Fresh accounts
 * burn rate-limit quota.
 *
 * @param {Object} opts
 * @param {string} opts.email
 * @param {string} [opts.directoryUrl] - default: LE production
 * @param {Object} [opts.acmeLib]      - default: require('acme-client'); injectable for tests
 * @returns {Promise<{accountKey: string, accountUrl: string, email: string, directoryUrl: string}>}
 */
async function createAccount ({ email, directoryUrl, acmeLib }: any = {}) {
  if (!email) throw new Error('AcmeClient.createAccount: email is required');
  const lib = acmeLib || require('acme-client');
  const url = directoryUrl || DIRECTORY_PRODUCTION;

  const accountKey = await lib.crypto.createPrivateKey();
  const client = new lib.Client({ directoryUrl: url, accountKey });
  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: ['mailto:' + email]
  });

  return {
    accountKey: Buffer.isBuffer(accountKey) ? accountKey.toString() : accountKey,
    accountUrl: client.getAccountUrl(),
    email,
    directoryUrl: url
  };
}

/**
 * Issue (or renew — same thing from ACME's point of view) a cert.
 *
 * @param {Object} opts
 * @param {string} opts.commonName              - e.g. '*.mc.example.com'
 * @param {string[]} [opts.altNames=[]]         - SAN list, e.g. ['mc.example.com']
 * @param {Object} opts.account                 - { accountKey, accountUrl } from createAccount()
 * @param {Function} opts.challengeCreateFn     - (authz, challenge, keyAuthorization) => Promise
 * @param {Function} opts.challengeRemoveFn     - (authz, challenge, keyAuthorization) => Promise
 * @param {string[]} [opts.challengePriority]   - default ['dns-01']
 * @param {string}   [opts.directoryUrl]        - default: LE production
 * @param {Object}   [opts.acmeLib]             - default require('acme-client')
 * @returns {Promise<{
 *   commonName: string,
 *   altNames: string[],
 *   certPem: string,   // leaf only
 *   chainPem: string,  // issuer chain (possibly empty)
 *   keyPem: string,    // cert private key (PEM)
 *   issuedAt: number,
 *   expiresAt: number
 * }>}
 */
async function issueCert (opts: any = {}) {
  const {
    commonName, altNames = [], account,
    challengeCreateFn, challengeRemoveFn,
    challengePriority = ['dns-01'],
    directoryUrl, acmeLib
  } = opts;

  if (!commonName) throw new Error('AcmeClient.issueCert: commonName is required');
  if (!account || !account.accountKey || !account.accountUrl) {
    throw new Error('AcmeClient.issueCert: account {accountKey, accountUrl} is required');
  }
  if (typeof challengeCreateFn !== 'function' || typeof challengeRemoveFn !== 'function') {
    throw new Error('AcmeClient.issueCert: challengeCreateFn and challengeRemoveFn are required');
  }

  const lib = acmeLib || require('acme-client');
  const url = directoryUrl || DIRECTORY_PRODUCTION;
  const client = new lib.Client({
    directoryUrl: url,
    accountKey: account.accountKey,
    accountUrl: account.accountUrl
  });

  const [certKey, csr] = await lib.crypto.createCsr({
    commonName,
    altNames: altNames.length > 0 ? altNames : undefined
  });

  const bundlePem = await client.auto({
    csr,
    challengePriority,
    challengeCreateFn,
    challengeRemoveFn
  });

  const { leafPem, chainPem } = splitCertChain(bundlePem);
  const { issuedAt, expiresAt } = parseValidity(leafPem);

  return {
    commonName,
    altNames,
    certPem: leafPem,
    chainPem,
    keyPem: Buffer.isBuffer(certKey) ? certKey.toString() : certKey,
    issuedAt,
    expiresAt
  };
}

module.exports = {
  DIRECTORY_STAGING,
  DIRECTORY_PRODUCTION,
  createAccount,
  issueCert
};
