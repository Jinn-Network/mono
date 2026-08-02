import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

describe('native requester CLI surface', () => {
  it('is registered but feature-disabled before configuration, key loading, or posting', async () => {
    const io = captureIo();

    await runCli([
      'native-requester', 'request',
      '--network', 'base-sepolia',
      '--fixture', 'prediction-snapshot-v1',
      '--run-id', 'operator-run-20260802',
    ], { writer: io.writer, exit: io.exit, stdoutIsTty: false });

    const result = JSON.parse(io.writes.at(-1)!);
    expect(result).toMatchObject({
      code: 'bootstrap_incomplete',
      details: { feature: 'native-requester', state: 'feature-disabled' },
    });
    expect(result.message).toMatch(/feature-disabled/i);
    expect(io.exits).toEqual([20]);
  });

  it('documents the request shape without enabling the product path', async () => {
    const io = captureIo();

    await runCli(['native-requester', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });

    expect(io.writes.join('')).toContain('jinn native-requester request');
    expect(io.exits).toEqual([]);
  });
});
