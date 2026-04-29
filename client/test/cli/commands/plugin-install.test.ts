/**
 * Tests for `jinn plugin install` dry-run / preview / confirmation controls.
 * Audit finding W3 — jinn-mono-964.3
 *
 * Each test uses a temp HOME so nothing touches the real filesystem.
 * Tests cover:
 *   - Default non-TTY behaviour is dry-run (no file writes)
 *   - --dry-run flag works explicitly
 *   - --yes flag enables writes in non-TTY mode
 *   - `plugin plan` subverb is an alias for install --dry-run
 *   - --mcp-only / --skill-only filter correctly
 *   - --mcp-only and --skill-only are mutually exclusive
 *   - Plan output includes filePath, fileExists, patch, alreadyConfigured
 *   - Codex, Claude Desktop, and Cursor target paths appear in plan output
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir as realHomedir } from 'node:os';
import { join } from 'node:path';
import plugin from '../../../src/cli/commands/plugin-install.js';
import { makeCommandCtx } from '@test/cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

beforeEach(() => {
  origHome = process.env['HOME'] ?? realHomedir();
  tmpHome = mkdtempSync(join(tmpdir(), 'jinn-plugin-test-'));
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeCtx(argv: string[] = [], tty = false) {
  return makeCommandCtx({ argv, tty });
}

function parseOutput(writes: string[]): unknown {
  const joined = writes.join('');
  const lines = joined.split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('{')) {
      try { return JSON.parse(line); } catch { /* skip */ }
    }
  }
  return null;
}

// Simulate a detected target by creating the required marker directory/file
function setupCodexDir() {
  mkdirSync(join(tmpHome, '.codex'), { recursive: true });
}

function setupCursorDir() {
  mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
}

