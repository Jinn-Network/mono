# Default learning restorer — Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the default learning restorer as a **drop-in agent-harness plugin** under `client/plugins/default-learner/`. The plugin contains 8 skills (the coordinator + one per phase, each thin and delegating to a specialized subagent), 7 agents (the specialized subagents that do the actual reasoning), 1 hook (git-init the operator's `implStateDir` on session start), 1 validator script, and per-harness loader files. No TypeScript code in this plan — Plan 2 ships the daemon-side `RestorerImpl` shim that dispatches into this plugin.

**Architecture:** Uniform pattern across phases. The coordinator skill sequences phases by loading each phase's skill via the harness's Skill tool. Each phase skill is small — its job is to launch one or more specialized subagents (via the harness's Agent tool), collect their outputs, and write structured artifacts under `workingDir/.<phase>/`. Specialized agents (strategist, planner, analyst, promoter, consolidator, explorer, step-worker) carry the deep reasoning in fresh contexts. Subagents do not nest — only one level below the main coordinator session — which is enforced structurally by the design (phase skills launch agents; agents do not launch further agents). `implStateDir` is a git repo; identity is set once by the session-start hook so any `git commit` from inside the agents uses the right author identity automatically.

**Tech Stack:** Markdown with YAML frontmatter (`name`, `description`, `allowed-tools`). Bash for the session-start hook. Node ESM for the validator script. No build step.

**Spec reference:** `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.

**Existing convention reference:** `client/skills/jinn-operator/SKILL.md` for frontmatter shape + body style. The default-learner plugin lives at `client/plugins/default-learner/` (new top-level plugin dir, distinct from the existing `client/skills/<single-skill>/` layout — the default learner is a multi-component plugin, not a single skill).

---

## File structure

All paths relative to repo root (worktree `/Users/adrianobradley/harbor/jinn-learner/`).

```
client/plugins/default-learner/
├── README.md                           ← overview + install per harness
├── AGENTS.md                           ← Codex / generic loader
├── CLAUDE.md                           ← Claude Code loader
├── skills/
│   ├── coordinator/SKILL.md            ← entry point; sequences phases
│   ├── orient/SKILL.md                 ← launches explorer subagents
│   ├── strategize/SKILL.md             ← launches strategist
│   ├── plan/SKILL.md                   ← launches planner
│   ├── execute/SKILL.md                ← walks plan, launches step-workers
│   ├── debrief/SKILL.md                ← launches analyst (+ explorers if needed)
│   ├── improve/SKILL.md                ← launches promoter; commits
│   └── memory-consolidation/SKILL.md   ← launches consolidator; commits
├── agents/
│   ├── explorer.md                     ← generic info-gatherer (orient/debrief)
│   ├── strategist.md                   ← diverge/converge approach selection
│   ├── planner.md                      ← concrete plan builder
│   ├── step-worker.md                  ← generic plan-step executor
│   ├── analyst.md                      ← retrospective synthesizer
│   ├── promoter.md                     ← decides + applies implStateDir mutations
│   └── consolidator.md                 ← curates state; sets workingDir public/private
├── hooks/
│   └── session-start.sh                ← git-init implStateDir + set author identity
└── scripts/
    └── validate-plugin.mjs             ← structure + frontmatter validator
```

Plus one modified file: `client/package.json` to include `plugins/` in the published `files` array so the bundle ships with the npm package.

---

## Cross-skill / cross-agent conventions (read before authoring any file)

**Frontmatter, every SKILL.md and agent.md:**

```yaml
---
name: <name>                            # must match the directory or filename stem
description: <one sentence>             # used by the harness to decide when to load
allowed-tools: <comma-separated>        # only the tools this skill/agent actually uses
---
```

**Spawning a specialized subagent (in a phase skill body):**

```
Use the Agent tool to spawn a fresh-context subagent. The agent's role is `<agent-name>`.
Pass it inputs:
  intent       = <copy of intent>
  workingDir   = <path>
  implStateDir = <path>
  msUntilEndTs = <current value>
  <phase-specific inputs>
The subagent will load its <agent-name>.md role definition, do the work, and return a structured summary.
Read the artifact paths it wrote under workingDir/.<phase>/.
```

**Standard output convention, every phase skill:**

- Per-phase artifacts live under `workingDir/.<phase>/` (e.g., `workingDir/.orient/...`).
- Structured summary returned to the coordinator session.

**Standard boundaries, every skill / agent:**

- Never write outside `implStateDir/**` or `workingDir/**`.
- Never modify success criteria or constitution after Strategize commits them.
- Never spawn further subagents from inside an agent (no nesting).

**Git identity:** the session-start hook sets `user.name = default-learner` and `user.email = default-learner@jinn.local` once at boot. Any `git commit` from inside Improve's promoter or Memory consolidation's consolidator picks up this identity automatically — agents do not need to wrap commits with `-c user.name=...`.

---

## Task 1: Plugin scaffold + loader files + README

**Files:**
- Create: `client/plugins/default-learner/README.md`
- Create: `client/plugins/default-learner/CLAUDE.md`
- Create: `client/plugins/default-learner/AGENTS.md`
- Modify: `client/package.json` (add `"plugins/"` to `files` array)

- [ ] **Step 1: Create the plugin directory skeleton**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
mkdir -p client/plugins/default-learner/{skills,agents,hooks,scripts}
mkdir -p client/plugins/default-learner/skills/{coordinator,orient,strategize,plan,execute,debrief,improve,memory-consolidation}
```

- [ ] **Step 2: Write `README.md`**

`client/plugins/default-learner/README.md`:

````markdown
# default-learner — agent harness plugin

A drop-in plugin for any agent harness that supports skills + subagents + hooks. Implements the Jinn default learning restorer end-to-end: 8 skills sequencing 7 specialized subagents through Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation.

## What it provides

- **8 skills** — `coordinator` (entry point) plus one per phase. Skills are thin: their job is to launch the right specialized subagent and collect results.
- **7 agents** — `explorer`, `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator`. These are the specialized subagents the phase skills launch in fresh contexts.
- **1 hook** — `session-start.sh` initializes `implStateDir` as a git repo and sets author identity.
- **1 validator** — `validate-plugin.mjs` checks structure + frontmatter.

## Installing

The plugin ships inside the `@jinn-network/client` npm package under `node_modules/@jinn-network/client/plugins/default-learner/`. Per harness:

**Claude Code:**

```bash
mkdir -p ~/.claude/plugins
cp -r "$(npm root -g)/@jinn-network/client/plugins/default-learner" ~/.claude/plugins/
```

**Codex:**

```bash
mkdir -p ~/.codex/plugins
cp -r "$(npm root -g)/@jinn-network/client/plugins/default-learner" ~/.codex/plugins/
```

**Pi.dev / other harnesses:** copy the directory into wherever the harness loads plugins from. Each harness reads its own loader file at the plugin root (`CLAUDE.md`, `AGENTS.md`, etc.).

## What the harness must provide

These are the runtime primitives the plugin assumes the harness exposes (Claude Code names; substitute equivalents on other harnesses):

- `Skill` — load a named skill into the current session
- `Agent` — spawn a fresh-context subagent with a role name and inputs
- `Bash` — for git commands and other shell calls
- `Read`, `Write`, `Edit`, `Glob`, `Grep` — filesystem
- A wait primitive — block until duration / deadline / condition (Claude Code: `Monitor`)

If your harness lacks any of the first six, the plugin will not run. The wait primitive gates time-anchored plans only — the plugin can run for `early-return` postures without it.

## What this plugin does NOT contain

- The Jinn daemon-side `RestorerImpl` shim (separate plan).
- Kind-specific tools (HL MCP, Polymarket, etc.) — those come from the daemon's MCP setup.
- `buildRestorerImpls` registration — separate plan wires the shim.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
````

- [ ] **Step 3: Write `CLAUDE.md` (Claude Code loader)**

`client/plugins/default-learner/CLAUDE.md`:

````markdown
# default-learner plugin (Claude Code loader)

This plugin provides the Jinn default learning restorer.

## Entry point

When a Jinn restoration session starts, invoke the `coordinator` skill via the Skill tool. It will sequence the seven-phase pipeline.

## Components

**Skills:**
- `coordinator` — entry point; sequences phases
- `orient`, `strategize`, `plan`, `execute`, `debrief`, `improve`, `memory-consolidation` — one per phase; each launches its specialized subagent

**Agents (subagents the phase skills spawn via the Agent tool):**
- `explorer` — info gatherer (used by orient and debrief)
- `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator` — one per specialized phase role

**Hooks:**
- `session-start.sh` — runs once at session start; ensures `implStateDir` is a git repo and sets `default-learner` author identity

## Conventions

- All durable self-modification lives in `implStateDir/**` (git-backed).
- Episode artifacts live under `workingDir/**`; the engine harvests `workingDir` per the kind's output contract once the coordinator returns.
- Subagents are one level deep only — agents do not spawn further agents.
- Strategize-frozen success criteria + timing posture must not change during the run.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
````

- [ ] **Step 4: Write `AGENTS.md` (generic / Codex loader)**

`client/plugins/default-learner/AGENTS.md`:

````markdown
# default-learner plugin (generic / Codex loader)

This plugin provides the Jinn default learning restorer for any agent harness that supports skills + subagents + hooks.

## Tool name mapping

The skills and agents in this plugin use Claude Code tool names by default. On other harnesses, substitute equivalents:

| Claude Code | Codex | Pi.dev | Generic |
|---|---|---|---|
| `Skill` | `skill` | (extension load) | "load named instructions into current session" |
| `Agent` | `agent` | (subprocess) | "spawn fresh-context subagent with role + inputs" |
| `Bash` | `shell` | `bash` | shell tool |
| `Read`/`Write`/`Edit` | `file_read`/`file_write` | `fs` tools | filesystem |
| `Monitor` (wait) | (bespoke) | (built-in) | "block until duration/deadline/condition" |

## Entry point

Invoke the `coordinator` skill at the start of a Jinn restoration session.

## Components

See `CLAUDE.md` for the same component listing — both loaders cover the same plugin contents; this file just notes the cross-harness tool mapping.

## Spec

`docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1.
````

- [ ] **Step 5: Modify `client/package.json` to include the plugin in the published files**

Use Edit on `client/package.json`:

old_string:
```
  "files": [
    "dist/",
    "deployments/",
    "skills/",
```

new_string:
```
  "files": [
    "dist/",
    "deployments/",
    "plugins/",
    "skills/",
```

- [ ] **Step 6: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/README.md client/plugins/default-learner/CLAUDE.md client/plugins/default-learner/AGENTS.md client/package.json
git commit -m "feat(default-learner): plugin scaffold + loader files + READMEs"
```

---

## Task 2: Hook + validator script

**Files:**
- Create: `client/plugins/default-learner/hooks/session-start.sh`
- Create: `client/plugins/default-learner/scripts/validate-plugin.mjs`

- [ ] **Step 1: Write `session-start.sh`**

`client/plugins/default-learner/hooks/session-start.sh`:

```bash
#!/usr/bin/env bash
# default-learner session-start hook.
#
# Runs once at the start of every default-learner session. Ensures
# implStateDir is a git repo and sets the author identity so any
# subsequent `git commit` from inside the plugin's agents uses the
# default-learner identity automatically.
#
# Inputs (from environment):
#   IMPL_STATE_DIR — path to the operator's implStateDir
#
# Idempotent: safe to re-run. No remote, no signing — implStateDir
# history is operator-private.

set -euo pipefail

if [[ -z "${IMPL_STATE_DIR:-}" ]]; then
  echo "session-start: IMPL_STATE_DIR not set" >&2
  exit 1
fi

mkdir -p "$IMPL_STATE_DIR"
cd "$IMPL_STATE_DIR"

if [[ ! -d .git ]]; then
  git init --initial-branch=main --quiet
  git commit --allow-empty -m "init implStateDir" --quiet
fi

git config user.name "default-learner"
git config user.email "default-learner@jinn.local"

echo "session-start: implStateDir ready at $(pwd) (HEAD=$(git rev-parse HEAD))"
```

Make it executable:

```bash
chmod +x /Users/adrianobradley/harbor/jinn-learner/client/plugins/default-learner/hooks/session-start.sh
```

- [ ] **Step 2: Write `validate-plugin.mjs`**

`client/plugins/default-learner/scripts/validate-plugin.mjs`:

```javascript
#!/usr/bin/env node
// Structural + frontmatter validator for the default-learner plugin.
// Fails (exit 1) on any error; prints each finding.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_SKILLS = [
  'coordinator',
  'orient',
  'strategize',
  'plan',
  'execute',
  'debrief',
  'improve',
  'memory-consolidation',
];

const REQUIRED_AGENTS = [
  'explorer',
  'strategist',
  'planner',
  'step-worker',
  'analyst',
  'promoter',
  'consolidator',
];

const REQUIRED_FRONTMATTER = ['name', 'description', 'allowed-tools'];

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

let errors = 0;

function check(predicate, message) {
  if (!predicate) {
    console.error(message);
    errors++;
  }
}

// Skills
for (const name of REQUIRED_SKILLS) {
  const skillFile = join(PLUGIN_ROOT, 'skills', name, 'SKILL.md');
  let text;
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    console.error(`MISSING: ${skillFile}`);
    errors++;
    continue;
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    console.error(`NO_FRONTMATTER: ${skillFile}`);
    errors++;
    continue;
  }
  for (const f of REQUIRED_FRONTMATTER) {
    check(fm[f], `MISSING_FIELD ${f}: ${skillFile}`);
  }
  check(fm.name === name, `NAME_MISMATCH: ${skillFile} has name="${fm.name}", expected "${name}"`);
}

// Agents
for (const name of REQUIRED_AGENTS) {
  const agentFile = join(PLUGIN_ROOT, 'agents', `${name}.md`);
  let text;
  try {
    text = readFileSync(agentFile, 'utf8');
  } catch {
    console.error(`MISSING: ${agentFile}`);
    errors++;
    continue;
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    console.error(`NO_FRONTMATTER: ${agentFile}`);
    errors++;
    continue;
  }
  for (const f of REQUIRED_FRONTMATTER) {
    check(fm[f], `MISSING_FIELD ${f}: ${agentFile}`);
  }
  check(fm.name === name, `NAME_MISMATCH: ${agentFile} has name="${fm.name}", expected "${name}"`);
}

// Hook
const hookFile = join(PLUGIN_ROOT, 'hooks', 'session-start.sh');
try {
  const stat = statSync(hookFile);
  check((stat.mode & 0o100) !== 0, `NOT_EXECUTABLE: ${hookFile}`);
} catch {
  console.error(`MISSING: ${hookFile}`);
  errors++;
}

// Loader files
for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
  try {
    statSync(join(PLUGIN_ROOT, f));
  } catch {
    console.error(`MISSING: ${join(PLUGIN_ROOT, f)}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s)`);
  process.exit(1);
}
console.log(`OK — ${REQUIRED_SKILLS.length} skills, ${REQUIRED_AGENTS.length} agents, hook + loaders validated`);
```

- [ ] **Step 3: Add a yarn alias for the validator**

Edit `client/package.json` to add a script entry. Use Edit:

old_string (find the line just below `"validate-skills":` if it exists, else under `"scripts"`):
```
  "scripts": {
```

new_string:
```
  "scripts": {
    "validate-plugin": "node plugins/default-learner/scripts/validate-plugin.mjs",
```

(If a `validate-skills` entry already exists from a prior unrelated plan, place this entry adjacent to it.)

- [ ] **Step 4: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/hooks/session-start.sh client/plugins/default-learner/scripts/validate-plugin.mjs client/package.json
git commit -m "feat(default-learner): session-start hook + plugin validator"
```

---

## Task 3: Coordinator skill

**Files:**
- Create: `client/plugins/default-learner/skills/coordinator/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

`client/plugins/default-learner/skills/coordinator/SKILL.md`:

````markdown
---
name: coordinator
description: Use when running a Jinn restoration intent end-to-end. Sequences the seven-phase pipeline (Orient → Strategize → Plan → Execute → Debrief → Improve → Memory consolidation) by loading each phase's skill in order.
allowed-tools: Bash, Read, Write, Skill
---

# Coordinator — default-learner entry point

You are running one Jinn restoration intent end-to-end. This skill is the entry point. Each phase's skill is loaded into your session in turn; each phase skill does its own thin orchestration (typically launching a specialized subagent via the Agent tool).

## Inputs (from the daemon)

- `intent` — `{ id, description, kind, window: { startTs, endTs }, spec, eligibility? }`
- `workingDir` — ephemeral; the engine harvests for delivery when you return
- `implStateDir` — operator-private durable self; persists across runs
- `msUntilEndTs` — function returning remaining time in the window
- An abort signal that fires at `window.endTs`

## Boot

The session-start hook (`hooks/session-start.sh`) has already run with `IMPL_STATE_DIR` set, so:
- `implStateDir` is a git repo
- The default-learner git author identity is configured
- HEAD sha is the implStateDir state at run start

Capture it for the constitution span:

```bash
IMPL_STATE_DIR_SHA=$(git -C "$IMPL_STATE_DIR" rev-parse HEAD)
SKILL_BUNDLE_CID=$(find "$PLUGIN_ROOT" -type f \( -name '*.md' -o -name '*.sh' -o -name '*.mjs' \) | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
```

(`$PLUGIN_ROOT` is the path to this plugin install; if your harness doesn't expose it, hash the loaded skills from their loaded paths.)

Write `workingDir/.coordinator/boot.json`:

```json
{
  "implStateDirShaAtStart": "<IMPL_STATE_DIR_SHA>",
  "skillBundleCid": "sha256:<SKILL_BUNDLE_CID>",
  "intentId": "<intent.id>",
  "windowEndTs": <window.endTs>
}
```

## Pipeline

For each phase below, in order:

1. Load the phase skill via the `Skill` tool (e.g., `Skill orient`).
2. The skill loads into your session; follow its instructions. It will typically launch one or more specialized subagents via the Agent tool, collect their outputs, and write artifacts under `workingDir/.<phase>/`.
3. Append a JSONL entry to `workingDir/.coordinator/log.jsonl` after each phase: `{ ts, phase, status, summary }`.

Phases in order:

1. `orient` — gather intent + world-state + history
2. `strategize` — pick approach, freeze success criteria + timing posture
3. `plan` — concrete steps, optionally time-anchored
4. `execute` — walk plan, spawn step-workers, decide stuck
5. `debrief` — post-execution analysis
6. `improve` — mutate `implStateDir`, commit
7. `memory-consolidation` — curate, separate commit

## Constitution span

After Strategize, read `workingDir/.strategize/constitution.json` and emit its fields as attributes on a `jinn.state_transition` span. If your harness exposes an OTel tracer, do this; otherwise the file itself is the constitution record (Debrief reads it from there).

## Returning

When all seven phases complete (or one aborts), return. The Jinn daemon's `walkArtifacts` packaging handles delivery. Never modify anything outside `implStateDir/**` or `workingDir/**`.

## Failure handling

- Within Execute: that skill judges `continue / retry-step / replan / abort` per its own rules.
- Other phases: if a phase reports a hard problem, write `workingDir/.errors/<phase>.json` and abort the pipeline. Still invoke `memory-consolidation` so partial work gets curated.
- Abort signal fired (window expired): stop the current phase cleanly, write `workingDir/.errors/abort.json`, invoke `memory-consolidation`, return.

## Cross-reference

Spec: `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` v1.1, sections §2, §10.
````

- [ ] **Step 2: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/coordinator/SKILL.md
git commit -m "feat(default-learner): coordinator skill"
```

---

## Task 4: Orient skill + explorer agent

**Files:**
- Create: `client/plugins/default-learner/skills/orient/SKILL.md`
- Create: `client/plugins/default-learner/agents/explorer.md`

- [ ] **Step 1: Write `orient/SKILL.md`**

`client/plugins/default-learner/skills/orient/SKILL.md`:

````markdown
---
name: orient
description: Use when the coordinator reaches the Orient phase. Decide what topics to gather; launch one explorer subagent per topic; collate findings into a summary Strategize will consume.
allowed-tools: Bash, Read, Write, Agent
---

# Orient skill

You are coordinating the Orient phase. Your only jobs are: decide what topics need gathering for this intent, launch an `explorer` subagent for each topic, and collate their results.

## Inputs

- The intent and paths from the coordinator session
- `workingDir` — write findings here
- `implStateDir` — read-only in this phase

## Decide what topics to gather

Choose from these typical categories; add or omit based on the intent:

1. **intent-parse** — what's the goal, kind, window, spec, eligibility? Always include.
2. **world-state** — for kinds with a venue (portfolio.v0, prediction.v0, etc.), pull current relevant state. Include if the kind has a venue.
3. **own-history** — list prior runs of this kind by this operator. Include if `implStateDir/runs/index.json` exists or the harness exposes a knowledge-tree query.
4. **others-history** — recent runs of this kind by other operators. Include only if `implStateDir/policy.json` sets `allowCrossOperatorReads: true` AND the harness exposes the query tool.

## Launch explorers

For each topic chosen, spawn an `explorer` subagent via the Agent tool:

```
Use the Agent tool to spawn a fresh-context subagent with role `explorer`.
Pass it inputs:
  topic        = <topic name, e.g. "world-state">
  intent       = <copy of intent>
  scope        = <topic-specific scope; explorer's role definition explains what it expects>
  workingDir   = <path>
  implStateDir = <path, read-only>
  outputPath   = workingDir/.orient/<topic>.json
  msUntilEndTs = <current value>
The subagent will load its `explorer` role definition, gather, write findings, return a summary.
```

Spawn explorers in parallel if your harness supports it; otherwise spawn sequentially. The explorers themselves do not spawn further agents (no nesting).

## Collate

After all explorers return, read each `workingDir/.orient/<topic>.json` and write `workingDir/.orient/summary.json`:

```json
{
  "intent": { "id": "...", "kind": "...", "window": { "startTs": 0, "endTs": 0 } },
  "topics": [
    { "topic": "intent-parse", "artifact": "workingDir/.orient/intent-parse.json", "summary": "...", "flags": [] },
    { "topic": "world-state", "artifact": "workingDir/.orient/world-state.json", "summary": "...", "flags": ["stale"] }
  ],
  "openQuestions": ["string — anything Strategize needs to know was uncertain or unavailable"]
}
```

Return to the coordinator: a one-paragraph summary and the path to `summary.json`.

## Boundaries

- Do not pick an approach — Strategize's job
- Do not write a plan — Plan's job
- Do not execute work — Execute's job
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.1.
````

- [ ] **Step 2: Write `agents/explorer.md`**

`client/plugins/default-learner/agents/explorer.md`:

````markdown
---
name: explorer
description: Generic info-gathering subagent. Spawned by orient or debrief skills with a topic + scope. Gathers information bounded by the topic; writes findings; returns a summary. Does not spawn further agents.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Explorer (subagent role)

You are a fresh-context info-gatherer. The phase skill that spawned you has handed you a topic and a scope. Your job is to gather information about that topic and report findings.

## Inputs (from your spawn prompt)

- `topic` — string label (e.g., "intent-parse", "world-state", "own-history", "others-history", or a debrief-specific topic)
- `intent` — the restoration intent (read-only)
- `scope` — topic-specific scope description: what to look at, what to ignore, what depth
- `workingDir` — path; you write to `outputPath` only, which lives under `workingDir/.<phase>/`
- `implStateDir` — path; read-only
- `outputPath` — exact path to write your findings JSON to
- `msUntilEndTs` — your time budget

## Topic conventions

- **intent-parse** — extract id, kind, window timestamps, spec details, eligibility constraints. Output is purely structural — the parsed intent plus any normalized flags.
- **world-state** — call the kind's tools (HL, Polymarket, on-chain, etc.) to fetch current state. Include a snapshot timestamp. Be conservative on volume.
- **own-history** — read `implStateDir/runs/index.json` if present, otherwise call the harness's knowledge-tree query for past runs of this kind by this operator. Note success/failure trends.
- **others-history** — call the harness's knowledge-tree query for runs of this kind by other operators. Annotate evidence tier per envelope.
- (debrief-specific topics) — outcome-probe, cross-operator-comparison, divergence-attribution; the spawning skill describes the scope.

## What you do

1. Parse the inputs.
2. Gather only the data the topic + scope describe.
3. Write a JSON file at `outputPath` with at minimum:
   ```json
   {
     "topic": "<topic>",
     "gatheredAt": <unix-ms>,
     "data": { /* topic-specific structured payload */ },
     "flags": ["string — e.g., 'stale', 'partial', 'access-denied'"]
   }
   ```
4. Return a structured summary to the spawning skill: `{ summary: '<one sentence>', artifactPath: '<outputPath>', flags: ['...'] }`.

## Boundaries

- Do not spawn other subagents — you are one level below the main session; further nesting is not supported.
- Do not modify `implStateDir`.
- Do not write outside `outputPath`.
- Do not exceed the topic's scope.
- Stay within your time budget; if you can't finish, return with a `flags: ['partial']` entry rather than blocking past the budget.

## Cross-reference

Spec: §4.1 (orient), §4.5 (debrief).
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/orient/SKILL.md client/plugins/default-learner/agents/explorer.md
git commit -m "feat(default-learner): orient skill + explorer agent"
```

