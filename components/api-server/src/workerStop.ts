/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * What an API worker finishes before it ends on SIGTERM or SIGINT.
 *
 * A signal listener replaces Node's default exit: the signal is raised again,
 * once, when every task is done or after a bound (inside the master's own,
 * see masterShutdown.ts). One hook for all the tasks: two listeners each
 * raising the signal again would cut each other short. Without a task, no
 * listener: the worker ends as it would.
 */

type Task = () => unknown;
type ProcessLike = {
  pid: number;
  once: (signal: NodeJS.Signals, listener: () => void) => unknown;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
};

const BOUND_MS = 2_000;
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

function createWorkerStop (proc: ProcessLike = process, boundMs = BOUND_MS): { onWorkerStop: (name: string, task: Task) => void } {
  const tasks = new Map<string, Task>();
  let hooked = false;
  let left = false;
  let stopping = false;

  function stop (signal: NodeJS.Signals): void {
    const leave = () => {
      if (left) return;
      left = true;
      proc.kill(proc.pid, signal);
    };
    if (stopping) return leave(); // the other signal meanwhile: now
    stopping = true;
    const bound = setTimeout(leave, boundMs);
    Promise.allSettled([...tasks.values()].map(async (task) => await task()))
      .finally(() => { clearTimeout(bound); leave(); });
  }

  /** Registers a task; the same name again replaces it. */
  function onWorkerStop (name: string, task: Task): void {
    tasks.set(name, task);
    if (hooked) return;
    hooked = true;
    for (const signal of SIGNALS) proc.once(signal, () => stop(signal));
  }

  return { onWorkerStop };
}

const { onWorkerStop } = createWorkerStop();

export { onWorkerStop, createWorkerStop };
