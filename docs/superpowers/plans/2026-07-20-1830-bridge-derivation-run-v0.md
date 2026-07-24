# Bridge Derivation Run v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the historical ledger bridge with unbounded paging, canonical typed transcript spans, explicit derived provenance, authenticated held-out exclusion, and B5 manifest/gas evidence.

**Architecture:** Rehome the existing #1473 Claude/Codex stream parsers in `@jinn-network/core/trajectory` and expose an in-memory parse method so the bridge can reuse them on snapshot bytes. Keep the authenticated verdict/attempt join and held-out chokepoint intact, widen the canonical provenance vocabulary end-to-end, and remove the CLI's implicit 2,000-row cap while retaining explicit bounded dry runs.

**Tech Stack:** TypeScript, Zod, Vitest, Ponder indexer, Yarn 4, Node.js 22.

## Global Constraints

- Work only in `/Users/adrianobradley/jinn-mono_worktrees/1830` on `feat/1830-bridge-derivation-run-v0`.
- Preserve immutable source records, append-only publication semantics, C11 Episode v1 strict-write/read-compatible rules, and B5 recovery journaling.
- Never contact production, fetch a live ledger, upload IPFS content, publish a record, or broadcast a chain transaction.
- Historical records must use exact provenance `derived-from-history`.
- Historical records must set `retrievalVisible: false` and must never carry `retrieval:visible.v1`.
- Held-out exclusion uses authenticated task identity and runs before capture/upload/anchor.
- Missing, unsupported, or unparseable snapshots degrade to patch plus verdict.
- Gas evidence is accepted only from injected confirmed receipt facts; never estimate or invent it.
- Parser source format, name, and version remain on every derived typed span.
- Use Node `22.22.2` from `$HOME/.nvm/versions/node/v22.22.2/bin`.

---

## File Map

- `packages/core/src/trajectory/transcript-to-spans/` — canonical pure stream parsers and shared span/parser types.
- `client/src/trajectory/transcript-to-spans/` — compatibility re-exports plus client-only registry/Hermes adapter.
- `packages/core/src/{captured-task,envelope}.ts` — canonical provenance contract accepted by capture.
- `packages/plugin/src/schemas/episode.ts` — canonical Episode v1 provenance contract.
- `client/packages/harness-layer/src/{snapshot-transcript,bridge-fetch-evidence,bridge}.ts` — snapshot parse, typed history mapping, held-out chokepoint, and manifest survivors.
- `client/packages/harness-layer/src/{bridge-verdict-source,pipeline,cli}.ts` — full default ledger walk and explicit bounded slice.
- `packages/indexer/src/handlers.ts` — lossless lightweight provenance projection.
- Associated `test/` files — automated binary acceptance and regression coverage.

### Task 1: Canonical in-memory transcript parser API

**Files:**

- Create: `packages/core/src/trajectory/transcript-to-spans/types.ts`
- Create: `packages/core/src/trajectory/transcript-to-spans/attrs.ts`
- Create: `packages/core/src/trajectory/transcript-to-spans/claude-code-stream-json.ts`
- Create: `packages/core/src/trajectory/transcript-to-spans/codex-exec-json.ts`
- Create: `packages/core/src/trajectory/transcript-to-spans/index.ts`
- Modify: `packages/core/src/trajectory/index.ts`
- Modify: `client/src/trajectory/transcript-to-spans/{types,attrs,claude-code-stream-json,codex-exec-json}.ts`
- Test: `client/test/trajectory/transcript-to-spans/{claude-code-stream-json,codex-exec-json,conformance-roundtrip}.test.ts`
- Test: `packages/core/test/trajectory/transcript-to-spans.test.ts`

**Interfaces:**

- Produces: `TranscriptSpanInput`, `TranscriptSpanParser`, `ClaudeCodeStreamJsonParser.parseText(rawText)`, `CodexExecJsonParser.parseText(rawText)`.
- Preserves: existing `parse(path)` behavior and all `jinn.transcript.*` attributes.

- [ ] **Step 1: Write failing in-memory parser conformance tests**

Add core tests that instantiate both parsers with real fixture text and assert:

```ts
const spans = parser.parseText(rawText);
expect(spans.some((span) =>
  span.attributes['jinn.span.kind'] === 'jinn.agent_turn')).toBe(true);
expect(spans.some((span) =>
  span.attributes['jinn.span.kind'] === 'jinn.tool_call')).toBe(true);
expect(spans.every((span) =>
  span.attributes['jinn.transcript.parser'] === parser.parserName
  && span.attributes['jinn.transcript.parserVersion'] === parser.parserVersion
  && span.attributes['jinn.transcript.sourceFormat'] === parser.sourceFormat,
)).toBe(true);
```

