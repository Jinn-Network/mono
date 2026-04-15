import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
    expect(String(parsed.details?.expected)).not.toContain('fleet-manage');
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

  it('emits invalid_invocation for config load failures', async () => {
    const io = captureIo();
    await runCli(
      ['version', '--config', '/tmp/does-not-exist.json'],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('config');
    expect(parsed.details?.code).toBe('config_file_not_found');
    expect(io.exits).toEqual([11]);
  });

  it('prints fleet-manage help for fleet scale --help', async () => {
    const io = captureIo();
    await runCli(['fleet', 'scale', '--help'], {
      writer: io.writer,
      exit: io.exit,
      stdoutIsTty: true,
    });
    const combined = io.writes.join('');
    expect(combined).toContain('jinn fleet');
    expect(combined).toContain('jinn fleet retire 1 --dry-run');
  });

  it('emits invalid_invocation envelope for fleet scale config load failures', async () => {
    const io = captureIo();
    await runCli(
      ['fleet', 'scale', '--config', '/tmp/does-not-exist.json', '--to', '2', '--dry-run'],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('config');
    expect(parsed.details?.code).toBe('config_file_not_found');
    expect(parsed.exampleCli).toBe('jinn fleet scale');
    expect(io.exits).toEqual([11]);
  });

  it('emits invalid_invocation for unknown fleet subverbs', async () => {
    const io = captureIo();
    await runCli(['fleet', 'nope'], {
      writer: io.writer,
      exit: io.exit,
      stdoutIsTty: false,
    });
    const parsed = JSON.parse(io.writes[io.writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.message).toBe('Unknown fleet subverb: nope');
    expect(io.exits).toEqual([11]);
  });

  it('keeps fleet introspection for fleet --human', async () => {
    const io = captureIo();
    await runCli(['fleet', '--human'], {
      writer: io.writer,
      exit: io.exit,
      stdoutIsTty: true,
    });
    expect(io.exits).toEqual([]);
    expect(io.writes.join('')).not.toContain('Unknown fleet subverb');
  });

  it('keeps fleet introspection for fleet --human on a fresh home directory', async () => {
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const home = mkdtempSync(`${tmpdir()}/jinn-home-`);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;

    try {
      const io = captureIo();
      await runCli(['fleet', '--human'], {
        writer: io.writer,
        exit: io.exit,
        stdoutIsTty: true,
      });
      expect(io.exits).toEqual([]);
      expect(io.writes.join('')).not.toContain('"code":"fatal"');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
