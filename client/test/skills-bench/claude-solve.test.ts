import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildClaudeArgs, mountSkill, unmountSkill, prepareBenchConfigDir, parseClaudeJson,
  authPreflightFailureMessage,
} from '../../src/skills-bench/claude-solve.js';

const exec = promisify(execFile);

describe('buildClaudeArgs', () => {
  it('pins model, print mode, JSON output, max turns, project settings, and bypass permission mode', () => {
    const args = buildClaudeArgs({ prompt: 'fix it', model: 'claude-sonnet-5', maxTurns: 40 });
    expect(args).toEqual([
      '-p', 'fix it',
      '--output-format', 'json',
      '--model', 'claude-sonnet-5',
      '--max-turns', '40',
      '--setting-sources', 'project',
      '--permission-mode', 'bypassPermissions',
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

describe('unmountSkill', () => {
  it('removes the .claude mount so a mounted-then-unmounted checkout produces a git diff with no .claude/ hunk (C1)', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'co-git-'));
    await exec('git', ['init', '-q'], { cwd: checkout });
    await exec('git', ['-C', checkout, 'config', 'user.email', 't@t'], {});
    await exec('git', ['-C', checkout, 'config', 'user.name', 't'], {});
    await writeFile(join(checkout, 'a.py'), 'print("before")\n');
    await exec('git', ['-C', checkout, 'add', '-A'], {});
    await exec('git', ['-C', checkout, 'commit', '-q', '-m', 'init'], {});

    const skillDir = await mkdtemp(join(tmpdir(), 'skill-'));
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: tdd\ndescription: d\n---\nbody');
    await writeFile(join(skillDir, 'pin.json'), '{}');
    await mountSkill(checkout, skillDir, 'tdd');
    expect(existsSync(join(checkout, '.claude', 'skills', 'tdd', 'SKILL.md'))).toBe(true);

    // simulate the agent editing a source file during the solve
    await writeFile(join(checkout, 'a.py'), 'print("after")\n');

    await unmountSkill(checkout);
    expect(existsSync(join(checkout, '.claude'))).toBe(false);

    await exec('git', ['-C', checkout, 'add', '-A'], {});
    const { stdout: names } = await exec('git', ['-C', checkout, 'diff', '--cached', '--name-only'], {});
    const paths = names.trim().split('\n').filter(Boolean);
    expect(paths).toEqual(['a.py']);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(false);

    const { stdout: diff } = await exec('git', ['-C', checkout, 'diff', '--cached'], {});
    expect(diff).not.toContain('.claude/');
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

  it('parses pretty-printed JSON spanning multiple lines', () => {
    const pretty = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 3,
      session_id: 'sess-2', total_cost_usd: 0.07, result: 'done',
    }, null, 2);
    expect(parseClaudeJson(pretty)).toMatchObject({
      costUsd: 0.07, numTurns: 3, isError: false, sessionId: 'sess-2',
    });
  });

  it('parses JSON preceded by a plain-text preamble line', () => {
    const withPreamble = `Loading model...\n${JSON.stringify({
      type: 'result', is_error: false, num_turns: 5, session_id: 'sess-3', total_cost_usd: 0.2,
    })}`;
    expect(parseClaudeJson(withPreamble)).toMatchObject({
      costUsd: 0.2, numTurns: 5, isError: false, sessionId: 'sess-3',
    });
  });
});

describe('authPreflightFailureMessage', () => {
  it('names both remediation routes and the resolved config dir', () => {
    const configDir = '/repo/bench/.claude-bench-config';
    const msg = authPreflightFailureMessage(configDir);
    // both routes named
    expect(msg).toContain('ANTHROPIC_API_KEY');
    expect(msg).toContain('/login');
    // the config dir appears (identifies which dir has no usable creds, and
    // is reused verbatim in the interactive-login remediation command)
    const occurrences = msg.split(configDir).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