Also compare `await parser.parse(tempPath)` with `parser.parseText(rawText)` after
normalizing synthesized Claude timestamps.

- [ ] **Step 2: Run RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" \
  corepack yarn --cwd packages/core vitest run test/trajectory/transcript-to-spans.test.ts
```

Expected: FAIL because the stream parser exports and `parseText()` do not exist in core.

- [ ] **Step 3: Move the implementations and delegate file parsing**

Define the core contract:

```ts
export interface TranscriptSpanParser {
  readonly sourceFormat: string;
  readonly parserName: string;
  readonly parserVersion: string;
  parse(transcriptPath: string): Promise<TranscriptSpanInput[]>;
  parseText?(rawText: string): TranscriptSpanInput[];
}
```

For Claude and Codex, make `parse(path)` read the file and return
`this.parseText(rawText)`, while `parseText` contains the current parsing logic.
Export the classes and helpers from `@jinn-network/core/trajectory`. Replace the
four client implementation files with compatibility re-exports. Do not change
the source-format mappings or span contents.

- [ ] **Step 4: Run GREEN and existing parser conformance**

Run the core test plus the existing client parser suites. Expected: PASS with
the same live-path behavior and new in-memory behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/trajectory packages/core/test/trajectory \
  client/src/trajectory/transcript-to-spans \
  client/test/trajectory/transcript-to-spans
git commit -m "refactor(core): share transcript span parsers"
```

### Task 2: Derived provenance across the C11 contract

**Files:**

- Modify: `packages/core/src/captured-task.ts`
- Modify: `packages/core/src/envelope.ts`
- Modify: `packages/plugin/src/schemas/episode.ts`
- Modify: `packages/plugin/src/{ports/corpus-port.ts,schemas/knowledge-packet.ts}`
- Modify: `client/packages/harness-layer/src/{signal,gate}.ts`
- Modify: `client/packages/harness-layer/src/adapters/corpus-adapter.ts`
- Modify: `packages/indexer/src/handlers.ts`
- Test: `packages/plugin/test/schemas/episode.test.ts`
- Test: `client/packages/harness-layer/test/{gate,signal}.test.ts`
- Test: `packages/indexer/test/handlers.capture-signal.test.ts`

**Interfaces:**

- Produces: canonical provenance union
  `'contributed' | 'imported' | 'derived-from-history'`.
- Gate policy: `imported` remains ineligible; contributed and derived raw
  evidence are eligible when every other gate passes.

- [ ] **Step 1: Write failing provenance contract tests**

Require strict Episode v1 and CapturedTask parsing to preserve
`derived-from-history`; require indexer-lite parsing to return it verbatim; and
require the promotion gate to accept evaluator-verified derived evidence while
continuing to reject imported seeds.

- [ ] **Step 2: Run RED**

Run focused plugin, harness gate, and indexer signal tests. Expected: schema
enum rejection or provenance collapsing to `contributed`.

- [ ] **Step 3: Widen the vocabulary without weakening defaults**

Use one exact three-value union at each write/read boundary. In the indexer,
replace the lossy binary projection with:

```ts
const provenance =
  evidence['provenance'] === 'imported'
  || evidence['provenance'] === 'derived-from-history'
    ? evidence['provenance']
    : 'contributed';
```

Change the gate check to reject `imported` specifically:

```ts
if (env.provenance === 'imported') {
  reasons.push('imported seeds are already-distilled layer-2, not raw evidence');
}
```

Keep every omitted-provenance default as `contributed`.

- [ ] **Step 4: Run GREEN and typechecks**

Run focused tests plus plugin/core/indexer typechecks. Expected: PASS and no
binary provenance assumptions remaining on the derived path.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/plugin/src packages/plugin/test \
  client/packages/harness-layer/src client/packages/harness-layer/test \
  packages/indexer/src packages/indexer/test
