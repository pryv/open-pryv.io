
class Template {
  
  constructor (mailType, language, templateExists) {
    this.root = [mailType, language].join('/');
    this.templateExists = templateExists;
  }
  
  async exists() {
    
    const parts = ['subject.pug', 'html.pug'];
    
    for (const part of parts) {
      const currentPath = this.templatePath(part);
      if (! await this.templateExists(currentPath)) return false;
    }
    
    return true;
  }
  
  async executeSend(sendOp) {
    return await sendOp.sendMail(this.root);
  }
  
  templatePath(part) {
    return [this.root, part].join('/');
  }
}

module.exports = {
  Template,
}