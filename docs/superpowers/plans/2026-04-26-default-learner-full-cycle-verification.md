# Default learner — Full-Cycle Verification (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate the default learner's full cycle works end-to-end against a real `claude` CLI: (a) the plugin gets discovered + loaded by Claude Code; (b) the `coordinator` skill actually invokes via the Skill tool and walks the phases; (c) the phase agents actually spawn via the Agent tool and produce non-trivial artifacts; (d) **Improve actually mutates `implStateDir` and git-commits the change**; (e) a **second run** starts with the updated `implStateDir` HEAD sha and the loaded self-state reflects the prior Improve. Plans 1–3 produced a system that *should* work; this plan verifies it *does*.

**Architecture:** Three deliverables in order — (1) a manual smoke-test runbook + first hands-on attempt to surface what actually breaks; (2) a purpose-built synthetic intent kind (`learner-loop-test`) with no venue dependencies, designed for the loop to run cheaply and deterministically; (3) an automated two-cycle e2e harness that asserts the load-bearing claim — `implStateDir` HEAD sha advances between cycles AND cycle 2's coordinator boot reads the new sha. Plus a bug-sweep task that captures every issue surfaced, files follow-ups, and lands fixes.

**Tech Stack:** TypeScript (existing), real `claude` CLI, Vitest, Anvil, possibly tsx for the e2e script. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.

**Plan dependencies:** Plans 1, 2, 3 all complete (last commit `a97c0ec7` on `learner/spec`).

**Why this plan exists:** every per-task review and the final whole-branch review verified structural correctness — types, contracts, mocked harness behavior. None of that exercised the *actual* loop with the real harness. The 25 default-learner unit tests use `NoOpHarnessAdapter` which simulates plugin output by writing fake JSON files; they never spawn `claude`. The Plan 3 T5 e2e skeleton verifies wrapper-first registration *live* but its phase-artifact loop logs `(skeleton) would assert ...` instead of running the daemon. So the whole-system claim — "the learner runs, mutates itself, and the next run picks up changes" — has never executed.

**Important note on scope:** this plan is **diagnostic and corrective**, not feature-building. Tasks T1 and T3 will likely surface integration bugs. Each bug gets a fix commit on top of the task it surfaced from. T4 captures the findings + files follow-up bd issues for any deferred fixes. Implementer agents should expect to flag DONE_WITH_CONCERNS frequently here and report what broke, not paper over it.

---

## File structure

**New files:**

| File | Role |
|---|---|
| `docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md` | Manual smoke-test runbook (T1) |
| `client/src/intents/kinds/learner-loop-test/spec.ts` | Synthetic intent kind for testing the loop (T2) |
| `client/src/intents/kinds/learner-loop-test/index.ts` | Kind module exports (T2) |
| `client/scripts/e2e-default-learner-full-cycle.ts` | Two-cycle automated e2e (T3) |

**Modified files:**

| File | Change |
|---|---|
| `client/src/intents/kinds/index.ts` | Register `learner-loop-test` in `SPEC_KINDS` |
| `client/package.json` | Add `e2e:full-cycle` script alias |

**Findings + follow-ups:**

| Output | Where |
|---|---|
| Bug discoveries from T1 + T3 | `docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md` (appended) |
| Follow-up bd issues for deferred fixes | beads tracker |

---

## Cross-task conventions

**Real `claude` CLI required for T1 and T3.** Both tasks will skip cleanly if `claude` is not in PATH, but the WHOLE POINT of this plan is to run it for real. If `claude` is unavailable in your environment, file a blocker and stop — there's nothing useful this plan can deliver without it.

**Plugin install path:** Claude Code reads plugins from `~/.claude/plugins/`. The plugin must be installed there (or symlinked from `client/plugins/default-learner/`) before T1 or T3 will work. T1's first step covers installation; T3's harness handles installation programmatically.

