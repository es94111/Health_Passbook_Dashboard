import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<boolean>();
const active = new Set<Promise<void>>();
let maintenance: Promise<void> = Promise.resolve();

/** Ordinary operations may overlap, but never overlap a backup transaction. */
export async function withDataAccess<T>(fn: () => Promise<T>): Promise<T> {
  if (context.getStore()) return fn();
  for (;;) {
    const barrier = maintenance;
    await barrier;
    if (barrier === maintenance) break;
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  active.add(done);
  try {
    return await context.run(true, fn);
  } finally {
    active.delete(done);
    release();
  }
}

/** Drain in-flight operations and block new ones until export/restore finishes. */
export async function withDataMaintenance<T>(fn: () => Promise<T>): Promise<T> {
  const previous = maintenance;
  let release!: () => void;
  maintenance = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  await Promise.all(active);
  try {
    return await context.run(true, fn);
  } finally {
    release();
  }
}
