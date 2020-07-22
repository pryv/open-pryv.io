const emailTemplates = require('email-templates');
const TemplateRepository = require('./mail/template_repository.js').TemplateRepository;
const Sender = require('./mail/sender.js').Sender;

// Application context object, holding references to all major subsystems. Once
// the system is initialized, these instance references will not change anymore
// and together make up the configuration of the system.  
// 
class Context {
  
  constructor(settings, logFactory) {
    const logger = this.logger = logFactory('context');
    const defaultLanguage = this.defaultLanguage = settings.get('templates.defaultLang');
    
    this.logFactory = logFactory;
    this.authKey = settings.get('http.auth');
    
    const delivery = this.deliveryService = this.configureDelivery(settings, logger);
    this.templateRepository = new TemplateRepository(defaultLanguage, delivery.templateExists);
    this.sender = new Sender(delivery);
  }
  
  configureTransport (settings, logger) {
    // Using sendmail command
    if(settings.get('sendmail.active')) {
      logger.info('Using sendmail command to send emails.');
      return {
        sendmail: true,
        path: settings.get('sendmail.path')
      };
    }
    // Using SMTP
    else {
      logger.info('Using SMTP to send emails.');
      return settings.get('smtp');
    }
  }
  
  configureDelivery(settings, logger) {
    const emailSettings = settings.get('email');
    const templatesSettings = settings.get('templates');
    const transportSettings = this.configureTransport(settings, logger);

    return new emailTemplates({
      message: emailSettings.message,
      views: templatesSettings,
      transport: transportSettings,
      // If true, it will open a webpage with a preview
      preview: emailSettings.preview,
      // Activate/deactivate the actual sending (prod/test env)
      send: emailSettings.send
    });
  }
  
}
module.exports = Context;