git commit -m "feat(evidence): record derived history provenance"
```

### Task 3: Typed snapshot spans with patch-only degradation

**Files:**

- Modify: `client/packages/harness-layer/src/snapshot-transcript.ts`
- Modify: `client/packages/harness-layer/src/bridge-fetch-evidence.ts`
- Modify: `client/packages/harness-layer/src/bridge.ts`
- Delete: `client/packages/harness-layer/src/transcript-outline.ts`
- Test: `client/packages/harness-layer/test/{snapshot-transcript,bridge-fetch-evidence,bridge}.test.ts`
- Delete: `client/packages/harness-layer/test/transcript-outline.test.ts`

**Interfaces:**

- `BridgeEvidence.trajectorySpans?: TranscriptSpanInput[]`
- `toBridgeCapturedTask()` emits patch → typed spans → verdict, or patch →
  verdict with `patch-only`.

- [ ] **Step 1: Write failing bridge typed-span tests**

Use the existing real Claude/Codex fixtures inside donation-wrapped in-memory
snapshots. Require:

```ts
expect(evidence.trajectorySpans).toEqual(expect.arrayContaining([
  expect.objectContaining({
    attributes: expect.objectContaining({
      'jinn.span.kind': 'jinn.agent_turn',
      'jinn.transcript.parser': 'claude-code-stream-json',
      'jinn.transcript.parserVersion': '1.0.0',
    }),
  }),
]));
```

For absent, Hermes-only, corrupt, and hash-mismatched snapshots require
`trajectorySpans` to be undefined and the published Episode to contain patch
and verdict only with `patch-only`.

- [ ] **Step 2: Run RED**

Run the three focused bridge suites. Expected: FAIL because only `stepTrace`
exists and the bridge emits a single outline step.

- [ ] **Step 3: Parse with core and map to Episode steps**

Select the core parser by snapshot harness, call `parseText(jsonl)`, and return
non-empty typed spans. In `toBridgeCapturedTask`, map them structurally:

```ts
const historySteps = (ev.trajectorySpans ?? []).map((span, index) => ({
  spanId: `history-${String(index + 1).padStart(6, '0')}`,
  parentSpanId: null,
  kind: span.attributes['jinn.span.kind'] as
    | 'jinn.agent_turn'
    | 'jinn.tool_call',
  name: span.name,
  startTimeUnixNano: span.startTimeUnixNano,
  endTimeUnixNano: span.endTimeUnixNano,
  attributes: span.attributes,
  redactedKeys: [],
}));
```

Set task provenance to `derived-from-history`. Remove the obsolete outline
module after every caller is gone.

- [ ] **Step 4: Assert final payload serving invariants**

Publish through injected artifact/envelope/anchor fakes and parse the actual
`jinn.episode.v1` upload. Require:

```ts
expect(episode.provenance).toBe('derived-from-history');
expect(episode.retrievalVisible).toBe(false);
expect(episode.task.distributionTags).not.toContain(RETRIEVAL_VISIBLE_TAG);
expect(episode.trajectory.some((span) =>
  span.attributes['jinn.transcript.parserVersion'] === '1.0.0')).toBe(true);
```

- [ ] **Step 5: Run GREEN and commit**

Run all snapshot/bridge/parser suites, then:

```bash
git add client/packages/harness-layer packages/core packages/plugin
git commit -m "feat(bridge): derive typed history episodes"
```

### Task 4: Complete default paging with explicit bounded slices

**Files:**

- Modify: `client/packages/harness-layer/src/bridge-verdict-source.ts`
- Modify: `client/packages/harness-layer/src/pipeline.ts`
- Modify: `client/packages/harness-layer/src/cli.ts`
- Test: `client/packages/harness-layer/test/{bridge-verdict-source,pipeline,cli}.test.ts`

**Interfaces:**

- `VerdictSource.list()` with no limit returns the complete paged walk.
- `VerdictSource.list({limit:N})` returns at most N authoritative attempt
  tuples while retaining bounded duplicate discovery candidates.
- CLI only supplies a bridge limit when the operator used `--limit`.

- [ ] **Step 1: Write the failing >1,000 fixture**

Create a fetch fake returning 1,000 valid rows on page 1 and at least two valid
rows on page 2. Assert `source.list()` returns all 1,002. Assert `after` on the
second request equals page 1's `endCursor`.

Add a ceiling test whose final allowed page still reports `hasNextPage: true`;
require a named incomplete-walk error instead of a partial success.

- [ ] **Step 2: Run RED**

Expected: the no-argument call truncates at the old `DEFAULT_LIMIT = 500`, and
the safety-ceiling case returns partial data.

- [ ] **Step 3: Implement full default walk**

Use `Infinity` (or the finite page ceiling capacity) as the internal no-limit
tuple cap, retain the 1,000-row GraphQL page size, and throw when the loop
exhausts `MAX_PAGES` with another page advertised.

In CLI parsing, remove `DEFAULT_DISTILL_LIMIT` and build:

```ts
const limit =
  userSetLimit && Number.isFinite(n) && n > 0
    ? n
    : undefined;
