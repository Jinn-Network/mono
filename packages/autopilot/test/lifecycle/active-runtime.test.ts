import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeActiveRuntime,
} from '../../src/lifecycle/active-runtime.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function pool(): CredentialPool {
  return new CredentialPool([
    {
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'i',
    },
    {
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'r',
    },
  ]);
}

function attempt(
  phase: AttemptManifest['phase'],
  selectedLogin: string,
): AttemptManifest {
  return {
    phase,
    selectedLogin,
  } as AttemptManifest;
}

describe('active runtime boundary', () => {
  it('derives only this runner’s phase capacity and identity lanes from injected local attempts', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, review: 1, mergePrep: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [attempt('implement', 'implementation-bot')],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        mergePrep: async () => ({ status: 'spawned' }),
        merge: async () => ({ status: 'merged' }),
      },
    });

    expect(runtime.readLocalState()).toEqual({
      remaining: { implementation: 1, review: 1, mergePrep: 1 },
      availableLogins: ['review-bot'],
      implementationPreferredLogin: 'implementation-bot',
    });
  });

  it('passes only currently free credentials to an exact-head action handler', async () => {
    const selected: string[][] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, review: 1, mergePrep: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [attempt('implement', 'implementation-bot')],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async (action, credentials) => {
          selected.push(credentials.logins());
          expect(action).toMatchObject({ prNumber: 84, head: HEAD });
          return { status: 'spawned' };
        },
        mergePrep: async () => ({ status: 'spawned' }),
        merge: async () => ({ status: 'merged' }),
      },
    });

    await expect(runtime.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
      recoverFixes: false,
    })).resolves.toEqual({ outcome: 'spawned' });
    expect(selected).toEqual([['review-bot']]);
  });
});
