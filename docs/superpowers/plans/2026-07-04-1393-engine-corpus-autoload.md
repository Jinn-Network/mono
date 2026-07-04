# Engine Corpus Knowledge Autoload (#1393) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a successful claim and before harness spawn, the engine auto-loads the top ~3 corpus solution records for the task's solverType into `task.context.corpusKnowledge`, preferring higher evidence tiers, never blocking the solve path, opt-out via `engine.knowledgeAutoload`, and proven end-to-end in the Anvil daemon-harness e2e.

**Architecture:** A new pure retrieval module (`corpus-knowledge.ts`) reuses `handleSearchRecords` (projections + local artifacts + optional network corpus), ranks by evidence tier then recency, and returns a self-describing payload (artifact refs embed `acquire_artifact` arguments). `TaskEngine.runImpl()` injects the payload into a shallow clone of the runtime Task's `context` (same side-channel as evaluation tasks' `context.restorationResult`) for restoration runs only; the consumed refs are persisted as a new `consumed_refs_json` column and emitted as a `corpus_knowledge` lifecycle event. `pack()` gains the missing production call to `saveEnvelopeProjection(projectEnvelope(...))` so an operator's own published work is its first knowledge source — which is what makes the e2e work with no indexer infra.

**Tech Stack:** TypeScript (Node 22), Vitest, better-sqlite3, Zod, existing corpus/MCP modules. No new dependencies.

## Global Constraints

- Branch: `feat/1393-engine-corpus-autoload` in worktree `/Users/gcd/Repositories/main/jinn-mono_worktrees/1393` (based on `origin/next`).
- All commands below run from `/Users/gcd/Repositories/main/jinn-mono_worktrees/1393/client` unless stated otherwise.
- Corpus failure must NEVER block the claim/solve path: try/catch + `Promise.race` timeout (default 10 000 ms); on failure log a warning, inject nothing, proceed (AC3).
- Restoration runs only (`taskRole === 'restoration'`) — never bias evaluators with prior solutions.
- The injected context is never persisted into the signed Task and never re-hashed (envelope integrity references `taskCid`; evaluators re-fetch the signed task). No `HarnessContext` field, no env vars, no prompt-template changes.
- Opt-out config `engine.knowledgeAutoload` (boolean, default **true**; env `JINN_ENGINE_KNOWLEDGE_AUTOLOAD`).
- Surgical changes: match existing style; British English in prose; no emoji.
- Conventional commit prefix: `feat(engine): …` with issue ref `#1393`.
- The full `yarn e2e:daemon-harness` needs a fork of Base + (for non-default harnesses) an API key; the second-task leg lives inside `main()` after the existing key-check skip, so it inherits the existing clean-skip conditions. Treat the live e2e run as the Task 8 integration verification, not a per-task gate.

## Verified reality vs the design note (corrections)

All paths/symbols in the design note were verified against the worktree. Three deviations, adopted below:

