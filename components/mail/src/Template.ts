/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */


import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/**
 * Ported verbatim from the standalone service-mail repo. Represents a
 * single {type, language} template; presence is probed via the injected
 * `templateExists` function (disk in service-mail, PlatformDB here).
 */
type TemplateExistsFn = (path: string) => boolean | Promise<boolean>;
type SendOpLike = { sendMail: (root: string) => Promise<unknown> };

class Template {
  root: string;
  templateExists: TemplateExistsFn;
  constructor (mailType: string, language: string, templateExists: TemplateExistsFn) {
    this.root = [mailType, language].join('/');
    this.templateExists = templateExists;
  }

  async exists (): Promise<boolean> {
    const parts = ['subject.pug', 'html.pug'];
    for (const part of parts) {
      if (!await this.templateExists(this.templatePath(part))) return false;
    }
    return true;
  }

  async executeSend (sendOp: SendOpLike): Promise<unknown> {
    return await sendOp.sendMail(this.root);
  }

  templatePath (part: string): string {
    return [this.root, part].join('/');
  }
}

export { Template };
