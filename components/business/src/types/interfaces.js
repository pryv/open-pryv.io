/**
 * @license
 * Copyright (C) 2020-2021 Pryv S.A. https://pryv.com 
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
 */
// @flow

// Event type: One of two, simple or complex. If it is simple, then the only 
// 'property' that needs to be given is called 'value'. If not simple, then 
// some fields are required and some optional. Call `forField` with a valid
// field name to get a property type. 
// 
export interface EventType {
  // Returns this types official name ('mass/kg'). 
  // 
  typeName(): string; 
  
  // Returns a type to use for coercion of field named `name`.
  // 
  forField(name: string): PropertyType; 
  
  // Returns a list of required fields in no particular order (a Set).
  // 
  requiredFields(): Array<string>; 
  
  // Returns a list of optional fields in no particular order. 
  // 
  optionalFields(): Array<string>; 
  
  // Returns a list of all fields, optional and mandatory. 
  // 
  fields(): Array<string>; 
  
  // Returns true if this type represents a series of another type. 
  // 
  isSeries(): boolean; 

  // Call the validator with this types schema. 
  // 
  callValidator(
    validator: Validator, 
    content: Content
  ): Promise<Content>;
}

// A single property of a type has a type that can be applied to incoming
// values.  
// 
export interface PropertyType {
  // Coerces the value given into this type. If the input value cannot be
  // coerced, an error will be thrown. 
  // 
  // @throws {InputTypeError} Type after coercion must be valid for this column.
  //
  coerce(value: any): any; 
}

export interface Validator {
  
  // Validate `content` using the JSON schema `schema`. If needed, perform 
  // value coercion to allow the content to pass verification. Coerced value
  // is returned in the promise. 
  //
  validateWithSchema(
    content: Content, schema: any)
    : Promise<Content>;
}

export type Content = Object | string | number | boolean;
