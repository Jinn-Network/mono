import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectAutoModeAvailable } from '../../src/agent/auto-mode-detect.js';
import { OperatorClaudeSpawnError, spawnOperatorClaude } from '../../src/agent/operator-claude.js';

vi.mock('node-pty', () => ({
  spawn: () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    throw err;
  },
}));

describe('detectAutoModeAvailable', () => {
  it('returns available=false when binary does not exist', async () => {
    const res = await detectAutoModeAvailable('/nonexistent/claude');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('failed');
  });
});

describe('spawnOperatorClaude', () => {
  it('maps ENOENT spawn failures to missing Claude Code remediation', async () => {
    const oldHome = process.env['HOME'];
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'jinn-operator-claude-'));
    try {
      await expect(spawnOperatorClaude({
        claudePath: '/missing/claude',
        cwd: process.cwd(),
        autoMode: false,
      })).rejects.toMatchObject({
        name: 'OperatorClaudeSpawnError',
        message: 'Claude Code CLI not found: /missing/claude',
      } satisfies Partial<OperatorClaudeSpawnError>);
    } finally {
      if (oldHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = oldHome;
    }
  });
});