1. **`emitEvent` kinds are a closed union.** `emitEvent(store, event, component)` takes a `LifecycleEvent` whose `kind` must be in `ALLOWED_LIFECYCLE_KINDS` (`client/src/observability/emit-event.ts`), and it has no free-form payload — only a `detail` string. So Task 4 adds `'corpus_knowledge'` to `ALLOWED_LIFECYCLE_KINDS` and serialises the refs into `detail` (the design's `emitEvent('corpus_knowledge', { requestId, refs })` shape does not exist).
2. **Do not pass `taskCid` to `projectEnvelope` in `pack()`.** `resolveProjectedTaskCid` gives `options.taskCid` top precedence; for evaluation runs that would stamp the *evaluation* task's CID and defeat the `solutionTaskCid` context-key mapping used for verdict projections. `envelope.task.cid` already equals `task.taskCid` (set at `engine.ts:1686`), so `projectEnvelope(envelope, { envelopeCid, task: task.task })` is both simpler and correct for all roles.
3. **`_daemon-harness-helpers.ts` needs no changes.** `RunningDaemon` already exposes `store: Store`, `startDaemon` already omits `corpusFactory` (store-only knowledge path), and `waitForDaemonClaim` filters by on-chain `taskId` so a second `postPredictionV1Task` call needs no helper support. The touch list shrinks accordingly.

Other verified anchors (line numbers as of `c94f85b0d`): `runImpl` at `engine.ts:1190`, `HarnessContext` assembly at `:1236`, the two POST_SNAPSHOT `persistence.transition` patches carrying `runtimePluginsJson` at `:1299` and `:1351`, `assembleAndSignEnvelope` destructure at `:1719` (it already returns `envelope` — just widen the destructure), transient-map cleanup at `:1766-1770`, `TaskEngineOptions` at `:220`, constructor at `:470`. `handleSearchRecords(corpus, store, args)` in `client/src/mcp/search-records.ts:298` accepts `{ solverType, role, limit }` and works with `corpus === null` (projection + local-artifact results, warning attached). `Store.saveEnvelopeProjection` (`store.ts:2501`) is an upsert (`ON CONFLICT(envelope_id) DO UPDATE`), so a `pack()` retry is safe. `Daemon.start()` builds the corpus at `daemon.ts:330-332`; `createCorpus` (`client/src/corpus/index.ts:70`) is pure closure construction (no store writes), so hoisting to the constructor respects the #649 ordering constraint — and `test/daemon/daemon-start-order.test.ts` (which pushes a marker from `corpusFactory`) still passes because a constructor-time call is still before all store mutations.

## File Structure

- **Create** `client/src/harnesses/engine/corpus-knowledge.ts` — pure retrieval/ranking module; only new file with logic.
- **Create** `client/test/harnesses/engine/corpus-knowledge.test.ts` — loader unit tests + engine injection/opt-out/role-gate/projection tests.
- **Modify** `client/src/config.ts` — `engine.knowledgeAutoload` schema field, env override, resolved type + default, `TRACKED_ENV_VARS` entry.
- **Modify** `client/src/observability/emit-event.ts` — add `'corpus_knowledge'` lifecycle kind.
- **Modify** `client/src/harnesses/engine/persistence.ts` — `consumed_refs_json` column (schema, migration, row mapping, patch).
- **Modify** `client/src/harnesses/engine/engine.ts` — `knowledge` option, injection in `runImpl`, consumed-refs persistence + event, projection call in `pack`, transient cleanup.
- **Modify** `client/src/daemon/daemon.ts` — hoist corpus construction to the constructor; thread corpus into the engine.
- **Modify** `client/src/main.ts` — thread `knowledge: { enabled: config.engine.knowledgeAutoload }` into `restorationEngine`.
- **Modify** `client/test/config.test.ts`, `client/test/harnesses/engine/persistence.test.ts` — targeted new cases.
- **Modify** `client/test/e2e/daemon-harness-cycle.ts` — second-task corpus-knowledge leg (AC4).
- **Modify** `CLAUDE.md` (repo root) — config-table row.

---

### Task 1: Config flag `engine.knowledgeAutoload`

**Files:**
- Modify: `client/src/config.ts` (schema ~line 448, env block ~line 1035, `JinnConfig` type ~line 636, resolution ~line 1208, `TRACKED_ENV_VARS` ~line 1301)
- Modify: `CLAUDE.md` (config table, after the `engine.implStateDirRoot` row)
- Test: `client/test/config.test.ts`

**Interfaces:**
- Produces: `JinnConfig['engine']` gains `knowledgeAutoload: boolean` (always resolved, default `true`). Consumed by Task 6 (`main.ts`).

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block at the end of `client/test/config.test.ts` (reuse the file's mkdtemp/writeFile pattern):

```ts
describe('engine.knowledgeAutoload (#1393)', () => {
  const dirs: string[] = [];
  const originalEnv = process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    } else {
      process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = originalEnv;
    }
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  const writeConfig = async (body: Record<string, unknown>): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-test-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(body));
    return configPath;
  };

  it('defaults to true when neither file nor env sets it', async () => {
    delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    const config = loadConfig(await writeConfig({}));
    expect(config.engine.knowledgeAutoload).toBe(true);
  });

  it('respects engine.knowledgeAutoload: false from the config file', async () => {
    delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: false } }));
    expect(config.engine.knowledgeAutoload).toBe(false);
  });

  it('JINN_ENGINE_KNOWLEDGE_AUTOLOAD=0 overrides a file-set true', async () => {
    process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = '0';
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: true } }));
    expect(config.engine.knowledgeAutoload).toBe(false);
  });

  it('JINN_ENGINE_KNOWLEDGE_AUTOLOAD=true enables it over a file-set false', async () => {
    process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = 'true';
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: false } }));
    expect(config.engine.knowledgeAutoload).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run test/config.test.ts -t knowledgeAutoload`
Expected: FAIL — `config.engine.knowledgeAutoload` is `undefined` (property does not exist yet); the env-override cases fail likewise.

- [ ] **Step 3: Implement the config flag**

In `client/src/config.ts`:

(a) Schema (~line 448) — add the field:

```ts
  engine: z
    .object({
      workingDirRoot: z.string().optional(),
      implStateDirRoot: z.string().optional(),
      /**
       * Auto-load top-3 corpus solution records for the task's solverType
       * into task.context.corpusKnowledge before each restoration harness
       * spawn (#1393). Default true; env JINN_ENGINE_KNOWLEDGE_AUTOLOAD.
       */
      knowledgeAutoload: z.boolean().optional(),
    })
    .optional(),
```

(b) `JinnConfig` type (~line 636):

```ts
  engine: { workingDirRoot: string; implStateDirRoot: string; knowledgeAutoload: boolean };
```

(c) Env override block (~line 1035) — widen the condition and merge:

```ts
  if (
    env['JINN_ENGINE_WORKING_DIR_ROOT'] ||
    env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] ||
    env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] !== undefined
  ) {
    const prev = typeof merged['engine'] === 'object' && merged['engine'] !== null
      ? (merged['engine'] as Record<string, unknown>)
      : {};
    merged['engine'] = {
      ...prev,
      ...(env['JINN_ENGINE_WORKING_DIR_ROOT'] ? { workingDirRoot: env['JINN_ENGINE_WORKING_DIR_ROOT'] } : {}),
      ...(env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] ? { implStateDirRoot: env['JINN_ENGINE_IMPL_STATE_DIR_ROOT'] } : {}),
      ...(env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] !== undefined
        ? { knowledgeAutoload: ['1', 'true', 'yes'].includes(env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'].trim().toLowerCase()) }
        : {}),
    };
  }
```

(d) Resolution (~line 1208):

```ts
    engine: {
      workingDirRoot: parsed.engine?.workingDirRoot ?? DEFAULT_ENGINE.workingDirRoot,
      implStateDirRoot: parsed.engine?.implStateDirRoot ?? DEFAULT_ENGINE.implStateDirRoot,
      knowledgeAutoload: parsed.engine?.knowledgeAutoload ?? true,
    },
```

(e) `TRACKED_ENV_VARS` (~line 1301) — add `'JINN_ENGINE_KNOWLEDGE_AUTOLOAD',` immediately after `'JINN_ENGINE_IMPL_STATE_DIR_ROOT',`.

(f) `CLAUDE.md` (repo root) — add one row to the config table after the `engine.implStateDirRoot` row:

```markdown
| engine.knowledgeAutoload | JINN_ENGINE_KNOWLEDGE_AUTOLOAD | true — before each restoration harness spawn, auto-load the top-3 corpus solution records for the task's solverType into `task.context.corpusKnowledge` (verified-tier preferred; full content acquirable via MCP `inspect_record` / `acquire_artifact`). Corpus failure never blocks the solve path (#1393). |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/config.test.ts`
Expected: PASS (all cases, including pre-existing ones).

- [ ] **Step 5: Typecheck and commit**

Run: `yarn typecheck` — expected zero errors (the `JinnConfig` change is additive; `config.engine` consumers only read the two dir fields).

```bash
git add client/src/config.ts client/test/config.test.ts CLAUDE.md
git commit -m "feat(engine): add engine.knowledgeAutoload config flag (#1393)"
```

---

### Task 2: `consumed_refs_json` persistence column

**Files:**
- Modify: `client/src/harnesses/engine/persistence.ts` (CREATE TABLE ~line 104, `PersistedTaskRun` ~line 205, `TaskRunPatch` ~line 256, `RawRow` ~line 297, `runAdditiveMigrations` ~line 321, `rowToTaskRun` ~line 418, `transition` setClauses ~line 564)
- Test: `client/test/harnesses/engine/persistence.test.ts`

**Interfaces:**
- Produces: `PersistedTaskRun.consumedRefsJson: string | null` and `TaskRunPatch.consumedRefsJson` — consumed by Task 4 (engine) and Task 7 (e2e assertion).

- [ ] **Step 1: Write the failing test**

Append to `client/test/harnesses/engine/persistence.test.ts` (reuse the file's `makeInput` helper):

```ts
describe('consumedRefsJson (#1393)', () => {
  it('persists via the POST_SNAPSHOT transition patch and survives later transitions', () => {
    const store = new Store(':memory:');
    try {
      const p = new TaskRunPersistence(store.db);
      p.insertDiscovered(makeInput({ requestId: 'req-refs-1' }));
      p.transition('req-refs-1', TaskRunState.CLAIMED);
      p.transition('req-refs-1', TaskRunState.WAITING);
      p.transition('req-refs-1', TaskRunState.PRE_SNAPSHOT);
      p.transition('req-refs-1', TaskRunState.RUNNING);
      const refs = JSON.stringify([{ envelopeCid: 'bafyenv1', artifacts: [] }]);
      p.transition('req-refs-1', TaskRunState.POST_SNAPSHOT, { consumedRefsJson: refs });
      expect(p.getByRequestId('req-refs-1')!.consumedRefsJson).toBe(refs);
      // A later patch-less transition must not clear it.
      p.transition('req-refs-1', TaskRunState.PACKAGING);
      expect(p.getByRequestId('req-refs-1')!.consumedRefsJson).toBe(refs);
    } finally {
      store.close();
    }
  });

  it('is null for rows that never set it', () => {
    const store = new Store(':memory:');
    try {
      const p = new TaskRunPersistence(store.db);
      p.insertDiscovered(makeInput({ requestId: 'req-refs-2' }));
      expect(p.getByRequestId('req-refs-2')!.consumedRefsJson).toBeNull();
    } finally {
      store.close();
    }
  });
});
```

(Imports `Store`, `TaskRunPersistence`, `TaskRunState`, `makeInput` are already in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/harnesses/engine/persistence.test.ts -t consumedRefsJson`
Expected: FAIL — TS error / `consumedRefsJson` undefined on `PersistedTaskRun`, and the transition patch key is rejected by `TaskRunPatch`.

- [ ] **Step 3: Implement the column**

In `client/src/harnesses/engine/persistence.ts`:

(a) `TASK_RUNS_SCHEMA` — after `runtime_plugins_json        TEXT,` (~line 104) add:

```sql
  -- Additive column (#1393, corpus knowledge autoload):
  -- consumed_refs_json: JSON array of corpus knowledge record refs injected
  --   into task.context.corpusKnowledge for this run (envelopeCid + artifact
  --   sha256s). NULL when no knowledge was injected. Read by the #1397
  --   consumed-refs hook and the daemon-harness e2e.
  consumed_refs_json          TEXT,
```

(b) `PersistedTaskRun` — after `runtimePluginsJson: string | null;` (~line 205):

```ts
  /**
   * JSON array of corpus knowledge refs injected into
   * task.context.corpusKnowledge for this run (#1393). Null when the
   * autoload was disabled, found nothing, or the run predates the column.
   */
  consumedRefsJson: string | null;
```

(c) `TaskRunPatch` — after `runtimePluginsJson: string | null;` (~line 256):

```ts
  /** Corpus knowledge refs consumed by this run (#1393). */
  consumedRefsJson: string | null;
```

(d) `RawRow` — after `runtime_plugins_json: string | null;` (~line 297): `consumed_refs_json: string | null;`

(e) `runAdditiveMigrations` additions array — after the `runtime_plugins_json` entry (~line 321):

```ts
    { column: 'consumed_refs_json',      ddl: 'ALTER TABLE task_runs ADD COLUMN consumed_refs_json TEXT' },
```

(f) `rowToTaskRun` — after `runtimePluginsJson: row.runtime_plugins_json,` (~line 418): `consumedRefsJson: row.consumed_refs_json,`

(g) `transition()` setClauses — after the `runtimePluginsJson` block (~line 564-566):

```ts
    if (patch.consumedRefsJson !== undefined) {
      setClauses.push('consumed_refs_json = @consumedRefsJson');
      params['consumedRefsJson'] = patch.consumedRefsJson;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/harnesses/engine/persistence.test.ts`
Expected: PASS (including the pre-existing migration tests, which prove the additive migration path on an old DB).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/persistence.ts client/test/harnesses/engine/persistence.test.ts
git commit -m "feat(engine): persist consumed corpus-knowledge refs on task_runs (#1393)"
```

---

### Task 3: `corpus-knowledge.ts` retrieval module

**Files:**
- Create: `client/src/harnesses/engine/corpus-knowledge.ts`
- Create: `client/test/harnesses/engine/corpus-knowledge.test.ts` (loader section)

**Interfaces:**
- Consumes: `handleSearchRecords`, `ReadOnlyCorpus`, `RecordSummary`, `ArtifactDescriptor` from `client/src/mcp/search-records.ts`; `Store` from `client/src/store/store.ts`.
- Produces (consumed by Tasks 4 and 7):

```ts
export interface CorpusKnowledgeArtifactRef {
  sha256: string;
  artifactType: string;
  acquisition?: ArtifactDescriptor['acquisition'];
}
export interface CorpusKnowledgeRecordRef {
  recordRef: string;
  envelopeCid: string;
  evidenceTier: string;
  generatedAt?: number;
  artifacts: CorpusKnowledgeArtifactRef[];
  scoreMetadata?: Record<string, unknown>;
}
export interface CorpusKnowledgePayload {
  version: 1;
  solverType: string;
  retrievedAt: number;
  guidance: string;
  records: CorpusKnowledgeRecordRef[];
}
export interface LoadCorpusKnowledgeOptions {
  corpus: ReadOnlyCorpus | null;
  store: Store;
  solverType: string;
  limit?: number;        // default 3
  searchLimit?: number;  // default 12
  timeoutMs?: number;    // default 10_000
  log?: (msg: string) => void;
}
export async function loadCorpusKnowledge(opts: LoadCorpusKnowledgeOptions): Promise<CorpusKnowledgePayload | null>;
```

`loadCorpusKnowledge` NEVER throws and NEVER exceeds `timeoutMs` (returns `null` on failure/timeout/no results).

- [ ] **Step 1: Write the failing tests**

Create `client/test/harnesses/engine/corpus-knowledge.test.ts`:

```ts
/**
 * #1393 — corpus knowledge autoload: loader unit tests.
 *
 * Store-only seams: envelope projections (via store.saveEnvelopeProjection)
 * carry solverType/role/evidenceTier; served_artifacts rows (via
 * store.saveServedArtifact) carry the artifact sha256s keyed by envelopeCid.
 * handleSearchRecords merges both; the loader ranks, dedupes, and trims.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { loadCorpusKnowledge } from '../../../src/harnesses/engine/corpus-knowledge.js';
import type { ReadOnlyCorpus } from '../../../src/mcp/search-records.js';
import type { EnvelopeProjection } from '../../../src/corpus/types.js';

function projection(overrides: Partial<EnvelopeProjection>): EnvelopeProjection {
  return {
    envelopeId: overrides.envelopeCid ?? 'env-default',
    envelopeCid: 'env-default',
    envelopeSha256: null,
    signatureHash: `0xsig-${overrides.envelopeCid ?? 'default'}`,
    solverType: 'prediction.v1',
    role: 'solution',
    taskCid: 'bafytask',
    taskId: null,
    requestId: null,
    generatedAt: 1_000,
    evidenceTier: 'self-signed',
    participantSafeAddress: '0xsafe',
    participantAgentEoa: '0xeoa',
    executorImplName: 'prediction-v1-baseline',
    executorImplVersion: '1.0.0',
    executorRuntimeBundleDigest: null,
    executorPlugins: [],
    solutionEnvelopeCid: null,
    solutionEnvelopeSha256: null,
    solutionEnvelopeRef: null,
    metadata: {},
    ...overrides,
  };
}

describe('loadCorpusKnowledge (#1393)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('returns null when the store has no matching records (corpus-null)', async () => {
    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).toBeNull();
  });

  it('ranks by evidence tier (attested > committed > self-signed) then generatedAt desc, slices 3', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-a', envelopeCid: 'env-a', evidenceTier: 'self-signed', generatedAt: 5_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-b', envelopeCid: 'env-b', evidenceTier: 'committed', generatedAt: 1_000 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-c', envelopeCid: 'env-c', evidenceTier: 'attested', generatedAt: 500 }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-d', envelopeCid: 'env-d', evidenceTier: 'self-signed', generatedAt: 4_000 }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload).not.toBeNull();
    expect(payload!.records).toHaveLength(3);
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-c', 'env-b', 'env-a']);
  });

  it('filters to the requested solverType and role=solution', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-sol', envelopeCid: 'env-sol' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-verdict', envelopeCid: 'env-verdict', role: 'verdict' }));
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-other', envelopeCid: 'env-other', solverType: 'swe-rebench-v2.v1' }));

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records.map((r) => r.envelopeCid)).toEqual(['env-sol']);
  });

  it('merges local served-artifact sha256s into records by envelopeCid', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-art', envelopeCid: 'env-art' }));
    store.saveServedArtifact({
      sha256: 'ab'.repeat(32),
      artifactType: 'prediction_v1_solution',
      envelopeCid: 'env-art',
      content: Buffer.from('{}'),
      priceUsdc: '0',
      createdAt: new Date().toISOString(),
    });

    const payload = await loadCorpusKnowledge({ corpus: null, store, solverType: 'prediction.v1' });
    expect(payload!.records[0]!.artifacts).toEqual([
      expect.objectContaining({ sha256: 'ab'.repeat(32), artifactType: 'prediction_v1_solution' }),
    ]);
  });

  it('returns null (not a hang, not a throw) when the corpus query exceeds timeoutMs', async () => {
    store.saveEnvelopeProjection(projection({ envelopeId: 'env-slow', envelopeCid: 'env-slow' }));
    const hangingCorpus: ReadOnlyCorpus = {
      query: () => new Promise(() => { /* never resolves */ }),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: hangingCorpus,
      store,
      solverType: 'prediction.v1',
      timeoutMs: 50,
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('timed out');
  });

  it('returns null and logs when the corpus query throws', async () => {
    const throwingCorpus: ReadOnlyCorpus = {
      query: () => Promise.reject(new Error('boom')),
      fetchManifest: () => Promise.reject(new Error('unused')),
    };
    const warnings: string[] = [];
    const payload = await loadCorpusKnowledge({
      corpus: throwingCorpus,
      store,
      solverType: 'prediction.v1',
      log: (msg) => warnings.push(msg),
    });
    expect(payload).toBeNull();
    expect(warnings.join('\n')).toContain('boom');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts`
Expected: FAIL — cannot resolve `../../../src/harnesses/engine/corpus-knowledge.js`.

- [ ] **Step 3: Implement the module**

Create `client/src/harnesses/engine/corpus-knowledge.ts`:

```ts
/**
 * Corpus knowledge autoload (#1393).
 *
 * Pure retrieval + ranking: query the corpus for prior *solution* records of
 * the given solverType and shape the top few into a payload the engine can
 * inject into task.context.corpusKnowledge before harness spawn.
 *
 * Reuses handleSearchRecords (client/src/mcp/search-records.ts) so the result
 * set is exactly what the MCP tools would return: local envelope projections,
 * locally served/cached artifact rows, and (when a corpus is configured)
 * network manifests. Works corpus-null — the store-only path is the e2e
 * configuration and the mainnet default until an indexer is wired.
 *
 * Contract: loadCorpusKnowledge NEVER throws and is bounded by timeoutMs.
 * On failure or timeout it logs one warning and returns null — corpus
 * problems must never block the claim/solve path (AC3 of #1393).
 *
 * RecordSummary.scoreMetadata is passed through verbatim as the future
 * verdict-aware ranking seam (#1396).
 */

import {
  handleSearchRecords,
  type ArtifactDescriptor,
  type ReadOnlyCorpus,
  type RecordSummary,
} from '../../mcp/search-records.js';
import type { Store } from '../../store/store.js';

export interface CorpusKnowledgeArtifactRef {
  sha256: string;
  artifactType: string;
  /** Self-describing acquisition recipe: MCP acquire_artifact arguments. */
  acquisition?: ArtifactDescriptor['acquisition'];
}

export interface CorpusKnowledgeRecordRef {
  recordRef: string;
  envelopeCid: string;
  evidenceTier: string;
  generatedAt?: number;
  artifacts: CorpusKnowledgeArtifactRef[];
  /** Score/verdict fields surfaced by search (seam for #1396). */
  scoreMetadata?: Record<string, unknown>;
}

export interface CorpusKnowledgePayload {
  version: 1;
  solverType: string;
  retrievedAt: number;
  guidance: string;
  records: CorpusKnowledgeRecordRef[];
}

export interface LoadCorpusKnowledgeOptions {
  corpus: ReadOnlyCorpus | null;
  store: Store;
  solverType: string;
  /** Records to inject. Default 3. */
  limit?: number;
  /** Records to fetch before ranking. Default 12. */
  searchLimit?: number;
  /** Hard bound on the whole lookup. Default 10_000 ms. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export const CORPUS_KNOWLEDGE_GUIDANCE =
  'Prior solution records for this solverType, ranked by evidence tier then recency. '
  + 'Full artifact content is acquirable via the MCP tools: inspect_record (pass the '
  + 'envelopeCid) and acquire_artifact (pass each artifact\'s acquisition arguments).';

const TIER_WEIGHT: Record<string, number> = {
  attested: 3,
  committed: 2,
  'self-signed': 1,
  unknown: 1,
};

function tierWeight(record: RecordSummary): number {
  return TIER_WEIGHT[record.envelopeRef?.evidenceTier ?? 'unknown'] ?? 1;
}

function recency(record: RecordSummary): number {
  return record.generatedAt ?? record.envelopeRef?.publishedAt ?? 0;
}

export async function loadCorpusKnowledge(
  opts: LoadCorpusKnowledgeOptions,
): Promise<CorpusKnowledgePayload | null> {
  const limit = opts.limit ?? 3;
  const searchLimit = opts.searchLimit ?? 12;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`corpus knowledge lookup timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const result = await Promise.race([
      handleSearchRecords(opts.corpus, opts.store, {
        solverType: opts.solverType,
        role: 'solution',
        limit: searchLimit,
      }),
      timeout,
    ]);

    // Index artifact refs by envelopeCid across ALL returned records: local
    // served/cached rows carry the sha256s but no solverType/role; projection
    // records carry solverType/role/tier but no artifact refs. The join key
    // is the envelope CID (backfilled onto served_artifacts by pack()).
    const artifactsByCid = new Map<string, CorpusKnowledgeArtifactRef[]>();
    for (const record of result.records) {
      const cid = record.envelopeRef?.cid;
      if (!cid) continue;
      for (const artifact of record.artifactRefs) {
        const list = artifactsByCid.get(cid) ?? [];
        if (!list.some((existing) => existing.sha256 === artifact.sha256)) {
          list.push({
            sha256: artifact.sha256,
            artifactType: artifact.artifactType,
            ...(artifact.acquisition ? { acquisition: artifact.acquisition } : {}),
          });
        }
        artifactsByCid.set(cid, list);
      }
    }

    // Candidates: solution records for this solverType with an envelope CID
    // (no CID → nothing to dedupe on or reference downstream). First record
    // per CID wins (projection ordering puts local knowledge first).
    const byCid = new Map<string, RecordSummary>();
    for (const record of result.records) {
      const cid = record.envelopeRef?.cid;
      if (!cid) continue;
      if (record.solverType !== opts.solverType) continue;
      if (record.role !== 'solution') continue;
      if (!byCid.has(cid)) byCid.set(cid, record);
    }

    const ranked = [...byCid.entries()]
      .sort(([, a], [, b]) => {
        const tierDelta = tierWeight(b) - tierWeight(a);
        if (tierDelta !== 0) return tierDelta;
        return recency(b) - recency(a);
      })
      .slice(0, limit);

    if (ranked.length === 0) return null;

    return {
      version: 1,
      solverType: opts.solverType,
      retrievedAt: Date.now(),
      guidance: CORPUS_KNOWLEDGE_GUIDANCE,
      records: ranked.map(([cid, record]) => ({
        recordRef: record.recordRef,
        envelopeCid: cid,
        evidenceTier: record.envelopeRef?.evidenceTier ?? 'unknown',
        ...(record.generatedAt !== undefined ? { generatedAt: record.generatedAt } : {}),
        artifacts: artifactsByCid.get(cid) ?? [],
        ...(record.scoreMetadata ? { scoreMetadata: record.scoreMetadata } : {}),
      })),
    };
  } catch (err) {
    log(
      `[corpus-knowledge] lookup failed for solverType=${opts.solverType}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/engine/corpus-knowledge.ts client/test/harnesses/engine/corpus-knowledge.test.ts
git commit -m "feat(engine): corpus knowledge retrieval module (#1393)"
```

---

### Task 4: Engine injection in `runImpl` + `corpus_knowledge` event

**Files:**
- Modify: `client/src/observability/emit-event.ts` (~line 4)
- Modify: `client/src/harnesses/engine/engine.ts` (options ~line 220, fields ~line 457, constructor ~line 470, `runImpl` ~line 1214-1243, both POST_SNAPSHOT transitions ~line 1299 and ~line 1351, `pack` cleanup ~line 1766)
- Test: `client/test/harnesses/engine/corpus-knowledge.test.ts` (engine section)

**Interfaces:**
- Consumes: `loadCorpusKnowledge`, `CorpusKnowledgePayload`, `CorpusKnowledgeRecordRef` (Task 3); `TaskRunPatch.consumedRefsJson` (Task 2).
- Produces: `TaskEngineOptions.knowledge?: { corpus?: ReadOnlyCorpus | null; enabled?: boolean }` — consumed by Task 6 (daemon/main). Lifecycle kind `'corpus_knowledge'` with `detail = JSON.stringify(Array<{ envelopeCid: string; artifacts: string[] }>)` — consumed by Task 7 (e2e).

- [ ] **Step 1: Write the failing engine tests**

Append to `client/test/harnesses/engine/corpus-knowledge.test.ts`. Model the scaffold on `client/test/harnesses/engine/learner-attribution.test.ts` (real `runImpl` via `process()`, `legacy.v0` solverType for the passthrough payload schema, `uploadToIpfs` mocked):

```ts
// ── Engine injection tests ────────────────────────────────────────────────────

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import type { Harness, Solution } from '../../../src/harnesses/types.js';
import type { Task } from '../../../src/types/task.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafymock123'),
  cidToDigestHex: vi.fn().mockReturnValue(('0x' + 'de'.repeat(32)) as `0x${string}`),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
const SOLVER_TYPE = 'legacy.v0';

function mkTmp(): string {
  const dir = join(tmpdir(), `corpus-knowledge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stub impl that captures the ctx.task it received. */
function makeCapturingImpl(captured: { task?: Task }, role: 'restoration' | 'evaluation' = 'restoration'): Harness {
  return {
    name: 'capturing-stub',
    version: '0.0.1',
    supports: (s) => (role === 'evaluation' ? s.role === 'evaluation' : s.role !== 'evaluation') && s.solverType === SOLVER_TYPE,
    async run(ctx): Promise<Solution> {
      captured.task = ctx.task;
      return {
        venueRef: { name: 'capturing-stub' },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
}

function engineOpts(store: Store, tmp: string, impl: Harness, knowledge?: TaskEngineOptions['knowledge']): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(tmp, 'work'), implStateDirRoot: join(tmp, 'impl') },
    implRegistry: { findFor: (s) => (impl.supports(s) ? impl : undefined) },
    packagingDeps: {
      store,
      operatorEndpoint: 'https://op.test',
      defaultPriceUsdc: '0',
      perArtifactTypePrice: {},
    },
    envelopeDeps: {
      ipfsRegistryUrl: 'http://ipfs.test',
      agentEoaPrivateKey: TEST_PRIVATE_KEY,
      safeAddress: '0xsafe' as `0x${string}`,
    },
    ...(knowledge !== undefined ? { knowledge } : {}),
  };
}

function runInput(requestId: string, role: 'restoration' | 'evaluation' = 'restoration'): PersistedTaskRunInput {
  const now = Date.now() - 1000;
  return {
    requestId,
    taskCid: 'bafyintent123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    solverType: SOLVER_TYPE,
    taskRole: role,
    windowStartTs: now,
    windowEndTs: now + 86_400_000,
    task: { id: requestId, description: 'test', solverType: SOLVER_TYPE, role },
  };
}

/** observe → CLAIMED → WAITING, then one process() to drive the real runImpl. */
async function driveToPostSnapshot(engine: TaskEngine, store: Store, requestId: string, role: 'restoration' | 'evaluation' = 'restoration'): Promise<TaskRunPersistence> {
  const p = new TaskRunPersistence(store.db);
  await engine.observe(runInput(requestId, role));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  await engine.process(requestId);
  expect(p.getByRequestId(requestId)!.state).toBe(TaskRunState.POST_SNAPSHOT);
  return p;
}

describe('#1393 corpus knowledge injection in runImpl', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function seedProjection(cid: string): void {
    store.saveEnvelopeProjection(projection({
      envelopeId: cid,
      envelopeCid: cid,
      solverType: SOLVER_TYPE,
      role: 'solution',
      evidenceTier: 'self-signed',
      generatedAt: 2_000,
    }));
  }

  it('injects corpusKnowledge into ctx.task.context for a restoration run, persists consumedRefsJson, emits corpus_knowledge', async () => {
    seedProjection('env-prior-1');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-know-1');

    const payload = captured.task?.context?.['corpusKnowledge'] as { records: Array<{ envelopeCid: string }> };
    expect(payload).toBeDefined();
    expect(payload.records.map((r) => r.envelopeCid)).toEqual(['env-prior-1']);

    const row = p.getByRequestId('req-know-1')!;
    expect(JSON.parse(row.consumedRefsJson!)).toEqual([
      expect.objectContaining({ envelopeCid: 'env-prior-1' }),
    ]);

    const events = store.db
      .prepare(`SELECT kind, request_id, detail FROM activity_events WHERE kind = 'corpus_knowledge'`)
      .all() as Array<{ kind: string; request_id: string; detail: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.request_id).toBe('req-know-1');
    expect(JSON.parse(events[0]!.detail)).toEqual([
      expect.objectContaining({ envelopeCid: 'env-prior-1' }),
    ]);
  });

  it('does not inject when knowledge.enabled === false (opt-out)', async () => {
    seedProjection('env-prior-2');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured), { enabled: false }));
    const p = await driveToPostSnapshot(engine, store, 'req-know-2');

    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-2')!.consumedRefsJson).toBeNull();
    const events = store.db
      .prepare(`SELECT kind FROM activity_events WHERE kind = 'corpus_knowledge'`)
      .all();
    expect(events).toHaveLength(0);
  });

  it('does not inject for evaluation runs', async () => {
    seedProjection('env-prior-3');
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured, 'evaluation')));
    const p = await driveToPostSnapshot(engine, store, 'req-know-3', 'evaluation');

    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-3')!.consumedRefsJson).toBeNull();
  });

  it('proceeds normally (no injection, no failure) when the store has no matching records', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-know-4');
    expect(captured.task?.context?.['corpusKnowledge']).toBeUndefined();
    expect(p.getByRequestId('req-know-4')!.state).toBe(TaskRunState.POST_SNAPSHOT);
  });
});
```

Note: the loader-section `projection(...)` helper from Step 1 of Task 3 is reused; keep both sections in this one file so the helper is shared.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts -t "corpus knowledge injection"`
Expected: FAIL — `knowledge` is not a known `TaskEngineOptions` property (TS), no injection happens, no `corpus_knowledge` events exist.