**`implStateDir` contract:** every cycle's session-start hook initializes `implStateDir` as a git repo on first encounter. The HEAD sha at run start is what the coordinator boot captures into `boot.json.implStateDirShaAtStart`. After Improve commits a mutation, HEAD advances. After Memory consolidation commits its curation, HEAD advances again. So a complete cycle leaves `implStateDir` with at least one new commit (Improve) plus optionally one more (consolidation), both with the `default-learner` author identity.

**The load-bearing assertion of this plan:** between cycle 1 and cycle 2, `git -C "$IMPL_STATE_DIR" rev-parse HEAD` must return a different sha. Without this, the learner is not learning.

---

## Task 1: Manual smoke-test runbook + first hands-on attempt

Install the plugin, invoke the coordinator skill standalone (no daemon), and observe what actually happens. The goal is NOT to make it work end-to-end on the first try — the goal is to SURFACE what breaks. Document findings as you go.

**Files:**
- Create: `docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md`

- [ ] **Step 1: Install the plugin into Claude Code's plugin directory**

```bash
mkdir -p ~/.claude/plugins
rm -rf ~/.claude/plugins/default-learner  # clean slate
cp -r /Users/adrianobradley/harbor/jinn-learner/client/plugins/default-learner ~/.claude/plugins/
```

Verify the install:
```bash
ls -la ~/.claude/plugins/default-learner/skills/coordinator/SKILL.md
ls -la ~/.claude/plugins/default-learner/agents/
ls -la ~/.claude/plugins/default-learner/hooks/session-start.sh   # must be executable
```

If any sentinel file is missing, the source plugin layout is broken — fix at the source under `client/plugins/default-learner/`, recopy, retry.

- [ ] **Step 2: Verify Claude Code discovers the plugin**

Open a fresh `claude` session in any directory:
```bash
mkdir -p /tmp/jinn-smoke-test/{work,state}
cd /tmp/jinn-smoke-test
IMPL_STATE_DIR=/tmp/jinn-smoke-test/state claude
```

Inside the session, run the `Skill` tool with `coordinator` as the skill name. Observe:
- Does the skill load? (Claude Code should print the SKILL.md content as the loaded skill.)
- Does it surface in the available-skills list at session start? Check the system reminders.

If the skill is NOT discovered: this is the FIRST real bug. Possible causes: Claude Code has a different plugin path than `~/.claude/plugins/`; plugin format is wrong; frontmatter parsing failed silently. Document in the runbook + investigate.

- [ ] **Step 3: Verify the session-start hook fires**

Inside the same `claude` session, before invoking the coordinator skill, check:
```bash
# In the agent's first turn, ask it to run:
ls -la $IMPL_STATE_DIR/.git
git -C $IMPL_STATE_DIR log --oneline
```

Expected: `.git` exists with one initial commit `init implStateDir`. If not, the hook didn't fire — possible causes: Claude Code doesn't run plugin hooks; the hook script wasn't found; bash error. Document + investigate.

- [ ] **Step 4: Invoke the coordinator skill with a fake intent**

Inside the session, invoke `coordinator` via the Skill tool. Hand it a fake intent JSON. Observe:
- Does the coordinator load self-state? (read `implStateDir`)
- Does it capture the boot SHA + skill bundle CID? (write `workingDir/.coordinator/boot.json`)
- Does it invoke phase 1 (orient) via the Agent tool?

This is where things get interesting. Most likely failure modes:
- The Agent tool's prompt format doesn't match what the coordinator skill expects to construct.
- The Agent tool can't be invoked with a "role" the way the coordinator skill describes.
- The agent role definitions under `agents/` aren't discoverable as Agent-tool subagent types.

Each failure: document in runbook with EXACTLY what broke, what error message appeared, what was expected. Do NOT try to fix everything at once — capture a list.

- [ ] **Step 5: Walk as far through the pipeline as you can**

Continue prompting the agent to invoke each phase. Stop at the first hard break and document. Even partial progress is informative — knowing "Orient works but Strategize fails because X" is more useful than "the whole thing doesn't work."

- [ ] **Step 6: Inspect end state**

