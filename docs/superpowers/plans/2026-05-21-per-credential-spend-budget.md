# Per-Credential Daily Spend Budget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Jinn daemon a daily spend budget per authentication credential — it counts the actual USD cost of each completed harness run and pauses claims for a credential once its day's spend reaches the operator's cap.

**Architecture:** A credential is `{provider}:{authMethod}` (e.g. `anthropic:api-key`). On each harness run the engine records the run's actual cost (Claude Code self-reports `total_cost_usd`; Codex emits tokens priced via `tokenlens`; hermes falls back to a heuristic) onto the task's `activity_events` row. "Spent today" is a `SUM` over those rows since UTC midnight — no separate ledger table. A pre-claim gate in the engine-watcher loop, sibling to `gateClaimByReadiness`, skips claims for an over-budget credential.

**Tech Stack:** TypeScript, Node 22, vitest, `better-sqlite3`, `tokenlens` (new dependency).

**Scope:** Daemon-side only (design-spec build steps 1–8, 10). The operator-app UI (step 9) is deferred behind the canonical-doc amendment in issue #453 and is **not** in this plan.

**Design spec:** `docs/superpowers/specs/2026-05-21-per-credential-spend-budget-design.md`

---

## Setup

This work branches from `next` (where PR #345's `client/src/harnesses/cost-estimates.ts` exists). Before Task 1:

```bash
cd "/Users/adrianobradley/life's-work/jinn-mono"
git fetch origin
git switch -c feat/346-spend-budget origin/next
cd client && yarn install
```

All paths below are relative to the repo root. All commands run from `client/`.

## File Structure

**New files:**
- `client/src/spend/pricing.ts` — `priceTokens()` — token counts → USD via `tokenlens`.
- `client/src/spend/credential.ts` — `CredentialId` type, `resolveCredentialId()`.
- `client/src/spend/usage.ts` — `HarnessUsage`, `parseClaudeCodeUsage()`, `parseCodexUsage()`, `harvestHarnessUsage()`.
- `client/src/spend/record.ts` — `recordTaskCost()` — writes one cost row per harness run.
- `client/src/spend/daemon-config.ts` — `buildSpendCapConfig()` — assembles per-credential caps from operator config.
- `client/src/daemon/spend-cap-gate.ts` — `gateClaimBySpendCap()`, mirroring `readiness-gate.ts`.
- Tests under `client/test/spend/` and `client/test/daemon/`.

**Modified files:**
- `client/src/store/store.ts` — three `activity_events` columns + migration; `spentTodayMicros()`; extend `ActivityEventInput` / `ActivityEventRow` / `recordActivityEvent` / `getRecentActivityEvents`.
- `client/src/harnesses/engine/engine.ts` — call `recordTaskCost()` in `runImpl`.
- `client/src/config.ts` — `spendCaps` schema field; `JINN_SPEND_CAP_USD` in `TRACKED_ENV_VARS`.
- `client/src/daemon/daemon.ts` — `DaemonConfig.spendCap`; gate wiring in `_runEngineWatcherLoop`.
- `client/src/main.ts` — build `spendCap` config and pass it to the daemon + status config.
- `client/src/api/gather-status.ts` — `StatusGatherConfig.spendCaps`; compute the `spend` block.
- `client/src/api/status-build.ts` — `spend` field on `StatusV1Response`.
- `client/src/harnesses/cost-estimates.ts` — rewire `harnessUsesPaidApiKey()` to `resolveCredentialId()`.

---

## Task 1: Pricing helper (`priceTokens`)

**Files:**
- Create: `client/src/spend/pricing.ts`
- Test: `client/test/spend/pricing.test.ts`

- [ ] **Step 1: Add the dependency**

Run: `cd client && yarn add tokenlens @tokenlens/helpers`
Expected: both packages added to `client/package.json`.

- [ ] **Step 2: Verify the tokenlens API shape**

Run:
```bash
cd client && node --input-type=module -e "import {getTokenCosts} from '@tokenlens/helpers'; import {getModels} from 'tokenlens'; const c=getTokenCosts('gpt-4o',{prompt_tokens:1000,completion_tokens:1000},getModels()); console.log(JSON.stringify(c));"
```
Expected: a JSON object containing a numeric `totalUSD`. If the call signature differs in the installed version, adjust Step 4's wrapper to match (the wrapper is deliberately the only file that touches the tokenlens API).

- [ ] **Step 3: Write the failing test**

```typescript
// client/test/spend/pricing.test.ts
import { describe, expect, it } from 'vitest';
import { priceTokens } from '../../src/spend/pricing.js';

describe('priceTokens', () => {
  it('returns a positive USD cost for a known model', () => {
    const usd = priceTokens('gpt-4o', { inputTokens: 1000, outputTokens: 1000 });
    expect(usd).not.toBeNull();
    expect(usd as number).toBeGreaterThan(0);
  });

  it('returns null for an unknown model', () => {
    expect(priceTokens('no-such-model-xyz-123', { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('returns 0 for zero tokens on a known model', () => {
    expect(priceTokens('gpt-4o', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd client && yarn test test/spend/pricing.test.ts`
Expected: FAIL — `Cannot find module '../../src/spend/pricing.js'`.

- [ ] **Step 5: Write the implementation**

```typescript
// client/src/spend/pricing.ts
import { getTokenCosts } from '@tokenlens/helpers';
import { getModels } from 'tokenlens';

/** Bundled, offline model catalog (models.dev snapshot shipped with tokenlens). */
const MODELS = getModels();

/**
 * Price a token count in USD for the given model. Returns null when the model
 * is unknown to the catalog (caller falls back to a heuristic).
 */
export function priceTokens(
  modelId: string,
  tokens: { inputTokens: number; outputTokens: number },
): number | null {
  try {
    const costs = getTokenCosts(
      modelId,
      { prompt_tokens: tokens.inputTokens, completion_tokens: tokens.outputTokens },
      MODELS,
    );
    return typeof costs?.totalUSD === 'number' ? costs.totalUSD : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd client && yarn test test/spend/pricing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add client/package.json client/yarn.lock client/src/spend/pricing.ts client/test/spend/pricing.test.ts
git commit -m "feat(346): add priceTokens helper backed by tokenlens"
```

---

## Task 2: Credential resolution (`resolveCredentialId`)

**Files:**
- Create: `client/src/spend/credential.ts`
- Test: `client/test/spend/credential.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/spend/credential.test.ts
import { describe, expect, it } from 'vitest';
import { resolveCredentialId } from '../../src/spend/credential.js';

describe('resolveCredentialId', () => {
  it('claude-code with an OAuth token is a subscription', () => {
    expect(resolveCredentialId('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }))
      .toBe('anthropic:subscription');
  });

  it('claude-code with only an API key is a paid key', () => {
    expect(resolveCredentialId('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-x' }))
      .toBe('anthropic:api-key');
  });

  it('claude-code prefers the OAuth token when both are set', () => {
    expect(resolveCredentialId('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }))
      .toBe('anthropic:subscription');
  });

  it('codex with an API key is a paid key', () => {
    expect(resolveCredentialId('codex', { OPENAI_API_KEY: 'sk-x' })).toBe('openai:api-key');
  });

  it('codex with no API key is a subscription', () => {
    expect(resolveCredentialId('codex', {})).toBe('openai:subscription');
  });

  it('hermes-agent keys on the configured provider', () => {
    expect(resolveCredentialId('hermes-agent', { JINN_HERMES_PROVIDER: 'openrouter' }))
      .toBe('openrouter:api-key');
  });

  it('returns null for a harness with no LLM credential', () => {
    expect(resolveCredentialId('prediction-v1-baseline', {})).toBeNull();
    expect(resolveCredentialId(undefined, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/spend/credential.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// client/src/spend/credential.ts
import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  canonicalHarnessName,
} from '../harnesses/names.js';

/** A credential identity: `{provider}:{authMethod}`, e.g. `anthropic:api-key`. */
export type CredentialId = string;

/**
 * Resolve which authentication credential a harness will bill against, from
 * the presence of provider env vars. Returns null when the harness makes no
 * paid LLM call (e.g. prediction harnesses) or no credential is recognisable.
 */
export function resolveCredentialId(
  harness: string | undefined,
  env: NodeJS.ProcessEnv,
): CredentialId | null {
  if (!harness) return null;
  switch (canonicalHarnessName(harness)) {
    case CLAUDE_CODE_HARNESS:
      if (env['CLAUDE_CODE_OAUTH_TOKEN']) return 'anthropic:subscription';
      if (env['ANTHROPIC_API_KEY']) return 'anthropic:api-key';
      return null;
    case CODEX_HARNESS:
      if (env['OPENAI_API_KEY']) return 'openai:api-key';
      return 'openai:subscription';
    case HERMES_AGENT_HARNESS: {
      const provider = (env['JINN_HERMES_PROVIDER'] ?? 'hermes').trim().toLowerCase();
      return `${provider}:api-key`;
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/spend/credential.test.ts`
Expected: PASS (7 tests). If `canonicalHarnessName` or a harness constant is not exported from `client/src/harnesses/names.ts`, check that file for the actual export names and adjust the import.

- [ ] **Step 5: Commit**

```bash
git add client/src/spend/credential.ts client/test/spend/credential.test.ts
git commit -m "feat(346): resolve credential id from harness + env"
```

---

## Task 3: Usage harvest (`harvestHarnessUsage`)

**Files:**
- Create: `client/src/spend/usage.ts`
- Test: `client/test/spend/usage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/spend/usage.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeUsage, parseCodexUsage, harvestHarnessUsage } from '../../src/spend/usage.js';

describe('parseClaudeCodeUsage', () => {
  it('extracts total_cost_usd from the result line', () => {
    const jsonl = [
      '{"type":"assistant","message":{}}',
      '{"type":"result","total_cost_usd":0.42,"usage":{"input_tokens":1000,"output_tokens":200}}',
    ].join('\n');
    expect(parseClaudeCodeUsage(jsonl)).toEqual({ costUsd: 0.42, inputTokens: 1000, outputTokens: 200 });
  });

  it('returns null when there is no result line', () => {
    expect(parseClaudeCodeUsage('{"type":"assistant"}')).toBeNull();
  });

  it('ignores malformed lines', () => {
    const jsonl = 'not json\n{"type":"result","total_cost_usd":1.5}';
    expect(parseClaudeCodeUsage(jsonl)).toEqual({ costUsd: 1.5, inputTokens: undefined, outputTokens: undefined });
  });
});

describe('parseCodexUsage', () => {
  it('extracts tokens from the last turn.completed event', () => {
    const jsonl = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
      '{"type":"turn.completed","usage":{"input_tokens":4547,"output_tokens":120}}',
    ].join('\n');
    expect(parseCodexUsage(jsonl)).toEqual({ inputTokens: 4547, outputTokens: 120 });
  });

  it('returns null when there is no turn.completed event', () => {
    expect(parseCodexUsage('{"type":"turn.started"}')).toBeNull();
  });
});

describe('harvestHarnessUsage', () => {
  it('reads observed cost for claude-code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-cc-'));
    mkdirSync(join(dir, '.claude-code'));
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), '{"type":"result","total_cost_usd":0.7}');
    const usage = harvestHarnessUsage('claude-code', dir, 'claude-opus-4-7');
    expect(usage.costUsd).toBe(0.7);
    expect(usage.estimated).toBe(false);
  });

  it('falls back to an estimate when the output file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-miss-'));
    const usage = harvestHarnessUsage('claude-code', dir, 'claude-opus-4-7');
    expect(usage.estimated).toBe(true);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it('falls back to the unknown-model constant for an unpriceable model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-unk-'));
    const usage = harvestHarnessUsage('hermes-agent', dir, undefined);
    expect(usage.estimated).toBe(true);
    expect(usage.costUsd).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/spend/usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// client/src/spend/usage.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, canonicalHarnessName } from '../harnesses/names.js';
import { estimateModelCost } from '../harnesses/cost-estimates.js';
import { priceTokens } from './pricing.js';

/** USD attributed to a task whose model has no known price. */
export const UNKNOWN_MODEL_FALLBACK_USD = 1.0;

export interface HarnessUsage {
  model: string;
  costUsd: number;
  /** true = derived from the a-priori heuristic; false = from observed usage. */
  estimated: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/** Parse Claude Code `--output-format stream-json` output for the terminal result. */
export function parseClaudeCodeUsage(
  stdoutJsonl: string,
): { costUsd: number; inputTokens?: number; outputTokens?: number } | null {
  let result: { costUsd: number; inputTokens?: number; outputTokens?: number } | null = null;
  for (const line of stdoutJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj['type'] === 'result' && typeof obj['total_cost_usd'] === 'number') {
      const usage = obj['usage'] as Record<string, unknown> | undefined;
      result = {
        costUsd: obj['total_cost_usd'] as number,
        inputTokens: typeof usage?.['input_tokens'] === 'number' ? usage['input_tokens'] as number : undefined,
        outputTokens: typeof usage?.['output_tokens'] === 'number' ? usage['output_tokens'] as number : undefined,
      };
    }
  }
  return result;
}

/** Parse Codex `--json` output for the last turn.completed token usage. */
export function parseCodexUsage(
  stdoutJsonl: string,
): { inputTokens: number; outputTokens: number } | null {
  let result: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of stdoutJsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj['type'] === 'turn.completed' && obj['usage']) {
      const usage = obj['usage'] as Record<string, unknown>;
      const inT = usage['input_tokens'];
      const outT = usage['output_tokens'];
      if (typeof inT === 'number' && typeof outT === 'number') {
        result = { inputTokens: inT, outputTokens: outT };
      }
    }
  }
  return result;
}

function heuristicUsage(model: string | undefined): HarnessUsage {
  const est = model ? estimateModelCost(model) : null;
  return {
    model: model ?? 'unknown',
    costUsd: est?.usd ?? UNKNOWN_MODEL_FALLBACK_USD,
    estimated: true,
  };
}

/**
 * Determine the USD cost of a finished harness run. Reads the harness's own
 * output file for observed usage; falls back to a heuristic on any failure.
 * Always returns a HarnessUsage — never throws.
 */
export function harvestHarnessUsage(
  harness: string,
  workingDir: string,
  model: string | undefined,
): HarnessUsage {
  try {
    const canonical = canonicalHarnessName(harness);
    if (canonical === CLAUDE_CODE_HARNESS) {
      const raw = readFileSync(join(workingDir, '.claude-code', 'stdout.jsonl'), 'utf8');
      const parsed = parseClaudeCodeUsage(raw);
      if (parsed) {
        return {
          model: model ?? 'unknown',
          costUsd: parsed.costUsd,
          estimated: false,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
        };
      }
      return heuristicUsage(model);
    }
    if (canonical === CODEX_HARNESS) {
      const raw = readFileSync(join(workingDir, '.codex-code', 'stdout.jsonl'), 'utf8');
      const parsed = parseCodexUsage(raw);
      if (parsed && model) {
        const usd = priceTokens(model, parsed);
        if (usd != null) {
          return {
            model,
            costUsd: usd,
            estimated: false,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
          };
        }
      }
      return heuristicUsage(model);
    }
    return heuristicUsage(model);
  } catch {
    return heuristicUsage(model);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/spend/usage.test.ts`
Expected: PASS (8 tests). The third `harvestHarnessUsage` test asserts `1.0` — `estimateModelCost(undefined)` is not called, so the unknown-model constant applies.

- [ ] **Step 5: Commit**

```bash
git add client/src/spend/usage.ts client/test/spend/usage.test.ts
git commit -m "feat(346): harvest observed harness usage with heuristic fallback"
```

---

## Task 4: Activity-events cost columns

**Files:**
- Modify: `client/src/store/store.ts`
- Test: `client/test/store/activity-cost.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/store/activity-cost.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-store-')), 'jinn.db'));
}

describe('activity_events cost columns', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('round-trips credentialId, costUsdMicros and model', () => {
    store = freshStore();
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'task_cost',
      requestId: 'req-1',
      credentialId: 'anthropic:api-key',
      costUsdMicros: 420_000,
      model: 'claude-opus-4-7',
    });
    const rows = store.getRecentActivityEvents(10);
    const row = rows.find(r => r.requestId === 'req-1');
    expect(row?.credentialId).toBe('anthropic:api-key');
    expect(row?.costUsdMicros).toBe(420_000);
    expect(row?.model).toBe('claude-opus-4-7');
  });

  it('leaves cost columns null for non-cost events', () => {
    store = freshStore();
    store.recordActivityEvent({ ts: new Date().toISOString(), kind: 'claimed', requestId: 'req-2' });
    const row = store.getRecentActivityEvents(10).find(r => r.requestId === 'req-2');
    expect(row?.credentialId).toBeNull();
    expect(row?.costUsdMicros).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/store/activity-cost.test.ts`
Expected: FAIL — `recordActivityEvent` rejects unknown property / `credentialId` is `undefined` on the row.

- [ ] **Step 3: Extend the `ActivityEventInput` and `ActivityEventRow` interfaces**

In `client/src/store/store.ts`, add three fields to each interface (after `detail`):

```typescript
export interface ActivityEventInput {
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
  credentialId?: string | null;
  costUsdMicros?: number | null;
  model?: string | null;
}

export interface ActivityEventRow {
  id: number;
  ts: string | null;
  kind: string;
  requestId: string | null;
  serviceIndex: number | null;
  txHash: string | null;
  solverType: string | null;
  outcome: string | null;
  detail: string | null;
  credentialId: string | null;
  costUsdMicros: number | null;
  model: string | null;
}
```

- [ ] **Step 4: Add the column migration**

In `client/src/store/store.ts`, find the `envelope_projections` migration block (the `addColumn` helper, around line 534). Immediately after that block, add a parallel migration for `activity_events`:

```typescript
{
  const activityCols = new Set(
    (this.db.prepare(`PRAGMA table_info(activity_events)`).all() as Array<{ name: string }>)
      .map(c => c.name),
  );
  const addActivityColumn = (name: string, ddl: string) => {
    if (!activityCols.has(name)) this.db.exec(`ALTER TABLE activity_events ADD COLUMN ${ddl}`);
  };
  addActivityColumn('credential_id', 'credential_id TEXT');
  addActivityColumn('cost_usd_micros', 'cost_usd_micros INTEGER');
  addActivityColumn('model', 'model TEXT');
  this.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_activity_events_credential ON activity_events (credential_id, ts)`,
  );
}
```

- [ ] **Step 5: Extend `recordActivityEvent`**

Replace the `recordActivityEvent` body (around line 967) with:

```typescript
recordActivityEvent(event: ActivityEventInput): void {
  this.db.prepare(
    `INSERT INTO activity_events
       (ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
        credential_id, cost_usd_micros, model)
     VALUES
       (@ts, @kind, @requestId, @serviceIndex, @txHash, @solverType, @outcome, @detail,
        @credentialId, @costUsdMicros, @model)`,
  ).run({
    ts: event.ts ?? null,
    kind: event.kind,
    requestId: event.requestId ?? null,
    serviceIndex: event.serviceIndex ?? null,
    txHash: event.txHash ?? null,
    solverType: event.solverType ?? null,
    outcome: event.outcome ?? null,
    detail: event.detail ?? null,
    credentialId: event.credentialId ?? null,
    costUsdMicros: event.costUsdMicros ?? null,
    model: event.model ?? null,
  });
}
```

- [ ] **Step 6: Extend `getRecentActivityEvents`**

In `getRecentActivityEvents` (around line 983), add the three columns to the `SELECT` list and to the row-type cast and the returned mapping. The `SELECT` becomes:

```sql
SELECT id, ts, kind, request_id, service_index, tx_hash, solver_type, outcome, detail,
       credential_id, cost_usd_micros, model
