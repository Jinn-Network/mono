import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import {
  decodeCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'secret',
  }]);
}

describe('production active runtime preflight', () => {
  it('rejects active mode when no live capability attestation is configured', async () => {
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        'JINN_AUTOPILOT_CAPABILITY_ATTESTATION',
      ),
    });
  });

  it('requires the dedicated canonical HTTPS remote without mutating local Git config', async () => {
    const calls: string[][] = [];
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 1,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        atomicPairSuccess: true,
        atomicPairRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
      },
    }, expected);
    const accepted = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });
    await expect(accepted()).resolves.toEqual({ ok: true });
    await expect(accepted()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]);

    const rejected = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'git@example.invalid:Jinn-Network/mono.git\n',
    });
    await expect(rejected()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('canonical HTTPS'),
    });
  });
});
