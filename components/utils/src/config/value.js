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