---

## Task 5: Strategize skill + strategist agent

**Files:**
- Create: `client/plugins/default-learner/skills/strategize/SKILL.md`
- Create: `client/plugins/default-learner/agents/strategist.md`

- [ ] **Step 1: Write `strategize/SKILL.md`**

`client/plugins/default-learner/skills/strategize/SKILL.md`:

````markdown
---
name: strategize
description: Use when the coordinator reaches the Strategize phase. Launch one strategist subagent with the Orient summary; receive a strategy + constitution; persist them under workingDir/.strategize/.
allowed-tools: Bash, Read, Write, Agent
---

# Strategize skill

Launch the strategist; persist its outputs.

## Inputs

- `workingDir/.orient/summary.json` (and per-topic files for context)
- `implStateDir/strategies/<kind>/` if any prior promoted strategies exist
- The intent

## Launch the strategist

```
Use the Agent tool to spawn a fresh-context subagent with role `strategist`.
Pass it inputs:
  intent                 = <copy of intent>
  orientSummaryPath      = workingDir/.orient/summary.json
  priorStrategiesPath    = implStateDir/strategies/<kind>/   (or null if absent)
  workingDir             = <path>
  implStateDir           = <path, read-only>
  outputDir              = workingDir/.strategize/
  skillBundleCid         = <from coordinator boot>
  implStateDirShaAtStart = <from coordinator boot>
  msUntilEndTs           = <current value>
The subagent loads its `strategist` role, does the divergent/convergent
selection, and writes strategy.json + constitution.json. Return its summary.
```