FROM activity_events
```

Add to the `as Array<{...}>` cast: `credential_id: string | null; cost_usd_micros: number | null; model: string | null;`. Add to the object the function maps each row into: `credentialId: r.credential_id, costUsdMicros: r.cost_usd_micros, model: r.model,`.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd client && yarn test test/store/activity-cost.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add client/src/store/store.ts client/test/store/activity-cost.test.ts
git commit -m "feat(346): add cost columns to activity_events"
```

---

## Task 5: Spend query (`spentTodayMicros`)

**Files:**
- Modify: `client/src/store/store.ts`
- Test: `client/test/store/spent-today.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/store/spent-today.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-today-')), 'jinn.db'));
}

describe('spentTodayMicros', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('sums cost for one credential since UTC midnight', () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 300_000 });
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 250_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(550_000);
  });

  it('excludes other credentials', () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'openai:api-key', costUsdMicros: 999_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(0);
  });

  it('excludes rows from before UTC midnight', () => {
    store = freshStore();
    const now = new Date('2026-05-21T10:00:00.000Z');
    const yesterday = new Date('2026-05-20T23:00:00.000Z');
    store.recordActivityEvent({ ts: yesterday.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 700_000 });
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 100_000 });
    expect(store.spentTodayMicros('anthropic:api-key', now)).toBe(100_000);
  });

  it('returns 0 when nothing is recorded', () => {
    store = freshStore();
    expect(store.spentTodayMicros('anthropic:api-key', new Date())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/store/spent-today.test.ts`
