/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const accessesMod = require('./accesses');
const accesses = accessesMod.default ?? accessesMod;
const profile = [
  {
    id: 'public',
    data: {
      keyOne: 'value One',
      keyTwo: 2,
      keyThree: true,
      keyFour: [1, 2, 3, 4],
      keyFive: { giveMe: 5 }
    }
  },
  {
    id: 'private',
    data: {
      keyOne: 'value One',
      keyTwo: 2,
      keyThree: true,
      keyFour: [1, 2, 3, 4],
      keyFive: { giveMe: 5 }
    }
  },
  {
    id: accesses[4].name, // app profile
    data: {
      keyOne: 'value One',
      keyTwo: 2,
      keyThree: true,
      keyFour: [1, 2, 3, 4],
      keyFive: { giveMe: 5 }
    }
  }
];

export default profile;
export { profile };
