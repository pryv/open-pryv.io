/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

module.exports = [
  {
    id: 'u_0',
    username: 'userzero',
    password: 't3st-Z3r0',
    email: 'zero@test.com',
    language: 'en',
    storageUsed: {
      // values are incorrect but that doesn't matter for tests
      dbDocuments: 0,
      attachedFiles: 275076
    }
  },
  {
    id: 'u_1',
    username: 'userone',
    password: 't3st-0n3',
    email: 'one@test.com',
    language: 'fr'
  },
  {
    id: 'u_2',
    username: '00000',
    password: 't3st-Numb3r',
    email: '00000@test.com',
    language: 'en'
  },
  // auditing
  {
    id: 'u_3',
    username: 'auditorUser',
    password: 't3st-tHr3e',
    email: 'auditor@test.com',
    language: 'en'
  },
  // websockets dash user
  {
    id: 'u_4',
    username: 'user-four',
    password: 't3st-f0uR',
    email: 'user-three@test.com',
    language: 'en'
  }
  // user with system stream permission accesses
  /* { // used to generate dump 1.7.1 - to remove when finished
    id: 'u_5',
    username: 'user-system-perms',
    password: 'walalala',
    email: 'user-system@pryv.com',
    language: 'en',
  }, */
];