Expected: FAIL — `store.spentTodayMicros is not a function`.

- [ ] **Step 3: Implement `spentTodayMicros`**

In `client/src/store/store.ts`, add this method to the `Store` class, immediately after `getRecentActivityEvents`:

```typescript
/**
 * Total cost in micro-dollars recorded against a credential since the most
 * recent UTC midnight. Backs the daily spend cap.
 */
spentTodayMicros(credentialId: string, now: Date = new Date()): number {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = this.db.prepare(
    `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total
     FROM activity_events
     WHERE credential_id = @cid AND ts IS NOT NULL AND ts >= @midnight`,
  ).get({ cid: credentialId, midnight }) as { total: number };
  return row.total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/store/spent-today.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/store/store.ts client/test/store/spent-today.test.ts
git commit -m "feat(346): add spentTodayMicros spend query"
```

---

## Task 6: Record cost on each harness run

**Files:**
- Create: `client/src/spend/record.ts`
- Modify: `client/src/harnesses/engine/engine.ts`
- Test: `client/test/spend/record.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/spend/record.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { recordTaskCost } from '../../src/spend/record.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-rec-')), 'jinn.db'));
}

describe('recordTaskCost', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('records observed claude-code cost against the resolved credential', () => {
    store = freshStore();
    const dir = mkdtempSync(join(tmpdir(), 'spend-rec-wd-'));
    mkdirSync(join(dir, '.claude-code'));
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), '{"type":"result","total_cost_usd":0.5}');
    const prev = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    try {
      recordTaskCost(store, {
        requestId: 'req-1', harness: 'claude-code',
        model: 'claude-opus-4-7', workingDir: dir, solverType: 'prediction.v0',
      });
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
    }
    expect(store.spentTodayMicros('anthropic:api-key')).toBe(500_000);
  });

  it('records nothing when no credential resolves', () => {
    store = freshStore();
    recordTaskCost(store, {
      requestId: 'req-2', harness: 'prediction-v1-baseline',
      model: undefined, workingDir: '/nonexistent', solverType: null,
    });
    expect(store.getRecentActivityEvents(10).filter(r => r.kind === 'task_cost')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/spend/record.test.ts`