## After it returns

Verify both files exist:
- `workingDir/.strategize/strategy.json`
- `workingDir/.strategize/constitution.json`

If either is missing, write `workingDir/.errors/strategize.json` with the failure context and abort.

Return to the coordinator: a one-paragraph summary of the chosen approach + success criteria + timing posture, plus paths to both files.

## Boundaries

- Do not generate the strategy yourself — that's the strategist agent's job in fresh context
- Do not modify `implStateDir`
- Never run a second strategist after the first has committed (no re-strategizing mid-run)

## Cross-reference

Spec: §4.2, §10.
````

- [ ] **Step 2: Write `agents/strategist.md`**

`client/plugins/default-learner/agents/strategist.md`:

````markdown
---
name: strategist
description: Specialized fresh-context subagent for Strategize. Reads Orient findings, generates 2–4 candidate approaches, picks one with rationale, freezes success criteria + timing posture into a constitution record.
allowed-tools: Bash, Read, Write
---

# Strategist (subagent role)

You commit to one approach for this run. Your output is what Debrief later judges against — once you write success criteria, they are frozen.

## Inputs (from your spawn prompt)

- `intent`
- `orientSummaryPath` — read this for context
- `priorStrategiesPath` — read if non-null for prior promoted strategies for this kind
- `workingDir`, `implStateDir` (read-only)
- `outputDir` — write strategy.json + constitution.json here
- `skillBundleCid`, `implStateDirShaAtStart` — for the constitution
- `msUntilEndTs`

