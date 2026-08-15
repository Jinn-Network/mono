import { describe, expect, it, vi } from 'vitest';
import { createScrubCommand } from '../../../src/cli/commands/scrub.js';

describe('jinn scrub bench (#1968)', () => {
  it('emits metrics-only JSON with zero corruption failures', async () => {
    const chunks: string[] = [];
    let exitCode: number | undefined;
    const cmd = createScrubCommand();
    await cmd.run({
      argv: ['bench', '--ci-only'],
      stdoutIsTty: false,
      writer: { write: (s) => { chunks.push(s); return true; } },
      exit: (code) => { exitCode = code; },
      env: process.env,
    });
    const report = JSON.parse(chunks.join(''));
    expect(report.schemaVersion).toBe(1);
    expect(report.corruption.failures).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/@example\.com/);
    expect(exitCode).toBeUndefined();
  });
});
