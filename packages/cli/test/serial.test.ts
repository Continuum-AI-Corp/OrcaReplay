import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../src/serial.js';

describe('SerialQueue', () => {
  it('runs tasks strictly one at a time, in submission order', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    let concurrent = 0;
    let peak = 0;

    const task = (name: string, delay: number) => async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, delay));
      order.push(name);
      concurrent -= 1;
    };

    // Submitted fastest-last on purpose: without serialization 'c' would finish first.
    queue.push(task('a', 20));
    queue.push(task('b', 10));
    queue.push(task('c', 0));
    await queue.drain();

    expect(peak, 'two snapshots at once collide on git index.lock').toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps draining after a task rejects, and surfaces the error', async () => {
    const queue = new SerialQueue();
    const ran: string[] = [];

    queue.push(async () => {
      ran.push('first');
    });
    queue.push(async () => {
      throw new Error('boom');
    });
    queue.push(async () => {
      ran.push('third');
    });

    // One failed write must not silently drop every later event.
    await expect(queue.drain()).rejects.toThrow('boom');
    expect(ran).toEqual(['first', 'third']);
    expect(queue.errors().map(String).join()).toContain('boom');
  });

  it('drains cleanly when nothing was pushed', async () => {
    await expect(new SerialQueue().drain()).resolves.toBeUndefined();
  });

  it('accepts work pushed while a task is already running', async () => {
    const queue = new SerialQueue();
    const ran: string[] = [];
    queue.push(async () => {
      ran.push('outer');
      queue.push(async () => {
        ran.push('inner');
      });
    });
    await queue.drain();
    expect(ran).toEqual(['outer', 'inner']);
  });
});
