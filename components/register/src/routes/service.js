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
const _ = require('lodash');
const appsList = require('../config').get('appList');
const messages = require('../utils/messages');
const dataservers = require('../business/dataservers');

const info = require('../business/service-info');

/**
 * Routes that provide information about the service and its applications
 * @param app
 */
module.exports = function (app) {
  /**
   * GET /service/info: retrieve service information
   * (version, name, terms, register/access/api url, etc...)
   */
  app.get('/service/info', function (req, res) {
    res.json(info);
  });

  // Old route, we keep it for backward compatibility
  // but we should remove it
  app.get('/service/infos', function (req, res) {
    res.json(info);
  });

  /**
   * GET /apps: retrieve the list of applications linked to this service
   */
  app.get('/apps', function (req, res) {
    const data = [];
    Object.keys(appsList).forEach(function (appid) {
      const appData = { id: appid };
      _.extend(appData, appsList[appid]);
      data.push(appData);
    });

    res.json({ apps: data });
  });

  /**
   * GET /apps/:appid: retrieve specific information about specified application
   */
  app.get('/apps/:appid', function (req, res, next) {
    const appid = req.params.appid;
    if (!appid) {
      return next(
        messages.e(400, 'INVALID_DATA', { message: 'missing appid' })
      );
    }

    const appData = { id: appid };
    _.extend(appData, appsList[appid]);
    if (!appData) {
      return next(
        messages.e(400, 'INVALID_DATA', { message: 'unknown appid : ' + appid })
      );
    }

    res.json({ app: appData });
  });

  /**
   * GET /hostings:  get the list of available hostings
   */
  app.get('/hostings', function (req, res) {
    res.json(dataservers.getHostings());
  });
};