- [ ] **Step 3: Implement**

(a) `client/src/observability/emit-event.ts` — add `'corpus_knowledge',` to `ALLOWED_LIFECYCLE_KINDS` (after `'engine_transition',`). No other change; the `/v1/activity-events` endpoint validates against this same array, so the new kind becomes queryable automatically.

(b) `client/src/harnesses/engine/engine.ts`:

Imports (top of file):

```ts
import { loadCorpusKnowledge } from './corpus-knowledge.js';
import type { CorpusKnowledgeRecordRef } from './corpus-knowledge.js';
import type { ReadOnlyCorpus } from '../../mcp/search-records.js';
```

`TaskEngineOptions` (after `workDirReaper`, ~line 380):

```ts
  /**
   * Corpus knowledge autoload (#1393). Before each restoration harness
   * spawn, the engine queries the corpus for prior solution records of the
   * task's solverType and injects the top few into
   * task.context.corpusKnowledge (a runtime side-channel, same as evaluation
   * tasks' context.restorationResult — never persisted into the signed Task,
   * never re-hashed).
   *
   * - `corpus`: read-only corpus for network results; when absent/null the
   *   lookup is store-only (local envelope projections + served artifacts).
   * - `enabled`: opt-out; defaults to true (config: engine.knowledgeAutoload).
   *
   * Failures never block the solve path: the lookup is time-bounded and
   * error-swallowing (loadCorpusKnowledge never throws).
   */
  knowledge?: { corpus?: ReadOnlyCorpus | null; enabled?: boolean };
```

