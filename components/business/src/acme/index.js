/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const AtRestEncryption = require('./AtRestEncryption');
const AcmeClient = require('./AcmeClient');
const certUtils = require('./certUtils');
const { CertRenewer, PlatformDBDnsWriter, acmeChallengeName, AT_REST_PURPOSE } = require('./CertRenewer');
const { FileMaterializer, runRotateScript } = require('./FileMaterializer');
const { deriveHostnames } = require('./deriveHostnames');
const { AcmeOrchestrator, build: buildAcmeOrchestrator } = require('./AcmeOrchestrator');

module.exports = {
  AtRestEncryption,
  AcmeClient,
  certUtils,
  CertRenewer,
  PlatformDBDnsWriter,
  acmeChallengeName,
  AT_REST_PURPOSE,
  FileMaterializer,
  runRotateScript,
  deriveHostnames,
  AcmeOrchestrator,
  buildAcmeOrchestrator
};
