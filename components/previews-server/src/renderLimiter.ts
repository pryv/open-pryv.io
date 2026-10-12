/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Runs at most `max` tasks at once; the others wait their turn, first come
 * first served. A finishing task hands its slot to the next waiting one, so
 * a caller arriving in between cannot take it.
 */
type RenderLimiter = {
  run<T> (task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
};

function createRenderLimiter (max: number): RenderLimiter {
  const limit = (Number.isInteger(max) && max > 0) ? max : 1;
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    async run<T> (task: () => Promise<T>): Promise<T> {
      if (active < limit) {
        active++;
      } else {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      try {
        return await task();
      } finally {
        const next = queue.shift();
        if (next != null) next(); else active--;
      }
    },
    get active () { return active; },
    get waiting () { return queue.length; }
  };
}

export { createRenderLimiter };
export type { RenderLimiter };
