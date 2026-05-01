# Plug-in surface — Path 1 mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Path 1 plug-in mechanism from `spec/2026-04-30-plug-in-surface.md` §4. Builders can publish a Path 1 plug-in (a markdown agent override, a topic explorer, an MCP tool, a skill bundle, a memory backend, or a hook) as an npm package; operators install it via `jinn plug-ins add @builder/<pkg>`; the `claude-code-learner` impl picks it up at session-start and routes it into the appropriate slot inside the seven-phase pipeline.

**Architecture:** Three layers, top-to-bottom:

1. **Manifest + loader (TS in `client/src/restorer/plug-ins/`)** — defines and validates `jinn-plugin.json`, reads `config.learnerPlugIns[]` at boot, resolves each entry to a normalized slot registry. The CLI (`jinn plug-ins list/add/remove/show`) edits config and runs install-time validation.
2. **Slot-registry hand-off (session-start hook update)** — the existing `claude-code-learner/hooks/session-start` script extends to write `workingDir/.coordinator/slots.json` from the daemon-supplied registry. Phase skills read that file and route around the bundled agent / topic / MCP / skill / memory / hook contributions.
3. **Slot integration points (per slot type)** — each of the six slot categories (phase-agent override, topic explorer, MCP tool, skill bundle, memory backend, hook) gets a minimal integration in the appropriate phase skill or at the harness adapter level. Worked examples are deferred to Plan 4.

**Tech Stack:** TypeScript 5, Node 22, Yarn 4 (workspace), vitest, ajv, JSON Schema 2020-12. Markdown phase-skill edits with YAML frontmatter (Claude Code skill format).

**Spec reference:** `spec/2026-04-30-plug-in-surface.md` §4 (Path 1 — contribute a plug-in into the `claude-code-learner` impl).

**Prerequisites (must be complete before this plan):**

