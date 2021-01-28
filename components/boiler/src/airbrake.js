/**
 * @license
 * Copyright (c) 2020 Pryv S.A. https://pryv.com
 * 
 * This file is part of Open-Pryv.io and released under BSD-Clause-3 License
 * 
 * Redistribution and use in source and binary forms, with or without 
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, 
 *    this list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice, 
 *    this list of conditions and the following disclaimer in the documentation 
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its contributors 
 *    may be used to endorse or promote products derived from this software 
 *    without specific prior written permission.
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
 * 
 */


const { Notifier } = require('@airbrake/node');

let airbrake;
let logger;

function setUpAirbrakeIfNeeded(config, rootLogger) {
  if (airbrake) {   
    rootLogger.debug('Skipping airBrake setup (already done)');
    return;
  }
  logger = rootLogger;

  const airBrakeSettings = config.get('logs:airbrake');
  if (airBrakeSettings.active) {
    airbrake = new Notifier({
      projectId: airBrakeSettings.projectId,
      projectKey: airBrakeSettings.key,
      environment: 'production',
    });
    logger.debug('Airbrake active with projectId: ', airBrakeSettings);
  }
  

  // Catch uncaught Promise rejections
  process.on('unhandledRejection', (reason) => {
    throw reason;
  });

  // Catch uncaught Exceptions
  process.on('uncaughtException', async (error) => {
    logger.error('uncaughtException', error);
    await notifyAirbrake(error);
    if (process.env.NODE_ENV !== 'test') process.exit(1);
  });

}

async function notifyAirbrake() {
  if (airbrake != null && typeof airbrake.notify === 'function') {
    await airbrake.notify(...arguments);
  } else {
    logger.debug('Skipping notifyAirbake', ...arguments);
  }
}

module.exports = {
  setUpAirbrakeIfNeeded: setUpAirbrakeIfNeeded,
  notifyAirbrake: notifyAirbrake
}