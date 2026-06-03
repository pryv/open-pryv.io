/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const errors = require('./errors.ts');
const { Template } = require('./Template.ts');

const { getLogger } = require('@pryv/boiler');
const logger = getLogger('mail-template-repository');

/**
 * Resolves a {mailType, requestedLanguage} pair to a `Template` whose
 * sources are known to exist. Falls back to the default language when the
 * requested one is missing. Existence is delegated to the caller via
 * `templateExists` — in the merged module this probes PlatformDB-backed
 * template rows; in the standalone service-mail origin it probed disk.
 */
type TemplateExistsFn = (mailType: string, language: string) => boolean | Promise<boolean>;
type TemplateLike = { exists: () => Promise<boolean> };

class TemplateRepository {
  defaultLanguage: string;
  templateExists: TemplateExistsFn;
  constructor (defaultLanguage: string, templateExists: TemplateExistsFn) {
    this.defaultLanguage = defaultLanguage;
    this.templateExists = templateExists;
  }

  async find (mailType: string, requestedLanguage: string): Promise<TemplateLike> {
    const candidateLanguages = [requestedLanguage, this.defaultLanguage];
    for (const currentLanguage of candidateLanguages) {
      if (currentLanguage == null) continue;
      const mailTemplate = await this.produceTemplate(mailType, currentLanguage);
      if (mailTemplate != null) return mailTemplate;
    }
    logger.error('Cannot find template', { mailType, requestedLanguage });
    throw errors.unknownResource('No template found.');
  }

  async produceTemplate (mailType: string, language: string): Promise<TemplateLike | null> {
    const template: TemplateLike = new Template(mailType, language, this.templateExists);
    if (!await template.exists()) return null;
    return template;
  }
}

export { TemplateRepository };
