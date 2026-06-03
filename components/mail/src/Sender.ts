/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


/**
 * Ported verbatim from the standalone service-mail repo. Wraps an
 * `email-templates` delivery instance (`deliveryService`) and orchestrates
 * the single-call render + send flow Template drives.
 */

interface Recipient {
  name: string;
  email: string;
}

type Substitutions = Record<string, unknown>;

interface DeliveryService {
  send: (opts: {
    message: { to: { name: string; address: string } };
    template: string;
    locals: Substitutions;
  }) => Promise<unknown>;
}

interface TemplateLike {
  executeSend: (op: SendOperation) => Promise<unknown>;
}

class Sender {
  deliveryService: DeliveryService;
  constructor (deliveryService: DeliveryService) {
    this.deliveryService = deliveryService;
  }

  async renderAndSend (template: TemplateLike, substitutions: Substitutions, recipient: Recipient): Promise<unknown> {
    const sendOp = new SendOperation(recipient, substitutions, this.deliveryService);
    return await template.executeSend(sendOp);
  }
}

class SendOperation {
  recipient: Recipient;
  substitutions: Substitutions;
  deliveryService: DeliveryService;
  constructor (recipient: Recipient, substitutions: Substitutions, deliveryService: DeliveryService) {
    this.recipient = recipient;
    this.substitutions = substitutions;
    this.deliveryService = deliveryService;
  }

  async sendMail (templateRoot: string): Promise<unknown> {
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

export { Sender };