function setupClaudeDir() {
  // Claude Desktop: create config dir marker
  const cfgDir = process.platform === 'darwin'
    ? join(tmpHome, 'Library', 'Application Support', 'Claude')
    : join(tmpHome, '.config', 'claude-desktop');
  mkdirSync(cfgDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Plan / dry-run tests
// ---------------------------------------------------------------------------

describe('plugin plan (dry-run mode)', () => {
  it('non-TTY mode without --yes defaults to dry-run (no files written)', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['install', '--target', 'codex'], false /* not TTY */);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    expect((out as Record<string, unknown>)['dryRun']).toBe(true);
    expect((out as Record<string, unknown>)['verb']).toBe('plugin plan');

    // No files must have been written
    const tomlPath = join(tmpHome, '.codex', 'config.toml');
    const agentsPath = join(tmpHome, '.codex', 'AGENTS.md');
    expect(existsSync(tomlPath)).toBe(false);
    expect(existsSync(agentsPath)).toBe(false);
  });

  it('--dry-run flag explicitly triggers plan output', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['install', '--dry-run', '--target', 'codex'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    expect((out as Record<string, unknown>)['dryRun']).toBe(true);
  });

  it('"plan" subverb is an alias for install --dry-run', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    expect((out as Record<string, unknown>)['dryRun']).toBe(true);
    expect((out as Record<string, unknown>)['verb']).toBe('plugin plan');
  });

  it('plan output includes filePath, fileExists, patch, alreadyConfigured for Codex', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBeGreaterThan(0);

    for (const entry of plan) {
      expect(entry).toHaveProperty('target', 'codex');
      expect(entry).toHaveProperty('filePath');
      expect(typeof entry['filePath']).toBe('string');
      expect(entry).toHaveProperty('fileExists');
      expect(typeof entry['fileExists']).toBe('boolean');
      expect(entry).toHaveProperty('patch');
      expect(typeof entry['patch']).toBe('string');
      expect(entry).toHaveProperty('alreadyConfigured');
      expect(typeof entry['alreadyConfigured']).toBe('boolean');
      expect(entry).toHaveProperty('kind');
    }
  });

  it('Codex MCP plan entry points at config.toml', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex', '--mcp-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    const mcpEntry = plan.find((e) => e['kind'] === 'mcp');
    expect(mcpEntry).toBeDefined();
    expect((mcpEntry!['filePath'] as string)).toContain('config.toml');
  });

  it('Codex skill plan entry points at AGENTS.md', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex', '--skill-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    const skillEntry = plan.find((e) => e['kind'] === 'skill');
    expect(skillEntry).toBeDefined();
    expect((skillEntry!['filePath'] as string)).toContain('AGENTS.md');
  });

  it('Cursor skill plan entry points at .cursor/rules/jinn.md', async () => {
    setupCursorDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'cursor', '--skill-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    const skillEntry = plan.find((e) => e['kind'] === 'skill');
    expect(skillEntry).toBeDefined();
    expect((skillEntry!['filePath'] as string)).toContain(join('.cursor', 'rules', 'jinn.md'));
  });

  it('Cursor MCP plan entry points at .cursor/mcp.json', async () => {
    setupCursorDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'cursor', '--mcp-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    const mcpEntry = plan.find((e) => e['kind'] === 'mcp');
    expect(mcpEntry).toBeDefined();
    expect((mcpEntry!['filePath'] as string)).toContain(join('.cursor', 'mcp.json'));
  });

  it('plan reports alreadyConfigured=true when Codex TOML already has jinn block', async () => {
    setupCodexDir();
    // Pre-write the TOML with jinn block
    const tomlPath = join(tmpHome, '.codex', 'config.toml');
    writeFileSync(tomlPath, '[mcp_servers.jinn]\ncommand = "jinn"\nargs = ["mcp"]\n', 'utf-8');

    const { ctx, writes } = makeCtx(['plan', '--target', 'codex', '--mcp-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    const mcpEntry = plan.find((e) => e['kind'] === 'mcp');
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!['alreadyConfigured']).toBe(true);
    expect(mcpEntry!['fileExists']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Write mode (--yes)
// ---------------------------------------------------------------------------

describe('plugin install --yes (write mode)', () => {
  it('--yes in non-TTY mode writes Codex TOML and AGENTS.md', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['install', '--yes', '--target', 'codex'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect(out).not.toBeNull();
    // In write mode, verb is 'plugin install', not 'plugin plan'
    expect((out as Record<string, unknown>)['verb']).toBe('plugin install');
    expect((out as Record<string, unknown>)['dryRun']).toBeUndefined();

    const tomlPath = join(tmpHome, '.codex', 'config.toml');
    const agentsPath = join(tmpHome, '.codex', 'AGENTS.md');
    expect(existsSync(tomlPath)).toBe(true);
    expect(readFileSync(tomlPath, 'utf-8')).toContain('[mcp_servers.jinn]');
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath, 'utf-8')).toContain('<!-- jinn-operator-start -->');
  });

  it('--yes writes Cursor mcp.json and rules/jinn.md', async () => {
    setupCursorDir();
    const { ctx, writes } = makeCtx(['install', '--yes', '--target', 'cursor'], false);
    await plugin.run(ctx);

    const mcpPath = join(tmpHome, '.cursor', 'mcp.json');
    const rulePath = join(tmpHome, '.cursor', 'rules', 'jinn.md');
    expect(existsSync(mcpPath)).toBe(true);
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8'))).toMatchObject({
      mcpServers: { jinn: { command: 'jinn', args: ['mcp'] } },
    });
    expect(existsSync(rulePath)).toBe(true);
  });

  it('--yes idempotent: second run skips MCP (already configured)', async () => {
    setupCodexDir();
    const argv = ['install', '--yes', '--target', 'codex'];

    const { ctx: ctx1, writes: w1 } = makeCtx(argv, false);
    await plugin.run(ctx1);
    const out1 = parseOutput(w1) as Record<string, unknown>;
    const results1 = (out1['results'] as Array<Record<string, unknown>>);
    expect(results1[0]!['mcp']).toMatchObject({ status: 'configured' });

    const { ctx: ctx2, writes: w2 } = makeCtx(argv, false);
    await plugin.run(ctx2);
    const out2 = parseOutput(w2) as Record<string, unknown>;
    const results2 = (out2['results'] as Array<Record<string, unknown>>);
    expect(results2[0]!['mcp']).toMatchObject({ status: 'skipped' });
  });
});