## Diverge

Generate 2–4 candidate approaches given the Orient findings. For each, name:

- The angle (one sentence)
- What success looks like
- What could go wrong
- The timing posture this approach implies

## Converge

Pick one. Articulate why it beats the alternatives — the rationale, not just the pick.

## Freeze invariants

Write `<outputDir>/strategy.json`:

```json
{
  "approach": "string — chosen approach, descriptive",
  "rationale": "string — why this beats alternatives",
  "successCriteria": "string — concrete 'success if X' statement",
  "timingPosture": "early-return | hold-and-revise | continuous-observation",
  "constraints": ["string", "..."],
  "rejectedAlternatives": [
    { "approach": "string", "reason": "string" }
  ]
}
```

Compute the success-criteria CID:

```bash
SUCCESS_CID="sha256:$(printf '%s' '<successCriteria>' | sha256sum | cut -d' ' -f1)"
```

Write `<outputDir>/constitution.json`:

```json
{
  "successCriteriaCid": "<SUCCESS_CID>",
  "timingPosture": "<from strategy.json>",
  "skillBundleCid": "<from input>",
  "implStateDirSha": "<implStateDirShaAtStart from input>",
  "editableScope": ["<implStateDir>/**", "<workingDir>/**"]
}
```

Return to your spawning skill: a one-paragraph summary of the chosen approach, success criteria, and timing posture.

## Timing postures

- `early-return` — finish work and exit before window end. Default for kinds where late information doesn't help.
- `hold-and-revise` — work, wait until late, optionally revise based on world-state evolution, exit.
- `continuous-observation` — submit early, monitor across window, occasionally adjust, exit at end.

## Boundaries

- Do not gather more info — Orient already did
- Do not detail per-step actions — Plan does that
- Do not modify `implStateDir`
- Do not spawn further subagents

## Cross-reference

