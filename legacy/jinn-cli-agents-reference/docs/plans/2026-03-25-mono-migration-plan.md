# Migration Plan: jinn-gemini → jinn-network/mono

> Date: 2026-03-25
> Status: Checklist — not yet executed

This plan identifies what to migrate from jinn-gemini to the new mono repo, how to adapt each item, and what to explicitly leave behind. The goal is to bring **knowledge, not implementation** — accumulated wisdom without dragging the new repo toward the old architecture.

---

## Guiding Principles

1. **Bring knowledge, not code** — docs, skills, patterns, and hard-won rules. Not implementations.
2. **Adapt terminology** — see [Terminology Map](#terminology-migration-map) below.
3. **Strip anything that assumes the old dispatch/worker model** — no ventures, workstreams, dispatch loops.
4. **Memory/knowledge is the moat** — the knowledge system concepts are the most important thing to preserve.
5. **OLAS Phase 0 gets its own box** — isolated, clearly marked, deletable when Phase 1 launches.

---

## Target Directory Layout (mono)

```
mono/
├── CLAUDE.md                           # Agent instructions (adapted)
├── package.json                        # Monorepo root
├── spec/                               # Protocol + implementation specs (already there)
├── .claude/
│   └── skills/                         # Symlinked from skills/
├── skills/                             # Curated skill catalog
│   ├── README.md
│   ├── ponder/
│   ├── ponder-deploy/
│   ├── maintain-docs/
│   ├── conversation-processor/
│   ├── jpeg-your-ideas/
│   ├── knowledge-system/               # NEW — drawn from memory concepts
│   ├── node-operations/                # NEW — replaces setup-worker/deploy-worker
│   └── olas-phase0/                    # OLAS skills bundled for Phase 0
├── docs/
│   ├── context/
│   │   ├── network-thesis.md           # Adapted
│   │   └── knowledge-system.md         # NEW — memory architecture is the moat
│   ├── guides/
│   │   ├── writing-desired-states.md   # Adapted from writing-invariants.md
│   │   ├── code-spec.md               # Nearly verbatim
│   │   └── code-spec-usage.md
│   ├── reference/
│   │   ├── blood-written-rules.md      # Filtered — universal rules only
│   │   └── environment-variables.md
│   └── runbooks/
│       └── git-operations.md
├── codespec/                           # Code quality enforcement — verbatim
├── ponder/                             # Indexer (skeleton for new events)
├── node/                               # Client/node runtime (new code)
├── contracts/                          # JINN token, ve-JINN, distribution (new code)
├── scripts/
│   ├── sync-skills.ts                  # Skills distribution
│   └── lib/                            # Shared utilities
└── packages/
    └── olas-compat/                    # Phase 0 OLAS compatibility (isolated)
```

---

## Phase 1: Foundation (Knowledge Layer)

The accumulated wisdom that is repo-independent.

### 1A. Blood Written Rules (filtered)

- [ ] **Source:** `docs/reference/blood-written-rules.md`
- [ ] **Destination:** `mono/docs/reference/blood-written-rules.md`

**Bring (universal rules):**

| Rules | Topic | Why Universal |
|-------|-------|---------------|
| 1–4 | RPC rate limits, IPFS timeouts, tx retries, undelivered set reverts | Blockchain/IPFS knowledge applies to any on-chain system |
| 11 | Recognition learning mimicry | Universal agent behavior — framing memory as history not instructions |
| 13 | Date scope confusion | Universal LLM prompting lesson |
| 14 | Token overflow from node_modules | Universal agent workspace management |
| 15–20 | Git operation gotchas | Universal |
| 28–33 | Ponder indexing lessons | Directly reusable — new system also uses Ponder |
| 36 | Infinite re-execution loop | Pattern applies to any claim-execute-deliver cycle |
| 37 | Lingering spawned agent processes | Universal |
| 45 | Browser automation conflicts | Universal |
| 52 | IPFS wrap-with-directory | Universal IPFS knowledge |
| 57–58 | Agent CLI hang issues | Universal agent spawning |
| 64 | Unbound Pino logger methods | Universal TypeScript gotcha |
| 72 | Embedded git credentials | Universal credential management |
| 77 | Keystore IV too short | Universal crypto gotcha |
| 79 | Pin git deps by commit SHA | Universal |

**Adapt:** Apply terminology map. Replace "worker" → "node", "mech" → "executor/node".

**Do NOT bring:**

| Rules | Topic | Why Skip |
|-------|-------|----------|
| 5–10 | Dispatch/child/parent model | Old architecture specific |
| 21–27 | Dispatch and workstream specifics | Old model |
| 34–35, 38–40 | Worker orchestration details | Old model |
| 41–44 | Old MCP tool specifics | Will be redesigned |
| 46–51, 59–63, 66–71, 73–76 | OLAS wallet/staking/middleware | → move to Phase 0 appendix |
| 53–56 | Old worker operational details | Old model |
| 80–85 | Old E2E testing, venture specifics | Old model |

### 1B. Network Thesis

- [ ] **Source:** `docs/context/network-thesis.md`
- [ ] **Destination:** `mono/docs/context/network-thesis.md`

**Adaptations needed:**
- Replace "invariant restoration" → "state restoration" throughout
- "Distributed Execution Memory" section maps directly to the new Knowledge stage
- "Verification Roadmap" (Optimistic → TEE → ZK) aligns with phased rollout — update to reference new spec phases
- Update "Node Economics" to reference JINN token and ve-JINN gauge
- Remove Moltbook-specific demo references; generalize
- Add references to ERC-8183 (jobs) and ERC-8004 (knowledge)
- The core thesis — distributed execution memory is the moat — is more true than ever

### 1C. Writing Desired States Guide

- [ ] **Source:** `docs/guides/writing-invariants.md`
- [ ] **Destination:** `mono/docs/guides/writing-desired-states.md`

**What to keep:**
- The four constraint types (FLOOR, CEILING, RANGE, BOOLEAN) — excellent, protocol-agnostic
- Assessment methodology
- Voice guidelines
- Anti-patterns section

**What to adapt:**
- "Invariants" → "desired state constraints" (or keep "invariants" as sub-concept)
- Remove template/blueprint-specific framing
- Remove tool-specific references (blog_get_stats, etc.)
- Remove `{{handlebars}}` variable substitution specifics

### 1D. Code Quality System

- [ ] **Source:** `codespec/` (entire directory) + `docs/guides/code-spec.md` + `docs/guides/code-spec-usage.md`
- [ ] **Destination:** `mono/codespec/` + `mono/docs/guides/code-spec.md`

**Adaptation:** Minimal.
- Three objectives (Orthodoxy, Discoverability, Security) are protocol-agnostic
- Four rules (No Secrets, Auto Guard, Preflight, No Silent Catch) are universal TypeScript
- Remove `gemini-agent/` path references
- Update "Mech delivery" examples → "Node delivery"

---

## Phase 2: Skills System

### 2A. Skills Infrastructure

- [ ] **Source:** `skills/README.md` + `scripts/sync-skills.ts`
- [ ] **Destination:** `mono/skills/README.md` + `mono/scripts/sync-skills.ts`

The multi-agent distribution pattern (skills/ → .claude/skills/, .gemini/skills/) is excellent and protocol-agnostic. Keep it.

### 2B. Skills to Bring

| Skill | Adaptation | Value |
|-------|-----------|-------|
| `ponder/` | Verbatim — Ponder carries over directly | HIGH |
| `ponder-deploy/` | Verbatim | HIGH |
| `maintain-docs/` | Verbatim — generic doc maintenance | HIGH |
| `conversation-processor/` | Verbatim — generic | MEDIUM |
| `jpeg-your-ideas/` | Verbatim — generic creative skill | MEDIUM |
| `local-dev-stack/` | Adapt to new stack components | MEDIUM |
| `node-e2e-testing/` | Adapt refs from jinn-node → node/ | MEDIUM |

### 2C. Skills to NOT Bring

| Skill | Why |
|-------|-----|
| `ventures/`, `services/`, `templates/` | Old model — venture/workstream concepts |
| `onboard/` | Tied to OLAS operate-profile flow |
| `deploy-worker/`, `setup-worker/`, `fleet-management/` | Old deployment model |
| `analyzing-workstreams/`, `analyzing-workstreams-cli/` | Old terminology (extract debugging methodology into a generic skill instead) |
| `launcher-growth/` | Venture-specific growth strategy |
| `deploy-frontend/` | Will be redesigned |

### 2D. OLAS Phase 0 Skills (bundled)

- [ ] Bundle into `mono/skills/olas-phase0/SKILL.md` or `mono/packages/olas-compat/skills/`:
  - `olas-registry/`
  - `olas-staking/`
  - `olas-service-preflight/` (rename to `olas-phase0-preflight`)
  - `activity-checker-whitelist/`
  - `deploy-staking/`

**Mark clearly as Phase 0 only.** Nothing outside olas-compat should depend on these.

### 2E. New Skills to Create (stubs)

- [ ] `knowledge-system/` — how the memory/knowledge system works (drawn from recognition/reflection concepts)
- [ ] `node-operations/` — how to run a node (replaces setup-worker + deploy-worker)
- [ ] `desired-states/` — how to define and submit desired states

---

## Phase 3: Agent Configuration

### 3A. CLAUDE.md

- [ ] **Source:** `CLAUDE.md`
- [ ] **Destination:** `mono/CLAUDE.md`

**Significant rewrite needed:**

| Section | Action |
|---------|--------|
| System Architecture | Replace dispatch event loop with Creation → Restoration → Evaluation → Knowledge |
| Key Components | Node (replaces Worker), Agent, Ponder (kept), Knowledge API (replaces Control API) |
| Memory System | Elevate — reference ERC-8004, distributed knowledge, LSH anti-farming |
| Quick Start | Keep pattern, update commands |
| Monorepo Layout | Update to new directory structure |
| Key Commands | Update for new CLI surface |
| MCP Tools | Remove old tool list; stub new tools |
| Blueprint Design | Replace with Desired State Design |
| Blood Written Rules Top 9 | Replace with universal rules from filtered set |

**Remove entirely:** venture/workstream terminology, dispatch model, IPFS delivery section (implementation detail), jinn-node sync section.

### 3B. .claude/ Directory

- [ ] Set up `.claude/skills/` symlinks to `skills/` directory
- [ ] Set up `.claude/commands/` for new repo commands

---

## Phase 4: Ponder Knowledge

- [ ] **Source:** `skills/ponder/SKILL.md` (comprehensive reference — verbatim)
- [ ] **Source:** `skills/ponder-deploy/` (deployment patterns)
- [ ] **Source:** Blood written rules 28–33 (Ponder gotchas)
- [ ] **Destination:** `mono/ponder/` (skeleton) + `mono/skills/ponder/`

**Bring:** Skill knowledge, configuration patterns, deployment expertise.
**Do NOT bring:** Implementation code (schema, handlers, ABIs) — too coupled to old contracts.

Schema terminology mapping for new Ponder:
- `request` → `restoration_job`
- `delivery` → `evaluation_record`
- `workstream` → remove
- `jobDefinition` → `desired_state`
- `artifact` → `knowledge_artifact`

---

## Phase 5: Knowledge System Architecture (CRITICAL)

This is the most important conceptual migration. Distributed execution memory is the protocol's moat.

- [ ] **Destination:** `mono/docs/context/knowledge-system.md`

**Draw from these sources (docs only, not code):**

| Source | What to Extract |
|--------|----------------|
| `docs/context/network-thesis.md` §"Distributed execution memory" | The moat thesis, replacement cost argument |
| `CLAUDE.md` §"Memory System" | Two pathways: semantic embeddings + tag-based retrieval |
| `worker/recognition/` (concepts only) | SITUATION artifact concept, query-before-execute pattern |
| `worker/reflection/` (concepts only) | Create-memory-after-execute pattern |
| `scripts/memory/inspect-situation.ts` (patterns only) | How to inspect and debug knowledge |
| `scripts/benchmark-memory-system.ts` (patterns only) | How to measure knowledge system performance |
| Blood Written Rule 11 | Recognition mimicry — frame memory as history not instructions |

**Adapt terminology:**
- SITUATION artifacts → Knowledge Records (aligns with ERC-8004)
- Recognition phase → Knowledge Retrieval
- Reflection phase → Knowledge Creation
- The core loop is identical: **retrieve knowledge → execute → create new knowledge**

**Add new concepts from spec:**
- ERC-8004 knowledge discovery and reputation
- LSH anti-farming decay mechanism
- x402 payment-gated knowledge access
- Evidence integrity (optimistic → ZK)

---

## Phase 6: OLAS Phase 0 Compatibility

- [ ] **Destination:** `mono/packages/olas-compat/`

Self-contained package for Phase 0 OLAS compatibility.

**Sources:**
- `docs/context/olas-integration.md`
- `docs/context/olas-protocol.md`
- `docs/reference/olas-contracts.md`
- `docs/reference/olas-custom-service-registration.md`
- `docs/reference/jinn-staking.md`
- Skills listed in §2D above
- Blood written rules 46–47, 59–63, 66–71, 73–76

**Principle:** This package should be deletable when Phase 1 launches. Nothing outside it depends on OLAS concepts.

---

## Phase 7: Scripts (selective)

### Bring

| Script | Adaptation |
|--------|-----------|
| `scripts/sync-skills.ts` | Update paths for new repo layout |
| `scripts/memory/inspect-situation.ts` | Adapt to "knowledge record" terminology |
| `scripts/inspect-job-run.ts` | Generalize to "inspect execution" |
| `scripts/benchmark-memory-system.ts` | Adapt to "knowledge system benchmark" |
| `scripts/shared/git-url.ts` | Verbatim — universal utility |
| `scripts/shared/github.ts` | Verbatim — universal utility |

### Do NOT Bring (~270 scripts)

All scripts containing "dispatch", "launch", "venture", "workstream", "service", "redispatch", "template" in the name. Also: all OLAS operation scripts (move to olas-compat if needed), all archive/ scripts, all debug/ scripts tied to old architecture.

---

## Terminology Migration Map

| Old (jinn-gemini) | New (mono) | Notes |
|---|---|---|
| venture | desired state | Top-level goal definition |
| workstream | restoration attempt | An attempt to achieve a desired state |
| blueprint / template | desired state definition | What "true" looks like |
| invariant | constraint | Keep as sub-concept within desired states |
| worker | node | The execution unit |
| mech | executor / node | Generalize from OLAS-specific term |
| dispatch_new_job | submit_restoration | New tool name |
| recognition | knowledge retrieval | Pre-execution memory lookup |
| reflection | knowledge creation | Post-execution memory generation |
| SITUATION artifact | knowledge record | ERC-8004 aligned |
| workstreamId | restorationId | Attempt identifier |
| jobDefinitionId | desiredStateId | State definition identifier |
| requestId | jobId | ERC-8183 aligned |
| control API | knowledge API | Write gateway |

---

## Explicit DO NOT BRING List

These items would push mono toward jinn-gemini's architecture:

1. `blueprints/` and `configs/` — 75+ venture-specific files
2. `control-api/` — will be redesigned as Knowledge API
3. `frontend/` — will be redesigned
4. `services/` — OLAS service management
5. `olas-operate-middleware/` — Python middleware, OLAS-specific
6. `migrations/` and `supabase/` — old database schemas
7. `prompts/` — old prompt templates
8. `worker/mech_worker.ts` and full worker loop — too coupled
9. `gemini-agent/mcp/tools/` (57 tools) — tightly coupled to dispatch/venture model
10. `docs/context/venture-workstream-separation.md`
11. `docs/context/workstream-model.md`
12. `docs/context/parent-child-flow.md`
13. `docs/reference/dispatch-types.md`
14. `docs/reference/ventures.md`
15. `docs/guides/creating-ventures.md`
16. `docs/guides/managing-services.md`
17. `docs/guides/blueprints_and_templates.md`
18. `docs/plans/` — old implementation plans
19. Any script with "venture", "workstream", "dispatch", "launch" in the name

---

## Implementation Order

| Step | Phase | Effort | Dependencies |
|------|-------|--------|-------------|
| 1 | Repo structure | Set up package.json, tsconfig, basic tooling | None |
| 2 | Phase 1 (Foundation) | Migrate + adapt blood rules, thesis, invariants guide, codespec | Step 1 |
| 3 | Phase 2+3 (Skills + Agent) | Skills infra, curated skills, CLAUDE.md | Step 1 |
| 4 | Phase 5 (Knowledge System) | Write knowledge-system.md from old memory concepts + new spec | Step 2 |
| 5 | Phase 4 (Ponder) | Ponder skill knowledge, skeleton | Step 1 |
| 6 | Phase 6 (OLAS Phase 0) | Isolated olas-compat package | Step 1 |
| 7 | Phase 7 (Scripts) | Selective script migration | Step 1 |

Steps 2–7 can largely be parallelized after Step 1.
