import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessModeCommand, harnessStatusCommand } from '../../src/cli/commands/harnesses.js';

let TMP: string;
let CONFIG_PATH: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'cli-mode-'));
  CONFIG_PATH = join(TMP, 'config.json');
  process.env['JINN_HARNESS_MODE_STATE_PATH'] = join(TMP, 'mode-state.json');
  writeFileSync(CONFIG_PATH, JSON.stringify({ network: 'testnet' }));
});

afterEach(() => {
  delete process.env['JINN_HARNESS_MODE_STATE_PATH'];
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
}

describe('jinn harness mode', () => {
  it('writes mode = "frozen" to config', async () => {
    await harnessModeCommand({ mode: 'frozen', configPath: CONFIG_PATH });
    const config = readConfig();
    expect((config.harness as any)?.mode).toBe('frozen');
  });

  it('writes mode = "train" to config', async () => {
    await harnessModeCommand({ mode: 'train', configPath: CONFIG_PATH });
    const config = readConfig();
    expect((config.harness as any)?.mode).toBe('train');
  });
});

describe('jinn harness status', () => {
  it('prints current mode', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ harness: { mode: 'frozen' } }));
    const output: string[] = [];
    await harnessStatusCommand({ configPath: CONFIG_PATH, log: (s) => output.push(s) });
    const combined = output.join('');
    expect(combined).toContain('mode: frozen');
  });

  it('prints default mode when not configured', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({}));
    const output: string[] = [];
    await harnessStatusCommand({ configPath: CONFIG_PATH, log: (s) => output.push(s) });
    const combined = output.join('');
    expect(combined).toContain('mode: train');
  });
});