Spec: §4.2, §10.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/strategize/SKILL.md client/plugins/default-learner/agents/strategist.md
git commit -m "feat(default-learner): strategize skill + strategist agent"
```

---

## Task 6: Plan skill + planner agent

**Files:**
- Create: `client/plugins/default-learner/skills/plan/SKILL.md`
- Create: `client/plugins/default-learner/agents/planner.md`

- [ ] **Step 1: Write `plan/SKILL.md`**

`client/plugins/default-learner/skills/plan/SKILL.md`:

````markdown
---
name: plan
description: Use when the coordinator reaches the Plan phase. Launch one planner subagent with the strategy; receive the plan; persist it under workingDir/.plan/.
allowed-tools: Bash, Read, Write, Agent
---

# Plan skill

Launch the planner; persist its output.

## Inputs

- `workingDir/.strategize/strategy.json`
- `workingDir/.orient/summary.json` for grounding
- `implStateDir/plans/<kind>/` if any prior promoted plan templates
- The intent

## Launch the planner

```
Use the Agent tool to spawn a fresh-context subagent with role `planner`.
Pass it inputs:
  intent              = <copy of intent>
  strategyPath        = workingDir/.strategize/strategy.json
  orientSummaryPath   = workingDir/.orient/summary.json
  priorPlanTemplatesPath = implStateDir/plans/<kind>/ (or null)
  workingDir          = <path>
  implStateDir        = <path, read-only>
  outputPath          = workingDir/.plan/plan.json
  msUntilEndTs        = <current value>
```

## After it returns

Verify `workingDir/.plan/plan.json` exists. If not, write `workingDir/.errors/plan.json` and abort.

Return to the coordinator: a one-line summary ("plan with N steps, M parallel batches, K wait checkpoints") and the path to `plan.json`.

## Boundaries

- Do not change success criteria or timing posture — frozen in Strategize
- Do not execute — Execute does that
- Do not modify `implStateDir`

## Cross-reference

Spec: §4.3, §5.
````

- [ ] **Step 2: Write `agents/planner.md`**

`client/plugins/default-learner/agents/planner.md`:

````markdown
---
name: planner
description: Specialized fresh-context subagent for Plan. Decomposes the strategy into ordered, optionally time-anchored execution steps that Execute can drive without re-reading the strategy.
allowed-tools: Bash, Read, Write
---

# Planner (subagent role)

Turn the strategy into concrete steps Execute can follow.

## Inputs (from your spawn prompt)

- `intent`
- `strategyPath` — read for chosen approach + success criteria + timing posture + constraints
- `orientSummaryPath` — read for grounding
- `priorPlanTemplatesPath` — read if non-null
- `workingDir`, `implStateDir` (read-only)
- `outputPath` — write plan.json here
- `msUntilEndTs`

## Decompose

Each step must be specific enough that a `step-worker` subagent can carry it out with no other context. For each step include:

- Unique step id (`step-1`, `step-2`, ...)
- `kind`: `work` or `wait`
- `concurrency`: `sequential` or `parallel-batch-A` (parallel steps with the same batch label run concurrently)
- Brief description (one sentence)
- Inputs the worker reads (paths or structured payloads)
- Tools / MCPs the worker needs
- Expected outputs (paths under `workingDir/`)
- Success signal — how the orchestrator knows this step succeeded
- Abort/recovery condition

For `hold-and-revise` or `continuous-observation` postures, include `wait`-kind steps where appropriate:

```json
{ "id": "step-3", "kind": "wait", "durationMs": 7200000, "untilTs": null, "condition": null }
```

## Output

Write `<outputPath>`:

```json
{
  "successCriteria": "<copied from strategy.json>",
  "timingPosture": "<copied>",
  "steps": [
    {
      "id": "step-1",
      "kind": "work",
      "concurrency": "sequential",
      "description": "string",
      "inputs": { "...": "..." },
      "toolsNeeded": ["string", "..."],
      "expectedOutputs": ["workingDir/<path>", "..."],
      "successSignal": "string — what proves this step succeeded",
      "abortCondition": "string — when to give up"
    },
    {
      "id": "step-2",
      "kind": "wait",
      "concurrency": "sequential",
      "durationMs": 7200000
    }
  ]
}
```

For wait-kind steps, only the wait fields are required.

Return to your spawning skill: a one-line summary plus the path to plan.json.

## Boundaries

- Do not change success criteria or timing posture
- Do not execute steps
- Do not modify `implStateDir`
- Do not spawn further subagents

## Cross-reference

Spec: §4.3, §5.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/plan/SKILL.md client/plugins/default-learner/agents/planner.md
git commit -m "feat(default-learner): plan skill + planner agent"
```

---

## Task 7: Execute skill + step-worker agent

**Files:**
- Create: `client/plugins/default-learner/skills/execute/SKILL.md`
- Create: `client/plugins/default-learner/agents/step-worker.md`

- [ ] **Step 1: Write `execute/SKILL.md`**

`client/plugins/default-learner/skills/execute/SKILL.md`:

````markdown
---
name: execute
description: Use when the coordinator reaches the Execute phase. Walk the plan, launch one step-worker subagent per work step, honor wait steps, decide at runtime when stuck.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# Execute skill

Walk the plan and drive it. Workers are spawned by you (the coordinator session via this skill); they do not nest further.

## Inputs

- `workingDir/.plan/plan.json` — the steps
- `workingDir/.strategize/strategy.json` — success criteria + timing posture
- `workingDir/.orient/summary.json` — grounding
- The intent + window + remaining time budget

## Walk the plan

For each step in order, respecting `concurrency` markings:

### Work steps

Spawn a `step-worker` subagent via the Agent tool:

```
Use the Agent tool to spawn a fresh-context subagent with role `step-worker`.
Pass it inputs:
  stepSpec     = <the entire step object from plan.json>
  intent       = <copy of intent>
  workingDir   = <path>
  implStateDir = <path, read-only>
  msUntilEndTs = <current value>
```

For parallel-batch steps (steps sharing a `concurrency: parallel-batch-X` label), spawn the whole batch concurrently if your harness supports it; wait for all to return before advancing.

After a worker returns:
- Check the `successSignal` from the step spec — did the step succeed?
- If yes: append to `workingDir/.execute/log.jsonl` and advance.
- If no: see "When stuck."

### Wait steps

Use the harness's wait primitive (Claude Code: `Monitor`; Pi.dev: equivalent). Honor `durationMs`, `untilTs`, and `condition`. The abort signal from the daemon (`window.endTs`) overrides any wait.

### When stuck

When a step fails its success signal or a worker returns without expected outputs, judge:

- **Continue** — accept partial; advance.
- **Retry-step** — spawn a fresh worker for the same step. Cap at 2 retries unless step `abortCondition` says otherwise.
- **Replan** — load the `plan` skill via `Skill plan` again with the failure as added context, write the new plan to a versioned path (`workingDir/.plan/plan-v2.json`), continue Execute on the new plan.
- **Abort** — write `workingDir/.errors/execute.json` with failure context; exit Execute. Coordinator continues to Debrief / Improve / Memory consolidation so partial work is harvested.

Explain your judgment in `workingDir/.execute/log.jsonl`.

## Outputs

Throughout the phase:
- `workingDir/.execute/log.jsonl` — one entry per step boundary: `{ ts, stepId, decision, summary, retryCount }`
- Per-step outputs as the plan declared

At end:
- `workingDir/.execute/summary.json`:
  ```json
  {
    "stepsCompleted": ["step-1", "step-2"],
    "stepsFailed": [],
    "decisions": ["continue", "retry-step", "continue"],
    "elapsedMs": 0,
    "returnReason": "all-steps-completed | hold-and-revise-window-end | abort"
  }
  ```

## Boundaries

- Do not invoke Strategize — strategy is frozen
- Do not write to `implStateDir` — Improve does that
- Do not run Debrief / Improve / Memory consolidation — coordinator does that next
- Do not call wait for arbitrarily long with no plan justification
- Do not spawn agents that themselves spawn agents (your workers are one level deep)

## Cross-reference

Spec: §4.4, §5.
````

