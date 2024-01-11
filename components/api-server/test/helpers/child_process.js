/**
 * @license
 * Copyright (C) 2020–2024 Pryv S.A. https://pryv.com
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
const Server = require('../../src/server');
const { getApplication } = require('api-server/src/application');
const ChildProcess = require('test-helpers').child_process;
const { getLogger, getConfig } = require('@pryv/boiler');
const logger = getLogger('child_process');

class ApplicationLauncher {
  app;
  constructor () {
    this.app = null;
  }

  /**
   * @param {any} injectSettings
   * @returns {Promise<any>}
   */
  async launch (injectSettings) {
    try {
      logger.debug('launch with settings', injectSettings);
      const config = await getConfig();
      // directly inject settings in nconf // to be updated to
      config.injectTestConfig(injectSettings);
      const app = (this.app = getApplication());
      await app.initiate();
      const server = new Server();
      return server.start();
    } catch (e) {
      // this is necessary for debug process as Error is not forwarded correctly
      logger.error('Error during child_process.launch()', e);
      throw e; // foward error
    }
  }
}
const appLauncher = new ApplicationLauncher();
const clientProcess = new ChildProcess(appLauncher);
clientProcess.run();
