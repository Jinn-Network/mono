# Headless Superpowers Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and lock in that the interactive superpowers skills can run unattended — via one global headless-override block plus a pressure-test harness that verifies each in-session-pipeline chain skill completes headless without blocking on a human.

**Architecture:** Global injection, no vendoring. One canonical headless-override block is injected into every headless (`claude -p`) session's prompt; it situationally overrides the interactive HARD-GATEs of all superpowers skills at once. A pressure-test harness spawns a headless skill run against a scenario fixture and classifies the result as `completed` / `interactive-block` / `error`. Scenarios cover each chain skill. This is unit 1 of Phase 1 of `docs/superpowers/specs/2026-05-21-automated-eng-flow-design.md` (§7) — it de-risks the whole pipeline before the in-session pipeline skill is built.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, the `claude` CLI, yarn 4 (standalone package — jinn-mono is *not* a yarn-workspaces monorepo; `client/`, `packages/sdk`, `packages/indexer` are each independent yarn projects, so `eng-loop` is too).

**Out of scope:** the in-session pipeline skill, `file-issue`, the merge skill, the dispatcher — each gets its own plan.

---

### Task 1: Scaffold the `packages/eng-loop` standalone package

`packages/eng-loop` is a **standalone** yarn 4 package — its own `package.json`, `.yarnrc.yml`, and `yarn.lock`, with no repo-root `package.json`. jinn-mono is *not* a yarn-workspaces monorepo: `client/`, `packages/sdk`, and `packages/indexer` are each independent yarn projects. Match the `packages/sdk` layout.

**Files:**
- Create: `packages/eng-loop/package.json`
- Create: `packages/eng-loop/.yarnrc.yml`
- Create: `packages/eng-loop/.gitignore`
- Create: `packages/eng-loop/tsconfig.json`
- Create: `packages/eng-loop/vitest.config.ts`
- Create: `packages/eng-loop/src/index.ts`
- Generate: `packages/eng-loop/yarn.lock` (via `yarn install`)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@jinn-network/eng-loop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 4: Create `.yarnrc.yml`**

```yaml
nodeLinker: node-modules
```

- [ ] **Step 5: Create `.gitignore`**

```gitignore
node_modules/
dist/
.yarn/cache/
.yarn/install-state.gz
.pnp.*
```

- [ ] **Step 6: Create `src/index.ts` placeholder export**

```typescript
export const ENG_LOOP_PACKAGE = '@jinn-network/eng-loop';
```

- [ ] **Step 7: Generate the lockfile and verify**

The repo has no root `package.json`, so yarn must treat `packages/eng-loop` as its own project root. Bootstrap an empty lockfile first so yarn does not walk up the directory tree:

```bash
cd packages/eng-loop && touch yarn.lock && yarn install && yarn typecheck
```
Expected: `yarn install` resolves `typescript` + `vitest` into `packages/eng-loop/yarn.lock`; `yarn typecheck` reports no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/eng-loop
git commit -m "chore(eng-loop): scaffold eng-loop as a standalone package"
```

---

### Task 2: The canonical headless-override block

**Files:**
- Create: `packages/eng-loop/headless-override.md`

- [ ] **Step 1: Write the override block**

Create `packages/eng-loop/headless-override.md` with exactly this content:

```markdown
# Headless mode

You are running in a non-interactive (`claude -p` / `--print`) session. There is no human present to answer questions.

When a skill or instruction tells you to ask the user, wait for approval, present options for the user to choose, or gate on user confirmation:

- Do not ask. Do not wait.
- Decide yourself, from the codebase patterns, project conventions, the issue or spec you were given, and the available context.
- Where options are presented, choose the one marked recommended; if none is marked, choose the one most consistent with existing conventions.
- Where approval is needed, proceed if you are confident.
- Log every such decision and the reason for it, so a human reviewing the transcript can audit it.

This instruction overrides the interactive gates — including any `HARD-GATE` — of every skill you invoke. It overrides only the human-in-the-loop checkpoints; it does not override the skill's methodology.

