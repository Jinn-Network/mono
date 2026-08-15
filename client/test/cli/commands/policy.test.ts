import { describe, expect, it } from 'vitest';
import type { JinnConfig } from '../../../src/config.js';
import { makeCommandCtx } from '../../_support/cli.js';
import { createPolicyCommand } from '../../../src/cli/commands/policy.js';

function policyWith(config: Partial<JinnConfig>) {
  return createPolicyCommand({
    loadConfig: () => config as JinnConfig,
    getConfigPathFromArgs: () => undefined,
  });
}

describe('jinn policy', () => {
  it('has name "policy" and a summary', () => {
    const cmd = policyWith({});
    expect(cmd.name).toBe('policy');
    expect(cmd.summary.length).toBeGreaterThan(0);
  });

  it('shows the configured claim policy', async () => {
    const cmd = policyWith({ claimPolicy: { mode: 'every-runnable', aiUnitCap: 3 } });
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['show', '--json'], tty: false });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.verb).toBe('policy show');
    expect(parsed.claimPolicy).toEqual({ mode: 'every-runnable', aiUnitCap: 3 });
    expect(exits).toEqual([0]);
  });

  it('says so plainly when no policy is configured', async () => {
    const cmd = policyWith({});
    const { ctx, writes } = makeCommandCtx({ argv: ['show', '--json'], tty: false });
    await cmd.run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).claimPolicy).toBeNull();
  });

  it('rejects an unknown subverb with invalid_invocation (exit 11)', async () => {
    const cmd = policyWith({});
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['bogus'], tty: false });
    await cmd.run(ctx);
    expect(JSON.parse(writes[writes.length - 1]!).code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
