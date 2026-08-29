/**
 * A one-at-a-time work queue for trace writes.
 *
 * The recorder is driven by proxy callbacks, which arrive whenever an exchange completes. Running
 * those handlers concurrently is not merely untidy: each one snapshots the workspace, and two
 * overlapping `git add` invocations collide on `index.lock` and fail. Serializing also keeps
 * `seq` in the order exchanges actually happened, which the whole format depends on.
 *
 * A failing task must not stall or silently empty the queue — one bad write should cost one event,
 * not the rest of the run — so errors are collected and re-thrown at `drain()`.
 */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #errors: unknown[] = [];

  push(task: () => Promise<void>): void {
    this.#tail = this.#tail.then(
      () => task().catch((err: unknown) => void this.#errors.push(err)),
      () => task().catch((err: unknown) => void this.#errors.push(err)),
    );
  }

  /** Wait for everything queued so far, including work queued by those tasks. */
  async drain(): Promise<void> {
    let previous: Promise<void> | undefined;
    // A task may enqueue more work, so keep waiting until the tail stops moving.
    while (previous !== this.#tail) {
      previous = this.#tail;
      await previous;
    }
    const [first] = this.#errors;
    if (first !== undefined) throw first instanceof Error ? first : new Error(String(first));
  }

  errors(): unknown[] {
    return this.#errors.slice();
  }
}