Field + constructor (mirroring neighbours at ~lines 423 and ~485):

```ts
  protected readonly knowledge: TaskEngineOptions['knowledge'];
```

```ts
    this.knowledge = opts.knowledge;
```

Transient map (next to `runtimePluginsByRequest`, ~line 457):

```ts
  // Corpus knowledge refs injected into the current run's task context
  // (#1393). Keyed by requestId; persisted as consumed_refs_json at the
  // RUNNING → POST_SNAPSHOT transition; cleared after successful pack.
  private readonly consumedRefsByRequest = new Map<string, CorpusKnowledgeRecordRef[]>();
```

`runImpl` — insert after `this.runtimePluginsByRequest.set(task.requestId, attributedPlugins);` (~line 1214) and before the `workingDir` computation:

```ts
    // #1393: corpus knowledge autoload. Restoration runs only — never bias
    // evaluators with prior solutions. The lookup is bounded (10 s) and
    // never throws; failure or an empty result simply injects nothing.
    let taskForCtx = task.task;
    if (role === 'restoration' && solverType && this.knowledge?.enabled !== false && taskForCtx) {
      const knowledgePayload = await loadCorpusKnowledge({
        corpus: this.knowledge?.corpus ?? null,
        store: this.store,
        solverType,
      });
      if (knowledgePayload) {
        // Shallow clone: the injected context lives only in the runtime Task
        // handed to the harness. Envelope integrity references taskCid, so
        // nothing signed or hashed changes.
        taskForCtx = {
          ...taskForCtx,
          context: { ...taskForCtx.context, corpusKnowledge: knowledgePayload },
        };
        this.consumedRefsByRequest.set(task.requestId, knowledgePayload.records);
        emitEvent(this.store, {
          kind: 'corpus_knowledge',
          requestId: task.requestId,
          solverType,
          outcome: 'ok',
          detail: JSON.stringify(knowledgePayload.records.map((record) => ({
            envelopeCid: record.envelopeCid,
            artifacts: record.artifacts.map((artifact) => artifact.sha256),
          }))),
        }, 'harness-engine');
      }
    }
```