- Plan 1 (`docs/superpowers/plans/2026-04-30-plug-in-surface-path-2-foundation.md`) — workspace root + SDK package + scaffolder infrastructure that Plan 3's `jinn create plug-in` extends.
- The branch this plan lands on **must contain both** the `spec/extension-model` work (this plan's parent) **and** the `claude-code-learner` plugin from main (commits `427a7151` rename + `afa991d5` scope-fix). On `spec/extension-model` alone the plugin directory `client/plugins/claude-code-learner/` is absent — extension-model branched at commit `6237288d` (the spec landing) before the plugin code shipped to main. **Task 1 of this plan performs the `git merge origin/main` as its first action**; Tasks 2–13 assume the merged tree.

**Existing codebase reference points (post-merge tree):**

- `client/plugins/claude-code-learner/.claude-plugin/plugin.json` — Claude Code plugin manifest (existing).
- `client/plugins/claude-code-learner/skills/coordinator/SKILL.md` — phase sequencer (existing); modified by Tasks 6, 7, 11.
- `client/plugins/claude-code-learner/skills/{orient,strategize,plan,execute,debrief,improve,memory-consolidation}/SKILL.md` — phase skills (existing); modified by Tasks 6 and 7.
- `client/plugins/claude-code-learner/hooks/session-start` — existing hook; modified by Task 5 (slot registry hand-off) and Task 12 (event surface).
- `client/plugins/claude-code-learner/agents/{analyst,consolidator,explorer,planner,promoter,step-worker,strategist}.md` — bundled agents (existing); reference shapes for phase-agent overrides.
- `client/src/restorer/impls/claude-code-learner/` — TypeScript shim (existing); modified by Tasks 3, 4, 9, 10.
- `client/src/cli/commands/` — CLI command pattern reference (existing); Task 6 adds `plug-ins.ts`.

---

## File structure

All paths relative to repo root.

### New files

```
client/
  schemas/
    jinn-plugin-v1.json                       ← Task 2 — JSON schema for jinn-plugin.json

  src/restorer/plug-ins/                      ← Tasks 2, 3, 4 — new module
    types.ts
    manifest.ts                                ← load + validate jinn-plugin.json
    registry.ts                                ← in-memory slot registry
    loader.ts                                  ← read config.learnerPlugIns + populate registry
    serialise.ts                               ← write registry to workingDir/.coordinator/slots.json
    index.ts

  src/cli/commands/
    plug-ins.ts                                ← Task 6 — jinn plug-ins list/add/remove/show

  templates/plug-in/                           ← Task 13 — scaffolder templates
    phase-agent-override/
      package.json.tmpl
      jinn-plugin.json.tmpl
      .claude-plugin/plugin.json.tmpl
      agents/<phase-agent>.md.tmpl
      test/manifest.test.ts.tmpl
      README.md.tmpl
      gitignore.tmpl
    topic-explorer/
      (same shape; agents/<explorer>.md.tmpl)
    mcp-tool/
      package.json.tmpl
      jinn-plugin.json.tmpl
      src/server.ts.tmpl
      test/server.test.ts.tmpl
      README.md.tmpl
      gitignore.tmpl
    skill-bundle/
      package.json.tmpl
      jinn-plugin.json.tmpl
      .claude-plugin/plugin.json.tmpl
      skills/<name>/SKILL.md.tmpl
      test/manifest.test.ts.tmpl
      README.md.tmpl
      gitignore.tmpl
    memory-backend/
      package.json.tmpl
      jinn-plugin.json.tmpl
      src/server.ts.tmpl                       ← MCP server exposing embed/query/prune
      test/server.test.ts.tmpl
      README.md.tmpl
      gitignore.tmpl
    hook/
      package.json.tmpl
      jinn-plugin.json.tmpl
      hooks/<event>.tmpl
      test/manifest.test.ts.tmpl
      README.md.tmpl
      gitignore.tmpl
```

### Modified files

- `client/src/restorer/impls/claude-code-learner/types.ts` — add slot-registry env hand-off field.
- `client/src/restorer/impls/claude-code-learner/restorer.ts` — call plug-in loader + serialise registry into `IntentSessionInputs`.
- `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts` — propagate slot registry path via env to the spawned harness.
- `client/plugins/claude-code-learner/hooks/session-start` — write `workingDir/.coordinator/slots.json` from `JINN_SLOT_REGISTRY_JSON` env var.
- `client/plugins/claude-code-learner/skills/coordinator/SKILL.md` — Boot section reads slots.json; extends hook event surface.
- `client/plugins/claude-code-learner/skills/{strategize,plan,execute,debrief,improve,memory-consolidation}/SKILL.md` — phase-agent override resolution (Task 7).
- `client/plugins/claude-code-learner/skills/orient/SKILL.md` — topic-explorer slot extension (Task 8), debrief gets the same treatment.
- `client/plugins/claude-code-learner/skills/debrief/SKILL.md` — topic-explorer extension (Task 8).
- `client/plugins/claude-code-learner/skills/memory-consolidation/SKILL.md` — memory-backend MCP routing (Task 11).
- `client/src/config.ts` — add `learnerPlugIns: ExternalPlugInEntry[]` field.
- `client/src/cli/command-registry.ts` — register `plug-ins` command.
- `client/src/cli/commands/create.ts` — extend with `jinn create plug-in <packageName> --slot=<type>`.

---

## Cross-task conventions

- **Manifest filename is `jinn-plugin.json`.** Lives at the package root alongside the existing `.claude-plugin/plugin.json` (Claude Code's manifest, unchanged).
- **CLI verb plurality.** `jinn plug-ins ...` (plural). Disambiguates from existing `jinn plugin install` (singular, AI-host MCP server install). The two commands surface separately in `jinn --help`.
- **Slot registry file location.** `workingDir/.coordinator/slots.json` is the canonical hand-off from daemon to phase skills. Phase skills read; never write.
- **Compatibility check.** Each plug-in declares `compatibility.claudeCodeLearner` as a semver range; the loader checks against the package's actual version (read from `client/plugins/claude-code-learner/.claude-plugin/plugin.json`). Out-of-range plug-ins are loaded with a warning, expected to break — not refused.
- **Slot routing rule (collisions).** If two installed plug-ins both declare a `phase-agent-override` for the same `(phase, agent, kind)` tuple, the loader picks the **last-installed** (later index in `config.learnerPlugIns`); a warning is emitted at boot. Operators resolve by reordering or uninstalling. Documented as a §8 spec open question; this plan implements last-installed-wins as the v0 default.
- **Trust posture.** Path 1 plug-ins inherit trust from the harness; no per-plug-in capability allow-list. The loader verifies (a) name + version match between `package.json` and `jinn-plugin.json`, (b) declared `entry` paths exist on disk, (c) compatibility range parses. No signature verification.
- **TDD discipline.** All TS tasks are TDD-shaped with bite-sized steps. Markdown skill modifications are integration-tested through a synthetic-session fixture (Task 7 step 7.1 introduces the fixture).
- **Commits.** One commit per logical change. Frequent commits per task.

---

## Task 1: Sync working branch with main

**Files:** none (branch-state operation only)

The `claude-code-learner` plugin (`client/plugins/claude-code-learner/`) lives on `main` but does not exist on the `spec/extension-model` branch this work is layered on top of. Every Path 1 integration task below modifies files inside that plugin directory; without the plugin present, those tasks have nothing to edit.

This task brings `main` into the working branch as the **first action** before any code or markdown change. It is intentionally framed as a discrete task so the implementer cannot skip it and discover the missing plugin halfway through Task 7.

- [ ] **Step 1.1: Confirm the missing-plugin precondition**

```bash
ls client/plugins/claude-code-learner/skills/coordinator/SKILL.md 2>&1
```

Expected: **either** the file exists (precondition already satisfied — skip to Step 1.5), or `No such file or directory` (proceed to Step 1.2).

- [ ] **Step 1.2: Fetch latest main**

```bash
git fetch origin main
git log --oneline origin/main -3
```

Expected: latest main commits print. Note the tip SHA — it should include the `claude-code-learner` plugin (commit `427a7151` "rename default-learner → claude-code-learner; opt-in framing" or later).

- [ ] **Step 1.3: Merge main into the working branch**

```bash
git merge origin/main --no-ff -m "Merge main into spec/extension-model layered branch (claude-code-learner plugin + ongoing main fixes)"
```

Expected: merge succeeds. If conflicts surface (most likely in `client/src/restorer/types.ts` — the extension specs add capability handle types in Plan 1, and main may have unrelated edits), resolve by **keeping both edits** unless they're directly contradictory:

- For `client/src/restorer/types.ts` conflicts: combine the capability-handle additions from Plan 1 with main's other field additions. Both should land.
- For `client/src/restorer/impls/plugin-path.ts` conflicts: prefer the union of both branches' changes; the `claude-code-learner` wrapper construction (from main) and the `externalImpls` integration (from Plan 1 Task 5) coexist.
- For lockfile conflicts (`client/yarn.lock`): regenerate via `cd client && yarn install` after the merge.
- If a conflict is genuinely contradictory, stop and flag it for the Captain — do not invent a resolution.

- [ ] **Step 1.4: Verify the plugin is present and the workspace builds**

```bash
ls client/plugins/claude-code-learner/skills/coordinator/SKILL.md
ls client/plugins/claude-code-learner/agents/ | sort
ls client/plugins/claude-code-learner/hooks/
cd client && yarn install && yarn typecheck && yarn vitest run
```

Expected:
- `SKILL.md` exists.
- `agents/` lists `analyst.md`, `consolidator.md`, `explorer.md`, `planner.md`, `promoter.md`, `step-worker.md`, `strategist.md`.
- `hooks/` contains `hooks.json` and `session-start` (executable).
- `yarn install` succeeds.
- `yarn typecheck` zero errors.
- `yarn vitest run` all tests pass (Plan 1 + Plan 2 tests included).

If any check fails, stop. The branch is not in a state where Task 2 can proceed.

- [ ] **Step 1.5: Verify the workspace root + SDK package from Plan 1 are present**

```bash
ls package.json packages/restorer-sdk/package.json
cat package.json | python3 -c "import json, sys; d = json.load(sys.stdin); print('workspaces:', d.get('workspaces'))"
```

Expected: workspace root `package.json` has `workspaces: ['client', 'packages/*', 'examples/external-restorer-impls/*']`. SDK package present at `packages/restorer-sdk/package.json`.

If absent, **Plan 1 is incomplete on this branch** — implementing Plan 3 ahead of Plan 1 is not supported. Stop and complete Plan 1 first.

- [ ] **Step 1.6: Commit the merge**

If the merge created a merge commit (which it should with `--no-ff`), it's already committed by Step 1.3. Verify:

```bash
git log --oneline -3
```

Expected: top of log shows the merge commit + the prior two commits ahead of `origin/spec/extension-model`. If for some reason the merge fast-forwarded (extension-model was already an ancestor of main, unusual), no extra commit is needed.

---

## Task 2: `jinn-plugin.json` JSON schema

**Files:**
- Create: `client/schemas/jinn-plugin-v1.json`
- Test: `client/src/restorer/plug-ins/manifest.test.ts` (placeholder; populated in Task 3)

- [ ] **Step 2.1: Author the JSON schema**

```json
// client/schemas/jinn-plugin-v1.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.jinn.network/jinn-plugin-v1.json",
  "title": "Jinn Path 1 plug-in manifest",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "name", "version", "compatibility", "slots"],
  "properties": {
    "schemaVersion": { "const": "1.0.0" },
    "name": { "type": "string", "pattern": "^(@[a-z0-9-]+/)?[a-z0-9][a-z0-9-]*$" },
    "version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9.-]+)?$" },
    "description": { "type": "string", "maxLength": 500 },
    "compatibility": {
      "type": "object",
      "required": ["claudeCodeLearner"],
      "additionalProperties": false,
      "properties": {
        "claudeCodeLearner": { "type": "string" },
        "supportedKinds": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]*\\.v[0-9]+$" }
        }
      }
    },
    "slots": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/slot" }
    },
    "author": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "name": { "type": "string" }, "url": { "type": "string", "format": "uri" } }
    },
    "license": { "type": "string" },
    "homepage": { "type": "string", "format": "uri" }
  },
  "$defs": {
    "slot": {
      "oneOf": [
        { "$ref": "#/$defs/phaseAgentOverride" },
        { "$ref": "#/$defs/topicExplorer" },
        { "$ref": "#/$defs/mcpTool" },
        { "$ref": "#/$defs/skillBundle" },
        { "$ref": "#/$defs/memoryBackend" },
        { "$ref": "#/$defs/hook" }
      ]
    },
    "phaseAgentOverride": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "phase", "agent", "entry"],
      "properties": {
        "type": { "const": "phase-agent-override" },
        "phase": { "enum": ["strategize", "plan", "execute", "debrief", "improve", "memory-consolidation"] },
        "agent": { "enum": ["strategist", "planner", "step-worker", "analyst", "promoter", "consolidator"] },
        "scope": { "$ref": "#/$defs/scope" },
        "entry": { "type": "string", "pattern": "^[A-Za-z0-9_./-]+\\.md$" }
      }
    },
    "topicExplorer": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "phase", "topic", "entry"],
      "properties": {
        "type": { "const": "topic-explorer" },
        "phase": { "enum": ["orient", "debrief"] },
        "topic": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "scope": { "$ref": "#/$defs/scope" },
        "entry": { "type": "string", "pattern": "^[A-Za-z0-9_./-]+\\.md$" }
      }
    },
    "mcpTool": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "command", "args"],
      "properties": {
        "type": { "const": "mcp-tool" },
        "command": { "type": "string" },
        "args": { "type": "array", "items": { "type": "string" } },
        "namespace": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" }
      }
    },
    "skillBundle": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "skillsDir"],
      "properties": {
        "type": { "const": "skill-bundle" },
        "skillsDir": { "type": "string", "pattern": "^[A-Za-z0-9_./-]+/?$" },
        "scope": { "$ref": "#/$defs/scope" }
      }
    },
    "memoryBackend": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "command", "args"],
      "properties": {
        "type": { "const": "memory-backend" },
        "command": { "type": "string" },
        "args": { "type": "array", "items": { "type": "string" } },
        "scope": { "$ref": "#/$defs/scope" }
      }
    },
    "hook": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "event", "entry"],
      "properties": {
        "type": { "const": "hook" },
        "event": { "enum": ["session-start", "pre-phase", "post-phase", "session-end"] },
        "phase": { "enum": ["orient", "strategize", "plan", "execute", "debrief", "improve", "memory-consolidation"] },
        "entry": { "type": "string", "pattern": "^[A-Za-z0-9_./-]+$" },
        "scope": { "$ref": "#/$defs/scope" }
      }
    },
    "scope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "matchKinds": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string", "pattern": "^[a-z][a-z0-9-]*\\.v[0-9]+$" }
        }
      }
    }
  }
}
```

- [ ] **Step 2.2: Verify schema parses**

```bash
cd client && node -e "
const { readFileSync } = require('node:fs');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const ajv = new Ajv({ strict: true });
addFormats(ajv);
ajv.compile(JSON.parse(readFileSync('schemas/jinn-plugin-v1.json', 'utf8')));
console.log('schema compiles');
"
```

Expected: prints `schema compiles`.

- [ ] **Step 2.3: Commit**

```bash
git add client/schemas/jinn-plugin-v1.json
git commit -m "Add jinn-plugin.json JSON schema (Path 1 plug-in manifest)"
```

---

## Task 3: Plug-in manifest loader

**Files:**
- Create: `client/src/restorer/plug-ins/types.ts`
- Create: `client/src/restorer/plug-ins/manifest.ts`
- Test: `client/src/restorer/plug-ins/manifest.test.ts`

The manifest loader reads + validates `jinn-plugin.json` from a package root.

- [ ] **Step 3.1: Author `types.ts`**

```ts
// client/src/restorer/plug-ins/types.ts

export type SlotScope = { matchKinds: readonly string[] };

export type PhaseAgentOverrideSlot = {
  type: 'phase-agent-override';
  phase: 'strategize' | 'plan' | 'execute' | 'debrief' | 'improve' | 'memory-consolidation';
  agent: 'strategist' | 'planner' | 'step-worker' | 'analyst' | 'promoter' | 'consolidator';
  scope?: SlotScope;
  entry: string;
};

export type TopicExplorerSlot = {
  type: 'topic-explorer';
  phase: 'orient' | 'debrief';
  topic: string;
  scope?: SlotScope;
  entry: string;
};

export type McpToolSlot = {
  type: 'mcp-tool';
  command: string;
  args: readonly string[];
  namespace?: string;
};

export type SkillBundleSlot = {
  type: 'skill-bundle';
  skillsDir: string;
  scope?: SlotScope;
};

export type MemoryBackendSlot = {
  type: 'memory-backend';
  command: string;
  args: readonly string[];
  scope?: SlotScope;
};

export type HookSlot = {
  type: 'hook';
  event: 'session-start' | 'pre-phase' | 'post-phase' | 'session-end';
  phase?: 'orient' | 'strategize' | 'plan' | 'execute' | 'debrief' | 'improve' | 'memory-consolidation';
  entry: string;
  scope?: SlotScope;
};

export type Slot =
  | PhaseAgentOverrideSlot
  | TopicExplorerSlot
  | McpToolSlot
  | SkillBundleSlot
  | MemoryBackendSlot
  | HookSlot;

export interface JinnPlugInManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  compatibility: {
    claudeCodeLearner: string;
    supportedKinds?: readonly string[];
  };
  slots: readonly Slot[];
  author?: { name: string; url?: string };
  license?: string;
  homepage?: string;
}

export interface ExternalPlugInEntry {
  /** MUST equal the manifest's `name`. */
  name: string;
  /** Local filesystem path to the plug-in package's root (typically a node_modules path). */
  entry: string;
}
```

- [ ] **Step 3.2: Write failing manifest test**

```ts
// client/src/restorer/plug-ins/manifest.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugInManifest } from './manifest.js';

function makePkg(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-pi-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@x/p', version: '0.1.0' }));
  writeFileSync(join(dir, 'jinn-plugin.json'), JSON.stringify(manifest));
  return dir;
}

describe('loadPlugInManifest', () => {
  it('parses + validates a phase-agent-override manifest', async () => {
    const pkg = makePkg({
      schemaVersion: '1.0.0',
      name: '@x/p',
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0', supportedKinds: ['prediction.v0'] },
      slots: [
        {
          type: 'phase-agent-override',
          phase: 'execute',
          agent: 'step-worker',
          entry: 'agents/calibration.md',
          scope: { matchKinds: ['prediction.v0'] },
        },
      ],
    });
    mkdirSync(join(pkg, 'agents'), { recursive: true });
    writeFileSync(join(pkg, 'agents', 'calibration.md'), '---\nname: calibration\n---\n# stub');
    const m = await loadPlugInManifest(pkg);
    expect(m.name).toBe('@x/p');
    expect(m.slots).toHaveLength(1);
  });

  it('rejects a manifest where name disagrees with package.json', async () => {
    const pkg = makePkg({
      schemaVersion: '1.0.0',
      name: '@x/wrong-name',
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots: [{ type: 'mcp-tool', command: 'node', args: ['server.js'] }],
    });
    await expect(loadPlugInManifest(pkg)).rejects.toThrow(/name mismatch/i);
  });

  it('rejects a manifest where slot entry does not exist', async () => {
    const pkg = makePkg({
      schemaVersion: '1.0.0',
      name: '@x/p',
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots: [
        { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/missing.md' },
      ],
    });
    await expect(loadPlugInManifest(pkg)).rejects.toThrow(/entry not found/i);
  });

  it('rejects a manifest violating the JSON schema', async () => {
    const pkg = makePkg({
      schemaVersion: '1.0.0',
      name: '@x/p',
      version: 'not-a-semver',
      compatibility: { claudeCodeLearner: '>=0.1.0' },
      slots: [{ type: 'mcp-tool', command: 'x', args: [] }],
    });
    await expect(loadPlugInManifest(pkg)).rejects.toThrow(/schema/i);
  });
});
```

- [ ] **Step 3.3: Run, expect failure**

Run: `cd client && yarn vitest run src/restorer/plug-ins/manifest.test.ts`
Expected: FAIL — `loadPlugInManifest` not defined.

- [ ] **Step 3.4: Implement `manifest.ts`**

```ts
// client/src/restorer/plug-ins/manifest.ts
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { JinnPlugInManifest, Slot } from './types.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../schemas/jinn-plugin-v1.json', import.meta.url));

let validatorPromise: Promise<(d: unknown) => boolean> | null = null;
async function getValidator(): Promise<(d: unknown) => boolean> {
  if (validatorPromise) return validatorPromise;
  validatorPromise = (async () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    return ajv.compile(schema);
  })();
  return validatorPromise;
}

export async function loadPlugInManifest(packageRoot: string): Promise<JinnPlugInManifest> {
  const root = resolve(packageRoot);
  const manifestPath = join(root, 'jinn-plugin.json');
  const pkgJsonPath = join(root, 'package.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`jinn-plugin.json not found in ${root}`);
  }
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${root}`);
  }

  const [manifestText, pkgJsonText] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(pkgJsonPath, 'utf8'),
  ]);

  let manifest: JinnPlugInManifest;
  try {
    manifest = JSON.parse(manifestText) as JinnPlugInManifest;
  } catch (err) {
    throw new Error(`jinn-plugin.json is invalid JSON: ${(err as Error).message}`);
  }

  const validate = await getValidator();
  if (!validate(manifest)) {
    throw new Error(`jinn-plugin.json failed schema validation`);
  }

  const pkgJson = JSON.parse(pkgJsonText) as { name?: string; version?: string };
  if (pkgJson.name !== manifest.name) {
    throw new Error(`name mismatch: package.json has "${pkgJson.name}" but jinn-plugin.json has "${manifest.name}"`);
  }
  if (pkgJson.version !== manifest.version) {
    throw new Error(`version mismatch: package.json has "${pkgJson.version}" but jinn-plugin.json has "${manifest.version}"`);
  }

  // Resolve + verify each slot's entry path on disk
  for (const slot of manifest.slots) {
    if ('entry' in slot && slot.entry) {
      const entryAbs = join(root, slot.entry);
      if (!existsSync(entryAbs)) {
        throw new Error(`slot entry not found: ${slot.entry} (slot type: ${slot.type})`);
      }
    }
    if ('skillsDir' in slot && slot.skillsDir) {
      const skillsAbs = join(root, slot.skillsDir);
      if (!existsSync(skillsAbs)) {
        throw new Error(`slot skillsDir not found: ${slot.skillsDir}`);
      }
    }
  }

  return manifest;
}
```

- [ ] **Step 3.5: Run, expect green**

Run: `cd client && yarn vitest run src/restorer/plug-ins/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3.6: Commit**

