import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareHermesHome,
  hermesReasoningEffort,
  HERMES_HOMES_DIR,
} from '../../src/dispatcher/hermes-home.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { Effort } from '../../src/dispatcher/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HERMES_ADAPTER_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  '.claude',
  'skills',
  'autopilot-runtime',
  'references',
  'hermes.md',
);

describe('hermesReasoningEffort', () => {
  it('maps the board tiers onto hermes VALID_REASONING_EFFORTS', () => {
    expect(hermesReasoningEffort('Low')).toBe('low');
    expect(hermesReasoningEffort('Medium')).toBe('medium');
    expect(hermesReasoningEffort('High')).toBe('high');
    expect(hermesReasoningEffort('XHigh')).toBe('xhigh');
  });

  it("maps Max → xhigh — 'max' is NOT a hermes tier and would silently degrade", () => {
    // hermes_constants.py VALID_REASONING_EFFORTS = minimal|low|medium|high|xhigh.
    // Passing 'max' through makes parse_reasoning_effort return None → provider
    // default, i.e. the board's highest tier would quietly become the lowest
    // common denominator. xhigh is the real ceiling.
    expect(hermesReasoningEffort('Max')).toBe('xhigh');
  });

  it('no effort → null (key omitted; hermes uses its own default)', () => {
    expect(hermesReasoningEffort(null)).toBeNull();
  });
});

describe('prepareHermesHome', () => {
  let tmp: string;
  let operatorHome: string;
  let worktree: string;
  let repoRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hermes-home-test-'));
    operatorHome = join(tmp, 'operator-hermes');
    worktree = join(tmp, 'wt');
    repoRoot = join(tmp, 'repo');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    // Clean any home this test created under the real HERMES_HOMES_DIR.
    rmSync(join(HERMES_HOMES_DIR, 'implement-4242'), { recursive: true, force: true });
    rmSync(join(HERMES_HOMES_DIR, 'implement-4243'), { recursive: true, force: true });
  });

  function prep(effort: Effort | null, issueNumber = 4242) {
    const { hermesHome } = prepareHermesHome({
      sessionId: `implement-${issueNumber}`,
      worktreePath: worktree,
      effort,
      cfg: DEFAULT_CONFIG,
      operatorHome,
      repoRoot,
    });
    return { hermesHome, yaml: readFileSync(join(hermesHome, 'config.yaml'), 'utf8') };
  }

  it('writes the dispatcher-chosen model and pins the subscription provider', () => {
    const { yaml } = prep('Low');
    expect(yaml).toContain('default: "gpt-5.6-sol"');
    expect(yaml).toContain('provider: "openai-codex"');
  });

  it('BILLING GUARD: the model id is bare — an org-prefixed id would infer openrouter', () => {
    // hermes infers `openrouter` from any `<org>/<model>` shape, which bills an
    // API key instead of the operator's ChatGPT/Codex subscription.
    const { yaml } = prep('Low');
    expect(yaml).not.toContain('openai/gpt');
    expect(yaml).not.toContain('openrouter');
  });

  it('does NOT set api_mode or base_url — openai-codex auto-selects codex_responses + the Codex URL', () => {
    const { yaml } = prep('Low');
    expect(yaml).not.toContain('api_mode');
    expect(yaml).not.toContain('base_url');
  });

  it('writes the mapped reasoning effort (the only way to set it — no flag, no env)', () => {
    expect(prep('High').yaml).toContain('reasoning_effort: "high"');
    expect(prep('Max').yaml).toContain('reasoning_effort: "xhigh"');
  });

  it('omits reasoning_effort entirely when the issue has no Effort', () => {
    expect(prep(null).yaml).not.toContain('reasoning_effort');
  });

  it('enables the delegation toolset — native subagents are the pipeline', () => {
    // The client daemon deliberately EXCLUDES delegation for marketplace solves;
    // a coordinator is the opposite case. This asserts the divergence is intact.
    const { yaml } = prep('Medium');
    expect(yaml).toContain('"delegation"');
    expect(yaml).toContain('"terminal"'); // shell for git/gh/yarn
    expect(yaml).toContain('"skills"');   // SKILL.md loader
  });

  it('keeps process-local depth at one because depth-needing stages are fresh roots', () => {
    const { yaml } = prep('Medium');
    expect(yaml).not.toContain('max_spawn_depth');
    expect(readFileSync(HERMES_ADAPTER_PATH, 'utf8'))
      .toMatch(/new\s+depth-0 Hermes process/);
  });

  it('does not pin delegation model/provider/effort — children inherit the parent (same Sol, same effort)', () => {
    const { yaml } = prep('High');
    const delegation = yaml.slice(yaml.indexOf('delegation:'), yaml.indexOf('skills:'));
    expect(delegation).not.toContain('model:');
    expect(delegation).not.toContain('provider:');
    expect(delegation).not.toContain('reasoning_effort:');
  });

  it('points the skills loader at the repo skills dir and wires the app-test MCP', () => {
    const { yaml } = prep('Low');
    expect(yaml).toContain(join(repoRoot, '.claude', 'skills'));
    expect(yaml).toContain('chrome-devtools');
  });

  it('pins the terminal to the session worktree', () => {
    const { yaml } = prep('Low');
    expect(yaml).toContain('backend: "local"');
    expect(yaml).toContain(`cwd: ${JSON.stringify(worktree)}`);
  });

  it('raises max_turns above the 90 default (a coordinator triages, delegates every stage, and ships)', () => {
    expect(prep('Low').yaml).toMatch(/max_turns: \d{3,}/);
  });

  it('seeds .env — hermes reads provider keys from $HERMES_HOME/.env, not the shell env', () => {
    // Without this the session dies ~14s in: "Provider resolver returned an
    // empty API key". The OpenRouter key typically exists ONLY in the
    // operator's ~/.hermes/.env, so a home without .env has no credentials.
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(join(operatorHome, '.env'), 'OPENROUTER_API_KEY=sk-test\n');
    const { hermesHome } = prep('Low');
    expect(existsSync(join(hermesHome, '.env'))).toBe(true);
    expect(readFileSync(join(hermesHome, '.env'), 'utf8')).toContain('OPENROUTER_API_KEY');
  });

  it('seeds operator auth + the tirith scanner when present, and never overwrites', () => {
    mkdirSync(join(operatorHome, 'bin'), { recursive: true });
    writeFileSync(join(operatorHome, 'auth.json'), '{"k":1}');
    writeFileSync(join(operatorHome, 'bin', 'tirith'), '#!/bin/sh\n');

    const { hermesHome } = prep('Low');
    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(true);
    expect(existsSync(join(hermesHome, 'bin', 'tirith'))).toBe(true);

    // Re-dispatch must not clobber seeded state.
    writeFileSync(join(hermesHome, 'auth.json'), '{"k":"local-edit"}');
    prep('High');
    expect(readFileSync(join(hermesHome, 'auth.json'), 'utf8')).toBe('{"k":"local-edit"}');
  });

  it('works when the operator has no hermes home at all (nothing to seed)', () => {
    expect(() => prep('Low')).not.toThrow();
  });

  it('gives each issue its own home (concurrent sessions may run at different efforts)', () => {
    const a = prep('Low', 4242);
    const b = prep('XHigh', 4243);
    expect(a.hermesHome).not.toBe(b.hermesHome);
    expect(a.yaml).toContain('reasoning_effort: "low"');
    expect(b.yaml).toContain('reasoning_effort: "xhigh"');
  });
});
