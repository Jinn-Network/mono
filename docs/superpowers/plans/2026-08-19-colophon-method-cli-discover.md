# Colophon Method Catalog Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Colophon method catalog enumerable and documented, add `--n` and GNU-style flags, ship verb-specific help and a GUI catalog bind, without a one-shot `run` verb or unified `-d/-a/-m`.

**Architecture:** List and help are CLI-only (parity stays 40). `--n` and known-id errors live in `resolveMethodOperand`. `--host` stays the pin file; catalog rows publish `hostKeys`. GUI catalog bind is a second form of existing `method.bind`. Doctor then quote remains the dry-run.

**Tech Stack:** TypeScript, Vitest, existing Colophon CLI parser, Next.js server actions.

## Global Constraints

- American English (`distill`, never `distil`).
- Do not amend `GROWTH.md`.
- Do not rename sealed `one_task|ten_task|full|custom`, `inspect`, `lock`, or `export`.
- Do not add `colophon run` or `-d/-a/-m`.
- Do not delete `import swebench`.
- Do not add a facade operation for catalog list (do not export `METHOD_CATALOG` from `operations/index.ts`).
- Re-export `METHOD_CATALOG` from `packages/benchmark-product/core/src/index.ts` only.
- Do not commit `node_modules`.
- TDD: failing test first.
- Human-surface: independent review, no agent self-merge.
- Issue [#2840](https://github.com/Jinn-Network/mono/issues/2840). DR-2026-08-19.

---

### Task 1: GNU parseArgs

**Files:**
- Modify: `packages/benchmark-product/core/src/cli/args.ts`
- Test: `packages/benchmark-product/core/src/cli/args.test.ts`

**Interfaces:**
- Produces: `parseArgs` accepts interleaved words and `--flags`; `--` terminator; boolean flags never consume the next positional.
- Boolean names: `help`, `json`, `include-native-artifacts`, `ack-provider-network-costs`.

- [ ] Write failing tests: mixed `["method", "--slice", "1", "terminal-bench-2.1"]` → words `["method","terminal-bench-2.1"]`, flag slice `1`; `["method", "--json", "terminal-bench-2.1"]` → json `""` and words include the catalog id; `["method", "--", "--not-a-flag"]` → words include `--not-a-flag`; replace "positional after first flag refuses" with the mixed-success case; repeated flags still refuse.
- [ ] Implement: scan argv; on `--` remaining tokens are words; `--name` in the boolean set is valueless even if the next token does not start with `--`; other flags keep today's value/boolean heuristic; `--flag=value` unchanged.
- [ ] Run: `cd packages/benchmark-product/core && yarn test src/cli/args.test.ts`
- [ ] Do not commit (coordinator owns stacked branches).

---

### Task 2: Catalog hostKeys, list helper, `--n`, known ids

**Files:**
- Modify: `packages/benchmark-product/core/src/operations/method-catalog.ts`
- Modify: `packages/benchmark-product/core/src/operations/method-catalog.test.ts`
- Modify: `packages/benchmark-product/core/src/operations/method.ts` (`SelectMethodInput` already extends `ResolveMethodOperandInput`; add `n?: string` there)
- Modify: `packages/benchmark-product/core/src/index.ts` — re-export `METHOD_CATALOG`, `isMethodCatalogId`, `listMethodCatalog` from `./operations/method-catalog.js` (not from `operations/index.ts`)

**Interfaces:**
- `MethodCatalogRow` gains `readonly hostKeys: readonly string[]` (required host JSON keys, no coverage/ids).
- TB 2.1 / 3.0 hostKeys: `executable`, `registryMetadataPath`, `datasetRevision`, `taskMaterialPath`, `arms`, `environment`, `outputs`.
- SWE-Verified / APEX-Agents: `executable`, `registryMetadataPath`, `arms`.
- APEX-SWE-dev: `apxExecutable`, `pythonExecutable`, `registryMetadataPath`, `integrationTasksDir`, `observabilityProjectDir`, `arms`.
- `export function listMethodCatalog(): ReadonlyArray<{ id: MethodCatalogId } & MethodCatalogRow>`
- `export function knownCatalogIds(): string` — comma-separated ids in catalog order.
- `ResolveMethodOperandInput` gains `readonly n?: string`.
- `--n` parse: positive integer (`/^[1-9][0-9]*$/`); refuse `--n` with `--slice` or `--ids`; refuse `--n` on file operand; require host; read `host.registryMetadataPath`; parse with existing suite Zod schemas; extract ids (`task_ids[].name` TB, `instance_ids` SWE, `task_ids` APEX-Agents, `tasks[].taskId` APEX-SWE-dev); `namedSliceTaskNames(ids, "full").slice(0, n)`; refuse N > inventory; `coverageFromSelectedNames`; if named slice omit `selectedIds` and set `coverage`; if custom set `selectedIds`.
- Failed neither-suite-nor-file message includes `known catalog ids: ${knownCatalogIds()}`.

- [ ] Write failing tests in `method-catalog.test.ts` for hostKeys snapshot, list length 5, failed-ref known ids, `--n` vs slice/ids, `--n 1` → `one_task` with a tiny registry fixture, `--n` on file refused, N too large refused.
- [ ] Implement.
- [ ] Run: `yarn test src/operations/method-catalog.test.ts`
- [ ] Do not commit.

---

### Task 3: CLI list, verb help, USAGE, `--n` flag

**Files:**
- Modify: `packages/benchmark-product/core/src/cli/main.ts`
- Modify: `packages/benchmark-product/core/src/cli/method-cli.test.ts`

**Interfaces:**
- `METHOD_FLAGS` adds `n`.
- `handleMethodBind`: `words.length === 1` → list via `listMethodCatalog()`; known flags `json` only; human stdout is a table (id, protocol, framework, derivedExport); json `{ ok: true, result: { catalog } }` (no journal). `words.length === 2` bind as today plus `n: optional(args, "n")`. Else refuse exactly one operand **or** none for list (so 3+ words still refuse).
- `runCli`: if `present(help)` or `words[0]==="help"`: if remaining words match a verb, print that verb's help (exit 0); else USAGE. Bare `--help` / no args still USAGE.
- `METHOD_HELP` (or equivalent): catalog ids, hostKeys table, `--slice`/`--ids`/`--n`/`--host`, doctor → quote → lock → launch, two SWE doors.
- Other verbs: matching USAGE line(s) is enough.
- USAGE `method` line includes `[--n <count>]`. USAGE `import swebench` line notes homemade rows (not official Verified). USAGE `method` notes catalog id or file.

- [ ] Rewrite `method without an operand refuses` to list success with `--json` containing all five ids; add `method --help` contains `terminal-bench-2.1` and `--host`; add mixed-flag bind still reaches selectMethod (may fail later on missing host — parse must not be "unexpected argument").
- [ ] Implement.
- [ ] Run: `yarn test src/cli/method-cli.test.ts src/cli/args.test.ts src/cli/lexicon.test.ts`
- [ ] Do not commit.

---

### Task 4: GUI catalog bind

**Files:**
- Modify: `packages/benchmark-product/web/src/app/actions.ts` (`methodBindAction`)
- Modify: `packages/benchmark-product/web/src/app/workspace/[draftId]/page.tsx`
- Modify: `packages/benchmark-product/web/src/app/workspace/[draftId]/page.test.tsx`

**Interfaces:**
- If `ref` is a catalog id: require host JSON (`host` textarea or uploaded `hostFile`); pass `selectMethod({ draftId, ref, cwd, hostPath, slice?, ids?, n? })` with temp host file; `try/finally` rm temp dir.
- If `configuration` present: today's Inspect file bind.
- If both or neither: refuse `invalid-invocation`.
- Page: second form submit label `Bind catalog suite`; select `name="ref"` options from `METHOD_CATALOG` keys; host textarea `name="host"`; optional slice/n/ids fields. Relabel Inspect submit to `Bind Inspect method`. Relabel SWE intake to homemade rows (not official Verified). No caption-only helper text.

- [ ] Failing page test: markup contains `Bind catalog suite` and `Bind Inspect method` and homemade SWE label; not only `Select Inspect evaluation`.
- [ ] Implement.
- [ ] Run web tests for the page and any action tests.
- [ ] Do not commit.

---

### Task 5: Runbooks

**Files:** the five `docs/runbooks/*-official-one-task.md` files — one sentence each that `colophon method --help` lists `--host` keys and `--n` is first N from the registry. Do not rewrite the qualify flows.

- [ ] Surgical one-sentence add near the existing `colophon method` invocation.
- [ ] Do not commit.
