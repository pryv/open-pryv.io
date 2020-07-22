const path = require('path');
const express = require('express');

const headPath = require('components/api-server/src/routes/Paths').WWW;
const publicHtml = path.resolve(__dirname, '../../../../public_html');


module.exports = async (expressApp, application) => {
  expressApp.use(headPath, express.static(publicHtml));
  // register all www routes
  expressApp.all(headPath + '/*', function (req, res, next) {
    res.status(404).send({ id: 'unkown-route', message: 'Unknown route: ' + req.path });
  });
}