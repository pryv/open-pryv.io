/**
 * @license
 * Copyright (C) 2020–2025 Pryv S.A. https://pryv.com
 *
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */
const EmailTemplates = require('email-templates');
const TemplateRepository = require('./mail/TemplateRepository.js');
const Sender = require('./mail/Sender');

// Application context object, holding references to all major subsystems. Once
// the system is initialized, these instance references will not change anymore
// and together make up the configuration of the system.
//
class Context {
  constructor (settings, logger) {
    this.logger = logger;
    const defaultLanguage = this.defaultLanguage = settings.get('templates:defaultLang');

    this.authKey = settings.get('http:auth');

    const delivery = this.deliveryService = this.configureDelivery(settings, logger);
    this.templateRepository = new TemplateRepository(defaultLanguage, delivery.templateExists);
    this.sender = new Sender(delivery);
  }

  configureTransport (settings, logger) {
    if (settings.get('sendmail:active')) {
      // Using sendmail command
      logger.info('Using sendmail command to send emails.');
      return {
        sendmail: true,
        path: settings.get('sendmail:path')
      };
    } else {
      // Using SMTP
      logger.info('Using SMTP to send emails.');
      return settings.get('smtp');
    }
  }

  configureDelivery (settings, logger) {
    const emailSettings = settings.get('email');
    const templatesSettings = settings.get('templates');
    const transportSettings = this.configureTransport(settings, logger);

    return new EmailTemplates({
      message: emailSettings.message,
      views: templatesSettings,
      transport: transportSettings,
      // If true, it will open a webpage with a preview
      preview: emailSettings.preview,
      // Activate/deactivate the actual sending (prod/test env)
      send: emailSettings.send
    });
  }
}

module.exports = Context;
