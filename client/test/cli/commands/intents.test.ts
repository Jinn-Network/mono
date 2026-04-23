import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli/index.js';

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

describe('jinn intents command', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-intents-cmd-'));
    configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      desiredStates: [],
    }, null, 2));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists all kinds as not ready with requires live daemon in stub CLI registry', async () => {
    const io = captureIo();
    await runCli(
      ['intents', 'list', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([]);
    const listPayload = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(listPayload.verb).toBe('intents list');
    const rows = listPayload.intents as Array<{ kind: string; ready: boolean; reason?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.ready, `kind ${row.kind}`).toBe(false);
      expect(row.reason, `kind ${row.kind}`).toBe('requires live daemon');
    }
  });

  it('supports swapping prediction.v0 impl via --impl and reflects it in list output', async () => {
    const ioEnable = captureIo();
    await runCli(
      ['intents', 'enable', 'prediction.v0', '--impl', 'claude-mcp-prediction', '--config', configPath],
      { writer: ioEnable.writer, exit: ioEnable.exit, stdoutIsTty: false },
    );
    expect(ioEnable.exits).toEqual([]);
    const enabledPayload = JSON.parse(ioEnable.writes.at(-1) ?? '{}');
    expect(enabledPayload.verb).toBe('intents enable');
    expect(enabledPayload.impl).toBe('claude-mcp-prediction');
    expect(enabledPayload.previousImpl).toBe('prediction-v0-baseline');
    expect(enabledPayload.byKindUpdated).toBe(true);

    const writtenConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(writtenConfig.restorers.byKind['prediction.v0']).toBe('claude-mcp-prediction');

    const ioList = captureIo();
    await runCli(
      ['intents', 'list', '--config', configPath],
      { writer: ioList.writer, exit: ioList.exit, stdoutIsTty: false },
    );
    const listPayload = JSON.parse(ioList.writes.at(-1) ?? '{}');
    const row = (listPayload.intents as Array<{ kind: string; impl: string }>).find((r) => r.kind === 'prediction.v0');
    expect(row?.impl).toBe('claude-mcp-prediction');
  });

  it('resets impl override to ship default', async () => {
    writeFileSync(configPath, JSON.stringify({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      desiredStates: [],
      restorers: { byKind: { 'prediction.v0': 'claude-mcp-prediction' } },
    }, null, 2));

    const io = captureIo();
    await runCli(
      ['intents', 'reset', 'prediction.v0', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([]);
    const payload = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(payload.verb).toBe('intents reset');
    expect(payload.previousImpl).toBe('claude-mcp-prediction');
    expect(payload.impl).toBe('prediction-v0-baseline');
  });

  it('rejects unknown impl names in --impl', async () => {
    const io = captureIo();
    await runCli(
      ['intents', 'enable', 'prediction.v0', '--impl', 'nope', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([11]);
    const envelope = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(envelope.code).toBe('invalid_invocation');
    expect(String(envelope.details?.expected)).toContain('prediction-v0-baseline');
  });

  it('rejects impls that do not support the target kind', async () => {
    const io = captureIo();
    await runCli(
      ['intents', 'enable', 'prediction.v0', '--impl', 'claude-mcp-hyperliquid', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([11]);
    const envelope = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(envelope.code).toBe('invalid_invocation');
  });

  it('reset on a kind with no override is a no-op that does not rewrite config', async () => {
    const originalBytes = readFileSync(configPath, 'utf-8');

    const io = captureIo();
    await runCli(
      ['intents', 'reset', 'prediction.v0', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([]);
    const payload = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(payload.verb).toBe('intents reset');
    expect(payload.previousImpl).toBeNull();
    expect(payload.impl).toBe('prediction-v0-baseline');
    expect(payload.configUpdated).toBe(false);

    expect(readFileSync(configPath, 'utf-8')).toBe(originalBytes);
  });

  it('--impl pointing at the current impl does not report a swap', async () => {
    const io = captureIo();
    await runCli(
      ['intents', 'enable', 'prediction.v0', '--impl', 'prediction-v0-baseline', '--config', configPath],
      { writer: io.writer, exit: io.exit, stdoutIsTty: false },
    );
    expect(io.exits).toEqual([]);
    const payload = JSON.parse(io.writes.at(-1) ?? '{}');
    expect(payload.impl).toBe('prediction-v0-baseline');
    expect(payload.previousImpl).toBeUndefined();
    expect(payload.byKindUpdated).toBeUndefined();

    // Config should not gain a restorers.byKind mapping for prediction.v0
    // just because the user passed --impl naming the current impl.
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.restorers?.byKind?.['prediction.v0']).toBeUndefined();
  });
});
