# Skills Factory MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the off-protocol skills-bench rig (pin skills → slate → claude-code arms → Docker grading → paired stats → receipts), run wave 1 (incumbent receipts) and support wave 2 (fork + holdout), and scaffold the public skills repo.

**Architecture:** A new `client/src/skills-bench/` module family plus `client/scripts/skills-bench/` CLIs, composing four shipped components: the pilot rig's repo/patch helpers (`client/src/pilot/repo.ts`), the swe-rebench Docker grader (`client/src/harnesses/impls/swe-rebench-v2-evaluator/`), core paired statistics (`client/src/eval/paired.ts` re-exporting `@jinn-network/core`), and Wilson intervals (`client/src/eval/wilson.ts`). Solves run through the **claude-code CLI** (not jinn-agent — the ecologically valid profile for registry skills), with the skill under test mounted into the per-attempt checkout at `.claude/skills/<name>/` and global-config leakage blocked via an isolated `CLAUDE_CONFIG_DIR`. Everything is durable-resumable via an append-only attempts JSONL. Spec: [`docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md`](../specs/2026-07-30-skills-factory-mvp-design.md).

**Tech Stack:** TypeScript ESM (Node 22, `.js` import suffixes), vitest, claude-code CLI, Docker (swe-rebench eval images), HuggingFace dataset fetch (existing `HttpHfFetcher`).

## Global Constraints

- **Receipt model is pinned:** `claude-sonnet-5` for all published receipts; `claude-haiku-4-5-20251001` for smoke/dry runs only. Never mix models inside one comparison.
- **Slate:** N=30 screened instances, split 15 feedback / 15 holdout, seed-deterministic, committed with sha256. Holdout is opened once per candidate (enforced by ledger, Task 7).
- **Exclusions:** slate must exclude all active cap-v0 held-out slate ids (`loadActiveHeldOutSlateIds`, versions `v1..v3`) — that boundary belongs to capability-eval.
- **Disk:** grading host needs `JINN_EVAL_DISK_FLOOR_GB≥40`; full waves run on a ≥100 GB-free Linux amd64 host, never a laptop.
- **Licenses:** a skill is fork-eligible only if its pinned `license` permits redistribution/modification; measure-only otherwise. Recorded in `pin.json`.
- **Frontmatter discipline (spec §5.1):** `description` = pure trigger text; receipts referenced only via flat string `metadata` keys `jinn.receipt`, `jinn.receipt-sha256`, `jinn.measured-on`, `jinn.forked-from`; six allowed frontmatter keys only.
- **No fabricated numbers:** no receipt, README, or fixture that could be mistaken for a real measurement; test fixtures use obviously synthetic ids (`fix-widget-0001`).
- **Repo conventions:** American English; match existing client code style; tests under `client/test/skills-bench/`; run with `cd client && yarn vitest run test/skills-bench/<file> --reporter=dot`.

## File Structure

```
client/src/skills-bench/
  skill-pin.ts        pin an upstream skill dir at a commit → vendored copy + pin.json
  slate.ts            deterministic feedback/holdout split + slate hashing
  claude-solve.ts     claude CLI args, skill mounting, config-dir isolation, output parsing
  attempts.ts         append-only attempt records + resume filtering + manifest guard
  receipt.ts          paired stats → ReceiptData → RECEIPT.md renderer
  frontmatter.ts      Agent-Skills frontmatter builder + lint (spec constraints)
  holdout-guard.ts    one-shot holdout ledger
client/scripts/skills-bench/
  pin-skill.ts        CLI: pin owner/repo@commit path → bench/skills-under-test/<name>/
  build-slate.ts      CLI: HF pool → candidates → slate.json
  run-bench.ts        CLI: orchestrator (solve → patch → grade → outcomes.jsonl)
  render-receipts.ts  CLI: outcomes.jsonl → receipts/<arm>.md + SUMMARY.md
client/test/skills-bench/
  skill-pin.test.ts  slate.test.ts  claude-solve.test.ts  attempts.test.ts
  receipt.test.ts  frontmatter.test.ts  holdout-guard.test.ts
bench/                              (gitignored working data EXCEPT committed slate + pins)
  skills-under-test/<name>/         vendored pinned skills (committed)
  slate/slate.json                  committed slate
docs/runbooks/skills-bench.md       wave-1/wave-2/publish runbook
```

---

### Task 1: Skill pinning (`skill-pin.ts` + `pin-skill.ts` CLI)

**Files:**
- Create: `client/src/skills-bench/skill-pin.ts`
- Create: `client/scripts/skills-bench/pin-skill.ts`
- Test: `client/test/skills-bench/skill-pin.test.ts`

**Interfaces:**
- Consumes: `CmdRunner` type from `../pilot/repo.js` (`(cmd, args, opts?) => Promise<{stdout, stderr, exitCode}>`).
- Produces: `pinSkill(opts: PinSkillOptions): Promise<SkillPin>`; type `SkillPin { name: string; source: string; commit: string; skillPath: string; sha256: string; license: string | null; fetchedAt: string }`. Vendored dir layout: `<destRoot>/<name>/{SKILL.md, ...companions, pin.json}`. Tasks 4 and 6 read vendored dirs; Task 6 reads `pin.json.license`.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/skill-pin.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pinSkill } from '../../src/skills-bench/skill-pin.js';

const exec = promisify(execFile);

async function makeFixtureRepo(): Promise<{ repoDir: string; commit: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), 'skill-fixture-'));
  await exec('git', ['init', '-q'], { cwd: repoDir });
  await exec('git', ['-C', repoDir, 'config', 'user.email', 't@t'], {});
  await exec('git', ['-C', repoDir, 'config', 'user.name', 't'], {});
  await mkdir(join(repoDir, 'skills', 'tdd'), { recursive: true });
  await writeFile(
    join(repoDir, 'skills', 'tdd', 'SKILL.md'),
    '---\nname: tdd\ndescription: Test-driven development workflow. Use when implementing features.\nlicense: MIT\n---\n\nBody.\n',
  );
  await exec('git', ['-C', repoDir, 'add', '-A'], {});
  await exec('git', ['-C', repoDir, 'commit', '-q', '-m', 'fixture'], {});
  const { stdout } = await exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {});
  return { repoDir, commit: stdout.trim() };
}

describe('pinSkill', () => {
  it('vendors the skill dir at the pinned commit and writes pin.json', async () => {
    const { repoDir, commit } = await makeFixtureRepo();
    const destRoot = await mkdtemp(join(tmpdir(), 'pins-'));
    const pin = await pinSkill({
      name: 'tdd',
      source: repoDir,        // local path or git URL — both go through `git clone`
      commit,
      skillPath: 'skills/tdd',
      destRoot,
    });
    expect(pin.commit).toBe(commit);
    expect(pin.license).toBe('MIT');
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(destRoot, 'tdd', 'SKILL.md'))).toBe(true);
    const onDisk = JSON.parse(await readFile(join(destRoot, 'tdd', 'pin.json'), 'utf8'));
    expect(onDisk.commit).toBe(commit);
  });

  it('fails loud when the skill path is missing at the commit', async () => {
    const { repoDir, commit } = await makeFixtureRepo();
    const destRoot = await mkdtemp(join(tmpdir(), 'pins-'));
    await expect(
      pinSkill({ name: 'nope', source: repoDir, commit, skillPath: 'skills/nope', destRoot }),
    ).rejects.toThrow(/skills\/nope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/skill-pin.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '../../src/skills-bench/skill-pin.js'`

- [ ] **Step 3: Implement `skill-pin.ts`**

```typescript
// client/src/skills-bench/skill-pin.ts
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface PinSkillOptions {
  name: string;
  /** git URL or local path (anything `git clone` accepts). */
  source: string;
  commit: string;
  /** path of the skill directory inside the repo, e.g. `skills/tdd`. */
  skillPath: string;
  destRoot: string;
}

export interface SkillPin {
  name: string;
  source: string;
  commit: string;
  skillPath: string;
  /** sha256 over sorted (relative-path, bytes) pairs of the vendored dir, pin.json excluded. */
  sha256: string;
  /** frontmatter `license` value, null when absent — Task 6 gates forking on it. */
  license: string | null;
  fetchedAt: string;
}

async function hashDir(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'pin.json') continue;
      if (e.isDirectory()) await walk(childRel);
      else {
        hash.update(childRel);
        hash.update(await readFile(join(dir, childRel)));
      }
    }
  };
  await walk('');
  return hash.digest('hex');
}

