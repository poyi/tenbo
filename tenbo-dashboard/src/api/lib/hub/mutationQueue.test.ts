import { describe, it, expect } from 'vitest';
import { enqueueMutation, flushMutationQueue } from './mutationQueue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('enqueueMutation', () => {
  it('applies queued work strictly in arrival order even when later work resolves faster', async () => {
    const order: number[] = [];

    // Enqueue 5 tasks with DESCENDING artificial delay — task 0 is slowest,
    // task 4 is fastest. If the queue did not serialize, task 4 would finish
    // first. A correct promise-chain mutex still runs them in arrival order
    // because each waits for the previous to *start and finish*, not just
    // for its own delay.
    const promises = [0, 1, 2, 3, 4].map((i) =>
      enqueueMutation(async () => {
        await delay((4 - i) * 5);
        order.push(i);
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not let one rejected mutation stall or corrupt the queue for later ones', async () => {
    const order: string[] = [];

    const first = enqueueMutation(async () => {
      order.push('first-start');
      throw new Error('boom');
    });
    const second = enqueueMutation(async () => {
      order.push('second');
      return 'second-result';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('second-result');
    expect(order).toEqual(['first-start', 'second']);
  });

  it('runs synchronous (non-async) work through the same serialized chain', async () => {
    const order: number[] = [];
    const promises = [0, 1, 2].map((i) => enqueueMutation(() => { order.push(i); return i; }));
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2]);
  });

  it('flushMutationQueue resolves once all enqueued work has settled', async () => {
    const order: number[] = [];
    enqueueMutation(async () => { await delay(5); order.push(1); });
    enqueueMutation(async () => { await delay(1); order.push(2); });

    await flushMutationQueue();
    expect(order).toEqual([1, 2]);
  });
});