Then change the `ctx.task` assignment (~line 1237) from `task: (task.task ?? { … })` to:

```ts
        task: (taskForCtx ?? {
          id: task.requestId,
          description: '',
          ...(task.solverType ? { solverType: task.solverType, spec: {} } : {}),
          role,
          window: { startTs: task.windowStartTs, endTs: task.windowEndTs },
        }) as import('../../types/task.js').Task,
```

Both POST_SNAPSHOT `persistence.transition` patches (the skipped path at ~line 1299 and the normal path at ~line 1351) — add alongside `runtimePluginsJson`:

```ts
            consumedRefsJson: this.consumedRefsByRequest.has(task.requestId)
              ? JSON.stringify(this.consumedRefsByRequest.get(task.requestId))
              : null,
```

`pack()` transient cleanup block (~line 1766-1770) — add:

```ts
    this.consumedRefsByRequest.delete(task.requestId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts`
Expected: PASS (loader + engine sections).

- [ ] **Step 5: Guard against regressions in the engine suite**

Run: `yarn vitest run test/harnesses/engine test/observability 2>/dev/null || yarn vitest run test/harnesses/engine`
Expected: PASS — existing engine tests construct `TaskEngine` without `knowledge`; the default-on path finds no records in their stores and injects nothing.

- [ ] **Step 6: Commit**