- [ ] **Step 2: Write `agents/step-worker.md`**

`client/plugins/default-learner/agents/step-worker.md`:

````markdown
---
name: step-worker
description: Specialized fresh-context subagent for one Execute plan step. Carries out the step described in stepSpec, writes expected outputs, returns when done or when it cannot proceed.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Step-worker (subagent role)

You execute one plan step. Fresh context. Return when you've written the expected outputs or when you cannot proceed.

## Inputs (from your spawn prompt)

- `stepSpec` — the entire step object from plan.json
- `intent` — for context
- `workingDir`, `implStateDir` (read-only)
- `msUntilEndTs`

## What you do

1. Read `stepSpec.description` and `stepSpec.inputs`. Do not re-read `plan.json` — the orchestrator gave you everything you need.
2. Use the tools listed in `stepSpec.toolsNeeded`. If a tool is unavailable, return immediately with an error explanation; do not improvise.
3. Write the outputs listed in `stepSpec.expectedOutputs`. Each is a path under `workingDir/`.
4. Check yourself against `stepSpec.successSignal`. Did your work satisfy it? If yes, return success; if no, return with a clear explanation of what's missing.

## Return shape

Return a structured summary to the orchestrator:

```json
{
  "stepId": "<from stepSpec.id>",
  "status": "success | partial | failed",
  "outputsWritten": ["workingDir/<path>", "..."],
  "summary": "string — one sentence",
  "blockers": ["string — if status != success, what's missing"]
}
```

## Boundaries

- Do not modify `implStateDir`
- Do not spawn further subagents
- Do not do work outside `stepSpec` — if you think additional work is needed, return with a `partial` status and explain
- Stay within your time budget; if you can't finish, return `partial` rather than blocking past the budget

## Cross-reference

Spec: §4.4.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/execute/SKILL.md client/plugins/default-learner/agents/step-worker.md
git commit -m "feat(default-learner): execute skill + step-worker agent"
```

---

## Task 8: Debrief skill + analyst agent

**Files:**
- Create: `client/plugins/default-learner/skills/debrief/SKILL.md`
- Create: `client/plugins/default-learner/agents/analyst.md`

- [ ] **Step 1: Write `debrief/SKILL.md`**

`client/plugins/default-learner/skills/debrief/SKILL.md`:

````markdown
---
name: debrief
description: Use when the coordinator reaches the Debrief phase. Optionally launch explorer subagents for cross-operator / outcome reads, then launch one analyst subagent with all evidence to produce the analysis Improve consumes.
allowed-tools: Bash, Read, Write, Agent
---

# Debrief skill

Mirrors Orient — gather + sense-make in hindsight. You may launch explorers (for cross-operator reads or fresh world-state probes) and always launch the analyst.

## Inputs

- All `workingDir/.<prior-phase>/` outputs through Execute
- Strategy + constitution from `workingDir/.strategize/`
- Plan from `workingDir/.plan/`
- `implStateDir/runs/` for own history
- The intent

## Optional: launch explorers

If the operator's policy enables cross-operator reads or fresh-world-state probes, spawn `explorer` subagents in parallel for each post-execution topic:

- `outcome-probe` — re-pull venue / market / on-chain state to see post-execution outcome
- `cross-operator-comparison` — knowledge-tree query for similar runs by other operators (only if policy allows)

Same Agent-tool spawn pattern as Orient. Outputs land under `workingDir/.debrief/<topic>.json`.

## Launch the analyst

```
Use the Agent tool to spawn a fresh-context subagent with role `analyst`.
Pass it inputs:
  intent             = <copy of intent>
  strategyPath       = workingDir/.strategize/strategy.json
  constitutionPath   = workingDir/.strategize/constitution.json
  planPath           = workingDir/.plan/plan.json
  executeSummaryPath = workingDir/.execute/summary.json
  executeLogPath     = workingDir/.execute/log.jsonl
  orientSummaryPath  = workingDir/.orient/summary.json
  debriefExplorerPaths = [workingDir/.debrief/<topic>.json, ...]
  ownHistoryPath     = implStateDir/runs/index.json (or null)
  workingDir         = <path>
  implStateDir       = <path, read-only>
  outputPath         = workingDir/.debrief/analysis.json
  msUntilEndTs       = <current value>
The subagent loads its `analyst` role and writes analysis.json. Return its summary.
```

## After it returns

Verify `workingDir/.debrief/analysis.json` exists. If not, write `workingDir/.errors/debrief.json` and abort.

Return to the coordinator: a one-paragraph plain-English summary plus the path to `analysis.json`.

## Boundaries

- Do not change success criteria — frozen in Strategize
- Do not modify `implStateDir` — Improve does that
- Do not invent recommendations — every recommendation must be grounded in the evidence

## Cross-reference

Spec: §4.5.
````

- [ ] **Step 2: Write `agents/analyst.md`**

`client/plugins/default-learner/agents/analyst.md`:

````markdown
---
name: analyst
description: Specialized fresh-context subagent for Debrief. Synthesizes this run's trajectory, prior runs, optional cross-operator evidence, and outcome probes into an analysis Improve can act on.
allowed-tools: Bash, Read, Write
---

# Analyst (subagent role)

Produce an analysis Improve can act on. Cover four things.

## Inputs (from your spawn prompt)

All paths listed in the Debrief skill's spawn-input block. Read them.

## What to cover

1. **Did this run meet its success criteria?** Compare execute outputs against `successCriteria` from `strategy.json`. Yes / no / partial. If partial, where did it fall short?
2. **Where did execution diverge from plan, and why?** Walk `executeLogPath`. For each retry / replan / abort decision, attribute the cause: prompt, tool choice, delegation, model, context, plan-wrong, world-state-changed.
3. **What signals from others' runs are relevant?** Read explorer outputs if present. Are others doing this kind successfully with a different approach? Are there patterns in the attested-tier corpus that suggest this run's approach was suboptimal?
4. **Trend — is this operator improving?** Read `ownHistoryPath`. Compare the last 5–10 runs by this operator for this kind. Trending up, flat, down? Note any specific kind+intent shape this operator does poorly on.

## Output

Write `<outputPath>`:

```json
{
  "successCriteriaMet": "yes | no | partial",
  "successCriteriaShortfall": "string — null if met",
  "divergencesFromPlan": [
    {
      "stepId": "step-3",
      "what": "string",
      "attributedCause": "prompt | tool-choice | delegation | model | context | plan-wrong | world-state-changed",
      "evidence": "string"
    }
  ],
  "crossOperatorSignals": [
    {
      "envelopeCid": "...",
      "tier": "attested | committed | self-signed",
      "lesson": "string"
    }
  ],
  "trend": {
    "kind": "...",
    "lastNRuns": 10,
    "passRate": 0.6,
    "direction": "improving | flat | declining",
    "notableFailureShapes": ["string", "..."]
  },
  "recommendationsForImprove": [
    "string — concrete suggestion (e.g. 'add a retry-on-stale-quote skill', 'tighten the slippage threshold in workflow.yaml')"
  ]
}
```

Return to the spawning skill: a one-paragraph plain-English summary plus the path to analysis.json.

## Boundaries

- Do not change `successCriteria`
- Do not modify `implStateDir`
- Do not spawn further subagents
- Do not invent recommendations not grounded in the evidence

## Cross-reference

Spec: §4.5.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/debrief/SKILL.md client/plugins/default-learner/agents/analyst.md
git commit -m "feat(default-learner): debrief skill + analyst agent"
```

---

## Task 9: Improve skill + promoter agent

**Files:**
- Create: `client/plugins/default-learner/skills/improve/SKILL.md`
- Create: `client/plugins/default-learner/agents/promoter.md`

- [ ] **Step 1: Write `improve/SKILL.md`**