```bash
git add client/src/restorer/plug-ins/types.ts client/src/restorer/plug-ins/manifest.ts client/src/restorer/plug-ins/manifest.test.ts
git commit -m "Add Path 1 plug-in manifest loader (jinn-plugin.json + schema)"
```

---

## Task 4: Slot registry data structure + plug-in loader

**Files:**
- Create: `client/src/restorer/plug-ins/registry.ts`
- Create: `client/src/restorer/plug-ins/loader.ts`
- Create: `client/src/restorer/plug-ins/index.ts`
- Test: `client/src/restorer/plug-ins/loader.test.ts`
- Modify: `client/src/config.ts` (add `learnerPlugIns: ExternalPlugInEntry[]`)

The slot registry is an in-memory normalised view of all installed plug-ins, keyed by slot type. The loader walks `config.learnerPlugIns[]`, calls `loadPlugInManifest` per entry, and merges results into the registry.

- [ ] **Step 4.1: Write failing registry test**

```ts
// client/src/restorer/plug-ins/loader.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugIns } from './loader.js';

function fakePkg(name: string, slots: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-load-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
  writeFileSync(join(dir, 'jinn-plugin.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    name,
    version: '0.1.0',
    compatibility: { claudeCodeLearner: '>=0.1.0' },
    slots,
  }));
  for (const slot of slots as Array<Record<string, unknown>>) {
    if (typeof slot.entry === 'string') {
      const abs = join(dir, slot.entry as string);
      mkdirSync(join(dir, ...((slot.entry as string).split('/').slice(0, -1))), { recursive: true });
      writeFileSync(abs, '---\nname: stub\n---\n# stub');
    }
  }
  return dir;
}

describe('loadPlugIns', () => {
  it('builds a registry with one phase-agent override', async () => {
    const pkg = fakePkg('@x/p', [
      { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/x.md', scope: { matchKinds: ['prediction.v0'] } },
    ]);
    const r = await loadPlugIns({ entries: [{ name: '@x/p', entry: pkg }], learnerVersion: '0.1.0' });
    expect(r.errors).toEqual([]);
    expect(r.registry.phaseAgentOverrides).toHaveLength(1);
    expect(r.registry.phaseAgentOverrides[0].phase).toBe('execute');
    expect(r.registry.phaseAgentOverrides[0].agent).toBe('step-worker');
    expect(r.registry.phaseAgentOverrides[0].plugInName).toBe('@x/p');
  });

  it('emits last-installed-wins ordering for collisions', async () => {
    const pA = fakePkg('@x/a', [
      { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/a.md' },
    ]);
    const pB = fakePkg('@x/b', [
      { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/b.md' },
    ]);
    const r = await loadPlugIns({
      entries: [{ name: '@x/a', entry: pA }, { name: '@x/b', entry: pB }],
      learnerVersion: '0.1.0',
    });
    expect(r.warnings).toContainEqual(expect.stringMatching(/collision/i));
    expect(r.registry.phaseAgentOverrides[0].plugInName).toBe('@x/b');
  });

  it('records load errors but continues with other plug-ins', async () => {
    const good = fakePkg('@x/good', [
      { type: 'mcp-tool', command: 'node', args: ['server.js'] },
    ]);
    const r = await loadPlugIns({
      entries: [
        { name: '@x/good', entry: good },
        { name: '@x/bad', entry: '/nonexistent/path/foo' },
      ],
      learnerVersion: '0.1.0',
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].plugInName).toBe('@x/bad');
    expect(r.registry.mcpTools).toHaveLength(1);
  });

  it('warns on out-of-range compatibility but loads anyway', async () => {
    const pkg = fakePkg('@x/p', [{ type: 'mcp-tool', command: 'node', args: [] }]);
    // Override the manifest to declare incompatible learner version
    writeFileSync(join(pkg, 'jinn-plugin.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: '@x/p',
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=99.0.0' },
      slots: [{ type: 'mcp-tool', command: 'node', args: [] }],
    }));
    const r = await loadPlugIns({ entries: [{ name: '@x/p', entry: pkg }], learnerVersion: '0.1.0' });
    expect(r.warnings).toContainEqual(expect.stringMatching(/compatibility|out-of-range/i));
    expect(r.registry.mcpTools).toHaveLength(1);
  });
});
```

- [ ] **Step 4.2: Run, expect failure**

Run: `cd client && yarn vitest run src/restorer/plug-ins/loader.test.ts`
Expected: FAIL — `loadPlugIns` not defined.

- [ ] **Step 4.3: Implement `registry.ts`**

```ts
// client/src/restorer/plug-ins/registry.ts
import type {
  PhaseAgentOverrideSlot,
  TopicExplorerSlot,
  McpToolSlot,
  SkillBundleSlot,
  MemoryBackendSlot,
  HookSlot,
} from './types.js';

/** A slot as stored in the registry — original slot data plus provenance. */
export interface RegistrySlot<S> {
  plugInName: string;
  plugInVersion: string;
  /** Absolute path to the plug-in package root. */
  packageRoot: string;
  slot: S;
}

export interface SlotRegistry {
  phaseAgentOverrides: ReadonlyArray<RegistrySlot<PhaseAgentOverrideSlot>>;
  topicExplorers: ReadonlyArray<RegistrySlot<TopicExplorerSlot>>;
  mcpTools: ReadonlyArray<RegistrySlot<McpToolSlot>>;
  skillBundles: ReadonlyArray<RegistrySlot<SkillBundleSlot>>;
  memoryBackends: ReadonlyArray<RegistrySlot<MemoryBackendSlot>>;
  hooks: ReadonlyArray<RegistrySlot<HookSlot>>;
}

export function emptyRegistry(): SlotRegistry {
  return {
    phaseAgentOverrides: [],
    topicExplorers: [],
    mcpTools: [],
    skillBundles: [],
    memoryBackends: [],
    hooks: [],
  };
}
```

- [ ] **Step 4.4: Implement `loader.ts`**