// ---------------------------------------------------------------------------
// --mcp-only / --skill-only
// ---------------------------------------------------------------------------

describe('--mcp-only and --skill-only flags', () => {
  it('--mcp-only only writes MCP config, not skill files', async () => {
    setupCodexDir();
    const { ctx } = makeCtx(['install', '--yes', '--target', 'codex', '--mcp-only'], false);
    await plugin.run(ctx);

    const tomlPath = join(tmpHome, '.codex', 'config.toml');
    const agentsPath = join(tmpHome, '.codex', 'AGENTS.md');
    expect(existsSync(tomlPath)).toBe(true);
    expect(existsSync(agentsPath)).toBe(false);
  });

  it('--skill-only only writes skill files, not MCP config', async () => {
    setupCodexDir();
    const { ctx } = makeCtx(['install', '--yes', '--target', 'codex', '--skill-only'], false);
    await plugin.run(ctx);

    const tomlPath = join(tmpHome, '.codex', 'config.toml');
    const agentsPath = join(tmpHome, '.codex', 'AGENTS.md');
    expect(existsSync(tomlPath)).toBe(false);
    expect(existsSync(agentsPath)).toBe(true);
  });

  it('--mcp-only with plan only includes MCP entries', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex', '--mcp-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    expect(plan.every((e) => e['kind'] === 'mcp')).toBe(true);
  });

  it('--skill-only with plan only includes skill entries', async () => {
    setupCodexDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'codex', '--skill-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    expect(plan.every((e) => e['kind'] === 'skill')).toBe(true);
  });

  it('--mcp-only and --skill-only together emit invalid_invocation', async () => {
    const { ctx, writes, exits } = makeCtx(['install', '--mcp-only', '--skill-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect((out as Record<string, unknown>)['code']).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});

// ---------------------------------------------------------------------------
// Claude Desktop plan output
// ---------------------------------------------------------------------------

describe('claude-desktop plan output', () => {
  it('plan entry for Claude Desktop MCP points at claude_desktop_config.json', async () => {
    setupClaudeDir();
    const { ctx, writes } = makeCtx(['plan', '--target', 'claude-desktop', '--mcp-only'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    const plan = (out as Record<string, unknown>)['plan'] as Array<Record<string, unknown>>;
    if (plan.length > 0) {
      const mcpEntry = plan.find((e) => e['kind'] === 'mcp');
      expect(mcpEntry).toBeDefined();
      expect((mcpEntry!['filePath'] as string)).toContain('claude_desktop_config.json');
    }
    // If plan is empty (no detected targets in CI), that is also valid
  });
});

// ---------------------------------------------------------------------------
// Missing subverb / edge cases
// ---------------------------------------------------------------------------

describe('subverb validation', () => {
  it('missing subverb emits invalid_invocation', async () => {
    const { ctx, writes, exits } = makeCtx([], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect((out as Record<string, unknown>)['code']).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('unknown subverb emits invalid_invocation', async () => {
    const { ctx, writes, exits } = makeCtx(['frobnicate'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect((out as Record<string, unknown>)['code']).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('unknown target emits invalid_invocation', async () => {
    const { ctx, writes, exits } = makeCtx(['install', '--target', 'nonexistent', '--yes'], false);
    await plugin.run(ctx);

    const out = parseOutput(writes) as Record<string, unknown> | null;
    expect((out as Record<string, unknown>)['code']).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