Escalation: if you genuinely cannot proceed — the task is mis-scoped, a human product/design decision is required, or you are not converging — stop and report clearly, with a one-paragraph summary of where you got to and why you stopped. Do not spin.
```

- [ ] **Step 2: Commit**

```bash
git add packages/eng-loop/headless-override.md
git commit -m "feat(eng-loop): canonical headless-override block"
```

---

### Task 3: `buildHeadlessPrompt` — compose a headless prompt

**Files:**
- Create: `packages/eng-loop/src/headless.ts`
- Test: `packages/eng-loop/test/headless.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { headlessOverride, buildHeadlessPrompt } from '../src/headless.js';

describe('headlessOverride', () => {
  it('loads the override block and mentions overriding HARD-GATEs', () => {
    const block = headlessOverride();
    expect(block).toMatch(/headless mode/i);
    expect(block).toMatch(/HARD-GATE/);
  });
});

describe('buildHeadlessPrompt', () => {
  it('composes the override block, the skill invocation, and the scenario', () => {
    const prompt = buildHeadlessPrompt('superpowers:writing-plans', 'Plan the widget.');
    expect(prompt.indexOf('Headless mode')).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain('Use the superpowers:writing-plans skill');
    expect(prompt).toContain('Plan the widget.');
    // Override block comes before the task.
    expect(prompt.indexOf('Headless mode')).toBeLessThan(prompt.indexOf('Plan the widget.'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/eng-loop && yarn test test/headless.test.ts)`
Expected: FAIL — `Cannot find module '../src/headless.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/eng-loop/src/headless.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The canonical headless-override block, injected into every headless session. */
export function headlessOverride(): string {
  return readFileSync(join(HERE, '..', 'headless-override.md'), 'utf8').trim();
}

/** Compose a headless prompt: the override block, then a skill invocation, then the scenario. */
export function buildHeadlessPrompt(skill: string, scenario: string): string {
  return [
    headlessOverride(),
    '',
    `Use the ${skill} skill for the following task.`,
    '',
    scenario.trim(),
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/eng-loop && yarn test test/headless.test.ts)`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/headless.ts packages/eng-loop/test/headless.test.ts
git commit -m "feat(eng-loop): buildHeadlessPrompt composes override + skill + scenario"
```

---

### Task 4: `classifyRun` — detect an interactive block

**Files:**
- Create: `packages/eng-loop/src/pressure-test/detect-block.ts`
- Test: `packages/eng-loop/test/detect-block.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { classifyRun } from '../src/pressure-test/detect-block.js';

describe('classifyRun', () => {
  it('returns completed when the deliverable was produced', () => {
    expect(classifyRun('any text', { producedDeliverable: true })).toBe('completed');
  });

  it('returns interactive-block when no deliverable and the text ends asking the user', () => {
    const text = 'I have drafted the design.\n\nWhich option would you like — A or B?';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('interactive-block');
  });

  it('returns interactive-block on a "waiting for your approval" tail', () => {
    const text = 'Design presented above.\n\nWaiting for your approval before continuing.';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('interactive-block');
  });

  it('returns error when no deliverable and no interactive tail', () => {
    const text = 'Traceback: something exploded and the run ended.';
    expect(classifyRun(text, { producedDeliverable: false })).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/eng-loop && yarn test test/detect-block.test.ts)`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/eng-loop/src/pressure-test/detect-block.ts`:

```typescript
export type RunVerdict = 'completed' | 'interactive-block' | 'error';

/**
 * Phrases that signal the run stopped to ask the human. Matched against the
 * tail of the final output. Tuned against live runs in the suite task.
 */
const INTERACTIVE_TAIL =
  /(which (?:option|approach)|waiting for (?:your |you)|let me know|shall i|should i proceed|do you want|your approval|approve (?:this|the)|please confirm)\b/i;

/**
 * Classify a finished headless run.
 *
 * The strong signal is whether the skill produced its expected deliverable.
 * If it did not, an interactive-style tail means the skill tried to block on a
 * human (the headless override failed); anything else is an error.
 */
export function classifyRun(
  finalText: string,
  opts: { producedDeliverable: boolean },
): RunVerdict {
  if (opts.producedDeliverable) return 'completed';
  const tail = finalText.trimEnd().slice(-600);
  if (INTERACTIVE_TAIL.test(tail) || /\?\s*$/.test(tail)) return 'interactive-block';
  return 'error';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/eng-loop && yarn test test/detect-block.test.ts)`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/pressure-test/detect-block.ts packages/eng-loop/test/detect-block.test.ts
git commit -m "feat(eng-loop): classifyRun verdict for headless skill runs"
```

---

### Task 5: `runSkillHeadless` — spawn a headless `claude -p` session

**Files:**
- Create: `packages/eng-loop/src/pressure-test/run-skill.ts`

This task has no unit test — it spawns the real `claude` CLI; it is exercised by the live suite in Task 9. Keep it tiny and obviously correct.

- [ ] **Step 1: Write the implementation**

Create `packages/eng-loop/src/pressure-test/run-skill.ts`:

```typescript
import { spawn } from 'node:child_process';

export interface SkillRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a one-shot headless `claude -p` session with the given prompt. */
export function runSkillHeadless(
  prompt: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<SkillRunResult> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', prompt], { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, opts.timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `(cd packages/eng-loop && yarn typecheck)`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/eng-loop/src/pressure-test/run-skill.ts
git commit -m "feat(eng-loop): runSkillHeadless spawns a headless claude -p session"
```

---

### Task 6: `pressureTest` — the harness glue

**Files:**
- Create: `packages/eng-loop/src/pressure-test/harness.ts`
- Test: `packages/eng-loop/test/harness.test.ts`

- [ ] **Step 1: Write the failing test**

The harness takes an injectable `run` function so it can be unit-tested without spawning `claude`.

```typescript
import { describe, it, expect } from 'vitest';
import { pressureTest, type PressureCase } from '../src/pressure-test/harness.js';

const baseCase: PressureCase = {
  skill: 'superpowers:writing-plans',
  scenarioName: 'happy-path',
  scenario: 'Plan the widget.',
  deliverableCheck: () => true,
};

describe('pressureTest', () => {
  it('reports completed when the deliverable check passes', async () => {
    const result = await pressureTest(
      baseCase, '/tmp/x',
      async () => ({ exitCode: 0, stdout: 'done', stderr: '', timedOut: false }),
    );
    expect(result.verdict).toBe('completed');
    expect(result.skill).toBe('superpowers:writing-plans');
  });

  it('reports interactive-block when no deliverable and the run asked a question', async () => {
    const result = await pressureTest(
      { ...baseCase, deliverableCheck: () => false }, '/tmp/x',
      async () => ({ exitCode: 0, stdout: 'Which option do you want?', stderr: '', timedOut: false }),
    );
    expect(result.verdict).toBe('interactive-block');
  });

  it('passes the composed headless prompt to the runner', async () => {
    let seen = '';
    await pressureTest(baseCase, '/tmp/x', async (p) => {
      seen = p;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    });
    expect(seen).toMatch(/Headless mode/);
    expect(seen).toContain('Plan the widget.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/eng-loop && yarn test test/harness.test.ts)`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/eng-loop/src/pressure-test/harness.ts`:

```typescript
import { buildHeadlessPrompt } from '../headless.js';
import { runSkillHeadless, type SkillRunResult } from './run-skill.js';
import { classifyRun, type RunVerdict } from './detect-block.js';

export interface PressureCase {
  skill: string;
  scenarioName: string;
  scenario: string;
  /** Returns true if the skill's expected deliverable exists in `cwd`. */
  deliverableCheck: (cwd: string) => boolean;
}

export interface PressureResult {
  skill: string;
  scenarioName: string;
  verdict: RunVerdict;
}

/**
 * Run one pressure case: compose the headless prompt, run the skill, classify.
 * `run` is injectable so the glue is unit-testable without spawning `claude`.
 */
export async function pressureTest(
  c: PressureCase,
  cwd: string,
  run: (prompt: string) => Promise<SkillRunResult> = (p) =>
    runSkillHeadless(p, { cwd, timeoutMs: 600_000 }),
): Promise<PressureResult> {
  const result = await run(buildHeadlessPrompt(c.skill, c.scenario));
  const verdict = classifyRun(result.stdout, {
    producedDeliverable: c.deliverableCheck(cwd),
  });
  return { skill: c.skill, scenarioName: c.scenarioName, verdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/eng-loop && yarn test test/harness.test.ts)`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/pressure-test/harness.ts packages/eng-loop/test/harness.test.ts
git commit -m "feat(eng-loop): pressureTest harness glue"
```

---

### Task 7: Pressure-test scenarios — `brainstorming`

Each scenario is a fixture: a self-contained task that, run interactively, would hit the skill's HARD-GATE / a "choose an option" prompt. Headless, the skill must instead decide and produce its deliverable.

**Files:**
- Create: `packages/eng-loop/pressure-tests/brainstorming/scenario-1-clear-spec.md`
- Create: `packages/eng-loop/pressure-tests/brainstorming/scenario-2-needs-a-choice.md`
- Create: `packages/eng-loop/pressure-tests/brainstorming/scenario-3-ambiguous.md`

- [ ] **Step 1: Scenario 1 — a clear spec (the gate should pass cleanly)**

`scenario-1-clear-spec.md`:

```markdown
Design a `slugify(text: string): string` utility for a TypeScript library:
lowercase, spaces and underscores to hyphens, strip non-alphanumeric/non-hyphen
characters, collapse repeated hyphens, trim leading/trailing hyphens.

Acceptance: `slugify("  Hello, World! ")` returns `"hello-world"`.

Expected deliverable: a design doc at `docs/superpowers/specs/` for this utility.
```

- [ ] **Step 2: Scenario 2 — a genuine either/or (the skill must pick, not ask)**

`scenario-2-needs-a-choice.md`:

```markdown
Design an in-memory cache for a TypeScript service. The eviction policy is open:
LRU or TTL are both reasonable. Pick one, justify it from common conventions,
and design it. Do not ask which to use.

Expected deliverable: a design doc at `docs/superpowers/specs/` that names the
chosen policy.
```

- [ ] **Step 3: Scenario 3 — an under-specified task (the skill must fill gaps with conventions)**

`scenario-3-ambiguous.md`:

```markdown
Design a retry helper for flaky network calls in a TypeScript codebase. The
backoff strategy, max attempts, and which errors are retryable are unspecified —
choose sensible defaults from common conventions and design it.

Expected deliverable: a design doc at `docs/superpowers/specs/`.
```

- [ ] **Step 4: Commit**

```bash
git add packages/eng-loop/pressure-tests/brainstorming
git commit -m "test(eng-loop): brainstorming pressure-test scenarios"
```

---

### Task 8: Pressure-test scenarios — the rest of the chain

Same shape as Task 7 — one directory per skill, three scenarios each, each with an "Expected deliverable" line the suite's `deliverableCheck` will look for.

**Files:**
- Create: `packages/eng-loop/pressure-tests/writing-plans/scenario-{1,2,3}.md`
- Create: `packages/eng-loop/pressure-tests/test-driven-development/scenario-{1,2,3}.md`
- Create: `packages/eng-loop/pressure-tests/executing-plans/scenario-{1,2,3}.md`
- Create: `packages/eng-loop/pressure-tests/verification-before-completion/scenario-{1,2,3}.md`
- Create: `packages/eng-loop/pressure-tests/requesting-code-review/scenario-{1,2,3}.md`

- [ ] **Step 1: `writing-plans` scenarios**

Three `.md` files. Each gives a small approved spec and asks for an implementation plan; expected deliverable: a plan at `docs/superpowers/plans/`. Scenario 1: a single-function utility (clean). Scenario 2: a spec with an open library choice the planner must pick. Scenario 3: a spec terse enough that the planner must infer file structure from conventions.

- [ ] **Step 2: `test-driven-development` scenarios**

Three `.md` files, each: implement one small function TDD. Expected deliverable: a passing test file + implementation. Scenario 2 leaves an edge-case decision (empty input behaviour) to the agent; scenario 3 leaves the error type unspecified.

- [ ] **Step 3: `executing-plans` scenarios**

Three `.md` files, each: a 2–3 task mini-plan to execute. Expected deliverable: the plan's checkboxes ticked + commits. Scenario 2 includes a step that interactively would say "ask the human partner"; headless it must decide and log.

- [ ] **Step 4: `verification-before-completion` scenarios**

Three `.md` files, each: a small change presented as "done"; the skill must verify. Scenario 1: genuinely complete. Scenario 2: a deliberately-broken test the skill must catch and not wave through. Scenario 3: a passing-but-incomplete change. Expected deliverable: a verification verdict file `verification-result.md`.

- [ ] **Step 5: `requesting-code-review` scenarios**

Three `.md` files, each: a small diff to review. Scenario 1: clean. Scenario 2: a planted bug. Scenario 3: a convention violation. Expected deliverable: a review-findings file the harness can read.

- [ ] **Step 6: Commit**

```bash
git add packages/eng-loop/pressure-tests
git commit -m "test(eng-loop): pressure-test scenarios for the chain skills"
```

---

### Task 9: The suite runner

**Files:**
- Create: `packages/eng-loop/src/pressure-test/suite.ts`
- Create: `packages/eng-loop/scripts/run-pressure-suite.ts`
- Modify: `packages/eng-loop/package.json` (add the `pressure` script)
- Test: `packages/eng-loop/test/suite.test.ts`

- [ ] **Step 1: Write the failing test for scenario discovery**

```typescript
import { describe, it, expect } from 'vitest';
import { discoverCases } from '../src/pressure-test/suite.js';

describe('discoverCases', () => {
  it('finds every scenario .md under the pressure-tests tree', () => {
    const cases = discoverCases();
    const skills = new Set(cases.map((c) => c.skill));
    expect(skills.has('superpowers:brainstorming')).toBe(true);
    expect(skills.has('superpowers:writing-plans')).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(18); // 6 skills x 3
    for (const c of cases) expect(c.scenario.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd packages/eng-loop && yarn test test/suite.test.ts)`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `suite.ts`**

Create `packages/eng-loop/src/pressure-test/suite.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PressureCase } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', 'pressure-tests');

/** Each pressure-test directory name maps to its full skill identifier. */
const SKILL_ID: Record<string, string> = {
  brainstorming: 'superpowers:brainstorming',
  'writing-plans': 'superpowers:writing-plans',
  'test-driven-development': 'superpowers:test-driven-development',
  'executing-plans': 'superpowers:executing-plans',
  'verification-before-completion': 'superpowers:verification-before-completion',
  'requesting-code-review': 'superpowers:requesting-code-review',
};

/** Discover every scenario `.md` under the pressure-tests tree. */
export function discoverCases(): PressureCase[] {
  const cases: PressureCase[] = [];
  for (const dir of Object.keys(SKILL_ID)) {
    const dirPath = join(ROOT, dir);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.md')) continue;
      const scenario = readFileSync(join(dirPath, file), 'utf8');
      cases.push({
        skill: SKILL_ID[dir]!,
        scenarioName: file.replace(/\.md$/, ''),
        scenario,
        // The scenario states its expected deliverable; the check looks for a
        // file under the named directory created during the run.
        deliverableCheck: (cwd) => deliverableExists(scenario, cwd),
      });
    }
  }
  return cases;
}

/** True if the scenario's "Expected deliverable" directory gained a file. */
function deliverableExists(scenario: string, cwd: string): boolean {
  const m = scenario.match(/Expected deliverable:[^`]*`([^`]+)`/);
  if (!m) return false;
  const target = join(cwd, m[1]!);
  if (existsSync(target) && !target.endsWith('/')) return true;
  // Directory form: deliverable is "a file under <dir>/".
  const dir = target.replace(/\/$/, '');
  return existsSync(dir) && readdirSync(dir).length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd packages/eng-loop && yarn test test/suite.test.ts)`
Expected: PASS.

- [ ] **Step 5: Write the runner script**

Create `packages/eng-loop/scripts/run-pressure-suite.ts`:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCases } from '../src/pressure-test/suite.js';
import { pressureTest, type PressureResult } from '../src/pressure-test/harness.js';

/** Run every pressure case (each in its own tmp cwd) and print a report. */
async function main(): Promise<void> {
  const cases = discoverCases();
  const results: PressureResult[] = [];
  for (const c of cases) {
    const cwd = mkdtempSync(join(tmpdir(), 'eng-loop-pressure-'));
    const r = await pressureTest(c, cwd);
    results.push(r);
    console.log(`${r.verdict.padEnd(18)} ${r.skill}  ${r.scenarioName}`);
  }
  const blocked = results.filter((r) => r.verdict !== 'completed');
  console.log(`\n${results.length - blocked.length}/${results.length} completed headless.`);
  if (blocked.length > 0) {
    console.log('Not completed headless:');
    for (const r of blocked) console.log(`  ${r.verdict}  ${r.skill}  ${r.scenarioName}`);
    process.exitCode = 1;
  }
}

void main();
```

- [ ] **Step 6: Add the `pressure` script to `package.json`**

In `packages/eng-loop/package.json`, add to `scripts`:

```json
"pressure": "tsx scripts/run-pressure-suite.ts"
```

Add `tsx` to `devDependencies`: `"tsx": "^4.19.0"`.

- [ ] **Step 7: Commit**

```bash
git add packages/eng-loop
git commit -m "feat(eng-loop): pressure-suite discovery + runner"
```

---

### Task 10: Run the suite live and record the result

This task is the actual experiment — the point of the whole plan. It needs an authenticated `claude` CLI on PATH.

- [ ] **Step 1: Run the full suite**

Run: `cd packages/eng-loop && yarn install && yarn pressure`
Expected: each case prints `completed` / `interactive-block` / `error`; a summary line.

- [ ] **Step 2: Triage any non-`completed` result**

For each `interactive-block`: read the run — the headless override failed to suppress that skill's gate. For each `error`: read the run — the skill failed for another reason (fix the scenario or the `deliverableCheck`). If `classifyRun`'s heuristic misfired (a `completed` run flagged, or vice versa), tighten `INTERACTIVE_TAIL` in `detect-block.ts` and re-run.

- [ ] **Step 3: Record the result**

Create `packages/eng-loop/pressure-tests/RESULTS.md` — a dated table of skill × scenario × verdict, and a one-line conclusion: either "all chain skills run headless under global injection" or a list of skills that need the per-skill vendor fallback (spec §7).

- [ ] **Step 4: If any skill blocks — apply the vendor fallback for that skill only**

Per spec §7: copy *that one* skill from the plugin cache (`~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/<skill>/`) into `packages/eng-loop/vendored-skills/<skill>/`, prepend the headless-override block to its `SKILL.md`, add an `UPSTREAM.md` recording source path + the single edit, and re-run its scenarios until `completed`. Do this only for skills that genuinely blocked.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/pressure-tests/RESULTS.md packages/eng-loop/vendored-skills 2>/dev/null || git add packages/eng-loop/pressure-tests/RESULTS.md
git commit -m "test(eng-loop): live pressure-suite results"
```

---

## Self-review

- **Spec coverage.** This plan implements spec §7 (autonomy — the override block + the pressure-testing discipline) under the global-injection decision. It does not implement §3 (the pipeline skill), §1 (`file-issue`), §5 (the merge skill), or §2 (the dispatcher) — each is a separate plan, as stated under "Out of scope". The plan's output — a proven headless mechanism + a reusable harness — is the prerequisite the pipeline plan consumes.
- **Placeholders.** Tasks 7–8 give scenario *content* for `brainstorming` in full and *specify exactly* what each remaining scenario must contain (its task, its open decision, its expected deliverable) — they are content specifications, not "TODO". Task 8 deliberately does not paste 15 near-identical fixtures; each is pinned by its description.
- **Type consistency.** `PressureCase` / `PressureResult` / `RunVerdict` / `SkillRunResult` are defined once (Tasks 4–6) and used consistently in Tasks 6 and 9. `buildHeadlessPrompt`, `classifyRun`, `pressureTest`, `discoverCases`, `runSkillHeadless` keep one signature throughout.
- **Scope.** One package, one foundational deliverable (a proven headless mechanism + harness). Right-sized for a single plan.