```ts
// client/src/restorer/plug-ins/loader.ts
import { resolve } from 'node:path';
import semver from 'semver';
import type { ExternalPlugInEntry, JinnPlugInManifest, Slot } from './types.js';
import { loadPlugInManifest } from './manifest.js';
import { emptyRegistry, type RegistrySlot, type SlotRegistry } from './registry.js';

export interface LoadPlugInsArgs {
  entries: readonly ExternalPlugInEntry[];
  /** Version of the bundled claude-code-learner package. Used for compatibility checks. */
  learnerVersion: string;
}

export interface LoadPlugInsResult {
  registry: SlotRegistry;
  errors: ReadonlyArray<{ plugInName: string; reason: string }>;
  warnings: ReadonlyArray<string>;
}

export async function loadPlugIns({ entries, learnerVersion }: LoadPlugInsArgs): Promise<LoadPlugInsResult> {
  const errors: { plugInName: string; reason: string }[] = [];
  const warnings: string[] = [];
  const phaseAgentOverrides: RegistrySlot<Extract<Slot, { type: 'phase-agent-override' }>>[] = [];
  const topicExplorers: RegistrySlot<Extract<Slot, { type: 'topic-explorer' }>>[] = [];
  const mcpTools: RegistrySlot<Extract<Slot, { type: 'mcp-tool' }>>[] = [];
  const skillBundles: RegistrySlot<Extract<Slot, { type: 'skill-bundle' }>>[] = [];
  const memoryBackends: RegistrySlot<Extract<Slot, { type: 'memory-backend' }>>[] = [];
  const hooks: RegistrySlot<Extract<Slot, { type: 'hook' }>>[] = [];

  // Track collisions for last-installed-wins
  const phaseAgentKeyed = new Map<string, RegistrySlot<Extract<Slot, { type: 'phase-agent-override' }>>>();

  for (const entry of entries) {
    let manifest: JinnPlugInManifest;
    try {
      manifest = await loadPlugInManifest(entry.entry);
    } catch (err) {
      errors.push({ plugInName: entry.name, reason: (err as Error).message });
      continue;
    }
    if (manifest.name !== entry.name) {
      errors.push({ plugInName: entry.name, reason: `manifest name "${manifest.name}" mismatches config entry "${entry.name}"` });
      continue;
    }
    const range = manifest.compatibility.claudeCodeLearner;
    if (!semver.satisfies(learnerVersion, range)) {
      warnings.push(
        `plug-in ${manifest.name}@${manifest.version} compatibility ${range} out-of-range for claude-code-learner@${learnerVersion}; loading anyway, expected to break`,
      );
    }
    const packageRoot = resolve(entry.entry);
    for (const slot of manifest.slots) {
      const reg = { plugInName: manifest.name, plugInVersion: manifest.version, packageRoot, slot };
      switch (slot.type) {
        case 'phase-agent-override': {
          const key = `${slot.phase}|${slot.agent}|${(slot.scope?.matchKinds ?? ['*']).join(',')}`;
          if (phaseAgentKeyed.has(key)) {
            warnings.push(`phase-agent-override collision on ${key}: ${manifest.name} overrides previous`);
          }
          const r = reg as RegistrySlot<typeof slot>;
          phaseAgentKeyed.set(key, r);
          break;
        }
        case 'topic-explorer':
          topicExplorers.push(reg as RegistrySlot<typeof slot>);
          break;
        case 'mcp-tool':
          mcpTools.push(reg as RegistrySlot<typeof slot>);
          break;
        case 'skill-bundle':
          skillBundles.push(reg as RegistrySlot<typeof slot>);
          break;
        case 'memory-backend':
          memoryBackends.push(reg as RegistrySlot<typeof slot>);
          break;
        case 'hook':
          hooks.push(reg as RegistrySlot<typeof slot>);
          break;
      }
    }
  }
  // Materialize the keyed map back into the array (last-write-wins semantics already enforced)
  phaseAgentOverrides.push(...phaseAgentKeyed.values());

  return {
    registry: { phaseAgentOverrides, topicExplorers, mcpTools, skillBundles, memoryBackends, hooks },
    errors,
    warnings,
  };
}
```

- [ ] **Step 4.5: Add `semver` dep**

```bash
cd client && yarn add semver && yarn add -D @types/semver
```

- [ ] **Step 4.6: Author barrel `client/src/restorer/plug-ins/index.ts`**

```ts
export { loadPlugInManifest } from './manifest.js';
export { loadPlugIns } from './loader.js';
export { emptyRegistry } from './registry.js';
export type { LoadPlugInsArgs, LoadPlugInsResult } from './loader.js';
export type { SlotRegistry, RegistrySlot } from './registry.js';
export type * from './types.js';
```

- [ ] **Step 4.7: Run loader tests, expect green**

Run: `cd client && yarn vitest run src/restorer/plug-ins/`
Expected: PASS (8 tests across manifest + loader).

- [ ] **Step 4.8: Wire `learnerPlugIns` into the daemon config schema**

In `client/src/config.ts`, add:

```ts
import type { ExternalPlugInEntry } from './restorer/plug-ins/types.js';

export interface JinnConfig {
  // … existing fields …
  learnerPlugIns?: readonly ExternalPlugInEntry[];
}
```

Mirror the existing config validation (Zod / handwritten). The schema accepts an optional array of `{ name: string; entry: string }` entries.

- [ ] **Step 4.9: Commit**

```bash
git add client/src/restorer/plug-ins/ client/src/config.ts client/package.json client/yarn.lock
git commit -m "Add Path 1 plug-in loader + slot registry (last-installed-wins on collision)"
```

---

## Task 5: Slot-registry hand-off via session-start hook

**Files:**
- Create: `client/src/restorer/plug-ins/serialise.ts`
- Test: `client/src/restorer/plug-ins/serialise.test.ts`
- Modify: `client/src/restorer/impls/claude-code-learner/types.ts` — add slot registry to `IntentSessionInputs`
- Modify: `client/src/restorer/impls/claude-code-learner/restorer.ts` — pass loaded registry through
- Modify: `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts` — propagate via env
- Modify: `client/plugins/claude-code-learner/hooks/session-start` — write `workingDir/.coordinator/slots.json`

The hand-off path: daemon loads plug-ins → serialises the registry to a JSON string → puts it in env as `JINN_SLOT_REGISTRY_JSON` → harness adapter passes the env into the Claude Code subprocess → session-start hook writes it to `workingDir/.coordinator/slots.json` → phase skills `Read` it.

- [ ] **Step 5.1: Author `serialise.ts`**

```ts
// client/src/restorer/plug-ins/serialise.ts
import type { SlotRegistry, RegistrySlot } from './registry.js';
import type { Slot } from './types.js';

/**
 * Serialised registry written to workingDir/.coordinator/slots.json
 * for phase skills to consult. Shape is intentionally simple JSON
 * so markdown skills can `Read` and parse it without bespoke tooling.
 */
export interface SerialisedRegistry {
  /** ISO timestamp of registry construction. */
  builtAt: string;
  /** claude-code-learner version this registry was built against. */
  learnerVersion: string;
  /** Per-slot-category arrays, each carrying the source plug-in's identity. */
  phaseAgentOverrides: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'phase-agent-override' }> }>;
  topicExplorers: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'topic-explorer' }> }>;
  mcpTools: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'mcp-tool' }> }>;
  skillBundles: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'skill-bundle' }> }>;
  memoryBackends: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'memory-backend' }> }>;
  hooks: ReadonlyArray<{ plugInName: string; packageRoot: string; slot: Extract<Slot, { type: 'hook' }> }>;
}

function projectSlot<S extends Slot>(r: RegistrySlot<S>): { plugInName: string; packageRoot: string; slot: S } {
  return { plugInName: r.plugInName, packageRoot: r.packageRoot, slot: r.slot };
}

export function serialiseRegistry(registry: SlotRegistry, learnerVersion: string): SerialisedRegistry {
  return {
    builtAt: new Date().toISOString(),
    learnerVersion,
    phaseAgentOverrides: registry.phaseAgentOverrides.map(projectSlot),
    topicExplorers: registry.topicExplorers.map(projectSlot),
    mcpTools: registry.mcpTools.map(projectSlot),
    skillBundles: registry.skillBundles.map(projectSlot),
    memoryBackends: registry.memoryBackends.map(projectSlot),
    hooks: registry.hooks.map(projectSlot),
  };
}
```

- [ ] **Step 5.2: Test the serialiser**

```ts
// client/src/restorer/plug-ins/serialise.test.ts
import { describe, it, expect } from 'vitest';
import { serialiseRegistry } from './serialise.js';
import { emptyRegistry } from './registry.js';

describe('serialiseRegistry', () => {
  it('produces a JSON-serialisable shape with builtAt + learnerVersion', () => {
    const r = serialiseRegistry(emptyRegistry(), '0.1.0');
    const json = JSON.stringify(r);
    const parsed = JSON.parse(json);
    expect(parsed.learnerVersion).toBe('0.1.0');
    expect(typeof parsed.builtAt).toBe('string');
    expect(parsed.phaseAgentOverrides).toEqual([]);
  });

  it('strips RegistrySlot internals beyond plugInName / packageRoot / slot', () => {
    const reg = emptyRegistry();
    (reg.phaseAgentOverrides as unknown[]).push({
      plugInName: '@x/p',
      plugInVersion: '0.1.0',
      packageRoot: '/tmp/x',
      slot: { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'a.md' },
    });
    const s = serialiseRegistry(reg, '0.1.0');
    const projected = s.phaseAgentOverrides[0] as Record<string, unknown>;
    expect(projected.plugInVersion).toBeUndefined(); // intentionally omitted from serialised shape
    expect(projected.plugInName).toBe('@x/p');
    expect(projected.packageRoot).toBe('/tmp/x');
  });
});
```

Run: `cd client && yarn vitest run src/restorer/plug-ins/serialise.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5.3: Extend `IntentSessionInputs` and `KnownAdapterEnvKey`**

In `client/src/restorer/impls/claude-code-learner/types.ts`, add a new env key constant and a new field on `IntentSessionInputs`:

```ts
export type KnownAdapterEnvKey =
  | 'JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE'
  | 'JINN_SLOT_REGISTRY_JSON';
```

(No additional type field is needed on `IntentSessionInputs` itself — the registry rides in `adapterEnv`.)

- [ ] **Step 5.4: Wire registry hand-off in `restorer.ts`**

Modify `client/src/restorer/impls/claude-code-learner/restorer.ts`. Add a constructor option `slotRegistryJson?: string`; in `run()`, merge it into the `adapterEnv` map under `JINN_SLOT_REGISTRY_JSON`:

```ts
// inside ClaudeCodeLearnerImpl constructor / config:
constructor(config: ClaudeCodeLearnerConfig & { slotRegistryJson?: string }) {
  this.adapter = config.adapter;
  this.name = config.name ?? 'claude-code-learner';
  this.version = config.version ?? '0.1.0-shim';
  this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
  this.slotRegistryJson = config.slotRegistryJson;
}

// in run() / runWithAdapterEnv():
const adapterEnvMerged: Record<string, string> = { ...adapterEnv };
if (this.slotRegistryJson) {
  adapterEnvMerged.JINN_SLOT_REGISTRY_JSON = this.slotRegistryJson;
}
```

- [ ] **Step 5.5: Wire `buildRestorerImpls` to load plug-ins + pass registry**

Modify `client/src/restorer/impls/plugin-path.ts` (the buildRestorerImpls factory). Where the learner is constructed:

```ts
import { loadPlugIns, serialiseRegistry } from '../plug-ins/index.js';
// … in buildRestorerImpls(env):
const plugInResult = await loadPlugIns({
  entries: env.learnerPlugIns ?? [],
  learnerVersion: '0.1.0', // TODO read from package.json at build time
});
for (const w of plugInResult.warnings) console.warn(`[plug-ins] ${w}`);
for (const e of plugInResult.errors) console.error(`[plug-ins] ${e.plugInName}: ${e.reason}`);
const registryJson = JSON.stringify(serialiseRegistry(plugInResult.registry, '0.1.0'));

