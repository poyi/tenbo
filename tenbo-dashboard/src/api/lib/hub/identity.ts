/**
 * identity.ts — agent-identity resolution for mutation attribution (td-030 /
 * x-004 "Attribution and event journal").
 *
 * Every mutating CLI command resolves an identity BEFORE building its
 * `MutationRequest` so the same string flows through both the hub path and
 * the direct-write fallback (see hub/mutations.ts). Precedence, highest
 * first:
 *
 *   1. `--agent <name>` CLI flag (caller extracts the flag value; this
 *      module has no CLI-parsing knowledge, matching the "CLI stays a thin
 *      shell / Data Layer owns logic" rule).
 *   2. `TENBO_AGENT` environment variable.
 *   3. The OS user running the process (`os.userInfo().username`).
 *   4. `'unknown'` — the last-resort fallback when nothing else resolves
 *      (e.g. a sandboxed environment where `userInfo()` throws).
 */

import { userInfo } from 'node:os';

export interface ResolveAgentIdentityOptions {
  /** The already-extracted value of a `--agent <name>` flag, if present. */
  agentFlag?: string;
  /** Injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to `os.userInfo`. */
  userInfoImpl?: typeof userInfo;
}

export const UNKNOWN_AGENT = 'unknown';

export function resolveAgentIdentity(opts: ResolveAgentIdentityOptions = {}): string {
  const env = opts.env ?? process.env;
  const userInfoImpl = opts.userInfoImpl ?? userInfo;

  if (opts.agentFlag && opts.agentFlag.trim()) return opts.agentFlag.trim();
  if (env.TENBO_AGENT && env.TENBO_AGENT.trim()) return env.TENBO_AGENT.trim();

  try {
    const username = userInfoImpl().username;
    if (username && username.trim()) return username.trim();
  } catch {
    // No OS user info available (e.g. some sandboxes) — fall through.
  }

  return UNKNOWN_AGENT;
}
