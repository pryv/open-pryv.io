const errors = require('../../errors');

/** POST /sendmail/welcome - Send a welcome email. 
 */
async function sendMail(ctx, req, res) {
  const logger = ctx.logFactory('sendmail');
  
  const lang = req.params.lang;
  const template = req.params.template;
  const substitutions = req.body.substitutions;
  const recipient = req.body.to;
  const key = req.body.key;

  // If requested service is not authenticated, abort. 
  if(key !== ctx.authKey) {
    throw errors.forbidden('Authorization key is missing or invalid.');
  }

  // If params are not there, abort. 
  if (substitutions == null) throw errors.invalidRequestStructure('Missing substitution variables.');
  if (recipient == null) throw errors.invalidRequestStructure('Missing recipient.');
  if (recipient.email == null) throw errors.invalidRequestStructure('Missing recipient email.');
  if (recipient.name == null) throw errors.invalidRequestStructure('Missing recipient name.');
  
  const loadedTemplate = await ctx.templateRepository.find(template, lang);
  const result = await ctx.sender.renderAndSend(loadedTemplate, substitutions, recipient);
  
  logger.info('Email sent:', result);
  
  res
    .status(200)
    .json(result);
}

module.exports = sendMail;