const learnerShim = new ClaudeCodeLearnerImpl({
  adapter: learnerAdapter,
  slotRegistryJson: registryJson,
});
```

(The factory becomes async; update `RestorerEnv` and `main.ts` accordingly. If async-factory is too invasive, an alternative is to load plug-ins synchronously in `main.ts` and pass the registry-JSON in via `RestorerEnv`.)

- [ ] **Step 5.6: Update `session-start` hook to write `slots.json`**

Modify `client/plugins/claude-code-learner/hooks/session-start`. After the existing git-init logic, add:

```bash
# Write slot registry hand-off if the daemon supplied one.
if [ -n "${JINN_SLOT_REGISTRY_JSON:-}" ] && [ -n "${WORKING_DIR:-}" ]; then
  mkdir -p "$WORKING_DIR/.coordinator"
  printf '%s\n' "$JINN_SLOT_REGISTRY_JSON" > "$WORKING_DIR/.coordinator/slots.json"
fi
```

- [ ] **Step 5.7: Add a synthetic-session integration fixture**

```ts
// client/src/restorer/impls/claude-code-learner/test-utils/synthetic-session.ts (new file)
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Synthetic-session fixture for testing slot-registry hand-off without
 * spawning a real Claude Code subprocess. Simulates session-start hook
 * by inspecting JINN_SLOT_REGISTRY_JSON in the supplied env.
 */
export interface SyntheticSession {
  workingDir: string;
  /** Apply the equivalent of the hook script: write slots.json if env has registry. */
  applySessionStart(env: Record<string, string>): void;
  /** Read the resulting slots.json (returns null if not written). */
  readSlots(): unknown | null;
}

export function makeSyntheticSession(): SyntheticSession {
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-synth-'));
  return {
    workingDir,
    applySessionStart(env: Record<string, string>) {
      const json = env.JINN_SLOT_REGISTRY_JSON;
      if (!json) return;
      mkdirSync(join(workingDir, '.coordinator'), { recursive: true });
      writeFileSync(join(workingDir, '.coordinator', 'slots.json'), json);
    },
    readSlots() {
      const path = join(workingDir, '.coordinator', 'slots.json');
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
  };
}
```

- [ ] **Step 5.8: Test the integration end-to-end**

```ts
// client/src/restorer/impls/claude-code-learner/integration.test.ts (new)
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlugIns, serialiseRegistry } from '../../plug-ins/index.js';
import { makeSyntheticSession } from './test-utils/synthetic-session.js';

