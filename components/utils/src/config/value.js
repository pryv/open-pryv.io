// @flow

// Encapsulates values that are obtained from the configuration (file/...) using
// a convict configuration for this project. 
// Example: 
// 
//   var settings = Settings.load(); 
//   var value = settings.get('logs.console.active');
//   value.bool() //=> true (or a type error)
// 
export interface ConfigValue {
  bool(): boolean;
  str(): string;
  num(): number;
  obj(): {};
  fun(): (...a: Array<mixed>) => void;
  
  exists(): boolean;
  blank(): boolean;
}

class ExistingValue implements ConfigValue {
  name: string; 
  value: mixed; 
  
  constructor(name: string, value: mixed) {
    this.name = name; 
    this.value = value; 
  }
  
  // REturns the configuration value as a boolean. 
  // 
  bool(): boolean {
    const value = this.value; 
    if (typeof value === 'boolean') {
      return value; 
    }
    
    throw this._typeError('boolean');
  }
  
  /** 
   * Returns the configuration value as a string. 
   */
  str(): string {
    const value = this.value; 
    if (typeof value === 'string') {
      return value; 
    }
    
    throw this._typeError('string');
  }
  
  /** 
   * Returns the configuration value as a number. 
   */
  num(): number {
    const value = this.value; 
    if (typeof value === 'number') {
      return value; 
    }
    
    throw this._typeError('number');
  }
  
  /** 
   * Returns the configuration value as an unspecified object. 
   */
  obj(): {} {
    const value = this.value; 
    
    // NOTE Flow doesn't want values to be null, that's why the second check is
    // also needed. (typeof null === 'object'...)
    if (typeof value === 'object' && value != null) {
      return value; 
    }
    
    throw this._typeError('object');
  }

  /** 
   * Returns the configuration value as an unspecified object. 
   */
  fun(): (...a: Array<mixed>) => void {
    const value = this.value;  
    
    if (typeof value === 'function') {
      return value; 
    }
    
    throw this._typeError('function');
  }
  
  // Returns true if the value exists, meaning that it is not null or undefined.
  // 
  exists(): boolean {
    const value = this.value;  

    return value != null; 
  }
  
  // Returns true if the value is either null, undefined or the empty string. 
  // 
  blank(): boolean {
    const value = this.value;  

    return !this.exists() || value === ''; 
  }
  
  _typeError(typeName: string) {
    const name = this.name; 
        
    return new Error(
      `Configuration value type mismatch: ${name} should be of type ${typeName}, but isn't. `+
      `(typeof returns '${typeof this.value}')`); 
  }
}

class MissingValue implements ConfigValue {
  // NOTE maybe we should define a common interface rather than inheriting 
  //   in this way. Oh well.
  
  message: string; 
  
  constructor(key: string) {
    this.message = `Configuration for '${key}' missing.`;
  }
  
  error() {
    return new Error(this.message);
  }
  
  bool(): boolean {
    throw this.error(); 
  }
  str(): string {
    throw this.error(); 
  }
  num(): number {
    throw this.error(); 
  }
  obj(): {} {
    throw this.error(); 
  }
  fun(): (...a: Array<mixed>) => void {
    throw this.error(); 
  }
  
  exists(): false {
    return false; 
  }
  blank(): true {
    return true; 
  }
}

module.exports = {
  ExistingValue, MissingValue
};