```bash
git add client/src/observability/emit-event.ts client/src/harnesses/engine/engine.ts client/test/harnesses/engine/corpus-knowledge.test.ts
git commit -m "feat(engine): inject corpus knowledge into restoration task context (#1393)"
```

---

### Task 5: `pack()` saves the envelope projection (production gap)

**Files:**
- Modify: `client/src/harnesses/engine/engine.ts` (imports; `pack()` at ~line 1719-1724)
- Test: `client/test/harnesses/engine/corpus-knowledge.test.ts` (one more engine test)

**Interfaces:**
- Consumes: `projectEnvelope` from `client/src/corpus/envelope-projection.ts`; `store.saveEnvelopeProjection` (upsert, retry-safe); the `envelope` now destructured from `assembleAndSignEnvelope`.
- Produces: every packed run leaves a row in `envelope_projections` — the knowledge source for subsequent runs and the AC4(b) assertion surface.

- [ ] **Step 1: Write the failing test**

Append to the engine section of `client/test/harnesses/engine/corpus-knowledge.test.ts`:

```ts
describe('#1393 pack() saves the envelope projection', () => {
  let store: Store;
  let tmp: string;

  beforeEach(() => {
    store = new Store(':memory:');
    tmp = mkTmp();
    vi.clearAllMocks();
  });
  afterEach(() => {
    store.close();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a completed pack leaves a solution projection queryable by solverType', async () => {
    const captured: { task?: Task } = {};
    const engine = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(captured)));
    const p = await driveToPostSnapshot(engine, store, 'req-proj-1');
    // Second process(): POST_SNAPSHOT → PACKAGING → real pack() (uploadToIpfs mocked).
    await engine.process('req-proj-1');
    expect(p.getByRequestId('req-proj-1')!.state).toBe(TaskRunState.DELIVERING);

    const projections = store.queryEnvelopeProjections({ solverType: SOLVER_TYPE, role: 'solution' });
    expect(projections).toHaveLength(1);
    expect(projections[0]!.envelopeCid).toBe('bafymock123'); // the mocked uploadToIpfs CID
    expect(projections[0]!.requestId).toBe('req-proj-1');
  });

  it('a second run of the same solverType sees the first run\'s projection as knowledge', async () => {
    const first: { task?: Task } = {};
    const engine1 = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(first)));
    await driveToPostSnapshot(engine1, store, 'req-chain-1');
    await engine1.process('req-chain-1'); // pack → projection saved

    const second: { task?: Task } = {};
    const engine2 = new TaskEngine(engineOpts(store, tmp, makeCapturingImpl(second)));
    await driveToPostSnapshot(engine2, store, 'req-chain-2');

    const payload = second.task?.context?.['corpusKnowledge'] as { records: Array<{ envelopeCid: string }> };
    expect(payload).toBeDefined();
    expect(payload.records.map((r) => r.envelopeCid)).toContain('bafymock123');
  });
});
```

Note (verified): `process()`'s POST_SNAPSHOT case (engine.ts:773-786) data-driven-advances to PACKAGING, runs the real `pack()`, then `break`s — it does NOT fall through to `deliver()`. So after the second `process()` the row sits at DELIVERING with no deliver attempt, and the `state === DELIVERING` assertion above is exact. This matches the `learner-attribution.test.ts` scaffold.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts -t projection`
Expected: FAIL — `queryEnvelopeProjections` returns `[]` (no production caller of `saveEnvelopeProjection` yet).

- [ ] **Step 3: Implement**

In `client/src/harnesses/engine/engine.ts`:

Import:

```ts
import { projectEnvelope } from '../../corpus/envelope-projection.js';
```

In `pack()` (~line 1719), widen the destructure and add the projection call immediately after:

```ts
    const { envelope, envelopeCid, envelopeHash } = await assembleAndSignEnvelope(
      envelopeInputs,
      this.envelopeDeps,
    );
    const manifestCid = envelopeCid;
    const signatureHash = envelopeHash;

    // #1393: project the just-published envelope into the local corpus index
    // so the operator's own work is discoverable as knowledge on the next
    // run (and by MCP search_records). Upsert keyed on envelope_id — a
    // pack() retry overwrites idempotently. Never fatal: a projection
    // failure must not fail packaging.
    // NOTE: taskCid is deliberately NOT passed — projectEnvelope resolves it
    // from options.task.context.solutionTaskCid (verdicts) or
    // envelope.task.cid (solutions), both already correct here.
    try {
      this.store.saveEnvelopeProjection(
        projectEnvelope(envelope, { envelopeCid, task: task.task }),
      );
    } catch (err) {
      console.warn(
        `[harness-engine] ${task.requestId}: envelope projection failed (non-fatal): `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression sweep over pack-adjacent suites**

Run: `yarn vitest run test/harnesses/engine`
Expected: PASS — packaging tests that drive the real `pack()` now also write projections into their in-memory stores; that is additive and asserted by nothing else.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/engine/engine.ts client/test/harnesses/engine/corpus-knowledge.test.ts
git commit -m "feat(engine): project published envelopes into the local corpus index (#1393)"
```

---

### Task 6: Daemon + main.ts wiring

**Files:**
- Modify: `client/src/daemon/daemon.ts` (fields ~line 245, constructor ~line 264-295, `start()` ~line 330-332)
- Modify: `client/src/main.ts` (`restorationEngine` block ~line 2508-2540)

**Interfaces:**
- Consumes: `TaskEngineOptions.knowledge` (Task 4); `JinnConfig.engine.knowledgeAutoload` (Task 1); existing `config.corpusFactory`.
- Produces: one shared `Corpus` instance per daemon (engine + API server); operator flag threaded end to end.

- [ ] **Step 1: Hoist corpus construction into the `Daemon` constructor**

In `client/src/daemon/daemon.ts`:

Add a field next to `private store: Store;`:

```ts
  private corpus?: Corpus;
```

(`Corpus` is already imported in daemon.ts for the `corpusFactory` type — verify; if the import is type-only via the config interface, add `import type { Corpus } from '../corpus/index.js';`.)

In the constructor, immediately after the store setup block (`this.ownsStore = …`, ~line 271):

```ts
    // #1393: build the corpus once, at construction time, so the TaskEngine
    // (knowledge autoload) and the API server share one instance. Safe w.r.t.
    // the #649 start() ordering constraint: createCorpus is pure closure
    // construction — no store writes, no network I/O.
    this.corpus = config.corpusFactory?.(this.store);
```

In the `TaskEngine` construction (~line 289):

```ts
    this.restorationEngine = new TaskEngine({
      ...config.restorationEngine,
      store: this.store,
      knowledge: {
        ...config.restorationEngine.knowledge,
        ...(this.corpus ? { corpus: this.corpus } : {}),
      },
      packagingDeps: config.restorationEngine.packagingDeps
        ? { ...config.restorationEngine.packagingDeps, store: this.store }
        : undefined,
    });
```

In `start()` (~line 330-332), replace:

```ts
    const corpus = this.config.corpusFactory
      ? this.config.corpusFactory(this.store)
      : undefined;
```

with:

```ts
    // Corpus is constructed in the constructor (#1393) so the engine's
    // knowledge autoload and the API server share one instance.
    const corpus = this.corpus;
```

No `DaemonConfig` change is needed: `restorationEngine` is `Omit<TaskEngineOptions, 'store' | 'packagingDeps'> & …`, so `knowledge` flows through automatically.

- [ ] **Step 2: Thread the config flag in `main.ts`**

In the `restorationEngine` block (~line 2536, next to `harnessMode`):

```ts
      harnessMode: config.harness.mode,
      // #1393: corpus knowledge autoload — operator opt-out flag. The corpus
      // instance itself is injected by the Daemon (built from corpusFactory).
      knowledge: { enabled: config.engine.knowledgeAutoload },
```

- [ ] **Step 3: Verify**

Run: `yarn typecheck`
Expected: zero errors.

Run: `yarn vitest run test/daemon/daemon-start-order.test.ts test/daemon/daemon.test.ts`
Expected: PASS — the start-order test's `corpusFactory` marker now records at construction time, which is still strictly before every store mutation the test asserts against.

- [ ] **Step 4: Commit**

```bash
git add client/src/daemon/daemon.ts client/src/main.ts
git commit -m "feat(engine): wire corpus knowledge autoload through daemon and main (#1393)"
```

---

### Task 7: Anvil e2e second-task leg (AC4)

**Files:**
- Modify: `client/test/e2e/daemon-harness-cycle.ts`

**Interfaces:**
- Consumes: existing helpers (`postPredictionV1Task`, `waitForDaemonClaim`, `waitForDelivery`), `RunningDaemon.store`, `TaskRunPersistence`, `Store.queryEnvelopeProjections`, `Store.searchOwnAndCached`. No helper changes required (`waitForDaemonClaim` filters by on-chain `taskId`; the second task doc gets a distinct CID from its fresh `createdAt`/window timestamps).

- [ ] **Step 1: Extend the e2e script**

In `client/test/e2e/daemon-harness-cycle.ts`, add the import:

```ts
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
```

Then, inside the daemon `try` block, after the existing activity-counter assertion (after the `=== Task 7 ok … ===` log, ~line 150), append:

```ts
      // ── #1393: corpus knowledge autoload — second run of the same task type ──
      //
      // Run 1's pack() must have projected its envelope into the local corpus
      // index; run 2 (same solverType) must have consumed it: the injected
      // refs are persisted as consumed_refs_json and mirrored in a
      // corpus_knowledge activity event. All assertions read RunningDaemon's
      // own SQLite store — no discovery/indexer infra (startDaemon omits
      // corpusFactory, so this exercises the store-only knowledge path).
      const persistence = new TaskRunPersistence(running.store.db);
      const row1 = persistence.getByRequestId(claim.requestId);
      const run1EnvelopeCid = row1?.manifestCid;
      if (!run1EnvelopeCid) {
        throw new Error(`run 1 has no manifestCid persisted (requestId=${claim.requestId})`);
      }

      // (a) run 1's envelope projection exists locally.
      const projections = running.store.queryEnvelopeProjections({
        solverType: 'prediction.v1',
        role: 'solution',
      });
      if (!projections.some((p) => p.envelopeCid === run1EnvelopeCid)) {
        throw new Error(
          `run 1 envelope projection missing (want envelopeCid=${run1EnvelopeCid}, `
          + `have ${projections.map((p) => p.envelopeCid).join(', ') || 'none'})`,
        );
      }
      console.log(`  ✓ run 1 envelope projection exists (${run1EnvelopeCid})`);

      // Run 1's solution artifact sha256 (served_artifacts, backfilled with the
      // envelope CID by pack()).
      const run1Artifacts = running.store
        .searchOwnAndCached({ artifactType: 'prediction_v1_solution', limit: 50 })
        .filter((a) => a.envelopeCid === run1EnvelopeCid);
      if (run1Artifacts.length === 0) {
        throw new Error(`run 1 has no prediction_v1_solution artifact for ${run1EnvelopeCid}`);
      }
      const run1ArtifactSha = run1Artifacts[0]!.sha256;

      // Post a second prediction.v1 task and drive it to delivery.
      const posted2 = await postPredictionV1Task(fixture, operator, CREATOR_PRIV_KEY, mockIpfs, v3Env);
      console.log(`posted task 2: id=${posted2.taskId} cidDigest=${posted2.taskCidDigest}`);
      const claim2 = await waitForDaemonClaim(fixture, posted2, operator, v3Env);
      console.log(`daemon claimed task 2: requestId=${claim2.requestId}`);
      const delivered2 = await waitForDelivery(fixture, claim2, v3Env, mockIpfs);
      console.log(`delivered task 2: tx=${delivered2.deliveryTxHash}`);

      // (b) run 2 consumed run 1's record: consumed_refs_json references the
      // first envelope CID and the solution artifact sha256.
      const row2 = persistence.getByRequestId(claim2.requestId);
      const consumed = JSON.parse(row2?.consumedRefsJson ?? '[]') as Array<{
        envelopeCid: string;
        artifacts: Array<{ sha256: string }>;
      }>;
      const consumedRun1 = consumed.find((r) => r.envelopeCid === run1EnvelopeCid);
      if (!consumedRun1) {
        throw new Error(
          `run 2 consumed_refs_json does not reference run 1's envelope `
          + `(want ${run1EnvelopeCid}, got ${JSON.stringify(consumed)})`,
        );
      }
      if (!consumedRun1.artifacts.some((a) => a.sha256 === run1ArtifactSha)) {
        throw new Error(
          `run 2 consumed refs missing run 1's solution artifact sha256 `
          + `(want ${run1ArtifactSha}, got ${JSON.stringify(consumedRun1.artifacts)})`,
        );
      }
      console.log(`  ✓ run 2 consumed run 1's record (envelope=${run1EnvelopeCid} sha=${run1ArtifactSha})`);

      // (c) the corpus_knowledge event fired for run 2.
      const knowledgeEvents = running.store.db
        .prepare(`SELECT detail FROM activity_events WHERE kind = 'corpus_knowledge' AND request_id = ?`)
        .all(claim2.requestId) as Array<{ detail: string }>;
      if (knowledgeEvents.length === 0) {
        throw new Error(`no corpus_knowledge event recorded for run 2 (${claim2.requestId})`);
      }
      console.log(`  ✓ corpus_knowledge event recorded for run 2`);

      console.log(`\n=== #1393 ok — second run consumed the first run's published knowledge ===`);