function parseFrontmatterLicense(skillMd: string): string | null {
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const line = fm[1]!.split('\n').find((l) => l.startsWith('license:'));
  return line ? line.slice('license:'.length).trim() || null : null;
}

export async function pinSkill(opts: PinSkillOptions): Promise<SkillPin> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'skill-pin-'));
  try {
    await exec('git', ['clone', '-q', opts.source, cloneDir]);
    await exec('git', ['-C', cloneDir, 'checkout', '-q', opts.commit]);
    const src = join(cloneDir, opts.skillPath);
    if (!existsSync(join(src, 'SKILL.md'))) {
      throw new Error(`no SKILL.md at ${opts.skillPath} in ${opts.source}@${opts.commit}`);
    }
    const dest = join(opts.destRoot, opts.name);
    await rm(dest, { recursive: true, force: true });
    await mkdir(opts.destRoot, { recursive: true });
    await cp(src, dest, { recursive: true });
    const skillMd = await readFile(join(dest, 'SKILL.md'), 'utf8');
    const pin: SkillPin = {
      name: opts.name,
      source: opts.source,
      commit: opts.commit,
      skillPath: opts.skillPath,
      sha256: await hashDir(dest),
      license: parseFrontmatterLicense(skillMd),
      fetchedAt: new Date().toISOString(),
    };
    await writeFile(join(dest, 'pin.json'), `${JSON.stringify(pin, null, 2)}\n`);
    return pin;
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/skill-pin.test.ts --reporter=dot`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the CLI wrapper**

```typescript
// client/scripts/skills-bench/pin-skill.ts
// Usage: yarn tsx scripts/skills-bench/pin-skill.ts --name tdd \
//          --source https://github.com/mattpocock/skills --commit <sha> \
//          --skill-path skills/tdd [--dest ../bench/skills-under-test]
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { pinSkill } from '../../src/skills-bench/skill-pin.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pin = await pinSkill({
  name: arg('name'),
  source: arg('source'),
  commit: arg('commit'),
  skillPath: arg('skill-path'),
  destRoot: resolve(arg('dest', join(repoRoot, 'bench', 'skills-under-test'))),
});
console.log(JSON.stringify(pin, null, 2));
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd client && yarn typecheck` — Expected: zero errors.

```bash
git add client/src/skills-bench/skill-pin.ts client/scripts/skills-bench/pin-skill.ts client/test/skills-bench/skill-pin.test.ts
git commit -m "feat(skills-bench): pin upstream skills at a commit with license + sha256"
```

---

### Task 2: Slate build + deterministic split (`slate.ts` + `build-slate.ts` CLI)

**Files:**
- Create: `client/src/skills-bench/slate.ts`
- Create: `client/scripts/skills-bench/build-slate.ts`
- Test: `client/test/skills-bench/slate.test.ts`

**Interfaces:**
- Consumes: `loadActiveHeldOutSlateIds`, `ACTIVE_HELD_OUT_SLATE_VERSIONS` from `client/src/solver-types/_swe-rebench-v2-held-out-slate.js`; HF pool helpers `fetchHfSplit`, `buildHistoricalPool`, `listMonthlyPartitions` from `client/src/solver-types/_swe-rebench-v2-pool.js` (mirror their use in `client/scripts/build-pilot-slate.ts`).
- Produces: `splitSlate(candidates: SlateCandidate[], opts: SplitOptions): SkillsBenchSlate`; types `SlateCandidate { instance_id: string; repo: string; hf_dataset: string; hf_split: string }`, `SkillsBenchSlate { version: 'skills-bench-slate.v1'; seed: string; feedback: SlateCandidate[]; holdout: SlateCandidate[]; sha256: string }`; `hashSlate(slate: Omit<SkillsBenchSlate,'sha256'>): string`. Task 4 reads `bench/slate/slate.json` in this shape; Task 7 reads `holdout` ids.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/slate.test.ts
import { describe, expect, it } from 'vitest';
import { splitSlate, hashSlate, type SlateCandidate } from '../../src/skills-bench/slate.js';

function candidates(n: number): SlateCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    instance_id: `fix-widget-${String(i).padStart(4, '0')}`,
    repo: `org/repo-${i % 7}`, // 7 repos so repo-dedup logic is exercised
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: 'test',
  }));
}

describe('splitSlate', () => {
  it('is deterministic for a fixed seed and disjoint', () => {
    const a = splitSlate(candidates(40), { seed: 'test-seed', feedbackSize: 15, holdoutSize: 15 });
    const b = splitSlate(candidates(40), { seed: 'test-seed', feedbackSize: 15, holdoutSize: 15 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.feedback).toHaveLength(15);
    expect(a.holdout).toHaveLength(15);
    const fb = new Set(a.feedback.map((c) => c.instance_id));
    for (const h of a.holdout) expect(fb.has(h.instance_id)).toBe(false);
  });

  it('changes with the seed', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const b = splitSlate(candidates(40), { seed: 's2', feedbackSize: 15, holdoutSize: 15 });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('throws when the pool is too small', () => {
    expect(() => splitSlate(candidates(20), { seed: 's', feedbackSize: 15, holdoutSize: 15 }))
      .toThrow(/pool too small/);
  });

  it('hash covers membership and halves', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const tampered = { ...a, holdout: a.holdout.slice(1) };
    expect(hashSlate(tampered)).not.toBe(a.sha256);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/slate.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `slate.ts`**

```typescript
// client/src/skills-bench/slate.ts
import { createHash } from 'node:crypto';

export interface SlateCandidate {
  instance_id: string;
  repo: string;
  hf_dataset: string;
  hf_split: string;
}

export interface SplitOptions {
  seed: string;
  feedbackSize: number;
  holdoutSize: number;
}

export interface SkillsBenchSlate {
  version: 'skills-bench-slate.v1';
  seed: string;
  feedback: SlateCandidate[];
  holdout: SlateCandidate[];
  sha256: string;
}

function rankKey(seed: string, id: string): string {
  return createHash('sha256').update(`${seed} ${id}`).digest('hex');
}