`client/plugins/default-learner/skills/improve/SKILL.md`:

````markdown
---
name: improve
description: Use when the coordinator reaches the Improve phase. Launch one promoter subagent with the analysis; commit each accepted mutation to implStateDir as a separate git commit; emit promotion records.
allowed-tools: Bash, Read, Write, Edit, Agent
---

# Improve skill

Launch the promoter; commit its mutations. Changes take effect NEXT run.

## Inputs

- `workingDir/.debrief/analysis.json`
- `implStateDir/policy.json` if present (operator policy on what Improve may touch)
- `implStateDir/` (current durable self)

## Launch the promoter

```
Use the Agent tool to spawn a fresh-context subagent with role `promoter`.
Pass it inputs:
  analysisPath       = workingDir/.debrief/analysis.json
  policyPath         = implStateDir/policy.json (or null)
  implStateDir       = <path, read-write for the promoter>
  workingDir         = <path>
  outputDir          = workingDir/.improve/
  msUntilEndTs       = <current value>
The promoter writes mutations directly into implStateDir, commits each as
a separate git commit (the session-start hook configured the author
identity already), and writes one promotion_record per mutation under
workingDir/.improve/promotions/.
```

## After it returns

Read `workingDir/.improve/summary.json`. Verify:
- `implStateDirShaAfter` matches `git -C <implStateDir> rev-parse HEAD`
- One `promotion_record` per accepted change
- Operator-access requests under `workingDir/.operator-requests/` if any

If anything is inconsistent, write `workingDir/.errors/improve.json` and abort.

