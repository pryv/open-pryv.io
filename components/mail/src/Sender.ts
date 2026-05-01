/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import type {} from 'node:fs';

/**
 * Ported verbatim from the standalone service-mail repo. Wraps an
 * `email-templates` delivery instance (`deliveryService`) and orchestrates
 * the single-call render + send flow Template drives.
 */
class Sender {
  deliveryService: any;
  constructor (deliveryService) {
    this.deliveryService = deliveryService;
  }

  async renderAndSend (template, substitutions, recipient) {
    const sendOp = new SendOperation(recipient, substitutions, this.deliveryService);
    return await template.executeSend(sendOp);
  }
}

class SendOperation {
  recipient: any;
  substitutions: any;
  deliveryService: any;
  constructor (recipient, substitutions, deliveryService) {
    this.recipient = recipient;
    this.substitutions = substitutions;
    this.deliveryService = deliveryService;
  }

  async sendMail (templateRoot) {
    return await this.deliveryService.send({
      message: {
        to: {
          name: this.recipient.name,
          address: this.recipient.email
        }
      },
      template: templateRoot,
      locals: this.substitutions
    });
  }
}

module.exports = Sender;
