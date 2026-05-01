import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPlugIns } from '../../../src/cli/commands/plug-ins.js';

let TMP: string;
let CONFIG: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'jinn-pi-cli-'));
  CONFIG = join(TMP, 'config.json');
  writeFileSync(CONFIG, JSON.stringify({ learnerPlugIns: [] }, null, 2));
});

/** A plug-in with an mcp-tool slot (executable — requires --yes or prompt). */
function fakePackageDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jinn-pkg-'));
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify({ name, version: '0.1.0' }),
  );
  writeFileSync(
    join(d, 'jinn-plugin.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      name,
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots: [{ type: 'mcp-tool', command: 'node', args: ['server.js'] }],
    }),
  );
  return d;
}

/** A plug-in with only non-executable slots (no confirmation required). */
function fakeSafePackageDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jinn-safe-pkg-'));
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify({ name, version: '0.1.0' }),
  );
  mkdirSync(join(d, 'agents'), { recursive: true });
  writeFileSync(join(d, 'agents', 'override.md'), '---\nname: stub\n---\n# stub');
  writeFileSync(
    join(d, 'jinn-plugin.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      name,
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots: [
        {
          type: 'phase-agent-override',
          phase: 'execute',
          agent: 'step-worker',
          entry: 'agents/override.md',
        },
      ],
    }),
  );
  return d;
}

describe('runPlugIns', () => {
  // ── Basic CRUD ──────────────────────────────────────────────────────────────

  it('add appends an entry to learnerPlugIns (--yes for executable slot)', async () => {
    const pkg = fakePackageDir('@example/p');
    const code = await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
    expect(cfg.learnerPlugIns[0].name).toBe('@example/p');
  });

  it('add refuses to add a duplicate name', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    const code = await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(1);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });

  it('add refuses an invalid manifest', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jinn-bad-'));
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ name: '@example/bad', version: '0.1.0' }),
    );
    writeFileSync(join(d, 'jinn-plugin.json'), JSON.stringify({ broken: true }));
    const code = await runPlugIns({
      argv: ['add', '@example/bad', '--entry', d, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(1);
  });

  it('remove deletes the entry', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    const code = await runPlugIns({
      argv: ['remove', '@example/p'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toEqual([]);
  });

  it('list prints installed plug-ins', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    let captured = '';
    const code = await runPlugIns({
      argv: ['list'],
      configPath: CONFIG,
      stdout: { write: (s: string) => { captured += s; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    expect(captured).toContain('@example/p');
  });

  it('show prints the manifest', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({
      argv: ['add', '@example/p', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    let captured = '';
    const code = await runPlugIns({
      argv: ['show', '@example/p'],
      configPath: CONFIG,
      stdout: { write: (s: string) => { captured += s; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(captured);
    expect(parsed.name).toBe('@example/p');
    expect(parsed.version).toBe('0.1.0');
  });

  // ── Finding 7: confirmation prompt for executable slots ─────────────────────

  it('Finding 7: mcp-tool slot without --yes returns exit 1 and does not write config', async () => {
    const pkg = fakePackageDir('@example/exec');
    let stderrOutput = '';
    const code = await runPlugIns({
      argv: ['add', '@example/exec', '--entry', pkg],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => { stderrOutput += s; } },
      // Inject a prompt that returns 'n' (simulates user declining).
      prompt: async () => 'n',
    });
    expect(code).toBe(1);
    expect(stderrOutput).toMatch(/confirmation_required/i);
    // Config must not have been written.
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(0);
  });

  it('Finding 7: mcp-tool slot with --yes flag succeeds without prompt', async () => {
    const pkg = fakePackageDir('@example/exec');
    let promptCalled = false;
    const code = await runPlugIns({
      argv: ['add', '@example/exec', '--entry', pkg, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      prompt: async () => { promptCalled = true; return 'n'; },
    });
    expect(code).toBe(0);
    // Prompt must NOT have been called when --yes is set.
    expect(promptCalled).toBe(false);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });

  it('Finding 7: mcp-tool slot with injected prompt answering "y" succeeds', async () => {
    const pkg = fakePackageDir('@example/exec');
    const code = await runPlugIns({
      argv: ['add', '@example/exec', '--entry', pkg],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      prompt: async () => 'y',
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });

  it('Finding 7: phase-agent-override plug-in (no executable slots) requires no prompt', async () => {
    const pkg = fakeSafePackageDir('@example/safe');
    let promptCalled = false;
    const code = await runPlugIns({
      argv: ['add', '@example/safe', '--entry', pkg],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      prompt: async () => { promptCalled = true; return 'n'; },
    });
    expect(code).toBe(0);
    // No prompt for non-executable slots.
    expect(promptCalled).toBe(false);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });

  it('Finding 7: hook slot triggers confirmation prompt', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jinn-hook-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@example/hook', version: '0.1.0' }));
    mkdirSync(join(d, 'hooks'), { recursive: true });
    writeFileSync(join(d, 'hooks', 'on-start'), '#!/bin/sh\necho hi');
    writeFileSync(
      join(d, 'jinn-plugin.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        name: '@example/hook',
        version: '0.1.0',
        compatibility: { claudeCodeLearner: '>=0.1.0' },
        slots: [{ type: 'hook', event: 'session-start', entry: 'hooks/on-start' }],
      }),
    );
    let stderrOutput = '';
    const code = await runPlugIns({
      argv: ['add', '@example/hook', '--entry', d],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: (s: string) => { stderrOutput += s; } },
      prompt: async () => 'n',
    });
    expect(code).toBe(1);
    expect(stderrOutput).toMatch(/confirmation_required/i);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(0);
  });

  it('Finding 7: memory-backend slot triggers confirmation prompt', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jinn-mem-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@example/mem', version: '0.1.0' }));
    writeFileSync(
      join(d, 'jinn-plugin.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        name: '@example/mem',
        version: '0.1.0',
        compatibility: { claudeCodeLearner: '>=0.1.0' },
        slots: [{ type: 'memory-backend', command: 'node', args: ['mem.js'] }],
      }),
    );
    const code = await runPlugIns({
      argv: ['add', '@example/mem', '--entry', d, '--yes'],
      configPath: CONFIG,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });
});