```

Pass the property into the pipeline only when defined. Keep `--limit` as the
bounded dry-run control and truncation warning source.

- [ ] **Step 4: Run GREEN and commit**

Run verdict-source, pipeline, and CLI tests, then:

```bash
git add client/packages/harness-layer/src/{bridge-verdict-source,pipeline,cli}.ts \
  client/packages/harness-layer/test/{bridge-verdict-source,pipeline,cli}.test.ts
git commit -m "feat(bridge): walk the full paged ledger"
```

### Task 5: End-to-end offline acceptance net

**Files:**

- Create: `client/packages/harness-layer/test/bridge-derivation-run.test.ts`
- Modify only if the test exposes a behavior gap in Tasks 1–4.

**Interfaces:**

- One injected dry run covers source paging, join input, typed and degraded
  records, held-out exclusion, manifest membership, and gas facts.

- [ ] **Step 1: Write the composed acceptance test**

Build an entirely local fixture with:

- a small explicit source limit for the composed dry-run (the separate Task 4
  source test proves the complete 1,001+ row paged walk);
- one typed Claude snapshot;
- one missing snapshot that degrades;
- one authenticated held-out instance and one same-repo sibling;
- one manifest publisher returning a confirmed receipt with exact
  `gasUsed: 123456n` and `feeWei: 789012n`.

Assert no held-out request reaches `publishManifestBatch`; every member is
schema-valid, derived, unmarked, and either typed or patch-only; and the bridge
result preserves the exact manifest CID/root/tx/gas/fee.

- [ ] **Step 2: Run RED if the composed behavior exposes a gap**

The new acceptance test may pass immediately where it characterizes already
implemented B5/I1 behavior. For any failure, confirm the failure is an actual
acceptance gap before editing production code and apply the systematic
debugging workflow.

- [ ] **Step 3: Run the full focused net**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" \
  corepack yarn --cwd client vitest run \
    packages/harness-layer/test/bridge-derivation-run.test.ts \
    packages/harness-layer/test/bridge-verdict-source.test.ts \
    packages/harness-layer/test/bridge-fetch-evidence.test.ts \
    packages/harness-layer/test/bridge.test.ts \
    packages/harness-layer/test/bridge-manifest.test.ts \
    packages/harness-layer/test/pipeline.test.ts \
    packages/harness-layer/test/cli.test.ts
```

Expected: all files and tests pass with no network access.

- [ ] **Step 4: Commit**

```bash
git add client/packages/harness-layer/test/bridge-derivation-run.test.ts
git commit -m "test(bridge): prove offline derivation acceptance"
```

### Task 6: Verification, reviews, and delivery

**Files:**

- Review the merge-base diff only:
  `git diff "$(git merge-base origin/next HEAD)"..HEAD`.

- [ ] **Step 1: Run proportional verification**

Run fresh focused tests; core/plugin/client/harness/indexer typechecks; core,
plugin, and indexer tests; client build; diff check; and the client suite
proportional to changed package boundaries. Do not run live/e2e commands that
contact testnet, IPFS, or production.

- [ ] **Step 2: Run isolated code review**

Provide the issue body, design, plan, merge-base/head, and exact diff to a fresh
reviewer. Fix every Critical and Important finding with a failing test first,
then re-review.

- [ ] **Step 3: Run isolated security review**

Audit authentication boundary, held-out chokepoint, decompression/byte bounds,
untrusted GraphQL paging, provenance downgrade/collapse, retrieval-mark
admission, manifest membership, irreversible-side-effect retry behavior, and
gas receipt persistence. Fix and re-run the gate for every actionable finding.

- [ ] **Step 4: Audit binary acceptance**

Map every issue criterion to an automated assertion. If any criterion remains
human-only, use `Refs #1830` and list the exact residual. Use `Closes #1830`
only if all criteria are automated and green.

- [ ] **Step 5: Push and open a draft PR**

Push `feat/1830-bridge-derivation-run-v0`, open a draft PR against `next` with
label `engine:review`, keep it drafted, never merge or undraft it, move the
Project status to `In Review`, and remove the clean worktree only after
verifying local HEAD equals the remote branch.