Expected: FAIL — module `record.js` not found.

- [ ] **Step 3: Implement `recordTaskCost`**

```typescript
// client/src/spend/record.ts
import type { Store } from '../store/store.js';
import { resolveCredentialId } from './credential.js';
import { harvestHarnessUsage } from './usage.js';

/**
 * Record the cost of one finished harness run as a `task_cost` activity row.
 * Called once per harness run (at the POST_SNAPSHOT transition). Best-effort:
 * never throws — a parse failure must not break task execution.
 */
export function recordTaskCost(
  store: Store,
  args: {
    requestId: string;
    harness: string;
    model: string | undefined;
    workingDir: string;
    solverType: string | null;
  },
): void {
  try {
    const credentialId = resolveCredentialId(args.harness, process.env);
    if (!credentialId) return;
    const usage = harvestHarnessUsage(args.harness, args.workingDir, args.model);
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'task_cost',
      requestId: args.requestId,
      solverType: args.solverType,
      credentialId,
      costUsdMicros: Math.round(usage.costUsd * 1_000_000),
      model: usage.model,
      detail: usage.estimated ? 'estimated' : 'observed',
    });
  } catch (err) {
    console.warn(
      `[spend] failed to record task cost for ${args.requestId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/spend/record.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `recordTaskCost` into the engine**

In `client/src/harnesses/engine/engine.ts`:

1. Add the import near the other relative imports at the top:
   ```typescript
   import { recordTaskCost } from '../../spend/record.js';
   ```
2. In `runImpl`, find the `console.log` line that reports the `RUNNING → POST_SNAPSHOT` transition (around line 1290, immediately after `this.persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {...})`). Immediately after that `console.log`, add:
   ```typescript
   recordTaskCost(this.store, {
     requestId: task.requestId,
     harness: impl.name,
     model: ctx.solverNet?.model,
     workingDir,
     solverType: task.solverType ?? null,
   });
   ```
   `workingDir`, `impl`, `ctx` and `task` are all in scope at that point (see the design spec §4 and the integration map). Recording here captures cost whether or not on-chain delivery later succeeds, and runs exactly once per harness run.

- [ ] **Step 6: Verify the engine still compiles**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/spend/record.ts client/test/spend/record.test.ts client/src/harnesses/engine/engine.ts
git commit -m "feat(346): record per-run harness cost in the engine"
```

---

## Task 7: Spend-cap gate

**Files:**
- Create: `client/src/daemon/spend-cap-gate.ts`
- Test: `client/test/daemon/spend-cap-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/daemon/spend-cap-gate.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gateClaimBySpendCap, _resetSpendCapGateMemoForTests } from '../../src/daemon/spend-cap-gate.js';

