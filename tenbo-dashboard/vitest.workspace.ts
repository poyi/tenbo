import { defineWorkspace } from 'vitest/config';
import { configDefaults } from 'vitest/config';

/**
 * td-035 — live-server hub tests flake under parallel vitest execution.
 *
 * `scripts/item.hub.test.ts` and `src/api/routes/hubMutate.test.ts` each
 * start real `node:http` servers on ephemeral ports and are already careful
 * about teardown (afterEach/finally close every server, restore every
 * chmod, and use a fresh mkdtemp dir per test) — so this is NOT a leaked
 * resource bug. The actual contention is timing, not identity: `discoverHub`
 * (src/api/lib/hub/discover.ts, product code, not modified here) races a
 * real loopback HTTP health check against a fixed 400ms `AbortSignal.timeout`
 * with no test-injectable override, because `scripts/item.ts` calls it with
 * no options. Confirmed by deliberately oversubscribing the fork pool
 * (`--poolOptions.forks.maxForks=32` on a 12-core machine): exactly the
 * `item.hub.test.ts` tests that assert routing THROUGH a live hub failed
 * (4/4), always due to `discoverHub` falling back as if no hub were
 * running — a benign scheduling race, not a product bug, but real under a
 * fully parallel `vitest run` when this file's timing-critical health
 * checks land in the same window as another CPU-heavy test file (in
 * particular `hubMutate.test.ts`'s own real-server + concurrent-mutation
 * tests, or general suite-wide fork contention).
 *
 * Fix: give these two live-HTTP-server files their own workspace project
 * with `fileParallelism: false` and a single fork, so they never run
 * concurrently with EACH OTHER (removing the specific double-jeopardy of two
 * 400ms-budget-sensitive files racing the scheduler at once) while every
 * other (fast, non-network) unit test file keeps running at full default
 * parallelism in the sibling project. This is the narrowest fix that
 * doesn't touch product code and doesn't serialize the whole suite.
 */

const HUB_LIVE_SERVER_FILES = [
  'scripts/item.hub.test.ts',
  'src/api/routes/hubMutate.test.ts',
  // td-033: exercises real timing-sensitive concurrency between the UI PATCH
  // route and the hub mutation queue over a real http server — same flake
  // risk as the two files above under parallel scheduling, same fix.
  'src/api/routes/items.test.ts',
];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'hub-live-server',
      include: HUB_LIVE_SERVER_FILES,
      // These two files must never run concurrently with each other (or
      // with themselves across multiple forks) — see the rationale above.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      exclude: [...configDefaults.exclude, ...HUB_LIVE_SERVER_FILES],
    },
  },
]);