export function hashSlate(slate: Omit<SkillsBenchSlate, 'sha256'>): string {
  const canonical = JSON.stringify({
    version: slate.version,
    seed: slate.seed,
    feedback: slate.feedback.map((c) => c.instance_id),
    holdout: slate.holdout.map((c) => c.instance_id),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Seed-deterministic split: candidates are ranked by sha256(seed, instance_id),
 * then assigned alternately (even rank → feedback, odd → holdout) until each
 * half is full. Alternation balances difficulty drift better than a prefix cut
 * and keeps the split a pure function of (seed, membership).
 */
export function splitSlate(candidates: SlateCandidate[], opts: SplitOptions): SkillsBenchSlate {
  const need = opts.feedbackSize + opts.holdoutSize;
  const unique = [...new Map(candidates.map((c) => [c.instance_id, c])).values()];
  if (unique.length < need) {
    throw new Error(`pool too small: ${unique.length} candidates for ${need} slots`);
  }
  const ranked = [...unique].sort((a, b) =>
    rankKey(opts.seed, a.instance_id).localeCompare(rankKey(opts.seed, b.instance_id)));
  const feedback: SlateCandidate[] = [];
  const holdout: SlateCandidate[] = [];
  for (const c of ranked) {
    if (feedback.length + holdout.length === need) break;
    if ((feedback.length + holdout.length) % 2 === 0 && feedback.length < opts.feedbackSize) feedback.push(c);
    else if (holdout.length < opts.holdoutSize) holdout.push(c);
    else feedback.push(c);
  }
  const body = { version: 'skills-bench-slate.v1' as const, seed: opts.seed, feedback, holdout };
  return { ...body, sha256: hashSlate(body) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/slate.test.ts --reporter=dot`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the CLI (network path, no unit test — validated in the smoke task)**

```typescript
// client/scripts/skills-bench/build-slate.ts
// Usage: yarn tsx scripts/skills-bench/build-slate.ts --seed jinn.skills-bench.v1 \
//          [--pool-size 60] [--out ../bench/slate/slate.json]
// Sources candidates the same way build-pilot-slate.ts does (HF monthly
// partitions → historical pool), then:
//   1. excludes every active cap-v0 held-out slate id (loadActiveHeldOutSlateIds),
//   2. dedupes to at most 2 instances per repo (independence: the cluster is the repo),
//   3. takes the seed-ranked first `pool-size` as candidates,
//   4. splitSlate({feedbackSize: 15, holdoutSize: 15}) and writes slate.json.
// Screening note (spec §2): instances here are already gradeable-screened by the
// validated-pool machinery this reuses; the smoke run (Task 9) is the final
// gradeability check before the slate is frozen by commit.
```

Implement by copying the pool-loading section of `client/scripts/build-pilot-slate.ts` (imports listed in Interfaces above), then applying steps 1–4 with `splitSlate` and `writeFileSync(out, JSON.stringify(slate, null, 2))`. Print `sha256` and both halves' sizes on completion.

- [ ] **Step 6: Typecheck and commit**

Run: `cd client && yarn typecheck` — Expected: zero errors.

```bash
git add client/src/skills-bench/slate.ts client/scripts/skills-bench/build-slate.ts client/test/skills-bench/slate.test.ts
git commit -m "feat(skills-bench): deterministic feedback/holdout slate split + build CLI"
```

---

### Task 3: claude-code solve path (`claude-solve.ts`)

**Files:**
- Create: `client/src/skills-bench/claude-solve.ts`
- Test: `client/test/skills-bench/claude-solve.test.ts`

**Interfaces:**
- Consumes: nothing internal (pure module: path/fs + arg building).
- Produces (Task 4 depends on these exact names):
  - `buildClaudeArgs(opts: { prompt: string; model: string; maxTurns: number }): string[]`
  - `mountSkill(checkoutDir: string, skillDir: string, name: string): Promise<string>` → returns mounted path `<checkoutDir>/.claude/skills/<name>`; copies every file except `pin.json`.
  - `prepareBenchConfigDir(benchConfigDir: string, opts: { sourceConfigDir?: string }): Promise<void>` — isolated `CLAUDE_CONFIG_DIR`: creates dir; copies ONLY `.credentials.json` from source when it exists and `ANTHROPIC_API_KEY` is unset; never copies `skills/`, `plugins/`, `CLAUDE.md`, `settings.json`.
  - `parseClaudeJson(stdout: string): ClaudeRunResult`; type `ClaudeRunResult { costUsd: number; numTurns: number | null; isError: boolean; sessionId: string | null; raw: string }` — tolerant: missing `total_cost_usd` → `costUsd = 0` (cost is reported, never gates; spec 1.5 of the parent design).

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/claude-solve.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/claude-solve.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `claude-solve.ts`**

```typescript
// client/src/skills-bench/claude-solve.ts
import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeRunResult {
  costUsd: number;
  numTurns: number | null;
  isError: boolean;
  sessionId: string | null;
  raw: string;
}

export function buildClaudeArgs(opts: { prompt: string; model: string; maxTurns: number }): string[] {
  return [
    '-p', opts.prompt,
    '--output-format', 'json',
    '--model', opts.model,
    '--max-turns', String(opts.maxTurns),
    '--dangerously-skip-permissions',
  ];
}

/** Mount the pinned skill into the per-attempt checkout — the project-level
 *  location claude-code discovers skills from, so the treatment is exactly
 *  "this skill is installed in this workspace". pin.json is rig metadata, not
 *  part of the published skill, and must not ride along. */
export async function mountSkill(checkoutDir: string, skillDir: string, name: string): Promise<string> {
  const dest = join(checkoutDir, '.claude', 'skills', name);
  await mkdir(dest, { recursive: true });
  await cp(skillDir, dest, { recursive: true });
  await rm(join(dest, 'pin.json'), { force: true });
  return dest;
}

/** Isolated CLAUDE_CONFIG_DIR: auth travels, nothing else does. User-level
 *  skills, plugins, memory, and settings must not leak into any arm — the
 *  baseline arm's claim is "no skill installed". */
export async function prepareBenchConfigDir(
  benchConfigDir: string,
  opts: { sourceConfigDir?: string },
): Promise<void> {
  await mkdir(benchConfigDir, { recursive: true });
  if (process.env.ANTHROPIC_API_KEY) return; // env auth: nothing to copy
  const src = opts.sourceConfigDir;
  if (src && existsSync(join(src, '.credentials.json'))) {
    await copyFile(join(src, '.credentials.json'), join(benchConfigDir, '.credentials.json'));
  }
}

export function parseClaudeJson(stdout: string): ClaudeRunResult {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{')) ?? '';
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    return {
      costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0,
      numTurns: typeof o.num_turns === 'number' ? o.num_turns : null,
      isError: o.is_error === true,
      sessionId: typeof o.session_id === 'string' ? o.session_id : null,
      raw: stdout,
    };
  } catch {
    return { costUsd: 0, numTurns: null, isError: true, sessionId: null, raw: stdout };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/claude-solve.test.ts --reporter=dot`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/skills-bench/claude-solve.ts client/test/skills-bench/claude-solve.test.ts
git commit -m "feat(skills-bench): claude-code solve path — args, skill mount, config isolation, output parse"
```

---

### Task 4: Durable attempts + bench orchestrator (`attempts.ts` + `run-bench.ts`)

**Files:**
- Create: `client/src/skills-bench/attempts.ts`
- Create: `client/scripts/skills-bench/run-bench.ts`
- Test: `client/test/skills-bench/attempts.test.ts`

**Interfaces:**
- Consumes: Task 2 `SkillsBenchSlate`; Task 3 `buildClaudeArgs`/`mountSkill`/`prepareBenchConfigDir`/`parseClaudeJson`; pilot helpers `prepareBaseCheckout(run, repo, baseCommit, baseDir)`, `recoverPatch(run, cwd)`, `createPilotWorkDir(outDir, prefix)`, `GitStepError` from `client/src/pilot/repo.js`; grading via `HttpHfFetcher` (`client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js`) and `PythonEvalRunner` + `EvalCouldNotGradeError` (`.../eval-runner.js`) — mirror `gradeOne` at `client/scripts/run-pilot.ts:361` exactly (fields: `row.image_name`, `row.install_config.install/test_cmd/log_parser`, `row.FAIL_TO_PASS`, `row.PASS_TO_PASS`; empty patch → `passed:false`; `EvalCouldNotGradeError` → `passed:null`).
- Produces:
  - `type BenchOutcome { instanceId: string; arm: string; repeat: number; passed: boolean | null; unscorable: boolean; costUsd: number }` (aligned with core `PairedInput` via mapping in Task 5).
  - `attemptKey(o: {instanceId: string; arm: string; repeat: number}): string` → `` `${instanceId}|${arm}|${repeat}` ``.
  - `appendAttempt(file: string, o: BenchOutcome): Promise<void>` (JSONL append).
  - `loadAttempts(file: string): Promise<BenchOutcome[]>` (missing file → `[]`; later duplicate key wins).
  - `assertManifestCompatible(file: string, manifest: BenchManifest): Promise<void>`; `type BenchManifest { version: 'skills-bench-manifest.v1'; slateSha256: string; model: string; arms: { name: string; skillSha256: string | null }[] }` — first run writes it; later runs fail loud on any mismatch (a changed skill or model must not resume into the same outcomes file).
  - CLI `run-bench.ts` writing `<out>/attempts.jsonl` + `<out>/bench-manifest.json` + per-attempt transcripts `<out>/transcripts/<attemptKey>.json`.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/attempts.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendAttempt, loadAttempts, attemptKey, assertManifestCompatible,
  type BenchOutcome, type BenchManifest,
} from '../../src/skills-bench/attempts.js';

const outcome = (over: Partial<BenchOutcome> = {}): BenchOutcome => ({
  instanceId: 'fix-widget-0001', arm: 'baseline', repeat: 0,
  passed: true, unscorable: false, costUsd: 0.1, ...over,
});

describe('attempts log', () => {
  it('round-trips and resumes: later duplicate key wins, missing file is empty', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'att-')), 'attempts.jsonl');
    expect(await loadAttempts(file)).toEqual([]);
    await appendAttempt(file, outcome());
    await appendAttempt(file, outcome({ arm: 'tdd' }));
    await appendAttempt(file, outcome({ passed: false })); // rerun of first key
    const loaded = await loadAttempts(file);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((o) => attemptKey(o) === 'fix-widget-0001|baseline|0')!.passed).toBe(false);
  });
});

describe('manifest guard', () => {
  const manifest: BenchManifest = {
    version: 'skills-bench-manifest.v1', slateSha256: 'abc', model: 'claude-sonnet-5',
    arms: [{ name: 'baseline', skillSha256: null }, { name: 'tdd', skillSha256: 'def' }],
  };

  it('writes on first run, accepts identical, rejects drift', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'mf-')), 'bench-manifest.json');
    await assertManifestCompatible(file, manifest);           // writes
    await assertManifestCompatible(file, manifest);           // identical → ok
    await expect(
      assertManifestCompatible(file, { ...manifest, model: 'claude-haiku-4-5-20251001' }),
    ).rejects.toThrow(/manifest mismatch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/attempts.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `attempts.ts`**

```typescript
// client/src/skills-bench/attempts.ts
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BenchOutcome {
  instanceId: string;
  arm: string;
  repeat: number;
  /** null = ungradeable (never coerced to fail — mirrors ArmResult in packages/layer/src/measurement.ts). */
  passed: boolean | null;
  unscorable: boolean;
  costUsd: number;
}

export interface BenchManifest {
  version: 'skills-bench-manifest.v1';
  slateSha256: string;
  model: string;
  arms: { name: string; skillSha256: string | null }[];
}

export function attemptKey(o: { instanceId: string; arm: string; repeat: number }): string {
  return `${o.instanceId}|${o.arm}|${o.repeat}`;
}

export async function appendAttempt(file: string, o: BenchOutcome): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(o)}\n`);
}