```

Skip behaviour: this leg sits inside `main()` after the existing `checkHarnessApiKey` early-return, so it skips cleanly in exactly the same conditions as the rest of the e2e. No change to `_daemon-harness-helpers.ts` (correction 3 above).

Type note: `consumedRefsJson` values shape must match Task 4's `CorpusKnowledgeRecordRef[]` (`envelopeCid` + `artifacts[].sha256`) — it does.

- [ ] **Step 2: Static verification**

Run: `yarn typecheck`
Expected: zero errors (the e2e is under `test/`, included in the typecheck project — if `yarn typecheck` excludes `test/`, run `yarn vitest run test/harnesses/engine/corpus-knowledge.test.ts` and rely on Task 8's live run instead; do not add a bespoke tsconfig).

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e/daemon-harness-cycle.ts
git commit -m "test(e2e): second-run corpus knowledge consumption in daemon-harness cycle (#1393)"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite + typecheck**

```bash
cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1393/client
yarn typecheck
yarn test
```
Expected: zero type errors; all vitest suites pass.

- [ ] **Step 2: Live e2e (integration verification; needs network + Anvil)**

```bash
cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1393/client
yarn e2e:daemon-harness
```

- Default harness `prediction-v1-baseline` is deterministic and needs no API key (it "skips cleanly if the selected harness's API key isn't available" — the default's key-check passes without one, but the run still needs internet for the Base fork RPC).
- Expected output ends with `=== #1393 ok — second run consumed the first run's published knowledge ===`.
- If the environment cannot reach the network, record the skip and flag it for the reviewer — the unit-level chain test (Task 5, "second run sees first run's projection") covers the same seam store-only.

- [ ] **Step 3: Final review pass**

Re-read the diff (`git diff origin/next...HEAD --stat` then per-file) against the Surgical Changes rule: no adjacent refactors, no formatting churn, comments match neighbouring style.

---

## Acceptance criteria → task mapping

| AC | Requirement | Tasks | Proof |
|----|-------------|-------|-------|
| AC1 | After claim, before harness spawn, query corpus for solverType (top ~3), pass summaries/refs into harness context; full content acquirable via existing MCP tools | 3, 4 | Loader ranking/slice tests; engine injection test asserts `ctx.task.context.corpusKnowledge` with refs; `acquisition` field embeds `acquire_artifact` arguments; `guidance` names `inspect_record`/`acquire_artifact` |
| AC2 | Verified-tier artifacts preferred when verdict data available; graceful when not | 3 | Tier-ranking test (attested > committed > self-signed/unknown); `scoreMetadata` passed through as the #1396 seam; absence of tier data degrades to recency |
| AC3 | Opt-out config; corpus failure never blocks claim/solve (log + proceed) | 1, 3, 4, 6 | `engine.knowledgeAutoload` config tests; loader timeout/throw tests return null; engine opt-out + no-records tests reach POST_SNAPSHOT normally |
| AC4 | Anvil e2e: second run of same task type sees first run's published artifact in context | 5, 7 | `pack()` projection tests (incl. store-only two-run chain); e2e asserts projection existence, `consumed_refs_json` referencing run 1's envelope CID + artifact sha256, and the `corpus_knowledge` event |
| — (design) | Consumed-refs recording for #1397 + observability event | 2, 4 | Persistence column round-trip test; event assertion in engine test and e2e |

## Self-review notes

- **Spec coverage:** every design-note element has a task — retrieval module (T3), injection + role gate + side-channel (T4), event + consumed refs (T2/T4), projection gap (T5), config (T1), daemon hoist + main threading (T6), e2e (T7).
- **Deviations from the design note** are listed under "Verified reality vs the design note" (event-kind union + detail string; no `taskCid` arg to `projectEnvelope`; no helper-file changes).
- **Type consistency:** `CorpusKnowledgeRecordRef` (T3) is what T4 persists (`consumedRefsJson = JSON.stringify(records)`) and what T7 parses (`envelopeCid`, `artifacts[].sha256`). The event `detail` uses the trimmed `{ envelopeCid, artifacts: string[] }` shape in both T4's emit and T4's test.
- **Existing-test blast radius:** default-on knowledge in engines without seeded projections injects nothing (no behaviour change); `daemon-start-order.test.ts` marker moves earlier but stays before all store mutations; `pack()` projections are additive in packaging suites.

---

## Paused state (2026-07-04, stand-down)

Implementation complete through Stage 4 review; pipeline paused before the
findings below were fixed. Tests 5481 passed, typecheck clean at HEAD.

Outstanding review findings (fix before opening a PR):

1. Projection tier mis-stamping — pack() saves the envelope projection at
   sign time, when v2/v3 envelopes are already stamped `committed`; a
   race-lost/failed delivery leaves a `committed` projection that outranks
   delivered `self-signed` work. Move the save to the deliver() success path
   (or downgrade tier at pack time).
2. Artifact join degrades on real stores — handleSearchRecords joins only the
   12 most-recent served/cached artifact rows of any type, so top-ranked
   records inject with empty artifact lists once the store has >12 recent
   rows; the ranking pool itself is the 12 newest projections, so older
   attested records fall out before the tier sort. Raise the pool and
   backfill refs by envelopeCid in corpus-knowledge.ts (do not touch MCP code).
3. Retry re-drive waste — the lookup re-runs in full on every RUNNING
   retry/recovery re-drive (duplicate corpus_knowledge events, repeated
   timeout charge). Reuse persisted consumedRefsJson.
4. Sick corpus beats no corpus — a hung network corpus times out the whole
   search, discarding local rows; fall back to a local-only pass. The timed-
   out query is also uncancelled (no AbortSignal).
5. Defanged #649 regression test — daemon-start-order.test.ts used
   corpusFactory invocation as its ordering marker; the constructor hoist
   makes its assertions unfalsifiable. Re-marker the test.
6. (Note) Knowledge keyed on solverType only — SolverNets sharing a
   solverType cross-pollinate; EnvelopeProjection has no manifest-cid
   dimension yet.
7. (Note) corpusKnowledge flows into published trajectories via the hermes
   prompt serialisation of ctx.task — refs-only today; treat as provenance,
   but any future payload field ships through this side door.
