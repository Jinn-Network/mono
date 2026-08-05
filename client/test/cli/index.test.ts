import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import { defaultTokenPath } from '../../src/api/ui-token.js';

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

async function withTempFleetEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevDbPath = process.env.JINN_DB_PATH;
  const prevEarningDir = process.env.JINN_EARNING_DIR;
  const root = mkdtempSync(`${tmpdir()}/jinn-cli-fleet-`);
  process.env.JINN_DB_PATH = join(root, 'jinn.db');
  process.env.JINN_EARNING_DIR = join(root, 'earning');

  try {
    return await fn();
  } finally {
    if (prevDbPath === undefined) delete process.env.JINN_DB_PATH;
    else process.env.JINN_DB_PATH = prevDbPath;
    if (prevEarningDir === undefined) delete process.env.JINN_EARNING_DIR;
    else process.env.JINN_EARNING_DIR = prevEarningDir;
    rmSync(root, { recursive: true, force: true });
  }
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

  it('prints mcp command help', async () => {
    const io = captureIo();
    await runCli(['mcp', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: true });
    const combined = io.writes.join('');
    expect(combined).toContain('jinn mcp');
    expect(combined).toContain('MCP server');
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

  // Review finding L1 (issue #2404 / spec §14.5): a /v1/status 401 gets a
  // machine-readable shape rather than falling into the generic `fatal`
  // bucket. `ErrorCode` has no `unauthorized` member (by design — don't mint
  // one), so the discriminator lives in `details.reason`.
  it('emits invalid_invocation with details.reason=unauthorized when /v1/status 401s', async () => {
    await withTempFleetEnv(async () => {
      const store = new Store(':memory:');
      const server = await startApiServer({
        port: 0,
        store,
        apiToken: 'bearer-not-used-here',
        ui: { token: 'the-real-token', handshakeKey: 'handshake-key' },
      });
      const prevApiPort = process.env.JINN_API_PORT;
      // Everything from here — env mutation, the deliberately-wrong token
      // write, the CLI dispatch — lives inside one try/finally so a failure
      // anywhere still restores the env var and closes the server; leaking
      // either would make every later test in this file resolve HTTP merges
      // against this same (now stale) server (jinn-mono review finding for
      // #2404: this exact leak was caught in an earlier draft).
      try {
        process.env.JINN_API_PORT = String(server.port);
        const tokenPath = defaultTokenPath();
        mkdirSync(dirname(tokenPath), { recursive: true });
        // Deliberately write a WRONG token so the merge fetch inside
        // `gatherIntrospectionRaw` gets a real 401 from the server above.
        writeFileSync(tokenPath, 'wrong-token\n', { mode: 0o600 });

        const io = captureIo();
        await runCli(['status'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });
        const parsed = JSON.parse(io.writes[io.writes.length - 1]);
        expect(parsed.code).toBe('invalid_invocation');
        expect(parsed.exitCode).toBe(11);
        expect(parsed.details?.reason).toBe('unauthorized');
        expect(io.exits).toEqual([11]);
      } finally {
        if (prevApiPort === undefined) delete process.env.JINN_API_PORT;
        else process.env.JINN_API_PORT = prevApiPort;
        await server.close();
        store.close();
      }
    });
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
    await withTempFleetEnv(async () => {
      const io = captureIo();
      await runCli(['fleet', '--human'], {
        writer: io.writer,
        exit: io.exit,
        stdoutIsTty: true,
      });
      expect(io.exits).toEqual([]);
      expect(io.writes.join('')).not.toContain('Unknown fleet subverb');
    });
  });

  it('keeps fleet introspection for fleet --human on a fresh home directory', async () => {
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const home = mkdtempSync(`${tmpdir()}/jinn-home-`);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;

    try {
      await withTempFleetEnv(async () => {
        const io = captureIo();
        await runCli(['fleet', '--human'], {
          writer: io.writer,
          exit: io.exit,
          stdoutIsTty: true,
        });
        expect(io.exits).toEqual([]);
        expect(io.writes.join('')).not.toContain('"code":"fatal"');
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});