Return to the coordinator: a one-paragraph summary of what changed (or didn't) and why.

## Boundaries

- Do not pre-judge what to mutate — that's the promoter's reasoning
- Do not commit yourself — the promoter commits as it goes
- Do not modify anything outside `workingDir/.improve/` from this skill

## Cross-reference

Spec: §4.6, §6.2, §6.4, §7.
````

- [ ] **Step 2: Write `agents/promoter.md`**

`client/plugins/default-learner/agents/promoter.md`:

````markdown
---
name: promoter
description: Specialized fresh-context subagent for Improve. Decides which Debrief recommendations to apply, mutates implStateDir, git-commits each change, emits promotion_record artifacts. Changes take effect next run.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Promoter (subagent role)

Act on Debrief by mutating `implStateDir`. Each accepted change is one git commit.

**Critical:** changes take effect on the **next run**. Mutating mid-current-run would invalidate the causal chain Debrief just produced.

## Inputs (from your spawn prompt)

- `analysisPath` — read for recommendations + trend
- `policyPath` — read if non-null for operator policy
- `implStateDir` — your write target; git repo with `default-learner` author identity already configured
- `outputDir` — write summary + promotion records here
- `msUntilEndTs`

## Action surface (in increasing risk order)

1. **Skill edits** — modify `implStateDir/skills/<name>/SKILL.md`
2. **Hook edits** — modify `implStateDir/hooks/*.sh`
3. **Tool config edits** — modify `implStateDir/configs/<name>.json`
4. **New skills / hooks / configs** — add files
5. **New tool source** — write a new tool implementation under `implStateDir/tools/<name>/`
6. **Operator-access requests** — emit deferred artifacts under `workingDir/.operator-requests/<name>.json` describing things you'd like the operator to provide. Never blocks.
7. **Harness install patches** — only if `policy.json` allows AND the harness adapter permits. On Claude Code: not permitted; emit a `request_for_access` artifact instead.

Anywhere outside `implStateDir/**` and `workingDir/.improve|operator-requests/` is forbidden.

## What you do

For each Debrief recommendation:

1. Decide: accept or reject. Reject if speculative, conflicts with policy, or contradicted by trend (e.g., a recently reverted promotion).
2. For accepted changes, make the change (edit / write the file).
3. Stage and commit:
   ```bash
   cd "$IMPL_STATE_DIR"
   git add -A
   git diff --cached --quiet || git commit -m "improve: <one-line description>

   Run: <intent.id>
   Cause: <attributed cause from analysis>
   Recommendation: <short pointer into analysis>" --quiet
   ```
4. Record `<outputDir>/promotions/<n>.json`:
   ```json
   {
     "ts": <unix-ms>,
     "implStateDirShaBefore": "<from prior commit / git log -1 --skip=1 HEAD>",
     "implStateDirShaAfter": "<git rev-parse HEAD post-commit>",
     "changeKind": "skill-edit | hook-edit | config-edit | new-skill | new-tool | operator-request",
     "target": "implStateDir/<path> | workingDir/.operator-requests/<name>.json",
     "summary": "string",
     "analysisSource": "string — pointer into analysis.json"
   }
   ```

One commit per logical change so `git log` and `git revert` operate cleanly.

## Operator-access requests

Format under `workingDir/.operator-requests/<short-name>.json`:

```json
{
  "ts": <unix-ms>,
  "what": "string — what's needed",
  "why": "string — analysis grounding",
  "howToGrant": "string — concrete steps for the operator",
  "blocksKinds": ["portfolio.v0"]
}
```

## Final summary

After all decisions, write `<outputDir>/summary.json`:

```json
{
  "implStateDirShaBefore": "<at start>",
  "implStateDirShaAfter": "<at end>",
  "changesAccepted": <count>,
  "changesRejected": <count>,
  "operatorRequests": <count>,
  "rejectionsRationale": [{ "recommendation": "string", "reason": "string" }]
}
```

Return to the spawning skill: one paragraph of what changed (or didn't) and why.

## Boundaries

- Never write outside `implStateDir/**` (except `<outputDir>` and `workingDir/.operator-requests/`)
- Never accept a change the trend signal contradicts
- Never spawn further subagents
- Never modify the analysis itself

## Cross-reference

Spec: §4.6, §6.2, §6.4, §7.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/improve/SKILL.md client/plugins/default-learner/agents/promoter.md
git commit -m "feat(default-learner): improve skill + promoter agent"
```

---

## Task 10: Memory consolidation skill + consolidator agent

**Files:**
- Create: `client/plugins/default-learner/skills/memory-consolidation/SKILL.md`
- Create: `client/plugins/default-learner/agents/consolidator.md`

- [ ] **Step 1: Write `memory-consolidation/SKILL.md`**

`client/plugins/default-learner/skills/memory-consolidation/SKILL.md`:

````markdown
---
name: memory-consolidation
description: Use when the coordinator reaches the Memory consolidation phase. Launch one consolidator subagent that curates implStateDir (prune unused, revert regressions) and workingDir (set public/private boundary); commits durable curation as one separate commit.
allowed-tools: Bash, Read, Write, Edit, Agent
---

# Memory consolidation skill

Launch the consolidator; verify outputs.

## Inputs

- `workingDir/.debrief/analysis.json` (trend signals, regression flags)
- `workingDir/.improve/summary.json` + `promotions/` (Improve's mutations)
- `implStateDir/` and `workingDir/` (full)
- `implStateDir/policy.json` (retention rules, size caps)

## Launch the consolidator

```
Use the Agent tool to spawn a fresh-context subagent with role `consolidator`.
Pass it inputs:
  analysisPath        = workingDir/.debrief/analysis.json
  improveSummaryPath  = workingDir/.improve/summary.json
  improvePromotionsDir = workingDir/.improve/promotions/
  policyPath          = implStateDir/policy.json (or null)
  implStateDir        = <path, read-write>
  workingDir          = <path, read-write>
  outputPath          = workingDir/.memory-consolidation/consolidation_record.json
  msUntilEndTs        = <current value>
The consolidator does both workstreams (durable + ephemeral), writes a
single git commit on implStateDir for the durable curation, and produces
the consolidation_record.
```

## After it returns

Verify the consolidation_record exists and `implStateDirShaAfter` matches `git -C <implStateDir> rev-parse HEAD`.

Return to the coordinator: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or analysis

## Cross-reference

Spec: §4.7, §6.1.
````

- [ ] **Step 2: Write `agents/consolidator.md`**

`client/plugins/default-learner/agents/consolidator.md`:

````markdown
---
name: consolidator
description: Specialized fresh-context subagent for Memory consolidation. Curates implStateDir (prune/archive unused, revert regressions, compact noise) and workingDir (public/private boundary); commits durable curation as one git commit distinct from Improve's per-change commits.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Consolidator (subagent role)

Two workstreams. One git commit on `implStateDir` at the end.

## Inputs (from your spawn prompt)

All paths listed in the memory-consolidation skill's spawn-input block. Read them.

## Workstream 1 — Curate durable self (`implStateDir`)

- **Unused skills / hooks / tools** — anything not invoked in the last N runs (default 20; check policy override). Move to `implStateDir/.archive/<ts>/` or delete per policy.
- **Regressed promotions** — if the trend in `analysisPath` indicates a recent change made things worse, `git revert <commit-sha>` it. Be specific: revert the exact commit identified, not a bulk rollback.
- **Noisy notes / records** — if `implStateDir/notes/` has accumulated more than `policy.maxNotesBytes` (default 1 MB), keep the last 50 by mtime, archive the rest.
- **Conflicts between recent promotions** — Improve may have promoted two skills with conflicting prompts. Detect and resolve (favor newer; flag conflict in the output record).

After all durable curation, commit ONE consolidation commit:

```bash
cd "$IMPL_STATE_DIR"
git add -A
git diff --cached --quiet || git commit -m "consolidate: <one-line summary>

Pruned: <n> | Reverted: <n> | Compacted: <n> | Conflicts resolved: <n>

Run: <intent.id>" --quiet
```

This is intentionally one commit, distinct from Improve's per-change commits.

## Workstream 2 — Curate ephemeral run (`workingDir`)

Set the public/private boundary that the engine's `walkArtifacts` will respect:

- **Declared kind outputs** — must remain at the harvestable paths the kind contract expects (don't move).
- **Per-phase artifacts** under `workingDir/.<phase>/` — generally harvestable as trajectory signal; can stay.
- **Session transcripts containing operator-private reasoning** — move under `workingDir/.private/<phase>/` or migrate to `implStateDir/transcripts/<runId>/`.
- **Operator-requests** under `workingDir/.operator-requests/` — operator-private, never delivery; move to `implStateDir/operator-requests/<runId>/`.
- **Errors** under `workingDir/.errors/` — keep public (buyers benefit from honest failure signal).

## Output

Write `<outputPath>`:

```json
{
  "ts": <unix-ms>,
  "implStateDirShaBefore": "<from improveSummaryPath>",
  "implStateDirShaAfter": "<git rev-parse HEAD post-consolidation-commit>",
  "durable": {
    "skillsArchived": ["string", "..."],
    "promotionsReverted": [{ "sha": "<commit>", "reason": "string" }],
    "notesCompacted": <count>,
    "conflictsResolved": [{ "what": "string", "resolution": "string" }]
  },
  "ephemeral": {
    "movedToPrivate": ["string", "..."],
    "migratedToImplState": ["string", "..."]
  }
}
```

Return to the spawning skill: a one-paragraph summary.

## Boundaries

- Do not promote new content — Improve already did
- Do not modify success criteria, plan, or Debrief output
- Do not delete declared kind outputs from `workingDir`
- Do not git-commit anything that wasn't in either Improve's mutation set or this consolidation's curation set
- Do not spawn further subagents

## Cross-reference

Spec: §4.7, §6.1.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/adrianobradley/harbor/jinn-learner
git add client/plugins/default-learner/skills/memory-consolidation/SKILL.md client/plugins/default-learner/agents/consolidator.md
git commit -m "feat(default-learner): memory-consolidation skill + consolidator agent"
```

---

## Task 11: Acceptance — run validator + manual review

**Files:** none new

- [ ] **Step 1: Run the validator**

```bash
cd /Users/adrianobradley/harbor/jinn-learner/client
yarn validate-plugin
```

Expected: `OK — 8 skills, 7 agents, hook + loaders validated`

If anything fails, fix the offending file and re-run.

- [ ] **Step 2: Sanity-check the cross-references manually**

Open each skill SKILL.md and verify:
- The Agent-tool spawn block names the correct agent role (e.g., orient → explorer, strategize → strategist).
- The input paths the skill passes match the input names the agent's role definition expects.
- Each skill's outputs feed cleanly into the next skill's inputs.

Open each agent .md and verify:
- The frontmatter `name` matches the filename stem.
- The "Inputs" section names every input the spawning skill passes.
- The "Boundaries" section forbids spawning further subagents.

- [ ] **Step 3: Walk the bundle as if running an intent**

Mentally simulate running an intent end-to-end:
1. Daemon dispatches → coordinator boots → captures shas
2. coordinator → Skill orient → orient skill spawns explorer per topic → collates summary.json
3. coordinator → Skill strategize → strategize skill spawns strategist → strategy.json + constitution.json
4. coordinator → Skill plan → plan skill spawns planner → plan.json
5. coordinator → Skill execute → execute skill walks plan, spawns step-worker per step → execute outputs
6. coordinator → Skill debrief → debrief skill optionally spawns explorers + spawns analyst → analysis.json
7. coordinator → Skill improve → improve skill spawns promoter → mutations + commits + promotion_records
8. coordinator → Skill memory-consolidation → spawns consolidator → consolidation_record + commit
9. coordinator returns → daemon harvests workingDir

Confirm the artifact paths and structured handoffs flow without gaps.

- [ ] **Step 4: No commit needed for this acceptance task**

Acceptance is verification-only. Move to Plan 2.

---

## Plan acceptance

When all 11 tasks are committed:

- [ ] `cd client && yarn validate-plugin` returns `OK — 8 skills, 7 agents, hook + loaders validated`
- [ ] All 8 `client/plugins/default-learner/skills/<name>/SKILL.md` files exist with required frontmatter and bodies
- [ ] All 7 `client/plugins/default-learner/agents/<name>.md` files exist with required frontmatter and bodies
- [ ] `client/plugins/default-learner/hooks/session-start.sh` is executable, idempotent, and sets `default-learner` author identity
- [ ] `client/plugins/default-learner/scripts/validate-plugin.mjs` runs as a yarn script
- [ ] `client/plugins/default-learner/{README,CLAUDE,AGENTS}.md` describe install + components
- [ ] `client/package.json` `files` array includes `"plugins/"` so the bundle ships with the npm package
- [ ] No TypeScript was added; no entry in `buildRestorerImpls` was touched; daemon behavior is unchanged
- [ ] An operator can `cp -r client/plugins/default-learner/` into their harness's plugin/skill directory per the README, and a manual session-start of `coordinator` will follow the pipeline

---

## What Plan 2 will pick up

- TypeScript `RestorerImpl` shim (`client/src/restorer/impls/default-learner/restorer.ts`) — small, ~50–100 lines — that spawns the harness CLI with this plugin loaded and an initial prompt invoking `coordinator` with the intent + paths
- Per-harness shim variants (Claude Code first; Pi.dev later)
- Optional `jinn install-plugin <harness>` CLI command that does the `cp -r` for the operator
- Real OTel tracing integration if the harness exposes a tracer (the constitution span emission)

## What Plan 3 will pick up

- `buildRestorerImpls` registry wiring per spec §12 first-match-wrapper recommendation
- Portfolio.v0 end-to-end acceptance test on Anvil fork
- Replan-path acceptance test
- Out-of-scope-write block test
