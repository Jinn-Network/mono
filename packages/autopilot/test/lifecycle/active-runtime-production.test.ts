import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'secret',
  }]);
}

describe('production active runtime preflight', () => {
  it('requires the dedicated canonical HTTPS remote without mutating local Git config', async () => {
    const calls: string[][] = [];
    const accepted = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });
    await expect(accepted()).resolves.toEqual({ ok: true });
    await expect(accepted()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]);

    const rejected = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async () => 'git@example.invalid:Jinn-Network/mono.git\n',
    });
    await expect(rejected()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('canonical HTTPS'),
    });
  });
});
