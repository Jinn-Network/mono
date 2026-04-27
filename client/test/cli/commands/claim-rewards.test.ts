import { describe, expect, it } from 'vitest';
import { makeCommandCtx } from '@test/cli.js';

describe('claim-rewards command', () => {
  it('--dry-run accepts --config and --password-fd without parse errors', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes } = makeCommandCtx({ argv: [
      '--dry-run',
      '--config',
      '/tmp/claim-rewards-config-test.json',
      '--password-fd',
      '4',
    ], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('claim-rewards');
  });

  it('--dry-run emits a plan without executing', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes } = makeCommandCtx({ argv: ['--dry-run'], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.verb).toBe('claim-rewards');
  });

  it('non-TTY without --yes or --dry-run emits invalid_invocation', async () => {
    const { default: cmd } = await import('../../../src/cli/commands/claim-rewards.js');
    const { ctx, writes, exits } = makeCommandCtx({ argv: [], env: { JINN_PASSWORD: 'test' } });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