describe('plug-in registry hand-off', () => {
  it('threads from config to slots.json via the synthetic session', async () => {
    const pkgDir = mkdtempSync(join(tmpdir(), 'jinn-pi-'));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@x/calib', version: '0.1.0' }));
    writeFileSync(join(pkgDir, 'jinn-plugin.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: '@x/calib',
      version: '0.1.0',
      compatibility: { claudeCodeLearner: '>=0.1.0', supportedKinds: ['prediction.v0'] },
      slots: [{ type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/calib.md', scope: { matchKinds: ['prediction.v0'] } }],
    }));
    mkdirSync(join(pkgDir, 'agents'), { recursive: true });
    writeFileSync(join(pkgDir, 'agents', 'calib.md'), '---\nname: calib\n---\n# stub');

    const result = await loadPlugIns({ entries: [{ name: '@x/calib', entry: pkgDir }], learnerVersion: '0.1.0' });
    expect(result.errors).toEqual([]);
    const json = JSON.stringify(serialiseRegistry(result.registry, '0.1.0'));

    const session = makeSyntheticSession();
    session.applySessionStart({ JINN_SLOT_REGISTRY_JSON: json });
    const slots = session.readSlots() as { phaseAgentOverrides: unknown[] };
    expect(slots.phaseAgentOverrides).toHaveLength(1);
  });
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5.9: Commit**

```bash
git add client/src/restorer/plug-ins/serialise.ts client/src/restorer/plug-ins/serialise.test.ts client/src/restorer/impls/claude-code-learner/types.ts client/src/restorer/impls/claude-code-learner/restorer.ts client/src/restorer/impls/plugin-path.ts client/plugins/claude-code-learner/hooks/session-start client/src/restorer/impls/claude-code-learner/test-utils/synthetic-session.ts client/src/restorer/impls/claude-code-learner/integration.test.ts
git commit -m "Wire slot registry hand-off: daemon → JINN_SLOT_REGISTRY_JSON → session-start → slots.json"
```

---

## Task 6: `jinn plug-ins` CLI command

**Files:**
- Create: `client/src/cli/commands/plug-ins.ts`
- Test: `client/src/cli/commands/plug-ins.test.ts`
- Modify: `client/src/cli/command-registry.ts`

Verbs: `list`, `add`, `remove`, `show`. Each operates on `~/.jinn-client/config.json`'s `learnerPlugIns[]` field with install-time validation.

- [ ] **Step 6.1: Write failing tests**

```ts
// client/src/cli/commands/plug-ins.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPlugIns } from './plug-ins.js';

let TMP: string;
let CONFIG: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'jinn-pi-cli-'));
  CONFIG = join(TMP, 'config.json');
  writeFileSync(CONFIG, JSON.stringify({ learnerPlugIns: [] }, null, 2));
});

function fakePackageDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jinn-pkg-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '0.1.0' }));
  writeFileSync(join(d, 'jinn-plugin.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    name,
    version: '0.1.0',
    compatibility: { claudeCodeLearner: '>=0.1.0' },
    slots: [{ type: 'mcp-tool', command: 'node', args: ['server.js'] }],
  }));
  return d;
}

describe('runPlugIns', () => {
  it('add appends an entry to learnerPlugIns', async () => {
    const pkg = fakePackageDir('@example/p');
    const code = await runPlugIns({ argv: ['add', '@example/p', '--entry', pkg], configPath: CONFIG });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
    expect(cfg.learnerPlugIns[0].name).toBe('@example/p');
  });

  it('add refuses to add a duplicate name', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({ argv: ['add', '@example/p', '--entry', pkg], configPath: CONFIG });
    const code = await runPlugIns({ argv: ['add', '@example/p', '--entry', pkg], configPath: CONFIG });
    expect(code).toBe(1);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toHaveLength(1);
  });

  it('add refuses an invalid manifest', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jinn-bad-'));
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@example/bad', version: '0.1.0' }));
    writeFileSync(join(d, 'jinn-plugin.json'), JSON.stringify({ broken: true }));
    const code = await runPlugIns({ argv: ['add', '@example/bad', '--entry', d], configPath: CONFIG });
    expect(code).toBe(1);
  });

  it('remove deletes the entry', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({ argv: ['add', '@example/p', '--entry', pkg], configPath: CONFIG });
    const code = await runPlugIns({ argv: ['remove', '@example/p'], configPath: CONFIG });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(cfg.learnerPlugIns).toEqual([]);
  });

  it('list prints installed plug-ins', async () => {
    const pkg = fakePackageDir('@example/p');
    await runPlugIns({ argv: ['add', '@example/p', '--entry', pkg], configPath: CONFIG });
    let captured = '';
    const code = await runPlugIns({
      argv: ['list'],
      configPath: CONFIG,
      stdout: { write: (s: string) => { captured += s; } },
    });
    expect(code).toBe(0);
    expect(captured).toContain('@example/p');
  });
});
```

- [ ] **Step 6.2: Run, expect failure**

Run: `cd client && yarn vitest run src/cli/commands/plug-ins.test.ts`
Expected: FAIL — `runPlugIns` not defined.

- [ ] **Step 6.3: Implement `plug-ins.ts`**

```ts
// client/src/cli/commands/plug-ins.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPlugInManifest } from '../../restorer/plug-ins/manifest.js';
import type { CommandContext, CommandModule } from '../command.js';

export interface RunPlugInsArgs {
  argv: readonly string[];
  configPath?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

const DEFAULT_CONFIG = join(homedir(), '.jinn-client', 'config.json');

interface ConfigShape {
  learnerPlugIns?: Array<{ name: string; entry: string }>;
  [k: string]: unknown;
}

function readConfig(path: string): ConfigShape {
  return JSON.parse(readFileSync(path, 'utf8')) as ConfigShape;
}
function writeConfig(path: string, cfg: ConfigShape): void {
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

export async function runPlugIns({
  argv,
  configPath = DEFAULT_CONFIG,
  stdout = process.stdout,
  stderr = process.stderr,
}: RunPlugInsArgs): Promise<number> {
  const verb = argv[0];
  switch (verb) {
    case 'list': return list(configPath, stdout);
    case 'add': return add(argv.slice(1), configPath, stderr);
    case 'remove': return remove(argv.slice(1), configPath, stderr);
    case 'show': return show(argv.slice(1), configPath, stdout, stderr);
    default:
      stderr.write(`Usage: jinn plug-ins {list|add|remove|show} ...\n`);
      return 1;
  }
}

function list(configPath: string, stdout: { write(s: string): void }): number {
  const cfg = readConfig(configPath);
  const entries = cfg.learnerPlugIns ?? [];
  if (entries.length === 0) {
    stdout.write('No plug-ins installed.\n');
    return 0;
  }
  for (const e of entries) {
    stdout.write(`${e.name}\t${e.entry}\n`);
  }
  return 0;
}

async function add(rest: readonly string[], configPath: string, stderr: { write(s: string): void }): Promise<number> {
  const name = rest[0];
  if (!name) { stderr.write(`error: name required\n`); return 1; }
  const entryFlagIdx = rest.findIndex((a) => a === '--entry');
  const entry = entryFlagIdx >= 0 ? rest[entryFlagIdx + 1] : undefined;
  if (!entry) { stderr.write(`error: --entry <path> required\n`); return 1; }
  const absEntry = resolve(entry);

  // validate manifest
  let manifest;
  try {
    manifest = await loadPlugInManifest(absEntry);
  } catch (err) {
    stderr.write(`error: invalid plug-in: ${(err as Error).message}\n`);
    return 1;
  }
  if (manifest.name !== name) {
    stderr.write(`error: name "${name}" mismatches manifest name "${manifest.name}"\n`);
    return 1;
  }

  const cfg = readConfig(configPath);
  const list = cfg.learnerPlugIns ?? [];
  if (list.some((e) => e.name === name)) {
    stderr.write(`error: plug-in ${name} already installed\n`);
    return 1;
  }
  list.push({ name, entry: absEntry });
  cfg.learnerPlugIns = list;
  writeConfig(configPath, cfg);
  return 0;
}

async function remove(rest: readonly string[], configPath: string, stderr: { write(s: string): void }): Promise<number> {
  const name = rest[0];
  if (!name) { stderr.write(`error: name required\n`); return 1; }
  const cfg = readConfig(configPath);
  const list = cfg.learnerPlugIns ?? [];
  const next = list.filter((e) => e.name !== name);
  if (next.length === list.length) {
    stderr.write(`error: plug-in ${name} not installed\n`);
    return 1;
  }
  cfg.learnerPlugIns = next;
  writeConfig(configPath, cfg);
  return 0;
}

async function show(rest: readonly string[], configPath: string, stdout: { write(s: string): void }, stderr: { write(s: string): void }): Promise<number> {
  const name = rest[0];
  if (!name) { stderr.write(`error: name required\n`); return 1; }
  const cfg = readConfig(configPath);
  const entry = (cfg.learnerPlugIns ?? []).find((e) => e.name === name);
  if (!entry) { stderr.write(`error: plug-in ${name} not installed\n`); return 1; }
  const manifest = await loadPlugInManifest(entry.entry);
  stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return 0;
}

export const plugInsCommand: CommandModule = {
  name: 'plug-ins',
  describe: 'Manage Path 1 plug-ins for the claude-code-learner impl',
  async run(ctx: CommandContext): Promise<number> {
    return runPlugIns({ argv: ctx.argv, stdout: ctx.stdout, stderr: ctx.stderr });
  },
};
```

- [ ] **Step 6.4: Run, expect green**

Run: `cd client && yarn vitest run src/cli/commands/plug-ins.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6.5: Register the command**

In `client/src/cli/command-registry.ts`, import + register `plugInsCommand`.

- [ ] **Step 6.6: Commit**

```bash
git add client/src/cli/commands/plug-ins.ts client/src/cli/commands/plug-ins.test.ts client/src/cli/command-registry.ts
git commit -m "Add jinn plug-ins {list|add|remove|show} CLI command"
```

---

## Task 7: Phase-agent override integration

**Files:**
- Modify: `client/plugins/claude-code-learner/skills/strategize/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/plan/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/execute/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/debrief/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/improve/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/memory-consolidation/SKILL.md`

Each phase skill that spawns a specialized subagent (strategist, planner, step-worker, analyst, promoter, consolidator) gains a small "consult slots.json" preamble. If a matching `phase-agent-override` is found, the skill spawns the override's agent file at `<packageRoot>/<entry>` instead of the bundled agent.

- [ ] **Step 7.1: Add a "Consult slot registry" section to the strategize skill**

Edit `client/plugins/claude-code-learner/skills/strategize/SKILL.md`. After the **Inputs** section and before the spawn-strategist section, insert:

```markdown
## Consult slot registry

Before spawning the bundled strategist, check whether an installed Path 1 plug-in declares a `phase-agent-override` for this phase + agent + intent kind.

Read `workingDir/.coordinator/slots.json`. If it does not exist, there are no overrides — proceed with the bundled `strategist` agent.

If it exists, parse it and look for a matching entry in `phaseAgentOverrides`:

```json
{
  "slot": { "phase": "strategize", "agent": "strategist", "scope": { "matchKinds": ["prediction.v0"] } }
}
```

Match rule: `slot.phase === "strategize"` AND `slot.agent === "strategist"` AND (`slot.scope` is absent OR `intent.spec.kind` ∈ `slot.scope.matchKinds`). The first match wins (the registry already enforces last-installed-wins on collisions, see spec §8 open question 8).

If a match exists, the agent to spawn is at `<packageRoot>/<slot.entry>`. Substitute that path for the bundled `claude-code-learner:strategist` reference in the next step. The override agent receives the same inputs as the bundled strategist (intent, orientSummaryPath, priorStrategiesPath, outputDir, skillBundleCid, implStateDirShaAtStart, msUntilEndTs).

If no match, proceed with the bundled strategist as before.
```

- [ ] **Step 7.2: Repeat the equivalent edit for plan, execute, debrief, improve, memory-consolidation**

For each of the five other phase skills, add the same pattern but parameterised on the phase name and agent name. Concretely:

| Skill file | Phase | Agent |
|---|---|---|
| `skills/plan/SKILL.md` | `plan` | `planner` |
| `skills/execute/SKILL.md` | `execute` | `step-worker` |
| `skills/debrief/SKILL.md` | `debrief` | `analyst` |
| `skills/improve/SKILL.md` | `improve` | `promoter` |
| `skills/memory-consolidation/SKILL.md` | `memory-consolidation` | `consolidator` |

The body is the same as Step 7.1, with `strategize`/`strategist` substituted accordingly.

- [ ] **Step 7.3: Add a unit test against the synthetic-session fixture**

Extend `client/src/restorer/impls/claude-code-learner/integration.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('phase-agent override is discoverable from slots.json by skill consumer', async () => {
  // (Build registry as in the previous integration test; reuse the helper.)
  // Verify the structure of slots.json is the documented shape.
  const session = makeSyntheticSession();
  session.applySessionStart({
    JINN_SLOT_REGISTRY_JSON: JSON.stringify({
      builtAt: '2026-04-30T00:00:00.000Z',
      learnerVersion: '0.1.0',
      phaseAgentOverrides: [
        {
          plugInName: '@x/calib',
          packageRoot: '/tmp/calib',
          slot: { type: 'phase-agent-override', phase: 'execute', agent: 'step-worker', entry: 'agents/calib.md', scope: { matchKinds: ['prediction.v0'] } },
        },
      ],
      topicExplorers: [], mcpTools: [], skillBundles: [], memoryBackends: [], hooks: [],
    }),
  });
  const slots = session.readSlots() as { phaseAgentOverrides: Array<{ slot: { phase: string; agent: string } }> };
  const matchExecute = slots.phaseAgentOverrides.find(
    (o) => o.slot.phase === 'execute' && o.slot.agent === 'step-worker',
  );
  expect(matchExecute).toBeDefined();
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/`
Expected: existing tests still PASS; 1 new test PASS.

- [ ] **Step 7.4: Commit**

```bash
git add client/plugins/claude-code-learner/skills/ client/src/restorer/impls/claude-code-learner/integration.test.ts
git commit -m "Phase skills consult slots.json for phase-agent overrides"
```

---

## Task 8: Topic explorer integration

**Files:**
- Modify: `client/plugins/claude-code-learner/skills/orient/SKILL.md`
- Modify: `client/plugins/claude-code-learner/skills/debrief/SKILL.md`

The orient and debrief skills spawn explorer subagents per topic. With Path 1 plug-ins, they additionally spawn explorers for declared topic-explorer slots.

- [ ] **Step 8.1: Extend the orient skill**

Edit `client/plugins/claude-code-learner/skills/orient/SKILL.md`. After the existing "Decide what topics to gather" section, insert:

```markdown
## Plug-in topic explorers

In addition to the bundled topic categories above, consult `workingDir/.coordinator/slots.json` (if present). For each entry in `topicExplorers` matching `slot.phase === "orient"` and either no `slot.scope` or `intent.spec.kind` ∈ `slot.scope.matchKinds`:

- Treat it as an additional topic to gather. Topic name is `slot.topic`.
- Spawn an explorer subagent (same shape as the bundled explorer, but with the explorer-role file at `<packageRoot>/<slot.entry>` instead of the bundled `explorer` role).
- Inputs to the explorer are unchanged (topic, intent, scope, workingDir, implStateDir, outputPath = workingDir/.orient/<topic>.json, msUntilEndTs).
- Include the topic's results in the collation (`workingDir/.orient/summary.json`'s `topics[]` array).

Topic-name collisions: if a plug-in declares a topic that matches a bundled name (`intent-parse`, `world-state`, `own-history`, `others-history`), the plug-in's explorer is spawned instead of the bundled fan-out for that topic. Surface a one-line note in `summary.json.flags`.
```

- [ ] **Step 8.2: Extend the debrief skill identically**

Edit `client/plugins/claude-code-learner/skills/debrief/SKILL.md`. Add an analogous "Plug-in topic explorers" section consulting `topicExplorers` for `slot.phase === "debrief"`.

- [ ] **Step 8.3: Test the synthetic session for topic-explorer routing**

Append to `integration.test.ts`:

```ts
it('topic explorer slots are discoverable from slots.json for orient + debrief', async () => {
  const session = makeSyntheticSession();
  session.applySessionStart({
    JINN_SLOT_REGISTRY_JSON: JSON.stringify({
      builtAt: '2026-04-30T00:00:00.000Z',
      learnerVersion: '0.1.0',
      phaseAgentOverrides: [],
      topicExplorers: [
        { plugInName: '@x/news', packageRoot: '/tmp/news', slot: { type: 'topic-explorer', phase: 'orient', topic: 'news-context', entry: 'agents/news.md', scope: { matchKinds: ['prediction.v0'] } } },
        { plugInName: '@x/comp', packageRoot: '/tmp/comp', slot: { type: 'topic-explorer', phase: 'debrief', topic: 'cross-operator-comparison', entry: 'agents/comp.md' } },
      ],
      mcpTools: [], skillBundles: [], memoryBackends: [], hooks: [],
    }),
  });
  const slots = session.readSlots() as { topicExplorers: Array<{ slot: { phase: string; topic: string } }> };
  expect(slots.topicExplorers.filter((t) => t.slot.phase === 'orient')).toHaveLength(1);
  expect(slots.topicExplorers.filter((t) => t.slot.phase === 'debrief')).toHaveLength(1);
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/`
Expected: PASS.

- [ ] **Step 8.4: Commit**

```bash
git add client/plugins/claude-code-learner/skills/orient/ client/plugins/claude-code-learner/skills/debrief/ client/src/restorer/impls/claude-code-learner/integration.test.ts
git commit -m "Orient + debrief skills consult slots.json for topic-explorer plug-ins"
```

---

## Task 9: MCP tool integration (daemon-side)

**Files:**
- Create: `client/src/restorer/impls/claude-code-learner/mcp-config.ts`
- Modify: `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts`
- Test: `client/src/restorer/impls/claude-code-learner/mcp-config.test.ts`

The Claude Code adapter spawns the harness with a `.mcp.json` (or equivalent) describing MCP servers. Path 1 `mcp-tool` slots extend that config so installed plug-ins' MCP servers are available to the spawned session.

- [ ] **Step 9.1: Write failing test**

```ts
// client/src/restorer/impls/claude-code-learner/mcp-config.test.ts
import { describe, it, expect } from 'vitest';
import { mergeMcpConfig } from './mcp-config.js';

describe('mergeMcpConfig', () => {
  it('appends slot servers under their plug-in namespace', () => {
    const merged = mergeMcpConfig(
      { mcpServers: { 'in-repo-tool': { command: 'node', args: ['x.js'] } } },
      [
        { plugInName: '@x/news', packageRoot: '/tmp/news', slot: { type: 'mcp-tool', command: 'node', args: ['/tmp/news/server.js'] } },
        { plugInName: '@x/poly', packageRoot: '/tmp/poly', slot: { type: 'mcp-tool', command: 'node', args: ['/tmp/poly/server.js'], namespace: 'polymarket' } },
      ],
    );
    expect(Object.keys(merged.mcpServers)).toEqual(
      expect.arrayContaining(['in-repo-tool', '@x/news', 'polymarket']),
    );
    expect(merged.mcpServers['polymarket'].args).toEqual(['/tmp/poly/server.js']);
  });

  it('rejects collisions with in-repo MCP names', () => {
    expect(() =>
      mergeMcpConfig(
        { mcpServers: { 'foo': { command: 'a', args: [] } } },
        [{ plugInName: '@x/foo', packageRoot: '/tmp', slot: { type: 'mcp-tool', command: 'b', args: [], namespace: 'foo' } }],
      ),
    ).toThrow(/collision/i);
  });
});
```

- [ ] **Step 9.2: Run, expect failure**

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/mcp-config.test.ts`
Expected: FAIL.

- [ ] **Step 9.3: Implement `mcp-config.ts`**

```ts
// client/src/restorer/impls/claude-code-learner/mcp-config.ts
import type { RegistrySlot } from '../../plug-ins/registry.js';
import type { McpToolSlot } from '../../plug-ins/types.js';

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: readonly string[] }>;
}

export function mergeMcpConfig(
  baseline: McpConfig,
  slots: ReadonlyArray<RegistrySlot<McpToolSlot>>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...baseline.mcpServers } };
  for (const reg of slots) {
    const key = reg.slot.namespace ?? reg.plugInName;
    if (key in out.mcpServers) {
      throw new Error(`MCP server name collision: ${key} (already in baseline or another plug-in)`);
    }
    out.mcpServers[key] = { command: reg.slot.command, args: reg.slot.args };
  }
  return out;
}
```

- [ ] **Step 9.4: Run, expect green**

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/mcp-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9.5: Wire `mergeMcpConfig` into the Claude Code adapter**

In `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts`, find the place where the adapter writes/passes the MCP config to the spawned subprocess. Before passing it, call `mergeMcpConfig(baseline, registry.mcpTools)` with the registry from the learner's session inputs (registry is already on `IntentSessionInputs.adapterEnv` or accessible from a serialised registry path).

(Existing adapter wiring varies; the change is additive — replace `baseline` with `merged` everywhere `mcpServers` is consumed.)

- [ ] **Step 9.6: Commit**

```bash
git add client/src/restorer/impls/claude-code-learner/mcp-config.ts client/src/restorer/impls/claude-code-learner/mcp-config.test.ts client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts
git commit -m "Merge plug-in MCP servers into harness's mcp.json at session-start"
```

---

## Task 10: Skill bundle integration (Claude Code plugin-dir convention)

**Files:**
- Modify: `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts`
- Test: `client/src/restorer/impls/claude-code-learner/skill-bundles.test.ts`

Claude Code already discovers skills inside its loaded plugin directories. The integration: each `skill-bundle` slot's `<packageRoot>/<skillsDir>` must be on the harness's `--plugin-dir` list (or symlinked into the bundled plugin's `skills/` directory).

- [ ] **Step 10.1: Implementation choice**

Two viable approaches:

(a) **`--plugin-dir` per slot.** Pass each plug-in's package as an additional `--plugin-dir` argument when spawning Claude Code. Each plug-in becomes its own loaded Claude Code plugin. *Drawback:* duplicates plug-in entries (one for the Path 1 mechanism, one for the actual skill content).

(b) **Symlink-into-bundled-plugin.** At session-start, the daemon symlinks each `skill-bundle` slot's directory into a temp directory under the bundled plugin's `skills/` tree, then spawns Claude Code with that as the plugin dir. *Drawback:* cleanup is operator's responsibility; symlinks complicate Windows compatibility.

Phase 1 picks **(a)** for simplicity. Operators with many plug-ins accept the longer command line; symlink machinery defers to Phase 2.

- [ ] **Step 10.2: Implement skill-bundle plugin-dir extension**

In `client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts`, when assembling the `--plugin-dir` argument list:

```ts
import type { SerialisedRegistry } from '../../../plug-ins/serialise.js';

function pluginDirsForSession(registry: SerialisedRegistry, bundledPluginRoot: string): string[] {
  const dirs: string[] = [bundledPluginRoot];
  for (const r of registry.skillBundles) {
    dirs.push(r.packageRoot); // each plug-in's root is its own Claude Code plugin
  }
  return dirs;
}
```

Pass `pluginDirsForSession(registry, this.pluginRoot)` into the Claude Code spawn args, replacing the existing single-plugin-dir.

- [ ] **Step 10.3: Test**

```ts
// client/src/restorer/impls/claude-code-learner/skill-bundles.test.ts
import { describe, it, expect } from 'vitest';
import { pluginDirsForSession } from './adapters/claude-code.js';
// (export pluginDirsForSession from claude-code.ts, or move it to a separate file for testability.)

describe('pluginDirsForSession', () => {
  it('includes the bundled plugin and each skill-bundle slot package root', () => {
    const registry = {
      builtAt: '', learnerVersion: '0.1.0',
      phaseAgentOverrides: [], topicExplorers: [], mcpTools: [],
      skillBundles: [
        { plugInName: '@x/skills', packageRoot: '/tmp/skills', slot: { type: 'skill-bundle' as const, skillsDir: 'skills' } },
      ],
      memoryBackends: [], hooks: [],
    };
    const dirs = pluginDirsForSession(registry, '/bundled');
    expect(dirs).toEqual(['/bundled', '/tmp/skills']);
  });
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/skill-bundles.test.ts`
Expected: PASS (1 test).

- [ ] **Step 10.4: Commit**

```bash
git add client/src/restorer/impls/claude-code-learner/adapters/claude-code.ts client/src/restorer/impls/claude-code-learner/skill-bundles.test.ts
git commit -m "Skill-bundle plug-ins extend Claude Code --plugin-dir at session-start"
```

---

## Task 11: Memory backend integration

**Files:**
- Modify: `client/plugins/claude-code-learner/skills/memory-consolidation/SKILL.md`
- Memory backends piggyback on the MCP-tool registration from Task 9 (memory backend = MCP server with embed/query/prune verbs).

- [ ] **Step 11.1: Reuse Task 9's MCP wiring**

A `memory-backend` slot is mechanically a specialized MCP tool. Per Task 9 wiring, the backend's `command` + `args` are merged into the harness's `.mcp.json`. The backend MCP server exposes three verbs by convention: `embed(text: string): vector`, `query(vector, k): []`, `prune(maxAgeDays): number`.

In `client/src/restorer/impls/claude-code-learner/mcp-config.ts`, extend the merger so memory-backend slots also map into `mcpServers`:

```ts
import type { MemoryBackendSlot } from '../../plug-ins/types.js';

export function mergeMemoryBackendsIntoMcpConfig(
  baseline: McpConfig,
  slots: ReadonlyArray<RegistrySlot<MemoryBackendSlot>>,
): McpConfig {
  const out: McpConfig = { mcpServers: { ...baseline.mcpServers } };
  for (const reg of slots) {
    const key = `memory-${reg.plugInName}`;
    if (key in out.mcpServers) {
      throw new Error(`MCP server name collision: ${key}`);
    }
    out.mcpServers[key] = { command: reg.slot.command, args: reg.slot.args };
  }
  return out;
}
```

- [ ] **Step 11.2: Update consolidator skill to use memory-backend MCPs when present**

Edit `client/plugins/claude-code-learner/skills/memory-consolidation/SKILL.md`. Add:

```markdown
## Plug-in memory backends

Consult `workingDir/.coordinator/slots.json`. For each entry in `memoryBackends`:

- The backend exposes MCP tools `embed(text: string)`, `query(vector, k: number)`, and `prune(maxAgeDays: number)` under the namespace `memory-<plugInName>` (replacing `/` with `_`).
- During curation, if the backend is the right policy match for this kind, call `mcp__<namespace>__embed` to index relevant artifacts and `mcp__<namespace>__query` to retrieve analogous prior cases.
- Multiple memory backends can coexist; each is a distinct MCP namespace. The consolidator decides per artifact which backend to use based on operator policy in `implStateDir/policy.json` (a `memoryBackend: { default?: string; perKind?: { kind: string } }` field; absent by default).

If no `memoryBackends` entries are present, fall back to the bundled file-based curation (the existing behaviour).
```

- [ ] **Step 11.3: Test**

Add to `mcp-config.test.ts`:

```ts
it('memory-backend slots merge under memory-* prefix', () => {
  const merged = mergeMemoryBackendsIntoMcpConfig(
    { mcpServers: {} },
    [{ plugInName: '@x/vec', packageRoot: '/tmp/vec', slot: { type: 'memory-backend', command: 'node', args: ['vec.js'] } }],
  );
  expect(merged.mcpServers).toHaveProperty('memory-@x/vec');
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/mcp-config.test.ts`
Expected: PASS.

- [ ] **Step 11.4: Commit**

```bash
git add client/src/restorer/impls/claude-code-learner/mcp-config.ts client/src/restorer/impls/claude-code-learner/mcp-config.test.ts client/plugins/claude-code-learner/skills/memory-consolidation/SKILL.md
git commit -m "Memory-backend plug-ins surface as MCP servers under memory-* namespace"
```

---

## Task 12: Hook integration

**Files:**
- Modify: `client/plugins/claude-code-learner/hooks/hooks.json`
- Modify: `client/plugins/claude-code-learner/skills/coordinator/SKILL.md`
- Test: `client/src/restorer/impls/claude-code-learner/hooks.test.ts`

Hook events: `session-start`, `pre-phase`, `post-phase`, `session-end`. Existing infrastructure has a `session-start` shell script the harness invokes. Path 1 `hook` slots get invoked at the appropriate event.

- [ ] **Step 12.1: Implementation choice — coordinator-driven hooks**

Pre-phase / post-phase / session-end events don't have existing harness hook integration (Claude Code's hook system fires on tool use, not on phase transitions). Two approaches:

(a) **Coordinator-driven.** The coordinator skill consults `slots.json.hooks[]` and invokes them via `Bash` at the right boundary. Markdown-only; no harness change.

(b) **Daemon-driven.** The daemon spawns a separate hook subprocess between phases. Requires harness-level coordination.

Phase 1 picks **(a)** — coordinator-driven. Daemon-side hooks defer to Phase 2.

- [ ] **Step 12.2: Update coordinator skill**

In `client/plugins/claude-code-learner/skills/coordinator/SKILL.md`, add (after the Pipeline section):

```markdown
## Plug-in hooks

Read `workingDir/.coordinator/slots.json`. For each `hooks[]` entry, retain it for invocation:

- `session-start` hooks run **once** before the first phase. The bundled session-start shell hook already ran during boot — these are *additional* hooks the plug-in author registered.
- `pre-phase` / `post-phase` hooks run before / after each phase. If `slot.phase` is set, only run for that phase.
- `session-end` hooks run after `memory-consolidation` (the last phase), regardless of failure.

Invoke each hook via `Bash`: `bash <packageRoot>/<entry>` with environment variables set:

- `JINN_INTENT_ID`, `JINN_INTENT_KIND`
- `JINN_PHASE` (for `pre-phase` / `post-phase`)
- `JINN_WORKING_DIR`, `JINN_IMPL_STATE_DIR`

Failures in hooks log a warning to `workingDir/.errors/hooks.log` but do not abort the session. The coordinator's failure handling continues unchanged.
```

- [ ] **Step 12.3: Test the hook event surface contract**

```ts
// client/src/restorer/impls/claude-code-learner/hooks.test.ts
import { describe, it, expect } from 'vitest';

describe('hook slot contract', () => {
  it('hooks.json lists session-start, pre-phase, post-phase, session-end events', () => {
    // Compile-time check via the schema's enum (re-asserted here so a future
    // schema bump that drops or adds an event triggers a test failure).
    const expected = ['session-start', 'pre-phase', 'post-phase', 'session-end'];
    // Check the schema literal:
    const schema = require('../../../schemas/jinn-plugin-v1.json');
    const events = schema.$defs.hook.properties.event.enum;
    expect(events).toEqual(expected);
  });
});
```

Run: `cd client && yarn vitest run src/restorer/impls/claude-code-learner/hooks.test.ts`
Expected: PASS.

- [ ] **Step 12.4: Commit**

```bash
git add client/plugins/claude-code-learner/skills/coordinator/SKILL.md client/src/restorer/impls/claude-code-learner/hooks.test.ts
git commit -m "Coordinator skill invokes plug-in hooks at session-start, pre/post-phase, session-end"
```

---

## Task 13: `jinn create plug-in` scaffolder

**Files:**
- Modify: `client/src/cli/commands/create.ts` (add `plug-in` kind branch)
- Create: `client/templates/plug-in/<slot-type>/` template trees (six)
- Test: extends `client/src/cli/commands/create.test.ts`

The scaffolder generates a Path 1 plug-in skeleton given a slot type.

- [ ] **Step 13.1: Author the six template trees**

For each slot type, create `client/templates/plug-in/<slot-type>/` with at minimum:

- `package.json.tmpl` — declares dependencies on `@jinn-network/restorer-sdk` if needed (memory-backend / mcp-tool slots that import the SDK; phase-agent / topic-explorer / skill-bundle / hook slots don't need it).
- `jinn-plugin.json.tmpl` — slot-shape-specific manifest.
- Slot-specific files:
  - `phase-agent-override`: `agents/<phase>-<agent>.md.tmpl` (markdown agent file).
  - `topic-explorer`: `agents/<topic>-explorer.md.tmpl`.
  - `mcp-tool`: `src/server.ts.tmpl` (minimal MCP server with one stub tool).
  - `skill-bundle`: `.claude-plugin/plugin.json.tmpl` + `skills/<skill-name>/SKILL.md.tmpl`.
  - `memory-backend`: `src/server.ts.tmpl` (MCP server with embed/query/prune stubs).
  - `hook`: `hooks/<event>.tmpl` (shell script).
- `test/manifest.test.ts.tmpl` — verifies the manifest validates against the schema.
- `README.md.tmpl` — quickstart explaining the slot and how to extend.
- `gitignore.tmpl`.

Each template uses the same `{{...}}` substitution convention as Plan 1's restorer templates.

(Per-template content is straightforward; the structural shape is dictated by §4.2 slot taxonomy. Each file is ~30-80 lines of templated content.)

- [ ] **Step 13.2: Extend `runCreate` to dispatch on `kind === 'plug-in'`**

Modify `client/src/cli/commands/create.ts`:

```ts
const PLUG_IN_PATTERN_FILES: Record<string, TemplateFile[]> = {
  'phase-agent-override': [
    { src: 'package.json.tmpl', dst: 'package.json' },
    { src: 'jinn-plugin.json.tmpl', dst: 'jinn-plugin.json' },
    { src: 'agents/agent.md.tmpl', dst: 'agents/{{phaseAgentName}}.md' },
    { src: 'test/manifest.test.ts.tmpl', dst: 'test/manifest.test.ts' },
    { src: 'README.md.tmpl', dst: 'README.md' },
    { src: 'gitignore.tmpl', dst: '.gitignore' },
  ],
  'topic-explorer': [/* analogous */],
  'mcp-tool': [/* */],
  'skill-bundle': [/* includes .claude-plugin/plugin.json.tmpl + skills/<skill-name>/SKILL.md.tmpl */],
  'memory-backend': [/* */],
  'hook': [/* */],
};

export interface RunCreatePlugInArgs {
  kind: 'plug-in';
  slotType: 'phase-agent-override' | 'topic-explorer' | 'mcp-tool' | 'skill-bundle' | 'memory-backend' | 'hook';
  packageName: string;
  phase?: string;
  agent?: string;
  topic?: string;
  event?: string;
  outDir: string;
}

export async function runCreate(args: RunCreateArgs | RunCreatePlugInArgs): Promise<void> {
  if (args.kind === 'restorer') {
    // … existing restorer flow from Plan 1 …
  } else if (args.kind === 'plug-in') {
    const files = PLUG_IN_PATTERN_FILES[args.slotType];
    if (!files) throw new Error(`unknown slot type: ${args.slotType}`);
    const targetRoot = join(args.outDir, args.packageName);
    const vars: Record<string, string | number> = {
      packageName: args.packageName,
      phase: args.phase ?? '',
      agent: args.agent ?? '',
      topic: args.topic ?? '',
      event: args.event ?? '',
      phaseAgentName: args.phase && args.agent ? `${args.phase}-${args.agent}` : 'agent',
    };
    for (const f of files) {
      const srcPath = join(TEMPLATES_ROOT, '../plug-in', args.slotType, f.src);
      const dstPath = join(targetRoot, substitute(f.dst, vars));
      const text = readFileSync(srcPath, 'utf8');
      mkdirSync(dirname(dstPath), { recursive: true });
      writeFileSync(dstPath, substitute(text, vars));
    }
  }
}
```

Update the `createCommand` CLI dispatch in the same file to accept `jinn create plug-in <packageName> --slot=<slotType> [--phase=...] [--agent=...] [--topic=...] [--event=...]`.

- [ ] **Step 13.3: Add scaffolder unit tests for each slot type**

Append six test blocks to `client/src/cli/commands/create.test.ts`, one per slot type. Each verifies the appropriate files emit (e.g., `phase-agent-override` emits `agents/<phase>-<agent>.md`; `mcp-tool` emits `src/server.ts`; `skill-bundle` emits `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`; etc.).

Run: `cd client && yarn vitest run src/cli/commands/create.test.ts`
Expected: PASS (forecaster + evaluator + alternative-harness from Plans 1+2 still pass; 6 new tests for plug-in slot types).

- [ ] **Step 13.4: Commit**

```bash
git add client/templates/plug-in/ client/src/cli/commands/create.ts client/src/cli/commands/create.test.ts
git commit -m "Add jinn create plug-in scaffolder with templates per slot type"
```

---

## Self-review

After implementing all 13 tasks, verify against `spec/2026-04-30-plug-in-surface.md` §4 and §7:

**Spec coverage check:**

| Spec section | Plan task | Status |
|---|---|---|
| §4.2 slot taxonomy | Tasks 1, 2, 3 (types + schema + registry) | ✅ |
| §4.3 trust model (host inheritance, no per-plug-in capabilities) | Task 4 step 4.4 — loader verifies name/version, no capability allow-list. | ✅ |
| §4.4.1 manifest schema | Task 2 | ✅ |
| §4.4.2 npm distribution | Task 6 (CLI add verb) | ✅ |
| §4.4.3 discovery + load at session-start | Tasks 3, 4 | ✅ |
| §4.4.4 lifecycle (once-per-process) | Task 5 (registry built once at boot, fed via env) | ✅ |
| §4.4.5 versioning + compatibility | Task 4 step 4.4 (semver range check) | ✅ |
| §4.6 scaffolder (`jinn create plug-in`) | Task 13 | ✅ |
| §7 acceptance #6 (six worked examples) | Plan 4 (next plan) | ⏭ deferred |
| §7 acceptance #8 (plug-in JSON schema published) | Task 2 | ✅ |
| §7 acceptance #9 (CLI verbs ship: `jinn plug-ins …`) | Task 6 | ✅ |

**Slot integration coverage:**

| Slot type | Integration task | Status |
|---|---|---|
| phase-agent-override | Task 7 | ✅ |
| topic-explorer | Task 8 | ✅ |
| mcp-tool | Task 9 | ✅ |
| skill-bundle | Task 10 | ✅ |
| memory-backend | Task 11 | ✅ |
| hook | Task 12 | ✅ |

**Placeholder scan:** Template TODOs (per-pattern templates) are intentional scaffolder fill-in markers, not plan placeholders. No real plan placeholders.

**Type consistency:** `Slot`, `JinnPlugInManifest`, `SlotRegistry`, `RegistrySlot`, `SerialisedRegistry` introduced in Tasks 2, 3, 4 and used consistently in Tasks 6–11. `ExternalPlugInEntry` introduced in Task 3 and used in Tasks 3, 5. Slot-type field names (`phase-agent-override`, `topic-explorer`, etc.) used identically in schema (Task 2), TS types (Task 3), and integration tasks (6–11).

---

## Next plans

After this plan ships:

- **Plan 4 (`2026-04-30-plug-in-surface-path-1-examples.md`)** — six Path 1 worked examples, one per slot category (calibration refiner, news-context topic, polymarket MCP, forecasting-techniques skill bundle, vector-store memory backend, pre-orient hook). Spec §4.7 + §7 acceptance #6.
- **Plan 5 (`2026-04-30-plug-in-surface-docs-and-cross-spec.md`)** — Path 1/2 documentation indices + cross-references in the five extension-branch specs (filed as separate beads). Spec §7 acceptance #2, #7, #10.

When all five plans are shipped, the spec's §7 acceptance criteria are met and the Phase A.4 campaign-launch gate is unblocked.