export async function loadAttempts(file: string): Promise<BenchOutcome[]> {
  if (!existsSync(file)) return [];
  const byKey = new Map<string, BenchOutcome>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as BenchOutcome;
    byKey.set(attemptKey(o), o); // later wins — a rerun supersedes
  }
  return [...byKey.values()];
}

export async function assertManifestCompatible(file: string, manifest: BenchManifest): Promise<void> {
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const existing = await readFile(file, 'utf8');
  const wanted = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existing !== wanted) {
    throw new Error(
      `skills-bench manifest mismatch: ${file} was written by a different configuration ` +
      `(slate, model, or arm bytes changed). Use a fresh --out dir for a changed run.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/attempts.test.ts --reporter=dot`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the orchestrator CLI**

`client/scripts/skills-bench/run-bench.ts`, modeled on `client/scripts/run-pilot.ts` (`solveOne`/`gradeOne`/durable loop) with these differences — solver is claude-code, arms are skill dirs, resume is `attempts.ts`:

```typescript
// Usage:
//   yarn tsx scripts/skills-bench/run-bench.ts --dry-run
//   yarn tsx scripts/skills-bench/run-bench.ts \
//     --slate ../bench/slate/slate.json [--half feedback|holdout|both] \
//     --arms ../bench/arms/wave1.json --model claude-sonnet-5 \
//     --out ../bench/runs/wave1 [--repeats 1] [--max-turns 40] \
//     [--max-instances N] [--grade-timeout-ms 600000] [--upstream-repo-dir PATH]
//
// arms file shape (baseline has skillDir null):
//   [{ "name": "baseline", "skillDir": null },
//    { "name": "tdd", "skillDir": "../bench/skills-under-test/tdd" }]
//
// Per (instance × arm × repeat), skipping keys already in attempts.jsonl:
//   1. row = new HttpHfFetcher().fetchTaskRow({hf_dataset, hf_split, instance_id})
//   2. baseDir = prepareBaseCheckout(run, row.repo, row.base_commit, workDir)   // GitStepError → skip instance, continue
//   3. armDir = copy of baseDir; if arm.skillDir: await mountSkill(armDir, arm.skillDir, arm.name)
//   4. prompt = buildPrompt(row.problem_statement)  — reuse run-pilot's prompt text
//      (client/scripts/run-pilot.ts:302-307) WITHOUT the skillsNudge line: claude-code
//      loads skill descriptions natively, so a nudge would measure prompt-compliance.
//   5. spawn 'claude' with buildClaudeArgs({prompt, model, maxTurns}), cwd=armDir,
//      env = { ...process.env, CLAUDE_CONFIG_DIR: benchCfgDir } (prepareBenchConfigDir once at startup)
//   6. patch = await recoverPatch(run, armDir); write transcript JSON (parseClaudeJson result + patch)
//   7. grade: mirror gradeOne (run-pilot.ts:361) — empty patch → passed:false;
//      PythonEvalRunner({upstreamRepoDir, evalTimeoutMs}); EvalCouldNotGradeError → passed:null.
//      Grading strictly serial (SerialTaskQueue from client/src/pilot/pipeline.js), solves --solve-concurrency (default 1).
//   8. appendAttempt(out/attempts.jsonl, {instanceId, arm, repeat, passed, unscorable: passed===null, costUsd})
//
// --dry-run synthesizes alternating outcomes exactly like run-pilot's
// synthesizeDryRunOutcomes and never touches git/Docker/network/claude.
// Startup: assertManifestCompatible(out/bench-manifest.json, {version, slateSha256, model,
//   arms: arms.map(a => ({name, skillSha256: a.skillDir ? pinSha(a.skillDir) : null}))})
//   where pinSha reads <skillDir>/pin.json's sha256.
```

Write the file following that skeleton; every referenced helper exists (Interfaces above). Keep it a thin composition — no new logic beyond the loop, flag parsing, and logging (`[bench] solving <id> arm=<name> repeat=<n>` / `[bench] graded <id> arm=<name> → passed|failed|ungradeable`).

- [ ] **Step 6: Verify the dry run end-to-end**

Run: `cd client && yarn tsx scripts/skills-bench/run-bench.ts --dry-run --slate ../bench/slate/slate.json --arms ../bench/arms/wave1.json --out /tmp/bench-dry` (create a 2-entry fixture slate + arms file inline if `bench/` files don't exist yet).
Expected: attempts.jsonl written; rerunning the same command reports every attempt skipped (resume works); `yarn typecheck` zero errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/skills-bench/attempts.ts client/scripts/skills-bench/run-bench.ts client/test/skills-bench/attempts.test.ts
git commit -m "feat(skills-bench): durable attempts log + claude-code bench orchestrator with dry-run"
```

---

### Task 5: Receipts (`receipt.ts` + `render-receipts.ts` CLI)

**Files:**
- Create: `client/src/skills-bench/receipt.ts`
- Create: `client/scripts/skills-bench/render-receipts.ts`
- Test: `client/test/skills-bench/receipt.test.ts`

**Interfaces:**
- Consumes: `BenchOutcome` from Task 4; `comparePaired`, `type PairedInput`, `type PairedComparison` from `client/src/eval/paired.js`; `wilsonInterval(passed, scorable, z?)` from `client/src/eval/wilson.js`; `SkillPin` (Task 1) for provenance lines.
- Produces:
  - `buildReceipt(outcomes: BenchOutcome[], opts: { baselineArm: string; treatmentArm: string; profile: ReceiptProfile }): ReceiptData`
  - `type ReceiptProfile { model: string; agent: string; slateSha256: string; slateHalf: 'feedback' | 'holdout' | 'both'; measuredOn: string; forkedFrom?: string }`
  - `type ReceiptData { profile: ReceiptProfile; baselineArm: string; treatmentArm: string; n: number; excluded: number; baseline: { passed: number; scorable: number; lo: number; hi: number }; treatment: { passed: number; scorable: number; lo: number; hi: number }; paired: PairedComparison; meanCostUsd: { baseline: number; treatment: number } }`
  - `renderReceiptMd(data: ReceiptData): string` — the pitch's receipt shape; scope caveat line is unconditional.
  - CLI writes `receipts/<treatmentArm>.md` per non-baseline arm + `receipts/SUMMARY.md` table.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/receipt.test.ts
import { describe, expect, it } from 'vitest';
import { buildReceipt, renderReceiptMd } from '../../src/skills-bench/receipt.js';
import type { BenchOutcome } from '../../src/skills-bench/attempts.js';

function o(id: string, arm: string, passed: boolean | null, costUsd = 0.1): BenchOutcome {
  return { instanceId: id, arm, repeat: 0, passed, unscorable: passed === null, costUsd };
}

const profile = {
  model: 'claude-sonnet-5', agent: 'claude-code',
  slateSha256: 'deadbeef', slateHalf: 'both' as const, measuredOn: '2026-08-01',
};

describe('buildReceipt', () => {
  it('pairs per instance, excludes unscorable pairs, computes Wilson bounds', () => {
    const outcomes = [
      o('a', 'baseline', true),  o('a', 'tdd', true),   // concordant pass
      o('b', 'baseline', false), o('b', 'tdd', true),   // improved
      o('c', 'baseline', true),  o('c', 'tdd', false),  // regressed
      o('d', 'baseline', false), o('d', 'tdd', false),  // concordant fail
      o('e', 'baseline', null),  o('e', 'tdd', true),   // excluded (unscorable pair)
    ];
    const r = buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile });
    expect(r.n).toBe(4);
    expect(r.excluded).toBe(1);
    expect(r.paired.improved).toBe(1);
    expect(r.paired.regressed).toBe(1);
    expect(r.baseline.passed).toBe(2);
    expect(r.treatment.passed).toBe(2);
    expect(r.baseline.lo).toBeGreaterThan(0);
    expect(r.baseline.hi).toBeLessThan(1);
  });
});

describe('renderReceiptMd', () => {
  it('renders the receipt shape with the unconditional scope caveat', () => {
    const outcomes = [o('a', 'baseline', false), o('a', 'tdd', true)];
    const md = renderReceiptMd(
      buildReceipt(outcomes, { baselineArm: 'baseline', treatmentArm: 'tdd', profile }),
    );
    expect(md).toContain('skill:      tdd');
    expect(md).toContain('agent:      claude-code, claude-sonnet-5');
    expect(md).toContain('scope:      one agent configuration, one benchmark, this task list');
    expect(md).toContain('slate sha256: deadbeef');
    expect(md).not.toMatch(/significan/i); // no significance language, ever (small-N honesty)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/receipt.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `receipt.ts`**

```typescript
// client/src/skills-bench/receipt.ts
import { comparePaired, type PairedComparison, type PairedInput } from '../eval/paired.js';
import { wilsonInterval } from '../eval/wilson.js';
import type { BenchOutcome } from './attempts.js';

export interface ReceiptProfile {
  model: string;
  agent: string;
  slateSha256: string;
  slateHalf: 'feedback' | 'holdout' | 'both';
  measuredOn: string;
  forkedFrom?: string;
}

export interface ArmSummary { passed: number; scorable: number; lo: number; hi: number }

export interface ReceiptData {
  profile: ReceiptProfile;
  baselineArm: string;
  treatmentArm: string;
  n: number;
  excluded: number;
  baseline: ArmSummary;
  treatment: ArmSummary;
  paired: PairedComparison;
  meanCostUsd: { baseline: number; treatment: number };
}

function armInputs(outcomes: BenchOutcome[], arm: string): PairedInput[] {
  return outcomes
    .filter((o) => o.arm === arm)
    .map((o) => ({ instance_id: o.instanceId, passed: o.passed, unscorable: o.unscorable }));
}

function summarize(outcomes: BenchOutcome[], arm: string, pairedIds: Set<string>): ArmSummary {
  const scored = outcomes.filter((o) => o.arm === arm && pairedIds.has(o.instanceId) && o.passed !== null);
  const passed = scored.filter((o) => o.passed === true).length;
  const { lo, hi } = wilsonInterval(passed, scored.length);
  return { passed, scorable: scored.length, lo, hi };
}

function meanCost(outcomes: BenchOutcome[], arm: string): number {
  const xs = outcomes.filter((o) => o.arm === arm);
  return xs.length ? xs.reduce((s, o) => s + o.costUsd, 0) / xs.length : 0;
}

export function buildReceipt(
  outcomes: BenchOutcome[],
  opts: { baselineArm: string; treatmentArm: string; profile: ReceiptProfile },
): ReceiptData {
  const base = armInputs(outcomes, opts.baselineArm);
  const treat = armInputs(outcomes, opts.treatmentArm);
  const paired = comparePaired(base, treat, {});
  // A pair counts only when BOTH arms scored (matches comparePaired's exclusion rule).
  const baseById = new Map(base.map((i) => [i.instance_id, i]));
  const pairedIds = new Set(
    treat.filter((t) => {
      const b = baseById.get(t.instance_id);
      return b && b.passed !== null && t.passed !== null;
    }).map((t) => t.instance_id),
  );
  const allIds = new Set([...base, ...treat].map((i) => i.instance_id));
  return {
    profile: opts.profile,
    baselineArm: opts.baselineArm,
    treatmentArm: opts.treatmentArm,
    n: pairedIds.size,
    excluded: allIds.size - pairedIds.size,
    baseline: summarize(outcomes, opts.baselineArm, pairedIds),
    treatment: summarize(outcomes, opts.treatmentArm, pairedIds),
    paired,
    meanCostUsd: {
      baseline: meanCost(outcomes, opts.baselineArm),
      treatment: meanCost(outcomes, opts.treatmentArm),
    },
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

export function renderReceiptMd(d: ReceiptData): string {
  const p = d.profile;
  const delta = d.treatment.passed - d.baseline.passed;
  return [
    '```',
    `skill:      ${d.treatmentArm}${p.forkedFrom ? `, forked from ${p.forkedFrom}` : ''}`,
    `measured:   ${d.n} paired tasks (${p.slateHalf} slate), ${d.excluded} excluded as ungradeable`,
    `agent:      ${p.agent}, ${p.model}, one pinned configuration`,
    `result:     baseline resolved ${d.baseline.passed}/${d.baseline.scorable} ` +
      `(95% Wilson ${pct(d.baseline.lo)}–${pct(d.baseline.hi)})`,
    `            with skill resolved ${d.treatment.passed}/${d.treatment.scorable} ` +
      `(95% Wilson ${pct(d.treatment.lo)}–${pct(d.treatment.hi)})`,
    `            net ${delta >= 0 ? '+' : ''}${delta} tasks ` +
      `(improved ${d.paired.improved}, regressed ${d.paired.regressed})`,
    `cost:       mean per task — baseline $${d.meanCostUsd.baseline.toFixed(2)}, ` +
      `with skill $${d.meanCostUsd.treatment.toFixed(2)} (reported, never gates)`,
    `scope:      one agent configuration, one benchmark, this task list`,
    `            slate sha256: ${p.slateSha256} · measured ${p.measuredOn}`,
    `files:      per-task outcomes, run manifests, full agent transcripts, rerun script`,
    '```',
    '',
    `This is a small paired sample; the intervals above are wide by construction and`,
    `no significance is claimed. Reproduce it from the pinned slate and rig (see files).`,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/receipt.test.ts --reporter=dot`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the render CLI**

```typescript
// client/scripts/skills-bench/render-receipts.ts
// Usage: yarn tsx scripts/skills-bench/render-receipts.ts \
//          --run ../bench/runs/wave1 --slate ../bench/slate/slate.json \
//          --half both --measured-on 2026-08-01 --out ../bench/runs/wave1/receipts
// Reads attempts.jsonl (loadAttempts) + bench-manifest.json (model, arms);
// for every non-baseline arm: buildReceipt(...) → writes receipts/<arm>.md;
// then writes receipts/SUMMARY.md: a table `| skill | baseline | with skill | net |`
// one row per arm, derived from the same ReceiptData (no free-text claims).
```

Implement with `loadAttempts`, `buildReceipt`, `renderReceiptMd`; profile fields come from the manifest and flags (`agent: 'claude-code'`).

- [ ] **Step 6: Typecheck and commit**

Run: `cd client && yarn typecheck` — Expected: zero errors.

```bash
git add client/src/skills-bench/receipt.ts client/scripts/skills-bench/render-receipts.ts client/test/skills-bench/receipt.test.ts
git commit -m "feat(skills-bench): paired receipt builder + markdown renderer + summary CLI"
```

---

### Task 6: Frontmatter builder/lint + public repo scaffold

**Files:**
- Create: `client/src/skills-bench/frontmatter.ts`
- Create: `bench/skills-repo-template/README.md`
- Create: `bench/skills-repo-template/skills/.gitkeep`, `bench/skills-repo-template/receipts/.gitkeep`, `bench/skills-repo-template/rig/README.md`
- Test: `client/test/skills-bench/frontmatter.test.ts`

**Interfaces:**
- Consumes: `SkillPin` (Task 1) for `jinn.forked-from`.
- Produces: `buildSkillFrontmatter(opts: FrontmatterOptions): string` and `lintFrontmatter(yaml: string): string[]` (empty array = valid); `type FrontmatterOptions { name: string; description: string; license?: string; metadata: Record<string, string> }`. Task 8's runbook uses these to package the fork.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/frontmatter.test.ts
import { describe, expect, it } from 'vitest';
import { buildSkillFrontmatter, lintFrontmatter } from '../../src/skills-bench/frontmatter.js';

describe('buildSkillFrontmatter', () => {
  it('emits only spec-allowed keys with flat string metadata', () => {
    const fm = buildSkillFrontmatter({
      name: 'tdd',
      description: 'Test-driven development workflow. Use when implementing features or fixing bugs.',
      license: 'MIT',
      metadata: {
        'jinn.receipt': 'https://github.com/Jinn-Network/skills/blob/main/receipts/tdd.md',
        'jinn.receipt-sha256': 'deadbeef',
        'jinn.measured-on': '2026-08-01',
        'jinn.forked-from': 'mattpocock/skills@abc123',
      },
    });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm).toContain('name: tdd');
    expect(fm).toContain('  jinn.receipt: ');
    expect(lintFrontmatter(fm)).toEqual([]);
  });
});

describe('lintFrontmatter', () => {
  it('rejects spec violations', () => {
    expect(lintFrontmatter('---\nname: TDD\ndescription: d\n---\n')).toContainEqual(
      expect.stringMatching(/name/));                       // uppercase
    expect(lintFrontmatter('---\nname: a--b\ndescription: d\n---\n')).toContainEqual(
      expect.stringMatching(/name/));                       // consecutive hyphens
    expect(lintFrontmatter(`---\nname: ok\ndescription: ${'x'.repeat(1025)}\n---\n`)).toContainEqual(
      expect.stringMatching(/description/));                // >1024 chars
    expect(lintFrontmatter('---\nname: ok\ndescription: d\nbenchmarked: true\n---\n')).toContainEqual(
      expect.stringMatching(/unknown key/));                // unknown top-level key
    expect(lintFrontmatter('---\nname: ok\n---\n')).toContainEqual(
      expect.stringMatching(/description/));                // missing description
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/frontmatter.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontmatter.ts`**

```typescript
// client/src/skills-bench/frontmatter.ts
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface FrontmatterOptions {
  name: string;
  description: string;
  license?: string;
  metadata: Record<string, string>;
}

export function buildSkillFrontmatter(opts: FrontmatterOptions): string {
  const lines = ['---', `name: ${opts.name}`, `description: ${opts.description}`];
  if (opts.license) lines.push(`license: ${opts.license}`);
  const metaKeys = Object.keys(opts.metadata);
  if (metaKeys.length) {
    lines.push('metadata:');
    for (const k of metaKeys) lines.push(`  ${k}: ${opts.metadata[k]}`);
  }
  lines.push('---', '');
  const fm = lines.join('\n');
  const problems = lintFrontmatter(fm);
  if (problems.length) throw new Error(`invalid frontmatter: ${problems.join('; ')}`);
  return fm;
}

/** Spec: https://agentskills.io/specification — six allowed keys; name 1-64
 *  lowercase/digits/hyphens, no leading/trailing/double hyphen; description
 *  1-1024 chars; metadata is a flat string map. Returns human-readable
 *  problems; empty array = valid. Line-oriented on purpose — the frontmatter
 *  this repo emits is flat, and a YAML dependency would be scope creep. */
export function lintFrontmatter(text: string): string[] {
  const problems: string[] = [];
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return ['no frontmatter block'];
  const lines = m[1]!.split('\n');
  const topKeys: string[] = [];
  let name = '';
  let description = '';
  let inMetadata = false;
  for (const line of lines) {
    if (/^\s{2,}\S/.test(line)) {
      if (!inMetadata) problems.push(`nested value outside metadata: "${line.trim()}"`);
      continue;
    }
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    topKeys.push(key!);
    inMetadata = key === 'metadata';
    if (key === 'name') name = value!;
    if (key === 'description') description = value!;
  }
  for (const k of topKeys) if (!ALLOWED_KEYS.has(k)) problems.push(`unknown key: ${k}`);
  if (!name) problems.push('name: required');
  else if (name.length > 64 || !NAME_RE.test(name)) problems.push(`name: invalid (${name})`);
  if (!description) problems.push('description: required');
  else if (description.length > 1024) problems.push('description: exceeds 1024 characters');
  return problems;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/frontmatter.test.ts --reporter=dot`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the public-repo template**

`bench/skills-repo-template/README.md`:

```markdown
# Skills, measured.

Agent skills with receipts: every skill in this repository links a benchmark
receipt — a paired comparison against a no-skill baseline (and, for forks, the
upstream original) on pinned real-world software tasks, with the raw per-task
results and the rerun script alongside.

| Skill | Receipt | Measured against | Net |
|---|---|---|---|
<!-- one row per published skill; generated from receipts/SUMMARY.md, never hand-written -->

## Install

    npx skills add Jinn-Network/skills

## What a receipt is — and is not

A receipt is a reproducible measurement: pinned task list, pinned agent
configuration, raw outcomes, rerun script (`rig/`). It is not a certification.
The frontmatter `metadata` keys (`jinn.receipt`, `jinn.receipt-sha256`) are
pointers to the receipt, never proof by themselves — re-run it, or disagree
with the task selection and swap your own.

Skills forked from upstream authors keep their license and attribution; the
receipt records the upstream commit measured against, and improvements are
offered back as PRs.

Published by [Jinn](https://jinn.network), an open agentic knowledge economy.
```

`bench/skills-repo-template/rig/README.md`:

```markdown
# Rig

Receipts in this repository are produced by the skills-bench rig in
[Jinn-Network/mono](https://github.com/Jinn-Network/mono) —
`client/scripts/skills-bench/` at the commit recorded in each receipt's run
manifest. To re-run: pin that commit, then follow
`docs/runbooks/skills-bench.md` (wave 1) with the slate file shipped next to
the receipt data.
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd client && yarn typecheck` — Expected: zero errors.

```bash
git add client/src/skills-bench/frontmatter.ts client/test/skills-bench/frontmatter.test.ts bench/skills-repo-template/
git commit -m "feat(skills-bench): spec-compliant frontmatter builder/lint + public repo template"
```

---

### Task 7: Holdout one-shot guard (`holdout-guard.ts`)

**Files:**
- Create: `client/src/skills-bench/holdout-guard.ts`
- Modify: `client/scripts/skills-bench/run-bench.ts` (wire the guard into `--half holdout`)
- Test: `client/test/skills-bench/holdout-guard.test.ts`

**Interfaces:**
- Consumes: nothing internal (fs + JSON).
- Produces: `assertHoldoutUnused(ledgerFile: string, candidateId: string): Promise<void>` (throws if `candidateId` already ran the holdout) and `recordHoldoutRun(ledgerFile: string, entry: { candidateId: string; runDir: string; at: string }): Promise<void>`. `run-bench.ts --half holdout` requires `--candidate-id <id>` and calls assert-then-record around the run; `--force-holdout-rerun` overrides with a loud warning (legitimate only for an aborted run that graded nothing).

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/skills-bench/holdout-guard.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHoldoutUnused, recordHoldoutRun } from '../../src/skills-bench/holdout-guard.js';

describe('holdout guard', () => {
  it('allows first use, blocks second, scopes by candidate', async () => {
    const ledger = join(await mkdtemp(join(tmpdir(), 'ho-')), 'holdout-ledger.json');
    await assertHoldoutUnused(ledger, 'tdd-fork-v3');                      // ok (no ledger yet)
    await recordHoldoutRun(ledger, { candidateId: 'tdd-fork-v3', runDir: '/runs/x', at: '2026-08-01T00:00:00Z' });
    await expect(assertHoldoutUnused(ledger, 'tdd-fork-v3')).rejects.toThrow(/already consumed/);
    await assertHoldoutUnused(ledger, 'tdd-fork-v4');                      // other candidate ok
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/skills-bench/holdout-guard.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `holdout-guard.ts`**

```typescript
// client/src/skills-bench/holdout-guard.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

interface HoldoutLedger { version: 'holdout-ledger.v1'; runs: { candidateId: string; runDir: string; at: string }[] }

async function loadLedger(file: string): Promise<HoldoutLedger> {
  if (!existsSync(file)) return { version: 'holdout-ledger.v1', runs: [] };
  return JSON.parse(await readFile(file, 'utf8')) as HoldoutLedger;
}

/** The holdout is opened once per candidate (spec §2, §4 step 5). A second run
 *  against the sealed half would make the published number an optimization
 *  target — the exact thing the split exists to prevent. */
export async function assertHoldoutUnused(ledgerFile: string, candidateId: string): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  const prior = ledger.runs.find((r) => r.candidateId === candidateId);
  if (prior) {
    throw new Error(
      `holdout already consumed for candidate '${candidateId}' (run ${prior.runDir} at ${prior.at}); ` +
      `a repeat would turn the sealed half into a tuning set`,
    );
  }
}

export async function recordHoldoutRun(
  ledgerFile: string,
  entry: { candidateId: string; runDir: string; at: string },
): Promise<void> {
  const ledger = await loadLedger(ledgerFile);
  ledger.runs.push(entry);
  await mkdir(dirname(ledgerFile), { recursive: true });
  await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/skills-bench/holdout-guard.test.ts --reporter=dot`
Expected: PASS (1 test)

- [ ] **Step 5: Wire into `run-bench.ts` and commit**

In `run-bench.ts`: when `--half holdout`, require `--candidate-id`, call `assertHoldoutUnused('../bench/holdout-ledger.json', candidateId)` before the first solve and `recordHoldoutRun` immediately after (record-first-then-run — an aborted run still burns the slot unless `--force-holdout-rerun`). Run `cd client && yarn typecheck`.

```bash
git add client/src/skills-bench/holdout-guard.ts client/test/skills-bench/holdout-guard.test.ts client/scripts/skills-bench/run-bench.ts
git commit -m "feat(skills-bench): one-shot holdout ledger wired into run-bench --half holdout"
```

---

### Task 8: Runbook (`docs/runbooks/skills-bench.md`)

**Files:**
- Create: `docs/runbooks/skills-bench.md`

**Interfaces:**
- Consumes: every CLI from Tasks 1–7 (exact invocations below).
- Produces: the operational document Task 9 and the human waves execute from.

- [ ] **Step 1: Write the runbook**

Content (write it in full, in runbook voice, with these sections and exact commands):

1. **Prerequisites** — Linux amd64 host, ≥100 GB free disk, Docker, Node 22 + corepack, claude-code CLI authenticated (or `ANTHROPIC_API_KEY`), `JINN_EVAL_DISK_FLOOR_GB=40`, swe-rebench upstream eval repo checked out (`--upstream-repo-dir`).
2. **Pin the incumbents** — one `yarn tsx scripts/skills-bench/pin-skill.ts` block per wave-1 skill (`tdd`, `grill-me`, `improve-codebase-architecture`, `vercel-react-best-practices`, `frontend-design` — resolve `--commit` to each repo's HEAD sha on pin day and record it in the commit message). Then: check each `pin.json` `license`; note fork-eligibility per skill in `bench/skills-under-test/LICENSES.md`.
3. **Build and freeze the slate** — `yarn tsx scripts/skills-bench/build-slate.ts --seed jinn.skills-bench.v1 --pool-size 60 --out ../bench/slate/slate.json`; commit `slate.json` (the commit is the freeze).
4. **Wave 1 smoke** — `run-bench.ts --slate … --arms ../bench/arms/wave1.json --model claude-haiku-4-5-20251001 --max-instances 2 --out ../bench/runs/smoke`; verify: attempts resume on rerun, transcripts present, at least one graded (non-null) outcome; a slate instance that proves ungradeable here is removed and the slate rebuilt BEFORE the freeze commit.
5. **Wave 1 full** — same command with `--model claude-sonnet-5`, no `--max-instances`, `--out ../bench/runs/wave1`; budget note (≈30 tasks × 6 arms ≈ 180 solves + grades); expect days; safe to interrupt/resume.
6. **Render + review receipts** — `render-receipts.ts` invocation; human review gate: every receipt read against the spec's no-overclaim rules before anything is published.
7. **Publish** — create `Jinn-Network/skills` from `bench/skills-repo-template/`; copy receipts + `receipts/data/` (slate.json, attempts.jsonl, bench-manifest.json, transcripts); README table from SUMMARY.md; do NOT copy skills yet (wave 1 publishes measurements, not forks). Reminder: publishing is an external action — human pushes, per the repo's external-communication rules.
8. **Wave 2 loop** — read failing transcripts from `../bench/runs/wave1/transcripts/` for the chosen target (choose by §6 wave-1 evidence); write K variant skill dirs under `bench/variants/<target>-v<k>/` (edit SKILL.md; frontmatter via `buildSkillFrontmatter`); arms file = original + variants; `run-bench.ts --half feedback --arms ../bench/arms/wave2-<target>.json --model claude-sonnet-5 --out ../bench/runs/wave2-r<round>`; iterate ≤3 rounds; winner = best net on feedback.
9. **Wave 2 holdout (one shot)** — `run-bench.ts --half holdout --candidate-id <target>-fork-v<k> --arms <original + winner only> --model claude-sonnet-5 --out ../bench/runs/wave2-holdout`; render receipt with `--half holdout` and `forkedFrom`; publish the fork only if it wins (fork dir + receipt into the public repo; `jinn.*` metadata keys; upstream PR offered), else publish the finding.
10. **Troubleshooting** — Docker wedge (grade timeout → ungradeable, run continues), disk floor abort, manifest mismatch (changed bytes → fresh `--out`), holdout guard refusal.

- [ ] **Step 2: Verify every command in the runbook against the implemented CLIs**

Read each `yarn tsx` line and check flag names against the scripts from Tasks 1–7. Fix drift in the runbook, not the code.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/skills-bench.md
git commit -m "docs(skills-bench): wave-1/wave-2 execution and publish runbook"
```

---

### Task 9: End-to-end smoke gate (dry run + 2-instance live smoke)

**Files:**
- No new files — executes Tasks 1–8's deliverables; fixes land in the task that owns the broken file.

- [ ] **Step 1: Full test suite + typecheck**

Run: `cd client && yarn vitest run test/skills-bench --reporter=dot && yarn typecheck`
Expected: all skills-bench tests pass; zero type errors.

- [ ] **Step 2: Dry-run pipeline end-to-end**

```bash
cd client
yarn tsx scripts/skills-bench/build-slate.ts --seed jinn.skills-bench.smoke --pool-size 60 --out /tmp/bench-smoke/slate.json
yarn tsx scripts/skills-bench/run-bench.ts --dry-run --slate /tmp/bench-smoke/slate.json --arms ../bench/arms/wave1.json --out /tmp/bench-smoke/run
yarn tsx scripts/skills-bench/render-receipts.ts --run /tmp/bench-smoke/run --slate /tmp/bench-smoke/slate.json --half both --measured-on smoke --out /tmp/bench-smoke/receipts
```

Expected: slate.json (15+15, printed sha256) → attempts.jsonl (synthesized) → one receipt per non-baseline arm + SUMMARY.md. Rerunning step 2's run-bench reports all attempts skipped.

- [ ] **Step 3: Live smoke (spends real money — small)**

Precondition: Docker running, claude-code authenticated, one skill pinned (Task 1 CLI against the real `tdd` repo), arms = `[baseline, tdd]`.
Run: `yarn tsx scripts/skills-bench/run-bench.ts --slate /tmp/bench-smoke/slate.json --arms /tmp/bench-smoke/arms-smoke.json --model claude-haiku-4-5-20251001 --max-instances 2 --grade-timeout-ms 600000 --out /tmp/bench-smoke/live`
Expected: 4 attempts (2 instances × 2 arms) with real patches in transcripts; ≥1 non-null grade; costUsd > 0 on solved attempts. On Apple Silicon a grade may time out to ungradeable — acceptable for the smoke; the full wave runs on Linux amd64.

- [ ] **Step 4: Commit any fixes and mark the rig ready**

```bash
git add -A && git commit -m "test(skills-bench): smoke-gate fixes from end-to-end dry run + live smoke"
```

Wave-1 full execution, receipt review, and publishing then proceed per the runbook — human-gated, outside this plan.

---

## Self-Review

**Spec coverage:** product/§1 (public repo + receipts) → Tasks 6, 8; rig/§2 (slate, arms, profile, grading, stats, scale) → Tasks 2, 3, 4, 5; §3 wave 1 (pinning, license gate, receipts, review) → Tasks 1, 8, 9; §4 wave 2 (variants on feedback half, one-shot holdout, fork packaging, upstream PR) → Tasks 7, 8; §5/§5.1 (repo layout, frontmatter pointers, description purity) → Task 6; §6 growth L3 (metadata for the inspecting agent) → Task 6; §8 risks (disk floor, resume, ungradeable handling, no significance language) → Tasks 4, 5, 8. Growth L1/L2/L4 are human actions recorded in the runbook's publish section and the spec — no code.

**Placeholder scan:** none — every code step is complete; the two CLIs specified as commented skeletons (build-slate, run-bench) name every helper, flag, and reused line range they compose.

**Type consistency:** `BenchOutcome` (Task 4) ↔ `PairedInput` mapping in Task 5 matches core's `{instance_id, passed, unscorable}`; `SkillPin.sha256` (Task 1) feeds `BenchManifest.arms[].skillSha256` (Task 4); slate `sha256` (Task 2) feeds `BenchManifest.slateSha256` and `ReceiptProfile.slateSha256`; `wilsonInterval(passed, scorable)` positional args match `client/src/eval/wilson.ts:31`.
