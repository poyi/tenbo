/**
 * mutationQueue.ts — in-process promise-chain mutex enforcing write ordering
 * for the hub's mutations.
 *
 * Today's `/api/hub/mutate` handler awaits each request's `applyMutation`
 * call fully before responding (fully synchronous read-modify-write over
 * `roadmapStore`), so there is no present-day race to fix — Node's single
 * event loop already serializes it. `enqueueMutation` exists to make that
 * ordering *structural* rather than incidental: every call is appended to a
 * single promise chain, so the N-th mutation does not start running until
 * the (N-1)-th has fully settled, regardless of how the handler is written.
 * This is load-bearing for future async mutation paths (e.g. td-030's
 * append-only event journal writes) where an `await` inside the mutation
 * body would otherwise let a second request interleave mid-mutation. (A
 * per-file queue would allow more parallelism across unrelated files, but a
 * single global queue is simpler and roadmap mutations are not
 * high-frequency enough to need it.)
 */

let tail: Promise<unknown> = Promise.resolve();

export function enqueueMutation<T>(fn: () => T | Promise<T>): Promise<T> {
  const result = tail.then(fn);
  // Keep the chain alive even when a mutation throws — swallow here so one
  // failed mutation doesn't permanently stall the queue for later callers.
  // The real rejection is still delivered to the caller via `result`.
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Test-only: wait for everything enqueued so far to settle. */
export function flushMutationQueue(): Promise<unknown> {
  return tail;
}
