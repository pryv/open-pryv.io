module.exports = function index(expressApp) {

  expressApp.options('*', function (req, res /*, next*/) {
    // common headers (e.g. CORS) are handled in related middleware
    res.sendStatus(200);
  });

};
module.exports.injectDependencies = true;
