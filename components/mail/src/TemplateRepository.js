/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

const errors = require('./errors');
const Template = require('./Template');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail-template-repository');

/**
 * Resolves a {mailType, requestedLanguage} pair to a `Template` whose
 * sources are known to exist. Falls back to the default language when the
 * requested one is missing. Existence is delegated to the caller via
 * `templateExists` — in the merged module this probes PlatformDB-backed
 * template rows; in the standalone service-mail origin it probed disk.
 */
class TemplateRepository {
  constructor (defaultLanguage, templateExists) {
    this.defaultLanguage = defaultLanguage;
    this.templateExists = templateExists;
  }

  async find (mailType, requestedLanguage) {
    const candidateLanguages = [requestedLanguage, this.defaultLanguage];
    for (const currentLanguage of candidateLanguages) {
      if (currentLanguage == null) continue;
      const mailTemplate = await this.produceTemplate(mailType, currentLanguage);
      if (mailTemplate != null) return mailTemplate;
    }
    logger.error('Cannot find template', { mailType, requestedLanguage });
    throw errors.unknownResource('No template found.');
  }

  async produceTemplate (mailType, language) {
    const template = new Template(mailType, language, this.templateExists);
    if (!await template.exists()) return null;
    return template;
  }
}

module.exports = TemplateRepository;
