import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeProductionMergePrepSessionPort,
  rangeDiffProvesMechanical,
} from '../../src/lifecycle/merge-prep-session-production.js';
import { gitOid } from '../../src/lifecycle/types.js';

const CLAIM = gitOid('1'.repeat(40));
const PREPARED = gitOid('2'.repeat(40));

describe('production merge-prep session port', () => {
  it('classifies only a complete patch-equivalent range-diff as mechanical', () => {
    expect(rangeDiffProvesMechanical([
      '1:  aaaaaaa = 1:  bbbbbbb Preserve the first patch',
      '2:  ccccccc = 2:  ddddddd Preserve the second patch',
    ].join('\n'))).toBe(true);
    expect(rangeDiffProvesMechanical(
      '1:  aaaaaaa ! 1:  bbbbbbb Conflict resolution changed the patch',
    )).toBe(false);
    expect(rangeDiffProvesMechanical(
      '1:  aaaaaaa < -:  ------- Patch disappeared',
    )).toBe(false);
    expect(rangeDiffProvesMechanical('')).toBe(false);
  });

  it('publishes the prepared exact child with a selected-identity lease', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    let remote = CLAIM;
    const port = makeProductionMergePrepSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        GITHUB_TOKEN: 'ambient-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      runner: async (command, args, options) => {
        expect(command).toBe('git');
        calls.push({ args, env: options?.env });
        if (args.includes('rev-list')) return `${PREPARED} ${CLAIM}\n`;
        if (args.includes('ls-remote')) {
          return `${remote}\trefs/heads/autopilot/42\n`;
        }
        if (args.includes('push')) {
          remote = PREPARED;
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });
    const manifest = {
      branch: 'autopilot/42',
      paths: {
        askpass: '/attempt/askpass',
        worktree: '/attempt/worktree',
      },
      repository: { remoteName: 'jinn-autopilot-v2' },
    } as AttemptManifest;

    await expect(port.publishPrepared({
      manifest,
      expectedRemoteHead: CLAIM,
      newHead: PREPARED,
    })).resolves.toMatchObject({ status: 'won', observed: PREPARED });

    const push = calls.find((call) => call.args.includes('push'));
    expect(push?.args).toContain(
      `--force-with-lease=refs/heads/autopilot/42:${CLAIM}`,
    );
    expect(push?.args).toContain('jinn-autopilot-v2');
    expect(calls.every((call) => call.env?.GH_TOKEN === 'selected-secret')).toBe(true);
    expect(calls.every((call) => call.env?.GITHUB_TOKEN === '')).toBe(true);
  });
});
