const errors = require('../errors');
const Template = require('./template.js').Template;

class TemplateRepository {
  constructor (defaultLanguage, templateExists) {
    this.defaultLanguage = defaultLanguage;
    this.templateExists = templateExists;
  }
  
  // (string, ?string) -> Template
  // 
  async find(mailType, requestedLanguage) {
    const candidateLanguages = [requestedLanguage, this.defaultLanguage];
    
    for (const currentLanguage of candidateLanguages) {
      if (currentLanguage == null) continue;
      
      const mailTemplate = await this.produceTemplate(mailType, currentLanguage);
      if (mailTemplate != null) return mailTemplate;
    }
    
    throw errors.unknownResource('No template found.');
  }
  
  // (string, string) -> ?Template
  // 
  async produceTemplate(mailType, language) {    
    const template = new Template(mailType, language, this.templateExists);
    if (! await template.exists()) return null;
    return template;
  }
  
}

module.exports = {
  TemplateRepository,
}