beforeEach(() => _resetSpendCapGateMemoForTests());

describe('gateClaimBySpendCap', () => {
  it('proceeds when spend is under the cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 5, logger });
    expect(r.proceed).toBe(true);
  });

  it('skips and reports newlyPaused on the first over-budget call', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 20, logger });
    expect(r).toMatchObject({ proceed: false, newlyPaused: true });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('does not repeat newlyPaused or the warn log on subsequent skips', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 21, logger });
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 22, logger });
    expect(r).toMatchObject({ proceed: false, newlyPaused: false });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('logs resumption when spend drops back under the cap', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 25, logger });
    const r = gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 1, logger });
    expect(r.proceed).toBe(true);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('tracks credentials independently', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    gateClaimBySpendCap({ credentialId: 'anthropic:api-key', capUsd: 20, spentTodayUsd: 25, logger });
    const r = gateClaimBySpendCap({ credentialId: 'openai:api-key', capUsd: 20, spentTodayUsd: 1, logger });
    expect(r.proceed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/daemon/spend-cap-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// client/src/daemon/spend-cap-gate.ts

export interface GateLogger {
  warn(msg: string): void;
  info(msg: string): void;
}

/** Per-credential paused state, so the warn/info logs fire once per transition. */
const lastPausedByCredential = new Map<string, boolean>();

/**
 * Decide whether a claim may proceed for a credential given today's spend.
 * Mirrors `gateClaimByReadiness`. `newlyPaused` is true only on the first skip
 * of an under→over transition — the daemon emits one event on that edge.
 */
export function gateClaimBySpendCap(args: {
  credentialId: string;
  capUsd: number;
  spentTodayUsd: number;
  logger: GateLogger;
}): { proceed: true } | { proceed: false; reason: string; newlyPaused: boolean } {
  const over = args.spentTodayUsd >= args.capUsd;
  const wasPaused = lastPausedByCredential.get(args.credentialId) ?? false;

  if (!over) {
    if (wasPaused) {
      args.logger.info(`[spend-cap] ${args.credentialId} under cap again; resuming claims`);
    }
    lastPausedByCredential.set(args.credentialId, false);
    return { proceed: true };
  }

  const reason =
    `daily spend cap reached for ${args.credentialId} ` +
    `($${args.spentTodayUsd.toFixed(2)} / $${args.capUsd.toFixed(2)})`;
  if (!wasPaused) {
    args.logger.warn(`[spend-cap] ${reason}; pausing claims until 00:00 UTC`);
  }
  lastPausedByCredential.set(args.credentialId, true);
  return { proceed: false, reason, newlyPaused: !wasPaused };
}

/** Test hook — clears the module-level paused-state memo. */
export function _resetSpendCapGateMemoForTests(): void {
  lastPausedByCredential.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/daemon/spend-cap-gate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/daemon/spend-cap-gate.ts client/test/daemon/spend-cap-gate.test.ts
git commit -m "feat(346): add spend-cap pre-claim gate"
```

---

## Task 8: Config — `spendCaps`

**Files:**
- Modify: `client/src/config.ts`
- Test: `client/test/config.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `client/test/config.test.ts`:

```typescript
describe('spendCaps config', () => {
  it('accepts a per-credential spendCaps map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-cfg-spend-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ spendCaps: { 'anthropic:api-key': 20 } }));
    const cfg = await loadConfig(path);
    expect(cfg.spendCaps).toEqual({ 'anthropic:api-key': 20 });
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a non-positive cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-cfg-spend-bad-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ spendCaps: { 'anthropic:api-key': 0 } }));
    await expect(loadConfig(path)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults spendCaps to undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-cfg-spend-none-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({}));
    const cfg = await loadConfig(path);
    expect(cfg.spendCaps).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
```

Reuse the existing imports at the top of `config.test.ts` (`mkdtemp`, `writeFile`, `rm` from `node:fs/promises`, `tmpdir`, `join`, `loadConfig`). If `mkdtemp`/`writeFile`/`rm` are not already imported there, add them.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/config.test.ts`
Expected: FAIL — `cfg.spendCaps` is `undefined` in the first test (schema does not yet allow the field, so it is stripped).

- [ ] **Step 3: Add the schema field**

In `client/src/config.ts`, inside the `JinnConfigSchema` `z.object({ ... })`, add (next to the other optional fields, e.g. after `discovery`):

```typescript
  spendCaps: z.record(z.string(), z.number().positive()).optional(),
```

- [ ] **Step 4: Register the env var for provenance**

In `client/src/config.ts`, add `'JINN_SPEND_CAP_USD'` to the `TRACKED_ENV_VARS` array. (`JINN_SPEND_CAP_USD` is a blanket cap consumed directly by `buildSpendCapConfig` in Task 9 — it is not a config-file field and needs no schema entry or override block, only provenance tracking.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && yarn test test/config.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 6: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "feat(346): add spendCaps config schema"
```

---

## Task 9: Wire the gate into the daemon

**Files:**
- Create: `client/src/spend/daemon-config.ts`
- Modify: `client/src/daemon/daemon.ts`, `client/src/main.ts`
- Test: `client/test/spend/daemon-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/spend/daemon-config.test.ts
import { describe, expect, it } from 'vitest';
import { buildSpendCapConfig } from '../../src/spend/daemon-config.js';

const joined = {
  bafycid1: { manifestCid: 'bafycid1', roles: ['solver'], harness: 'claude-code', plugins: [] },
  bafycid2: { manifestCid: 'bafycid2', roles: ['solver'], harness: 'hermes-agent', plugins: [] },
} as never;

describe('buildSpendCapConfig', () => {
  it('returns undefined when no caps are configured', () => {
    expect(buildSpendCapConfig({ joinedSolverNets: joined, spendCaps: undefined }, {})).toBeUndefined();
  });

  it('maps manifest cids to resolved credentials and applies explicit caps', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: { 'anthropic:api-key': 20 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x' },
    );
    expect(out?.manifestCredentials['bafycid1']).toBe('anthropic:api-key');
    expect(out?.caps['anthropic:api-key']).toBe(20);
  });

  it('applies JINN_SPEND_CAP_USD as a blanket cap', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: undefined },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(15);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });

  it('an explicit cap overrides the blanket for that credential', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: { 'anthropic:api-key': 50 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(50);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/spend/daemon-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildSpendCapConfig`**

```typescript
// client/src/spend/daemon-config.ts
import type { JinnConfig } from '../config.js';
import { resolveCredentialId, type CredentialId } from './credential.js';

export interface SpendCapDaemonConfig {
  /** credentialId → USD/day cap. */
  caps: Record<CredentialId, number>;
  /** manifest CID → the credential its harness bills against. */
  manifestCredentials: Record<string, CredentialId>;
}

/**
 * Assemble the daemon's spend-cap config from operator config + env. Returns
 * undefined when no credential ends up with a cap (the gate then stays off).
 */
export function buildSpendCapConfig(
  config: Pick<JinnConfig, 'joinedSolverNets' | 'spendCaps'>,
  env: NodeJS.ProcessEnv,
): SpendCapDaemonConfig | undefined {
  const blanketRaw = env['JINN_SPEND_CAP_USD'];
  const blanketNum = blanketRaw != null && blanketRaw.trim() !== '' ? Number(blanketRaw) : NaN;
  const blanket = Number.isFinite(blanketNum) && blanketNum > 0 ? blanketNum : undefined;

  const manifestCredentials: Record<string, CredentialId> = {};
  for (const [manifestCid, entry] of Object.entries(config.joinedSolverNets ?? {})) {
    const credentialId = resolveCredentialId(entry.harness, env);
    if (credentialId) manifestCredentials[manifestCid] = credentialId;
  }

  const caps: Record<CredentialId, number> = {};
  for (const credentialId of new Set(Object.values(manifestCredentials))) {
    const cap = config.spendCaps?.[credentialId] ?? blanket;
    if (cap != null) caps[credentialId] = cap;
  }

  return Object.keys(caps).length > 0 ? { caps, manifestCredentials } : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/spend/daemon-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `spendCap` to `DaemonConfig`**

In `client/src/daemon/daemon.ts`:

1. Add the imports near the other daemon imports:
   ```typescript
   import { gateClaimBySpendCap } from './spend-cap-gate.js';
   import type { SpendCapDaemonConfig } from '../spend/daemon-config.js';
   ```
2. Add a field to the `DaemonConfig` interface (after `harnessReadinessRegistry`):
   ```typescript
   /** Per-credential daily spend caps. Omitted → no spend gating. */
   spendCap?: SpendCapDaemonConfig;
   ```

- [ ] **Step 6: Wire the gate into `_runEngineWatcherLoop`**

In `client/src/daemon/daemon.ts`, in `_runEngineWatcherLoop`, find the readiness-gate block (the `if (this.config.harnessReadinessRegistry) { ... }` ending with `if (!gate.proceed) continue;`). Immediately **after** that block and **before** `let request;` / `request = await this.adapter.claimTask(...)`, add:

```typescript
// Spend-cap gate: skip claims for a credential that has hit its daily budget.
if (this.config.spendCap) {
  const spendManifestCid = taskAnnouncement.task.solverNetManifestCid;
  const credentialId = spendManifestCid
    ? this.config.spendCap.manifestCredentials[spendManifestCid]
    : undefined;
  const capUsd = credentialId ? this.config.spendCap.caps[credentialId] : undefined;
  if (credentialId && capUsd != null) {
    const spentTodayUsd = this.store.spentTodayMicros(credentialId) / 1_000_000;
    const spendGate = gateClaimBySpendCap({
      credentialId,
      capUsd,
      spentTodayUsd,
      logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
    });
    if (!spendGate.proceed) {
      if (spendGate.newlyPaused) {
        emitEvent(this.store, {
          kind: 'spend_cap_reached',
          requestId: taskAnnouncement.taskId,
          outcome: 'paused',
          detail: spendGate.reason,
        }, 'daemon');
      }
      continue;
    }
  }
}
```

`emitEvent` is already imported in `daemon.ts` (it is used in the claim-failure path of the same loop).

- [ ] **Step 7: Build and pass `spendCap` in `main.ts`**

In `client/src/main.ts`:

1. Add the import:
   ```typescript
   import { buildSpendCapConfig } from './spend/daemon-config.js';
   ```
2. After `config` is loaded and before the `DaemonConfig` object literal is constructed, add:
   ```typescript
   const spendCap = buildSpendCapConfig(config, process.env);
   ```
3. In the `DaemonConfig` object literal passed to `new Daemon(...)`, add the field:
   ```typescript
   spendCap,
   ```

- [ ] **Step 8: Verify compilation**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/spend/daemon-config.ts client/test/spend/daemon-config.test.ts client/src/daemon/daemon.ts client/src/main.ts
git commit -m "feat(346): gate claims on the per-credential spend cap"
```

---

## Task 10: Expose spend on `/v1/status`

**Files:**
- Modify: `client/src/api/status-build.ts`, `client/src/api/gather-status.ts`, `client/src/main.ts`
- Test: `client/test/api/status-spend.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/api/status-spend.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { gatherStatusForApi } from '../../src/api/gather-status.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'status-spend-')), 'jinn.db'));
}

describe('/v1/status spend block', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('reports per-credential spend and paused state', async () => {
    store = freshStore();
    const now = new Date();
    store.recordActivityEvent({ ts: now.toISOString(), kind: 'task_cost', credentialId: 'anthropic:api-key', costUsdMicros: 21_000_000 });
    const body = await gatherStatusForApi(store, { spendCaps: { 'anthropic:api-key': 20 } });
    const row = body.spend?.credentials.find(c => c.credentialId === 'anthropic:api-key');
    expect(row?.capUsd).toBe(20);
    expect(row?.spentTodayUsd).toBeCloseTo(21);
    expect(row?.paused).toBe(true);
  });

  it('omits the spend block when no caps are configured', async () => {
    store = freshStore();
    const body = await gatherStatusForApi(store, {});
    expect(body.spend).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/api/status-spend.test.ts`
Expected: FAIL — `spendCaps` not assignable to the status config / `body.spend` is `undefined` in the first test.

- [ ] **Step 3: Add the `spend` field to `StatusV1Response`**

In `client/src/api/status-build.ts`, add this optional field to the `StatusV1Response` interface (after `taskRuns`):

```typescript
  spend?: {
    credentials: Array<{
      credentialId: string;
      capUsd: number;
      spentTodayUsd: number;
      paused: boolean;
      resetsAt: string;
    }>;
  };
```

- [ ] **Step 4: Add `spendCaps` to `StatusGatherConfig`**

In `client/src/api/gather-status.ts`, find the `StatusGatherConfig` interface and add:

```typescript
  /** Per-credential daily caps; when present, /v1/status carries a `spend` block. */
  spendCaps?: Record<string, number>;
```

- [ ] **Step 5: Compute the `spend` block in `gatherStatusForApi`**

In `client/src/api/gather-status.ts`, replace the body of `gatherStatusForApi` with:

```typescript
export async function gatherStatusForApi(
  store: Store,
  status: StatusGatherConfig | undefined,
): Promise<StatusV1Response> {
  const raw = await gatherGatheredStatusRaw(store, status);
  const body = assembleStatusV1(raw);
  const caps = status?.spendCaps;
  if (caps && Object.keys(caps).length > 0) {
    const now = new Date();
    const resetsAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    ).toISOString();
    body.spend = {
      credentials: Object.entries(caps).map(([credentialId, capUsd]) => {
        const spentTodayUsd = store.spentTodayMicros(credentialId, now) / 1_000_000;
        return { credentialId, capUsd, spentTodayUsd, paused: spentTodayUsd >= capUsd, resetsAt };
      }),
    };
  }
  return body;
}
```

(If `gatherStatusForApi`'s existing body differs, keep its `gatherGatheredStatusRaw` + `assembleStatusV1` calls and only add the `caps` block before `return`.)

- [ ] **Step 6: Pass `spendCaps` into the status config in `main.ts`**

In `client/src/main.ts`, where the daemon's `status` config (`StatusGatherConfig`) is assembled, add `spendCaps: spendCap?.caps` (reusing the `spendCap` constant from Task 9). If `status` is built inline in the `DaemonConfig` literal, add the field there.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd client && yarn test test/api/status-spend.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add client/src/api/status-build.ts client/src/api/gather-status.ts client/src/main.ts client/test/api/status-spend.test.ts
git commit -m "feat(346): expose per-credential spend on /v1/status"
```

---

## Task 11: Rewire #345's cost surface to credential resolution

**Files:**
- Modify: `client/src/harnesses/cost-estimates.ts`
- Test: `client/test/harnesses/cost-estimates-credential.test.ts`

This closes the #331 / #346-comment blind spot: a `claude-code` harness on a raw `ANTHROPIC_API_KEY` currently reads as `subscriptionPath: true` (by harness name) and gets no cost surface. Keying off `resolveCredentialId` fixes it.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/harnesses/cost-estimates-credential.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessUsesPaidApiKey } from '../../src/harnesses/cost-estimates.js';

describe('harnessUsesPaidApiKey (credential-aware)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['OPENAI_API_KEY'];
  });
  afterEach(() => { process.env = { ...saved }; });

  it('claude-code on a raw API key counts as paid', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-x';
    expect(harnessUsesPaidApiKey('claude-code')).toBe(true);
  });

  it('claude-code on a subscription token does not', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'tok';
    expect(harnessUsesPaidApiKey('claude-code')).toBe(false);
  });

  it('hermes-agent counts as paid', () => {
    expect(harnessUsesPaidApiKey('hermes-agent')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/harnesses/cost-estimates-credential.test.ts`
Expected: FAIL — the second test fails: name-based `HARNESS_BILLING` returns `subscriptionPath: true` for `claude-code` regardless, and the first test fails for the same reason (raw key not detected).

- [ ] **Step 3: Rewire `harnessUsesPaidApiKey`**

In `client/src/harnesses/cost-estimates.ts`:

1. Add the import:
   ```typescript
   import { resolveCredentialId } from '../spend/credential.js';
   ```
2. Replace the `harnessUsesPaidApiKey` function with:
   ```typescript
   /**
    * Whether running this harness spends real money. Keyed off the resolved
    * credential (raw API key vs subscription token), not the harness name —
    * so a claude-code/codex run on a raw API key is correctly treated as paid.
    */
   export function harnessUsesPaidApiKey(harness: string | undefined): boolean {
     const credentialId = resolveCredentialId(harness, process.env);
     return credentialId?.endsWith(':api-key') ?? false;
   }
   ```

- [ ] **Step 4: Confirm `decideCostSurface` delegates**

Read `decideCostSurface` in the same file. If it gates on `harnessUsesPaidApiKey(harness)`, no further change is needed. If it instead reads `HARNESS_BILLING` or `estimate.entry.subscriptionPath` directly to decide whether to suppress the surface, change that check to call `harnessUsesPaidApiKey(harness)` so the credential-aware path is used consistently. Leave `HARNESS_BILLING` and `subscriptionPath` in place — they may still be referenced elsewhere; only the *decision* moves to `harnessUsesPaidApiKey`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn test test/harnesses/cost-estimates-credential.test.ts`
Expected: PASS (3 tests).

Run the existing cost-estimates suite to confirm no regression: `cd client && yarn test test/harnesses/cost-estimates.test.ts` (if that file exists).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/cost-estimates.ts client/test/harnesses/cost-estimates-credential.test.ts
git commit -m "feat(346): key cost surface off resolved credential, not harness name"
```

---

## Final verification

- [ ] **Step 1: Typecheck the whole client**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Run the full test suite**

Run: `cd client && yarn test`
Expected: all tests pass, including every new `test/spend/`, `test/store/`, `test/daemon/`, `test/api/` file added above.

- [ ] **Step 3: Fix any cross-task breakage**

If a pre-existing test broke (most likely a test that constructs `ActivityEventRow` literals or `DaemonConfig` / `StatusGatherConfig` objects), update it for the new optional fields. New fields are all optional, so breakage should be limited to exhaustive object literals or snapshot tests.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(346): update fixtures for spend-budget fields"
```

(Skip if Step 3 found nothing.)

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/346-spend-budget
gh pr create --base next --title "feat(346): daily spend budget per credential (daemon-side)" \
  --body "Implements the daemon-side of #346 per docs/superpowers/specs/2026-05-21-per-credential-spend-budget-design.md. Operator-app UI (Spend component) is deferred behind #453."
```

---

## Notes for the implementer

- **Branch from `next`, not `main`.** `cost-estimates.ts` (PR #345) only exists on `next`.
- **No reserve/settle.** Cost is counted once, at the harness-run-complete point (`runImpl` POST_SNAPSHOT transition), from the run's *actual* observed cost. There is no claim-time reservation — see design spec §2 and §5 for why approximate-is-correct here.
- **The cap is per credential.** With one credential (the common case) it is one number. Selective pause (one credential exhausted, others still claiming) falls out of the per-credential `WHERE` clause for free.
- **Out of scope (do not build):** the operator-app Spend component UI (design-spec build step 9) — blocked behind the canonical-doc amendment #453; provider-API reconciliation (descoped, design-spec §12 D3).
- **Subscriptions** are tracked identically but are simply absent from `spendCaps` by default, so the gate's `capUsd != null` check leaves them uncapped — see design spec §3.
