import { describe, it, expect } from 'vitest';
import type { userInfo } from 'node:os';
import { UNKNOWN_AGENT, resolveAgentIdentity } from './identity';

function fakeUserInfo(username: string | undefined): typeof userInfo {
  return (() => {
    if (username === undefined) throw new Error('no user info available');
    return { username } as ReturnType<typeof userInfo>;
  }) as typeof userInfo;
}

describe('resolveAgentIdentity (td-030 attribution)', () => {
  it('prefers the --agent flag over TENBO_AGENT and the OS user', () => {
    const identity = resolveAgentIdentity({
      agentFlag: 'alice',
      env: { TENBO_AGENT: 'bob' },
      userInfoImpl: fakeUserInfo('carol'),
    });
    expect(identity).toBe('alice');
  });

  it('falls back to TENBO_AGENT when no --agent flag is given', () => {
    const identity = resolveAgentIdentity({ env: { TENBO_AGENT: 'bob' }, userInfoImpl: fakeUserInfo('carol') });
    expect(identity).toBe('bob');
  });

  it('falls back to the OS user when neither a flag nor TENBO_AGENT is set', () => {
    const identity = resolveAgentIdentity({ env: {}, userInfoImpl: fakeUserInfo('carol') });
    expect(identity).toBe('carol');
  });

  it('falls back to "unknown" when nothing resolves (e.g. userInfo() throws in a sandbox)', () => {
    const identity = resolveAgentIdentity({ env: {}, userInfoImpl: fakeUserInfo(undefined) });
    expect(identity).toBe(UNKNOWN_AGENT);
  });

  it('trims whitespace and treats blank values as absent', () => {
    const identity = resolveAgentIdentity({ agentFlag: '   ', env: { TENBO_AGENT: '  bob  ' }, userInfoImpl: fakeUserInfo('carol') });
    expect(identity).toBe('bob');
  });
});
