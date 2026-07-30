import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildClaudeArgs, mountSkill, prepareBenchConfigDir, parseClaudeJson,
} from '../../src/skills-bench/claude-solve.js';

describe('buildClaudeArgs', () => {
  it('pins model, print mode, JSON output, max turns, and skips permissions', () => {
    const args = buildClaudeArgs({ prompt: 'fix it', model: 'claude-sonnet-5', maxTurns: 40 });
    expect(args).toEqual([
      '-p', 'fix it',
      '--output-format', 'json',
      '--model', 'claude-sonnet-5',
      '--max-turns', '40',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('mountSkill', () => {
  it('copies the skill into <checkout>/.claude/skills/<name> without pin.json', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'co-'));
    const skillDir = await mkdtemp(join(tmpdir(), 'skill-'));
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: tdd\ndescription: d\n---\nbody');
    await writeFile(join(skillDir, 'pin.json'), '{}');
    const mounted = await mountSkill(checkout, skillDir, 'tdd');
    expect(mounted).toBe(join(checkout, '.claude', 'skills', 'tdd'));
    expect(existsSync(join(mounted, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(mounted, 'pin.json'))).toBe(false);
  });
});

describe('prepareBenchConfigDir', () => {
  it('copies only credentials, never skills or memory', async () => {
    const source = await mkdtemp(join(tmpdir(), 'src-cfg-'));
    await writeFile(join(source, '.credentials.json'), '{"k":"v"}');
    await mkdir(join(source, 'skills', 'leaky'), { recursive: true });
    await writeFile(join(source, 'skills', 'leaky', 'SKILL.md'), 'leak');
    await writeFile(join(source, 'CLAUDE.md'), 'leak');
    const bench = join(await mkdtemp(join(tmpdir(), 'bench-cfg-')), 'cfg');
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await prepareBenchConfigDir(bench, { sourceConfigDir: source });
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    expect(JSON.parse(await readFile(join(bench, '.credentials.json'), 'utf8'))).toEqual({ k: 'v' });
    expect(existsSync(join(bench, 'skills'))).toBe(false);
    expect(existsSync(join(bench, 'CLAUDE.md'))).toBe(false);
  });
});

describe('parseClaudeJson', () => {
  it('extracts cost, turns, error flag, session id', () => {
    const out = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 12,
      session_id: 'sess-1', total_cost_usd: 0.42, result: 'done',
    });
    expect(parseClaudeJson(out)).toMatchObject({
      costUsd: 0.42, numTurns: 12, isError: false, sessionId: 'sess-1',
    });
  });

  it('is tolerant of missing cost (costUsd 0) and non-JSON (isError true)', () => {
    expect(parseClaudeJson('{"type":"result","is_error":false}').costUsd).toBe(0);
    expect(parseClaudeJson('garbage').isError).toBe(true);
  });
});