Whatever happened, inspect:
```bash
ls -laR /tmp/jinn-smoke-test/work
git -C /tmp/jinn-smoke-test/state log --oneline
ls -la /tmp/jinn-smoke-test/state
```

Document:
- Which phases produced artifacts under `workingDir/.<phase>/`?
- Did `implStateDir` HEAD advance from the initial commit?
- Are there any unexpected files / leaked writes outside scope?

- [ ] **Step 7: Write the runbook**

Create `docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md` with sections:

- **Setup** — exact commands used (steps 1–3)
- **Findings** — what worked, what didn't, with verbatim error messages
- **Bug list** — numbered, prioritized (Critical = pipeline can't proceed; Important = phase fails but pipeline continues; Minor = cosmetic)
- **Recommended fixes** — one per bug, with file:line references where known
- **What's verified** — concise list of what we now know works (likely: plugin discovery, hook firing, coordinator skill loading; possibly: Orient phase)
- **What's NOT verified** — concise list of remaining gaps

This runbook is the deliverable for T1 — it's the input for T2 (which kinds of bugs are "structural to the design" vs "easy fixes") and for T4 (which bugs to file as follow-ups).

- [ ] **Step 8: Land the obvious fixes inline**

For any Critical bugs found in T1 that have an obvious fix (path typo, frontmatter format wrong, hook missing chmod, etc.), fix them in `client/plugins/default-learner/` and recopy to `~/.claude/plugins/`. Re-run the smoke test from step 4. Repeat until you reach a stable point.

Each obvious fix is a separate commit:
```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/<file>
git commit -m "fix(default-learner): <one-line description per smoke test>"
```

Update the runbook's findings as fixes land.

- [ ] **Step 9: Commit the runbook**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md
git commit -m "docs(runbook): default-learner manual smoke test findings"
```

**Done condition for T1:** runbook exists with findings; obvious fixes landed; you have a clear list of remaining bugs to address in T4.

---

## Task 2: Synthetic test intent kind `learner-loop-test`

A purpose-built intent kind designed for cheap, deterministic loop testing. NO venue dependencies, NO real money, NO LLM-stochastic success criteria. Just enough structure that the pipeline can run end-to-end and produce verifiable artifacts.

**Files:**
- Create: `client/src/intents/kinds/learner-loop-test/spec.ts`
- Create: `client/src/intents/kinds/learner-loop-test/index.ts`
- Modify: `client/src/intents/kinds/index.ts`

- [ ] **Step 1: Read the existing kind layout**

```bash
ls /Users/adrianobradley/harbor/jinn-learner/client/src/intents/kinds/
cat /Users/adrianobradley/harbor/jinn-learner/client/src/intents/kinds/index.ts | head -40
cat /Users/adrianobradley/harbor/jinn-learner/client/src/intents/kinds/portfolio-v0/spec.ts | head -30
```

Confirm the existing pattern: each kind has a directory with `spec.ts` (Zod schema for the intent payload), and `index.ts` registers exports.

- [ ] **Step 2: Write `spec.ts`**

`client/src/intents/kinds/learner-loop-test/spec.ts`:

```typescript
import { z } from 'zod';

/**
 * Synthetic intent kind for verifying the default-learner full cycle
 * end-to-end. NO venue dependencies. NO real money. The intent describes
 * a trivial deterministic task: write a JSON output file with N fields.
 *
 * Why this kind exists: to exercise the learner's pipeline (Orient →
 * Strategize → Plan → Execute → Debrief → Improve → Memory consolidation)
 * with real LLM agents but without the cost / fragility of real-venue
 * kinds. The success criteria is purely structural — does the agent
 * produce the requested fields?
 *
 * The "improvement" demonstration: cycle 1 may produce an incomplete
 * output; Improve writes a skill correcting the gap; cycle 2 picks up
 * the new skill from implStateDir and produces complete output. This
 * demonstrates the LOOP, not LLM "intelligence".
 */
export const LearnerLoopTestSpec = z.object({
  kind: z.literal('learner-loop-test'),
  /** Number of fields the output JSON must contain. */
  fieldCount: z.number().int().min(1).max(10),
  /** Field names the output JSON must include. */
  fieldNames: z.array(z.string()).min(1).max(10),
  /** Path under workingDir/ where the output JSON must be written. */
  outputPath: z.string().default('output.json'),
});

export type LearnerLoopTestSpecType = z.infer<typeof LearnerLoopTestSpec>;
```

- [ ] **Step 3: Write `index.ts` for the kind**

`client/src/intents/kinds/learner-loop-test/index.ts`:

```typescript
export { LearnerLoopTestSpec, type LearnerLoopTestSpecType } from './spec.js';
```

- [ ] **Step 4: Register the kind in `SPEC_KINDS`**

Use Edit on `client/src/intents/kinds/index.ts`. Find the existing `SPEC_KINDS` registry and add an entry for `learner-loop-test`. Mirror the pattern of the existing entries (e.g., portfolio.v0). The exact shape depends on the existing registry — read it before editing.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn typecheck
```

Expected: zero errors. If the spec/registry doesn't fit the existing kind-registration pattern cleanly, document the friction in the T1 runbook and adjust.

- [ ] **Step 6: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/src/intents/kinds/learner-loop-test/ client/src/intents/kinds/index.ts
git commit -m "feat(intents): learner-loop-test kind for full-cycle verification"
```

**Done condition for T2:** `learner-loop-test` is a registered intent kind; typecheck passes; nothing else broke.

---

## Task 3: Two-cycle automated e2e harness

The script that demonstrates the load-bearing claim: run the daemon against a `learner-loop-test` intent twice in succession, assert `implStateDir` HEAD sha advances between cycles, assert cycle 2's coordinator boot reads the new sha, assert phase artifacts exist for both cycles.

**Files:**
- Create: `client/scripts/e2e-default-learner-full-cycle.ts`
- Modify: `client/package.json` (add `e2e:full-cycle` script)

- [ ] **Step 1: Write the e2e script**

`client/scripts/e2e-default-learner-full-cycle.ts`:

```typescript
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const PLUGIN_SRC = join(PACKAGE_ROOT, 'plugins', 'default-learner');

async function main(): Promise<void> {
  // Pre-flight checks.
  const claudeCheck = spawnSync('claude', ['--version']);
  if (claudeCheck.status !== 0) {
    console.log('SKIP: claude CLI not in PATH; install Claude Code to run this e2e');
    process.exit(0);
  }

  console.log('=== default-learner full-cycle e2e ===');

  // Install plugin into Claude Code's plugin directory.
  const claudePluginDir = join(homedir(), '.claude', 'plugins');
  mkdirSync(claudePluginDir, { recursive: true });
  const claudePluginPath = join(claudePluginDir, 'default-learner');
  rmSync(claudePluginPath, { recursive: true, force: true });
  cpSync(PLUGIN_SRC, claudePluginPath, { recursive: true });
  console.log(`  ✓ plugin installed at ${claudePluginPath}`);

  // Set up cycle directories.
  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-state-'));
  const cycle1WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c1-'));
  const cycle2WorkingDir = mkdtempSync(join(tmpdir(), 'jinn-fullcycle-c2-'));

  let exitCode = 0;
  try {
    console.log(`  implStateDir: ${implStateDir}`);
    console.log(`  cycle 1 workingDir: ${cycle1WorkingDir}`);
    console.log(`  cycle 2 workingDir: ${cycle2WorkingDir}`);

    // Construct the synthetic intent.
    const intent = {
      id: 'fullcycle-test-1',
      description:
        'Write a JSON file with the requested fields, demonstrating the learner pipeline.',
      window: { startTs: Date.now() - 1000, endTs: Date.now() + 600_000 },
      spec: {
        kind: 'learner-loop-test',
        fieldCount: 3,
        fieldNames: ['foo', 'bar', 'baz'],
        outputPath: 'output.json',
      },
    };

    // === CYCLE 1 ===
    console.log('\n--- CYCLE 1 ---');
    await runCycle({
      cycleLabel: 'cycle-1',
      intent,
      workingDir: cycle1WorkingDir,
      implStateDir,
    });

    const sha1 = currentImplStateSha(implStateDir);
    console.log(`  implStateDir HEAD after cycle 1: ${sha1}`);

    assertCycleArtifacts(cycle1WorkingDir, 'cycle-1');

    // === CYCLE 2 ===
    console.log('\n--- CYCLE 2 ---');
    await runCycle({
      cycleLabel: 'cycle-2',
      intent: { ...intent, id: 'fullcycle-test-2' },
      workingDir: cycle2WorkingDir,
      implStateDir,
    });

    const sha2 = currentImplStateSha(implStateDir);
    console.log(`  implStateDir HEAD after cycle 2: ${sha2}`);

    assertCycleArtifacts(cycle2WorkingDir, 'cycle-2');

    // === LOAD-BEARING ASSERTIONS ===
    console.log('\n--- LOAD-BEARING ASSERTIONS ---');

    if (sha1 === sha2) {
      throw new Error(
        `implStateDir HEAD did not advance between cycles. sha1=${sha1} sha2=${sha2}. ` +
          `This means Improve did not commit anything — the learner is not learning.`,
      );
    }
    console.log(`  ✓ implStateDir HEAD advanced: ${sha1.slice(0, 8)} → ${sha2.slice(0, 8)}`);

    // Cycle 2's coordinator boot should have captured sha1 (the state at cycle 2's run start).
    const cycle2BootPath = join(cycle2WorkingDir, '.coordinator', 'boot.json');
    if (existsSync(cycle2BootPath)) {
      const cycle2Boot = JSON.parse(readFileSync(cycle2BootPath, 'utf8'));
      if (cycle2Boot.implStateDirShaAtStart !== sha1) {
        throw new Error(
          `cycle 2 boot.json captured wrong sha. expected=${sha1} got=${cycle2Boot.implStateDirShaAtStart}. ` +
            `This means cycle 2's coordinator did not read the updated implStateDir from cycle 1's Improve.`,
        );
      }
      console.log(`  ✓ cycle 2 boot.json.implStateDirShaAtStart matches cycle 1's HEAD`);
    } else {
      console.log(`  ⚠ cycle 2 boot.json missing — coordinator did not record boot state. Defer assertion.`);
    }

    // Inspect what Improve actually committed.
    const commitsBetweenCycles = execSync(
      `git -C "${implStateDir}" log --oneline ${sha1}..${sha2}`,
      { encoding: 'utf8' },
    ).trim();
    console.log(`  ✓ commits between cycles:\n${commitsBetweenCycles.split('\n').map((l) => '      ' + l).join('\n')}`);

    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error('\ne2e FAILED:', err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    // Leave artifacts on failure for postmortem; clean up on success.
    if (exitCode === 0) {
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(cycle1WorkingDir, { recursive: true, force: true });
      rmSync(cycle2WorkingDir, { recursive: true, force: true });
    } else {
      console.log(`\nFailure artifacts preserved at:`);
      console.log(`  ${implStateDir}`);
      console.log(`  ${cycle1WorkingDir}`);
      console.log(`  ${cycle2WorkingDir}`);
    }
  }
  process.exit(exitCode);
}

interface CycleParams {
  cycleLabel: string;
  intent: unknown;
  workingDir: string;
  implStateDir: string;
}

async function runCycle(params: CycleParams): Promise<void> {
  // Construct the initial prompt that invokes the coordinator skill
  // with the intent context. Mirrors what the daemon-side
  // ClaudeCodeHarnessAdapter would build, but we invoke claude directly
  // here rather than going through the engine, to keep the e2e focused
  // on the loop semantics.
  const prompt = [
    'You are running a Jinn restoration intent. Invoke the `coordinator` skill via the Skill tool to begin.',
    '',
    'Session inputs (refer to these when the coordinator skill or any phase asks for them):',
    `- intent = ${JSON.stringify(params.intent)}`,
    `- workingDir = ${params.workingDir}`,
    `- implStateDir = ${params.implStateDir}`,
    `- msUntilEndTs = 600000`,
    '',
    'Run all seven phases and return when complete.',
  ].join('\n');

  return new Promise<void>((resolve, reject) => {
    const env = { ...process.env, IMPL_STATE_DIR: params.implStateDir };
    const child: ChildProcess = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: params.workingDir,
    });

    child.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(`[${params.cycleLabel}] ${d.toString()}`);
    });
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(`[${params.cycleLabel}:err] ${d.toString()}`);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`  ✓ ${params.cycleLabel} claude session exited cleanly`);
        resolve();
      } else {
        reject(new Error(`${params.cycleLabel} claude session exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function currentImplStateSha(implStateDir: string): string {
  return execSync(`git -C "${implStateDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
}

function assertCycleArtifacts(workingDir: string, cycleLabel: string): void {
  // For each phase, check whether its artifact directory exists. We don't
  // hard-fail on missing phases — instead we report what's present, so a
  // partial run is still diagnostic.
  const phases = [
    'orient',
    'strategize',
    'plan',
    'execute',
    'debrief',
    'improve',
    'memory-consolidation',
  ];
  let presentCount = 0;
  for (const phase of phases) {
    const dir = join(workingDir, `.${phase}`);
    if (existsSync(dir)) {
      console.log(`    ✓ ${cycleLabel} ${phase} artifact present`);
      presentCount++;
    } else {
      console.log(`    ✗ ${cycleLabel} ${phase} artifact MISSING`);
    }
  }
  if (presentCount === 0) {
    throw new Error(
      `${cycleLabel} produced ZERO phase artifacts — the coordinator skill did not run`,
    );
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add yarn alias**

Edit `client/package.json` `scripts` block to add:

```
"e2e:full-cycle": "tsx scripts/e2e-default-learner-full-cycle.ts",
```

- [ ] **Step 3: Run the e2e**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn e2e:full-cycle
```

Expected outcomes (in priority order):

- **Best case:** `=== e2e PASSED ===` — the learner ran two cycles, `implStateDir` HEAD advanced, cycle 2 read the new sha. The full-cycle claim is verified.
- **Partial case:** Phase artifacts present for one or both cycles but `implStateDir` HEAD did NOT advance — this means the coordinator ran but Improve didn't actually commit. Document where Improve broke.
- **Worst case:** ZERO phase artifacts — the coordinator skill didn't even start. T1's manual smoke test should have caught this; if it didn't, something different is happening in the spawn-from-script path.

Whatever happens, **preserve the failure artifacts** (the script does this automatically on non-zero exit) and document in the T1 runbook.

- [ ] **Step 4: Iterate if necessary**

If the e2e fails, do NOT silently fix the script to make it pass. Either:
- The plugin/shim has a real bug → fix it (separate commit per bug, mirroring T1's approach), then re-run.
- The script's assertions are wrong → adjust the script + explain why in the commit message.
- The contract is genuinely broken in a way that needs design-level rethinking → flag DONE_WITH_CONCERNS, document in T1 runbook, defer to follow-up.

- [ ] **Step 5: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/scripts/e2e-default-learner-full-cycle.ts client/package.json
git commit -m "test(default-learner): two-cycle full-cycle e2e (verifies implStateDir mutation)"
```

**Done condition for T3:** the e2e script exists; you've run it; the output (PASS / partial / fail) is documented in the T1 runbook. If PASS: the load-bearing claim is verified. If not: T4 captures the gap.

---

## Task 4: Capture findings + file follow-up bd issues

Convert the runbook's bug list into bd issues so the work isn't lost. For each bug:

- Critical (blocks the loop) → file as P1 bd issue blocking on the parent epic for this plan
- Important (degrades the loop but pipeline runs) → file as P2 bd issue
- Minor (cosmetic / future hardening) → file as P3 bd issue

**Files:** none new; just bd issue creation.

- [ ] **Step 1: Create the parent epic for full-cycle follow-up**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
bd create --title="Default learner full-cycle: surfaced bugs + deferred fixes" \
  --description="Issues surfaced during the Plan 4 manual smoke + automated e2e. See docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md for the bug list and recommended fixes." \
  --type=epic --priority=2
```

Note the epic id (e.g. `jinn-mono-XXX`).

- [ ] **Step 2: For each bug in the runbook's bug list, file a bd issue**

For each bug:

```bash
bd create --title="<short bug title>" \
  --description="<from runbook: what broke, expected behavior, observed behavior, recommended fix with file:line>" \
  --type=bug --priority=<1|2|3>
bd dep add <new-bug-id> <epic-id>
```

If you have many bugs, dispatch parallel `bd create` subagents for efficiency.

- [ ] **Step 3: Update the runbook to cross-reference the bd issues**

Append a section "Follow-up bd issues" to the runbook listing each bd issue id + title + priority. This makes the runbook the canonical artifact for what was found vs what was fixed inline vs what's deferred.

- [ ] **Step 4: Commit the runbook update**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md
git commit -m "docs(runbook): cross-reference bd issues for default-learner full-cycle bugs"
```

**Done condition for T4:** every bug from T1/T3 either has a fix commit landed (inline) or a bd issue filed (deferred). Nothing is lost in informal notes.

---

## Plan acceptance

When all 4 tasks are committed:

- [ ] Plugin installs cleanly into `~/.claude/plugins/`; sentinel files present.
- [ ] Manual smoke test runbook exists at `docs/superpowers/runbooks/2026-04-26-default-learner-manual-smoke.md` with concrete findings.
- [ ] `learner-loop-test` intent kind registered; typecheck passes.
- [ ] `client/scripts/e2e-default-learner-full-cycle.ts` exists; `yarn e2e:full-cycle` runs (PASS, partial, or documented FAIL — any of those is acceptable as long as the runbook captures the result).
- [ ] **Either** the e2e PASSES (load-bearing claim verified) **or** the gap to passing is fully documented in the runbook + filed as bd issues for follow-up.
- [ ] Pre-existing client test suite still passes; no regressions from T2 (new kind registration).

---

## What's deferred past Plan 4

- **Real "improvement" demonstration** — Plan 4 verifies the LOOP runs and `implStateDir` mutates. It does NOT verify the agent gets BETTER between cycles (cycle 2's output is materially better than cycle 1's). That's a harder claim that depends on LLM behavior and probably needs a curated benchmark suite. File as a follow-up if needed.
- **Cross-operator artifact reads** — explorer's "others-history" topic is documented in the plugin but never exercised end-to-end. Depends on the access/gating sibling epic of TEE scope §5.
- **Pi.dev harness verification** — Plan 4 only covers Claude Code. Repeating this plan against Pi.dev would catch harness-portability bugs.
- **Real OTel tracer integration** — the constitution span emission. Today the constitution lives only in `workingDir/.strategize/constitution.json`; the `jinn.state_transition` span never fires.
- **Production deployment confidence** — even if Plan 4 passes, "works on Anvil with synthetic kind" ≠ "works on mainnet with portfolio.v0." Real-venue verification is its own project.

---

## Critical: read this before starting

This plan is **diagnostic, not feature-building**. The implementer agent's job is to FIND bugs and DOCUMENT them, not to silently smooth over failures to make assertions pass. Every "I made it pass by tweaking the script" is a missed opportunity to learn what actually doesn't work in production.

If you reach a point where you're tempted to make the script lenient enough to pass without surfacing what broke: STOP and flag DONE_WITH_CONCERNS. Document the gap in the runbook. File a bd issue. Move on. The runbook + bd issues are the deliverable, not green test output.

The expected outcome of THIS plan is:
- A runbook with concrete findings (some bugs found, some fixed, some deferred)
- A working synthetic kind for future testing
- An e2e script that runs and reports honestly
- A clear answer to "does the full cycle work?" — even if the answer is "no, here's what's missing"
