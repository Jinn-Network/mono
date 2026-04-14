import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

describe('runCli', () => {
  it('dispatches `version` to the version command', async () => {
    const io = captureIo();
    await runCli(['version'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
    expect(io.writes.length).toBeGreaterThan(0);
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('emits invalid_invocation envelope and exits 11 for unknown verb', async () => {
    const io = captureIo();
    await runCli(['no-such-verb'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.exitCode).toBe(11);
    expect(io.exits).toEqual([11]);
  });

  it('prints top-level help when invoked with no args', async () => {
    const io = captureIo();
    await runCli([], { writer: io.writer, exit: io.exit, stdoutIsTty: true });
    const combined = io.writes.join('');
    expect(combined).toContain('Usage: jinn <verb>');
    expect(combined).toContain('version');
  });

  it('prints per-verb help when invoked with --help', async () => {
    const io = captureIo();
    await runCli(['version', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: true });
    const combined = io.writes.join('');
    expect(combined).toContain('jinn version');
    expect(combined).toContain('Examples:');
  });
});
