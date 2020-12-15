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
const ErrorIds = require('./ErrorIds');
/**
 * Identifier constants for API errors' messages.
 */
const ErrorMessages = {

  /**
   * Invitation token validation in the service-register
   */
  // ErrorIds.
  [ErrorIds.InvalidInvitationToken]: 'Invalid invitation',
  [ErrorIds.InvalidUsername]: 'Username should have from 5 to 23 characters and contain lowercase letters or numbers or dashes',
  [ErrorIds.UsernameRequired]: 'Username is required',
  [ErrorIds.InvalidEmail]: 'Invalid email',
  [ErrorIds.InvalidLanguage]: 'Invalid language',
  [ErrorIds.InvalidAppId]: 'Invalid app Id',
  [ErrorIds.Invalidreferer]: 'Invalid referer',
  [ErrorIds.InvalidInvitationToken]: 'Invalid invitation token',
  [ErrorIds.MissingRequiredField]: 'Missing required field',
  [ErrorIds.DeniedStreamAccess]: 'It is forbidden to access this stream.',
  [ErrorIds.TooHighAccessForAccountStreams]: 'Only read and contribute acceesses are allowed for the account sterams',
  [ErrorIds.EmailRequired]: 'Email is required',
  [ErrorIds.PasswordRequired]: 'Password is required',
  [ErrorIds.InvalidPassword]: 'Password should have from 5 to 23 characters',
  [ErrorIds.ForbiddenMultipleAccountStreams]: 'Event cannot be part of multiple account streams.',
  [ErrorIds.ForbiddenNoneditableAccountStreamsEdit]: 'Forbidden event modification, you are trying to edit a system event or trying to delete active system event.',
  [ErrorIds.ForbiddenNoneditableAccountStreamsEventsDeletion]: 'It is forbidden to delete non-editable or active system events.',
  [ErrorIds.ForbiddenToChangeAccountStreamId]: 'It is forbidden to change system stream id.',
  [ErrorIds.ForbiddenAccountStreamsActions]: 'It is forbidden to modify system streams.',
  [ErrorIds.ForbiddenAccountStreamsEventDeletion]: 'It is forbidden to delete non-editable or active system events.',
  [ErrorIds.ForbiddenToEditNoneditableAccountFields]: 'It is forbidden to edit non-editable acccount fields.',
  [ErrorIds.UnexpectedError]: 'Unexpected error',
  [ErrorIds.NewPasswordFieldIsRequired]: 'newPassword field is required.',
};
Object.freeze(ErrorMessages);

module.exports = ErrorMessages;