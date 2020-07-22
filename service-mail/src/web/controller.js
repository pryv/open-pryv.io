// ----------------------------------------------- (sync) express error handling

function mount(ctx, handler) {
  return catchAndNext(
    handler.bind(null, ctx)); 
}

function catchAndNext(handler) {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    }
    catch (err) {
      // TODO: parse error into API errors (remove stack trace, log)
      next(err);
    }
  };
}

// --------------------------------------------------------------------- factory

module.exports = function (ctx) {
  return {
    sendMail: mount(ctx, require('./op/send_mail'))
  };
};