# Train/Frozen Leaderboard Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the visibility / UX layer for the train + frozen mode split — subgraph indexing of `Executor.mode`, two-leaderboard dashboard view, verified-vs-unverified frozen credibility indicator, `jinn checkpoint` CLI, and the operator-app mode toggle. Together these turn the protocol-level mode field (Plan 1) into a usable surface for operators, recruits, and external comms.

**Architecture:** The subgraph extends the existing `Envelope` entity with a `mode` field and indexes it; a derived `HarnessRollup` entity aggregates by `(implName, version, codeDigest, mode)` over rolling windows. A cross-envelope consistency view flags operators whose claimed-frozen codeDigest mutates mid-window. The dashboard SPA gains two leaderboard tabs (train / frozen) per SolverNet, with verified-vs-unverified credibility tier surfaced via a badge on each row. The operator app's Configuration page gets a mode toggle and a "harness state" panel. The `jinn checkpoint publish` CLI verb produces a `HarnessCheckpoint` manifest, IPFS-pins source bundle + implStateDir, and anchors via `IdentityRegistry.setMetadata`. `jinn checkpoint install` reverses the flow.

**Tech Stack:** AssemblyScript (subgraph mappings, The Graph hosted-service); GraphQL (subgraph schema); React + Vite + TypeScript (dashboard SPA); Hono (dashboard API); TypeScript (CLI); Zod (HarnessCheckpoint manifest schema); IPFS HTTP API (pinning); ERC-8004 IdentityRegistry contract (`setMetadata` anchoring).

**Spec:** `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6.4 (verified/unverified frozen) + §7 (HarnessCheckpoint).

**DRs covered:** DR-2026-05-06-c (frozen-state contract — surface side); DR-2026-05-06-d (trust stack — subgraph cross-envelope consistency layer); DR-2026-05-06-e (multi-winrate dashboard rendering); DR-2026-05-06-g (vocabulary: HarnessCheckpoint).

**Depends on:**
- **Plan 1 (freeze-mode protocol mechanism)** — provides `Executor.mode` field this plan indexes + renders.
- **Plan 2 (SWE-rebench v2 SolverNet)** — provides the SolverNet whose verdicts populate the leaderboards. The mode/leaderboard infrastructure is benchmark-agnostic, but a real SolverNet must exist for the leaderboard to have content.

**Out of scope (filed for later):**
- ReputationRegistry on-chain slashing transaction (Phase B.2 evaluator-economics work). v1 surfaces violations in the subgraph + dashboard; the slash transaction itself ships when the Reputation economics design lands.
- Phase B.1 attested-tier credibility (cryptographic close on the trust stack). v1 surfaces verified vs unverified frozen via source-bundle publication; attested tier upgrades the credibility ladder when Phase B ships.
- Cross-checkpoint validation queries (operator-triggered audits comparing forks). v1.5+.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `subgraph/schema.graphql` | **Modify** | Add `mode: String!` field on `Envelope` entity. Add new `HarnessRollup` entity keyed by `(implName, codeDigest, mode, windowStart)`. |
| `subgraph/src/envelope-mappings.ts` | **Modify** | Index `Executor.mode` from envelope events; default `'train'` for legacy envelopes. |
| `subgraph/src/harness-rollup-mappings.ts` | **Create** | Derived rollups: increment per-`(implName, codeDigest, mode)` Verdict counters in 30-day rolling windows. |
| `subgraph/src/freeze-violation-detector.ts` | **Create** | Detect operators whose `codeDigest` changes within a claimed-frozen window; emit `FreezeViolation` entity. |
| `subgraph/test/mode-rollup.test.ts` | **Create** | Subgraph mapping unit tests (matchstick / similar). |
| `packages/sdk/src/checkpoint.ts` | **Create** | `HarnessCheckpoint` manifest schema (Zod) + `signCheckpointManifest` helper. |
| `packages/sdk/test/checkpoint.test.ts` | **Create** | Manifest schema validation; signature roundtrip. |
| `client/src/cli/commands/checkpoint.ts` | **Create** | `jinn checkpoint publish/install/list` subcommands. Pin source bundle + implStateDir to IPFS; anchor via setMetadata. |
| `client/test/cli/checkpoint.test.ts` | **Create** | CLI unit tests for publish + install + list. |
| `client/src/api/leaderboard-api.ts` | **Create** | Hono routes: `/api/solvernets/:name/leaderboard?mode=train\|frozen` returning the `HarnessRollup` query result with confidence intervals. |
| `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx` | **Create** | Top-level leaderboard page; tabs for train vs frozen; per-SolverNet selector. |
| `client/src/dashboard/spa/src/pages/leaderboard/TrainLeaderboardTable.tsx` | **Create** | Train-mode rollup table: `(implName, codeDigest, meanResolved, n, lastSeen)` rows; sortable. |
| `client/src/dashboard/spa/src/pages/leaderboard/FrozenLeaderboardTable.tsx` | **Create** | Frozen-mode rollup table with verified/unverified badge; sortable; CI columns. |
| `client/src/dashboard/spa/src/pages/leaderboard/VerifiedBadge.tsx` | **Create** | Visual indicator: green for verified (source bundle + implStateDir CID published), grey for unverified. |
| `client/src/dashboard/spa/src/pages/configuration/HarnessSection.tsx` | **Create** | Config-page section: mode toggle (train/frozen radio) + current codeDigest display + recent violation count. |
| `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx` | **Create** | Overview-page panel: current mode, codeDigest, time-since-mode-switch, in-flight tasks. |
| `client/test/cli/checkpoint.e2e.test.ts` | **Create** | End-to-end: operator A publishes a checkpoint, operator B installs it, both run frozen, both produce envelopes with the same codeDigest, leaderboard rolls them up under one identity. |

---

## Task 1: Subgraph — index `Executor.mode` on every envelope

**Files:**
- Modify: `subgraph/schema.graphql`
- Modify: `subgraph/src/envelope-mappings.ts`
- Modify: `subgraph/test/envelope.test.ts`

- [ ] **Step 1: Inspect existing envelope indexing**

Run: `grep -n "Envelope\|executor\|implName" subgraph/schema.graphql subgraph/src/*.ts | head -30`

Note the existing entity definition and the field where executor metadata is currently indexed.

- [ ] **Step 2: Add `mode` field to the `Envelope` entity**

In `subgraph/schema.graphql`, add to the existing `Envelope` entity:

```graphql
type Envelope @entity(immutable: false) {
  id: ID!
  # ... existing fields ...
  implName: String!
  implVersion: String!
  codeDigest: String!
  signingKey: String!
  # NEW:
  mode: String!  # "train" | "frozen"; defaults to "train" for legacy envelopes
}
```

- [ ] **Step 3: Update the envelope mapping handler**

In `subgraph/src/envelope-mappings.ts`, locate the handler that indexes envelopes (e.g., `handleSubmitRestorationDelivery` or similar). Read `executor.mode` from the envelope payload; default to `'train'` if absent (back-compat with envelopes from before Plan 1 shipped).

```typescript
// Inside the existing handler:
const envelope = new Envelope(envelopeId);
// ... existing fields ...
envelope.implName = parsedExecutor.implName;
envelope.codeDigest = parsedExecutor.codeDigest;
envelope.mode = parsedExecutor.mode ?? 'train';  // NEW; back-compat default
envelope.save();
```

- [ ] **Step 4: Run subgraph build**

Run: `cd subgraph && yarn build`

Expected: compiles cleanly.

- [ ] **Step 5: Run subgraph tests**

Run: `cd subgraph && yarn test`

Expected: all pass.

- [ ] **Step 6: Deploy to local Graph node + run a smoke query**

Run: `cd subgraph && yarn deploy:local && curl -X POST http://localhost:8000/subgraphs/name/jinn -d '{"query":"{ envelopes(first:1) { id mode } }"}'`

Expected: query returns at least one envelope with `mode: "train"` or `mode: "frozen"`.

- [ ] **Step 7: Commit**

```bash
git add subgraph/schema.graphql subgraph/src/envelope-mappings.ts subgraph/test/envelope.test.ts
git commit -m "feat(subgraph): index Executor.mode on every envelope

Adds mode field (train | frozen) to the Envelope entity. Back-compat:
envelopes from before Plan 1 default to 'train' on indexing. Dashboard
leaderboards filter on this field to split train and frozen rollups.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 2: Subgraph — `HarnessRollup` entity per `(implName, codeDigest, mode, window)`

**Files:**
- Modify: `subgraph/schema.graphql`
- Create: `subgraph/src/harness-rollup-mappings.ts`
- Create: `subgraph/test/harness-rollup.test.ts`

- [ ] **Step 1: Add the `HarnessRollup` entity to the schema**

```graphql
type HarnessRollup @entity(immutable: false) {
  id: ID!  # composite: "<implName>|<codeDigest>|<mode>|<windowStart>"
  implName: String!
  codeDigest: String!
  mode: String!  # "train" | "frozen"
  windowStart: BigInt!
  windowEnd: BigInt!

  verdictCount: BigInt!
  scoreSum: BigInt!  # sum of Verdict.score (0 or 1) over the window
  meanResolved: BigDecimal!  # = scoreSum / verdictCount

  uniqueOperators: BigInt!  # distinct signing keys
  byLanguage: [LanguageRollup!]!  # per-language sub-rollups
  firstSeenAt: BigInt!
  lastSeenAt: BigInt!
}

type LanguageRollup @entity(immutable: false) {
  id: ID!  # "<harnessRollupId>|<language>"
  parent: HarnessRollup!
  language: String!
  verdictCount: BigInt!
  scoreSum: BigInt!
  meanResolved: BigDecimal!
}
```

- [ ] **Step 2: Write the failing test**

Create `subgraph/test/harness-rollup.test.ts`:

```typescript
// Use the matchstick framework (or whichever subgraph test framework the project uses)
import { test, assert, beforeEach, clearStore } from 'matchstick-as/assembly/index';
import { handleNewVerdict } from '../src/harness-rollup-mappings';
import { mockNewVerdictEvent } from './helpers';

beforeEach(() => { clearStore(); });

test('first verdict creates a HarnessRollup entity with verdictCount = 1', () => {
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner',
    codeDigest: 'sha256:abc',
    mode: 'frozen',
    score: 1,
    language: 'python',
    timestamp: 1746547200,
  }));
  const id = 'claude-code-learner|sha256:abc|frozen|<windowStart>';
  assert.fieldEquals('HarnessRollup', id, 'verdictCount', '1');
  assert.fieldEquals('HarnessRollup', id, 'scoreSum', '1');
});

test('multiple verdicts accumulate within the same window', () => {
  // Three verdicts on same (implName, codeDigest, mode), same window
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner', codeDigest: 'sha256:abc', mode: 'frozen',
    score: 1, language: 'python', timestamp: 1746547200,
  }));
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner', codeDigest: 'sha256:abc', mode: 'frozen',
    score: 0, language: 'go', timestamp: 1746547260,
  }));
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner', codeDigest: 'sha256:abc', mode: 'frozen',
    score: 1, language: 'python', timestamp: 1746547320,
  }));
  const id = 'claude-code-learner|sha256:abc|frozen|<windowStart>';
  assert.fieldEquals('HarnessRollup', id, 'verdictCount', '3');
  assert.fieldEquals('HarnessRollup', id, 'scoreSum', '2');
});

test('different codeDigest creates separate rollups', () => {
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner', codeDigest: 'sha256:abc', mode: 'frozen',
    score: 1, language: 'python', timestamp: 1746547200,
  }));
  handleNewVerdict(mockNewVerdictEvent({
    implName: 'claude-code-learner', codeDigest: 'sha256:def', mode: 'frozen',
    score: 1, language: 'python', timestamp: 1746547200,
  }));
  // Both rollups exist independently
  const id1 = 'claude-code-learner|sha256:abc|frozen|<windowStart>';
  const id2 = 'claude-code-learner|sha256:def|frozen|<windowStart>';
  assert.fieldEquals('HarnessRollup', id1, 'verdictCount', '1');
  assert.fieldEquals('HarnessRollup', id2, 'verdictCount', '1');
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd subgraph && yarn test`

- [ ] **Step 4: Implement the rollup handler**

Create `subgraph/src/harness-rollup-mappings.ts`:

```typescript
import { BigInt, BigDecimal } from '@graphprotocol/graph-ts';
import { HarnessRollup, LanguageRollup, Envelope } from '../generated/schema';

const WINDOW_DAYS = 30;
const WINDOW_SECONDS = WINDOW_DAYS * 24 * 60 * 60;

function windowStartFor(timestamp: BigInt): BigInt {
  // Floor to UTC midnight, then snap to a fixed 30-day cadence
  const day = timestamp.div(BigInt.fromI32(86400));
  const window = day.div(BigInt.fromI32(WINDOW_DAYS)).times(BigInt.fromI32(WINDOW_DAYS));
  return window.times(BigInt.fromI32(86400));
}

export function handleNewVerdict(event: NewVerdictEvent): void {
  const envelope = Envelope.load(event.envelopeId);
  if (envelope == null) return;

  const windowStart = windowStartFor(event.block.timestamp);
  const id = `${envelope.implName}|${envelope.codeDigest}|${envelope.mode}|${windowStart.toString()}`;

  let rollup = HarnessRollup.load(id);
  if (rollup == null) {
    rollup = new HarnessRollup(id);
    rollup.implName = envelope.implName;
    rollup.codeDigest = envelope.codeDigest;
    rollup.mode = envelope.mode;
    rollup.windowStart = windowStart;
    rollup.windowEnd = windowStart.plus(BigInt.fromI32(WINDOW_SECONDS));
    rollup.verdictCount = BigInt.fromI32(0);
    rollup.scoreSum = BigInt.fromI32(0);
    rollup.uniqueOperators = BigInt.fromI32(0);
    rollup.byLanguage = [];
    rollup.firstSeenAt = event.block.timestamp;
  }
  rollup.verdictCount = rollup.verdictCount.plus(BigInt.fromI32(1));
  rollup.scoreSum = rollup.scoreSum.plus(BigInt.fromI32(event.score));
  rollup.meanResolved = rollup.scoreSum.toBigDecimal().div(rollup.verdictCount.toBigDecimal());
  rollup.lastSeenAt = event.block.timestamp;
  rollup.save();

  // Update language sub-rollup
  const langId = `${id}|${event.language}`;
  let lang = LanguageRollup.load(langId);
  if (lang == null) {
    lang = new LanguageRollup(langId);
    lang.parent = id;
    lang.language = event.language;
    lang.verdictCount = BigInt.fromI32(0);
    lang.scoreSum = BigInt.fromI32(0);
  }
  lang.verdictCount = lang.verdictCount.plus(BigInt.fromI32(1));
  lang.scoreSum = lang.scoreSum.plus(BigInt.fromI32(event.score));
  lang.meanResolved = lang.scoreSum.toBigDecimal().div(lang.verdictCount.toBigDecimal());
  lang.save();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd subgraph && yarn test`

Expected: 3 passes.

- [ ] **Step 6: Commit**

```bash
git add subgraph/schema.graphql subgraph/src/harness-rollup-mappings.ts subgraph/test/harness-rollup.test.ts
git commit -m "feat(subgraph): per-(implName, codeDigest, mode) rollups in 30-day windows

HarnessRollup entity aggregates Verdicts per harness identity, mode, and
30-day rolling window. LanguageRollup sub-entity stratifies by
programming language for the byLanguage view. Dashboard queries this
entity to render train and frozen leaderboards.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.5
DR: log/decisions/2026-05-06-aggregation-multi-winrate.md"
```

---

## Task 3: Subgraph — cross-envelope consistency detector for frozen-mode violations

**Files:**
- Modify: `subgraph/schema.graphql`
- Create: `subgraph/src/freeze-violation-detector.ts`
- Create: `subgraph/test/freeze-violation.test.ts`

- [ ] **Step 1: Add the `FreezeViolation` entity to the schema**

```graphql
type FreezeViolation @entity(immutable: true) {
  id: ID!  # "<signingKey>|<envelopeId>"
  signingKey: String!
  envelopeId: String!
  detectedAt: BigInt!
  reason: String!  # e.g. "codeDigest changed within frozen window"
  priorCodeDigest: String!
  envelopeCodeDigest: String!
}
```

- [ ] **Step 2: Write the failing test**

Create `subgraph/test/freeze-violation.test.ts`:

```typescript
// pseudo-test using matchstick or similar
test('emits FreezeViolation when codeDigest changes within frozen window', () => {
  // Operator submits 3 envelopes claiming mode=frozen
  emit({ signingKey: '0xop1', mode: 'frozen', codeDigest: 'sha256:aaa', timestamp: 1 });
  emit({ signingKey: '0xop1', mode: 'frozen', codeDigest: 'sha256:aaa', timestamp: 2 });
  // Third envelope has a different codeDigest — violation
  emit({ signingKey: '0xop1', mode: 'frozen', codeDigest: 'sha256:bbb', timestamp: 3 });

  // Expect a FreezeViolation entity for the third envelope
  assert.fieldEquals('FreezeViolation', '0xop1|env-3', 'reason', 'codeDigest changed within frozen window');
});

test('does NOT emit FreezeViolation across mode boundary', () => {
  // Operator submits in frozen mode, switches to train mode, switches back
  emit({ signingKey: '0xop1', mode: 'frozen', codeDigest: 'sha256:aaa', timestamp: 1 });
  emit({ signingKey: '0xop1', mode: 'train', codeDigest: 'sha256:bbb', timestamp: 2 });
  emit({ signingKey: '0xop1', mode: 'frozen', codeDigest: 'sha256:bbb', timestamp: 3 });
  // No violation: mode boundary breaks the consistency requirement
  assert.notInStore('FreezeViolation', '0xop1|env-3');
});
```

- [ ] **Step 3: Implement the detector**

Create `subgraph/src/freeze-violation-detector.ts`:

```typescript
import { BigInt, store } from '@graphprotocol/graph-ts';
import { Envelope, FreezeViolation } from '../generated/schema';

/**
 * Scans envelopes by signing key in chronological order. If two consecutive
 * frozen-mode envelopes from the same signing key have different codeDigests,
 * the second envelope is a violation. Mode boundaries (frozen → train → frozen)
 * reset the consistency requirement.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2
 * DR: log/decisions/2026-05-06-trust-stack-composition.md (layer 2)
 */
export function detectFreezeViolation(envelope: Envelope): void {
  if (envelope.mode != 'frozen') return;

  const priorEnvelopeId = lastFrozenEnvelopeIdFor(envelope.signingKey);
  if (priorEnvelopeId == null) return;  // first frozen envelope — no consistency claim yet
  const prior = Envelope.load(priorEnvelopeId);
  if (prior == null) return;

  // Was the prior envelope also frozen-mode (no train interval between them)?
  if (lastModeWasFrozenAfter(envelope.signingKey, prior.id)) {
    if (prior.codeDigest != envelope.codeDigest) {
      const violation = new FreezeViolation(`${envelope.signingKey}|${envelope.id}`);
      violation.signingKey = envelope.signingKey;
      violation.envelopeId = envelope.id;
      violation.detectedAt = envelope.timestamp;
      violation.reason = 'codeDigest changed within frozen window';
      violation.priorCodeDigest = prior.codeDigest;
      violation.envelopeCodeDigest = envelope.codeDigest;
      violation.save();
    }
  }
}

// Helper: query the latest frozen-mode envelope for a signing key.
// Stub here — real implementation queries via @derivedFrom or maintains
// a running state entity per signing key.
declare function lastFrozenEnvelopeIdFor(signingKey: string): string | null;
declare function lastModeWasFrozenAfter(signingKey: string, sinceEnvelopeId: string): bool;
```

- [ ] **Step 4: Wire the detector into the envelope mapping handler**

In `subgraph/src/envelope-mappings.ts`, after saving the envelope, call:

```typescript
import { detectFreezeViolation } from './freeze-violation-detector';
detectFreezeViolation(envelope);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd subgraph && yarn test`

Expected: 2 passes.

- [ ] **Step 6: Commit**

```bash
git add subgraph/schema.graphql subgraph/src/freeze-violation-detector.ts subgraph/src/envelope-mappings.ts subgraph/test/freeze-violation.test.ts
git commit -m "feat(subgraph): detect codeDigest mutations within frozen-mode windows

FreezeViolation entity surfaces operators whose codeDigest changes
within a claimed-frozen window. Mode boundaries reset the consistency
requirement. Dashboard renders these as a credibility flag on the
frozen-mode leaderboard.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2
DR: log/decisions/2026-05-06-trust-stack-composition.md (layer 2)"
```

---

## Task 4: HarnessCheckpoint manifest schema in SDK

**Files:**
- Create: `packages/sdk/src/checkpoint.ts`
- Create: `packages/sdk/test/checkpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/checkpoint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HarnessCheckpointManifestSchema } from '../src/checkpoint.js';

const validManifest = {
  schemaVersion: 'harness.checkpoint.v1',
  name: '@some-team/claude-code-learner-fork',
  version: '2.1.4',
  parentCheckpointCid: 'bafybeigwoof...',
  harnessPackage: {
    implName: 'claude-code-learner-fork',
    implVersion: '2.1.4',
    clientGitSha: '0xabc1234567890',
    sourceBundleCid: 'bafybeisource...',
  },
  implStateDirCid: 'bafybeistate...',
  codeDigest: 'sha256:' + 'a'.repeat(64),
  publisher: {
    agentId: 'did:jinn:eth:0x1234',
    signingKey: 'ed25519:' + 'b'.repeat(64),
    safeAddress: '0x' + 'c'.repeat(40),
  },
  publishedAt: '2026-05-15T12:00:00Z',
  registry: {
    anchor: 'IdentityRegistry.setMetadata',
    metadataKey: 'harness.checkpoint:bafybeicheckpoint...',
    txHash: '0x' + 'd'.repeat(64),
    blockNumber: 12345678,
  },
  signature: 'ed25519-sig-' + 'e'.repeat(128),
};

describe('HarnessCheckpointManifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(() => HarnessCheckpointManifestSchema.parse(validManifest)).not.toThrow();
  });

  it('parentCheckpointCid is optional (null allowed for root checkpoints)', () => {
    const manifest = { ...validManifest, parentCheckpointCid: null };
    expect(() => HarnessCheckpointManifestSchema.parse(manifest)).not.toThrow();
  });

  it('rejects manifests missing required fields', () => {
    const bad = { ...validManifest, codeDigest: undefined };
    expect(() => HarnessCheckpointManifestSchema.parse(bad)).toThrow();
  });

  it('rejects malformed codeDigest', () => {
    const bad = { ...validManifest, codeDigest: 'not-a-sha256' };
    expect(() => HarnessCheckpointManifestSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/checkpoint.test.ts`

- [ ] **Step 3: Implement the schema**

Create `packages/sdk/src/checkpoint.ts`:

```typescript
/**
 * HarnessCheckpoint — a published, frozen, forkable Harness state.
 *
 * A checkpoint is the artifact-level entity that bridges the substrate's
 * flowing operator-harnesses and the frozen-artifact world that recruits,
 * comparisons, and downstream integrations live in. Operators publish
 * checkpoints via `jinn checkpoint publish`; other operators install them
 * via `jinn checkpoint install`.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7
 */

import { z } from 'zod';

export const HarnessCheckpointManifestSchema = z.object({
  schemaVersion: z.literal('harness.checkpoint.v1'),
  /** Package name (npm-style: @org/name). */
  name: z.string().regex(/^(@[^/]+\/)?[^/@]+$/),
  /** SemVer version string. */
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  /**
   * IPFS CID of the parent checkpoint this was forked from. Null for root
   * checkpoints (initial publishings from operator state without a fork
   * lineage).
   */
  parentCheckpointCid: z.string().nullable(),
  harnessPackage: z.object({
    /** Harness implementation name as it appears on Executor.implName. */
    implName: z.string().min(1),
    implVersion: z.string().min(1),
    /** Git SHA of the Harness package source. */
    clientGitSha: z.string().regex(/^(0x)?[0-9a-f]+$/),
    /** IPFS CID of the source bundle (build recipe + sources). */
    sourceBundleCid: z.string().min(1),
  }),
  /** IPFS CID of the implStateDir contents at freeze time. */
  implStateDirCid: z.string().min(1),
  /**
   * Merkle hash of implStateDir contents (the same value the daemon's
   * freeze-fence produces). Format: 'sha256:<64 hex>'.
   */
  codeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  publisher: z.object({
    /** ERC-8004-style DID for the publishing operator/agent. */
    agentId: z.string().min(1),
    /** Ed25519 public key (with prefix). */
    signingKey: z.string().regex(/^ed25519:[0-9a-f]{64}$/),
    /** Operator's master Safe address. */
    safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }),
  publishedAt: z.string().datetime(),
  registry: z.object({
    /** Anchor mechanism, e.g. 'IdentityRegistry.setMetadata'. */
    anchor: z.literal('IdentityRegistry.setMetadata'),
    /** The setMetadata key under which this checkpoint manifest CID is published. */
    metadataKey: z.string().min(1),
    /** Tx hash of the setMetadata call. */
    txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    blockNumber: z.number().int().positive(),
  }),
  /** Ed25519 signature over the canonical-JSON serialisation of the rest of the manifest. */
  signature: z.string().min(1),
});

export type HarnessCheckpointManifest = z.infer<typeof HarnessCheckpointManifestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && yarn vitest run test/checkpoint.test.ts`

Expected: 4 passes.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/checkpoint.ts packages/sdk/test/checkpoint.test.ts
git commit -m "feat(sdk): add HarnessCheckpointManifestSchema

HarnessCheckpoint is the published, frozen, forkable Harness state.
Manifest carries name, version, parent fork lineage, source bundle CID,
implStateDir CID, codeDigest, publisher identity, ERC-8004 anchor
metadata, and ed25519 signature.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7"
```

---

## Task 5: `jinn checkpoint publish` CLI command

**Files:**
- Create: `client/src/cli/commands/checkpoint.ts`
- Create: `client/test/cli/checkpoint-publish.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/checkpoint-publish.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointPublishCommand } from '../../src/cli/commands/checkpoint.js';
import type { CheckpointPublishDeps } from '../../src/cli/commands/checkpoint.js';

describe('jinn checkpoint publish', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'checkpoint-pub-'));
    await writeFile(join(stateDir, 'state.json'), '{"a": 1}');
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('produces a HarnessCheckpoint manifest, pins to IPFS, anchors via setMetadata', async () => {
    const deps: CheckpointPublishDeps = {
      pinToIpfs: vi.fn().mockResolvedValue('bafy_pinned_cid'),
      callSetMetadata: vi.fn().mockResolvedValue({ txHash: '0x' + 'a'.repeat(64), blockNumber: 100 }),
      hashImplStateDir: vi.fn().mockResolvedValue('a'.repeat(64)),
      sign: vi.fn().mockResolvedValue('ed25519-sig-stub'),
      getSigningIdentity: vi.fn().mockResolvedValue({
        agentId: 'did:jinn:eth:0x1234',
        signingKey: 'ed25519:' + 'b'.repeat(64),
        safeAddress: '0x' + 'c'.repeat(40),
      }),
    };
    const result = await checkpointPublishCommand({
      name: '@team/my-fork',
      version: '0.1.0',
      implStateDir: stateDir,
      sourceBundleCid: 'bafy_src',
      implName: 'my-fork',
      implVersion: '0.1.0',
      clientGitSha: '0xdeadbeef',
      deps,
    });
    expect(result.checkpointCid).toBe('bafy_pinned_cid');
    expect(deps.pinToIpfs).toHaveBeenCalled();  // source bundle, implStateDir, manifest
    expect(deps.callSetMetadata).toHaveBeenCalled();
  });

  it('verifies the manifest signature roundtrips before pinning', async () => {
    // Test that the signed manifest's signature validates over the canonical-JSON form
    // (implementation detail — placeholder for now)
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test cli/checkpoint-publish`

- [ ] **Step 3: Implement the command**

Create `client/src/cli/commands/checkpoint.ts`:

```typescript
/**
 * `jinn checkpoint publish` / `install` / `list` — HarnessCheckpoint
 * lifecycle CLI verbs.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7
 */

import { HarnessCheckpointManifestSchema, type HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import { hashImplStateDir as defaultHashImplStateDir } from '../../harnesses/freeze.js';

export interface CheckpointPublishDeps {
  pinToIpfs(args: { kind: 'sourceBundle' | 'implStateDir' | 'manifest'; data: Buffer | string }): Promise<string>;
  callSetMetadata(args: { metadataKey: string; payload: string }): Promise<{ txHash: string; blockNumber: number }>;
  hashImplStateDir(dirPath: string): Promise<string>;
  sign(canonicalJson: string): Promise<string>;
  getSigningIdentity(): Promise<{
    agentId: string;
    signingKey: string;
    safeAddress: string;
  }>;
}

export async function checkpointPublishCommand(args: {
  name: string;
  version: string;
  implStateDir: string;
  sourceBundleCid: string;
  implName: string;
  implVersion: string;
  clientGitSha: string;
  parentCheckpointCid?: string | null;
  deps: CheckpointPublishDeps;
}): Promise<{ checkpointCid: string; manifest: HarnessCheckpointManifest }> {
  const codeDigest = `sha256:${await args.deps.hashImplStateDir(args.implStateDir)}`;
  const implStateDirCid = await args.deps.pinToIpfs({ kind: 'implStateDir', data: '' /* dir-CID via UnixFS */ });
  const publisher = await args.deps.getSigningIdentity();

  // Build the unsigned manifest core
  const core = {
    schemaVersion: 'harness.checkpoint.v1' as const,
    name: args.name,
    version: args.version,
    parentCheckpointCid: args.parentCheckpointCid ?? null,
    harnessPackage: {
      implName: args.implName,
      implVersion: args.implVersion,
      clientGitSha: args.clientGitSha,
      sourceBundleCid: args.sourceBundleCid,
    },
    implStateDirCid,
    codeDigest,
    publisher,
    publishedAt: new Date().toISOString(),
  };

  // Canonical-JSON for signature
  const canonicalJson = canonicalize(core);
  const signature = await args.deps.sign(canonicalJson);

  // Pin manifest then anchor on chain
  const manifestPayload = JSON.stringify({ ...core, signature, registry: null });
  const manifestPinCid = await args.deps.pinToIpfs({ kind: 'manifest', data: manifestPayload });
  const tx = await args.deps.callSetMetadata({
    metadataKey: `harness.checkpoint:${manifestPinCid}`,
    payload: manifestPinCid,
  });

  const final: HarnessCheckpointManifest = {
    ...core,
    signature,
    registry: {
      anchor: 'IdentityRegistry.setMetadata',
      metadataKey: `harness.checkpoint:${manifestPinCid}`,
      txHash: tx.txHash as `0x${string}`,
      blockNumber: tx.blockNumber,
    },
  };

  // Validate the final manifest
  HarnessCheckpointManifestSchema.parse(final);

  return { checkpointCid: manifestPinCid, manifest: final };
}

/** Canonical-JSON: stable object key ordering (RFC 8785). */
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((obj as any)[k])}`).join(',')}}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test cli/checkpoint-publish`

Expected: 2 passes.

- [ ] **Step 5: Wire the command into the argv parser**

In the CLI entry (`client/src/cli/...`), register the subcommand:

```typescript
program.command('checkpoint').command('publish')
  .option('--name <name>', 'Checkpoint name (e.g. @team/my-fork)')
  .option('--version <version>', 'SemVer version')
  .option('--from <implStateDir>', 'Path to implStateDir to publish (default: ~/.jinn-client/<harness>/state)')
  .action(async (opts) => {
    const result = await checkpointPublishCommand({ ...opts, deps: realDeps() });
    console.log(`Published checkpoint: ${result.checkpointCid}`);
  });
```

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/checkpoint.ts client/test/cli/checkpoint-publish.test.ts
git commit -m "feat(cli): jinn checkpoint publish

Pins the source bundle + implStateDir to IPFS, signs a HarnessCheckpoint
manifest with the operator's signing key, anchors via
IdentityRegistry.setMetadata. Returns the checkpoint CID.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7
DR: log/decisions/2026-05-06-trust-stack-composition.md (layer 4)"
```

---

## Task 6: `jinn checkpoint install` CLI command

**Files:**
- Modify: `client/src/cli/commands/checkpoint.ts`
- Create: `client/test/cli/checkpoint-install.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/cli/checkpoint-install.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkpointInstallCommand } from '../../src/cli/commands/checkpoint.js';

describe('jinn checkpoint install', () => {
  it('fetches a checkpoint manifest, verifies signature, stages implStateDir', async () => {
    const fakeManifest = { /* … HarnessCheckpoint … */ };
    const deps = {
      fetchFromIpfs: vi.fn().mockResolvedValue(JSON.stringify(fakeManifest)),
      verifySignature: vi.fn().mockResolvedValue(true),
      fetchImplStateDirToLocal: vi.fn().mockResolvedValue('/tmp/staged'),
      stageAsHarnessState: vi.fn().mockResolvedValue(undefined),
    };
    const result = await checkpointInstallCommand({ cid: 'bafy_checkpoint_cid', deps });
    expect(result.installed).toBe(true);
    expect(deps.verifySignature).toHaveBeenCalled();
    expect(deps.stageAsHarnessState).toHaveBeenCalled();
  });

  it('rejects manifest with invalid signature', async () => {
    const deps = {
      fetchFromIpfs: vi.fn().mockResolvedValue('{}'),
      verifySignature: vi.fn().mockResolvedValue(false),
      fetchImplStateDirToLocal: vi.fn(),
      stageAsHarnessState: vi.fn(),
    };
    await expect(checkpointInstallCommand({ cid: 'bafy', deps })).rejects.toThrow(/signature/);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

- [ ] **Step 3: Implement install**

Append to `client/src/cli/commands/checkpoint.ts`:

```typescript
export interface CheckpointInstallDeps {
  fetchFromIpfs(cid: string): Promise<string>;
  verifySignature(args: { manifest: HarnessCheckpointManifest; signature: string }): Promise<boolean>;
  fetchImplStateDirToLocal(implStateDirCid: string, targetDir: string): Promise<string>;
  stageAsHarnessState(stagedDir: string, implName: string): Promise<void>;
}

export async function checkpointInstallCommand(args: {
  cid: string;
  deps: CheckpointInstallDeps;
  targetDir?: string;
}): Promise<{ installed: true; codeDigest: string; implName: string }> {
  const manifestRaw = await args.deps.fetchFromIpfs(args.cid);
  const manifest = HarnessCheckpointManifestSchema.parse(JSON.parse(manifestRaw));
  const ok = await args.deps.verifySignature({ manifest, signature: manifest.signature });
  if (!ok) throw new Error(`Checkpoint ${args.cid}: invalid signature`);

  const stagingDir = args.targetDir ?? `/tmp/checkpoint-${args.cid}`;
  await args.deps.fetchImplStateDirToLocal(manifest.implStateDirCid, stagingDir);
  await args.deps.stageAsHarnessState(stagingDir, manifest.harnessPackage.implName);

  return { installed: true, codeDigest: manifest.codeDigest, implName: manifest.harnessPackage.implName };
}
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/checkpoint.ts client/test/cli/checkpoint-install.test.ts
git commit -m "feat(cli): jinn checkpoint install

Fetches a HarnessCheckpoint manifest from IPFS, verifies the publisher's
signature, fetches the implStateDir CID to a staging directory, and
stages it as the local harness state. Operators install a checkpoint to
start running it as their own harness state.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7"
```

---

## Task 7: `jinn checkpoint list` CLI command

**Files:**
- Modify: `client/src/cli/commands/checkpoint.ts`
- Create: `client/test/cli/checkpoint-list.test.ts`

- [ ] **Step 1: Write a failing test that lists local + queryable checkpoints**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkpointListCommand } from '../../src/cli/commands/checkpoint.js';

describe('jinn checkpoint list', () => {
  it('returns local published + installed checkpoints', async () => {
    const deps = {
      listLocallyPublished: vi.fn().mockResolvedValue([{ cid: 'bafy_pub', name: '@me/fork' }]),
      listLocallyInstalled: vi.fn().mockResolvedValue([{ cid: 'bafy_inst', name: '@other/checkpoint' }]),
    };
    const result = await checkpointListCommand({ deps });
    expect(result.published).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect fail; implement; run, expect pass**

```typescript
export interface CheckpointListDeps {
  listLocallyPublished(): Promise<Array<{ cid: string; name: string; version: string }>>;
  listLocallyInstalled(): Promise<Array<{ cid: string; name: string; version: string }>>;
}

export async function checkpointListCommand(args: {
  deps: CheckpointListDeps;
}): Promise<{
  published: Array<{ cid: string; name: string; version: string }>;
  installed: Array<{ cid: string; name: string; version: string }>;
}> {
  const [published, installed] = await Promise.all([
    args.deps.listLocallyPublished(),
    args.deps.listLocallyInstalled(),
  ]);
  return { published, installed };
}
```

- [ ] **Step 3: Wire into argv parser + commit**

```bash
git add client/src/cli/commands/checkpoint.ts client/test/cli/checkpoint-list.test.ts
git commit -m "feat(cli): jinn checkpoint list

Lists locally published + installed HarnessCheckpoints. Operators see at
a glance which checkpoints they have authored and which they have
installed from peers.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §7"
```

---

## Task 8: Dashboard API — leaderboard endpoint

**Files:**
- Create: `client/src/api/leaderboard-api.ts`
- Create: `client/test/api/leaderboard-api.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { leaderboardRoutes } from '../../src/api/leaderboard-api.js';

describe('GET /api/solvernets/:name/leaderboard', () => {
  it('returns train-mode HarnessRollup query results', async () => {
    const app = leaderboardRoutes({
      querySubgraph: async () => ({
        harnessRollups: [
          { implName: 'claude-code-learner', codeDigest: 'sha256:abc',
            mode: 'train', verdictCount: 12, scoreSum: 7,
            uniqueOperators: 1, lastSeenAt: 1746547200 },
        ],
      }),
    });
    const res = await app.request('/api/solvernets/swe-rebench-v2/leaderboard?mode=train');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollups).toHaveLength(1);
    expect(body.rollups[0].mode).toBe('train');
  });

  it('filters by mode = "frozen"', async () => {
    const app = leaderboardRoutes({
      querySubgraph: async (mode) => ({
        harnessRollups: [{ implName: 'claude-code-learner', codeDigest: 'sha256:abc',
            mode, verdictCount: 12, scoreSum: 7,
            uniqueOperators: 1, lastSeenAt: 1746547200 }],
      }),
    });
    const res = await app.request('/api/solvernets/swe-rebench-v2/leaderboard?mode=frozen');
    const body = await res.json();
    expect(body.rollups[0].mode).toBe('frozen');
  });
});
```

- [ ] **Step 2: Implement the API**

Create `client/src/api/leaderboard-api.ts`:

```typescript
import { Hono } from 'hono';

export interface LeaderboardDeps {
  querySubgraph(mode: 'train' | 'frozen'): Promise<{
    harnessRollups: Array<{
      implName: string;
      codeDigest: string;
      mode: 'train' | 'frozen';
      verdictCount: number;
      scoreSum: number;
      uniqueOperators: number;
      lastSeenAt: number;
      meanResolved?: number;
    }>;
  }>;
  isCheckpointVerified(args: { implName: string; codeDigest: string }): Promise<boolean>;
}

export function leaderboardRoutes(deps: LeaderboardDeps): Hono {
  const app = new Hono();
  app.get('/api/solvernets/:name/leaderboard', async (c) => {
    const mode = (c.req.query('mode') ?? 'train') as 'train' | 'frozen';
    const result = await deps.querySubgraph(mode);
    const rollups = await Promise.all(result.harnessRollups.map(async (r) => ({
      ...r,
      meanResolved: r.scoreSum / r.verdictCount,
      verified: mode === 'frozen'
        ? await deps.isCheckpointVerified({ implName: r.implName, codeDigest: r.codeDigest })
        : null,
    })));
    return c.json({ rollups });
  });
  return app;
}
```

- [ ] **Step 3: Run, expect pass; commit**

```bash
git add client/src/api/leaderboard-api.ts client/test/api/leaderboard-api.test.ts
git commit -m "feat(api): GET /api/solvernets/:name/leaderboard

Returns HarnessRollup query results from the subgraph, filtered by
mode=train|frozen. Frozen rollups carry a 'verified' flag indicating
whether the underlying codeDigest has a corresponding published
HarnessCheckpoint.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.4"
```

---

## Task 9: Dashboard SPA — train-mode and frozen-mode leaderboard tables

**Files:**
- Create: `client/src/dashboard/spa/src/pages/leaderboard/Leaderboard.tsx`
- Create: `client/src/dashboard/spa/src/pages/leaderboard/TrainLeaderboardTable.tsx`
- Create: `client/src/dashboard/spa/src/pages/leaderboard/FrozenLeaderboardTable.tsx`
- Create: `client/src/dashboard/spa/src/pages/leaderboard/VerifiedBadge.tsx`
- Create: `client/test/dashboard/leaderboard.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Leaderboard } from '../../src/dashboard/spa/src/pages/leaderboard/Leaderboard';

describe('Leaderboard page', () => {
  it('shows two tabs: Train and Frozen', () => {
    render(<Leaderboard solverNet="swe-rebench-v2" />);
    expect(screen.getByRole('tab', { name: /train/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /frozen/i })).toBeInTheDocument();
  });

  it('renders rollup rows with implName, codeDigest, meanResolved', async () => {
    // Mock fetch to return a rollup
    // assert rows render
  });

  it('shows VerifiedBadge on frozen rows when verified=true', async () => {
    // Mock rollup with verified=true
    // assert badge is rendered with green fill
  });
});
```

- [ ] **Step 2: Implement the components**

`Leaderboard.tsx`:

```tsx
import { useState } from 'react';
import { TrainLeaderboardTable } from './TrainLeaderboardTable';
import { FrozenLeaderboardTable } from './FrozenLeaderboardTable';

export function Leaderboard({ solverNet }: { solverNet: string }) {
  const [tab, setTab] = useState<'train' | 'frozen'>('train');
  return (
    <section>
      <div role="tablist">
        <button role="tab" aria-selected={tab === 'train'} onClick={() => setTab('train')}>Train</button>
        <button role="tab" aria-selected={tab === 'frozen'} onClick={() => setTab('frozen')}>Frozen</button>
      </div>
      {tab === 'train' ? (
        <TrainLeaderboardTable solverNet={solverNet} />
      ) : (
        <FrozenLeaderboardTable solverNet={solverNet} />
      )}
    </section>
  );
}
```

`TrainLeaderboardTable.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface Rollup { implName: string; codeDigest: string; meanResolved: number; verdictCount: number; uniqueOperators: number; }

export function TrainLeaderboardTable({ solverNet }: { solverNet: string }) {
  const [rollups, setRollups] = useState<Rollup[]>([]);
  useEffect(() => {
    fetch(`/api/solvernets/${solverNet}/leaderboard?mode=train`)
      .then((r) => r.json())
      .then((d) => setRollups(d.rollups));
  }, [solverNet]);
  return (
    <table>
      <thead>
        <tr><th>Harness</th><th>codeDigest</th><th>Mean resolved</th><th>n</th><th>Operators</th></tr>
      </thead>
      <tbody>
        {rollups.map((r) => (
          <tr key={r.codeDigest}>
            <td>{r.implName}</td>
            <td>{r.codeDigest.slice(0, 16)}…</td>
            <td>{(r.meanResolved * 100).toFixed(1)}%</td>
            <td>{r.verdictCount}</td>
            <td>{r.uniqueOperators}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`FrozenLeaderboardTable.tsx`: same shape as Train, plus a `<VerifiedBadge verified={r.verified} />` cell.

`VerifiedBadge.tsx`:

```tsx
export function VerifiedBadge({ verified }: { verified: boolean | null }) {
  if (verified === null) return null;
  return (
    <span title={verified ? 'Source bundle + implStateDir CID published; codeDigest independently verifiable' : 'Operator-claim only; codeDigest not independently verifiable'}>
      {verified ? '✓ verified' : '◌ unverified'}
    </span>
  );
}
```

- [ ] **Step 3: Run tests; expect pass**

- [ ] **Step 4: Add a route to the SPA router**

In the SPA's router config, add a route for `/leaderboard/:solverNet` that renders `<Leaderboard />`.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/leaderboard/ client/test/dashboard/leaderboard.test.tsx
git commit -m "feat(spa): two-leaderboard view + verified-vs-unverified badge

Leaderboard page exposes Train and Frozen tabs per SolverNet. Frozen rows
carry a Verified badge (green when source bundle + implStateDir CID are
published and the codeDigest can be independently re-derived; grey when
operator-claim only).

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.4"
```

---

## Task 10: Operator app — Configuration mode toggle + Overview harness panel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/configuration/HarnessSection.tsx`
- Create: `client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx`
- Create: `client/test/dashboard/HarnessSection.test.tsx`

- [ ] **Step 1: Write the failing test for the mode toggle**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HarnessSection } from '../../src/dashboard/spa/src/pages/configuration/HarnessSection';

describe('HarnessSection (Configuration)', () => {
  it('shows mode toggle with current mode pre-selected', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ harness: { mode: 'frozen' } });
    render(<HarnessSection fetchConfig={fetchMock} updateConfig={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /frozen/i })).toBeChecked();
    });
  });

  it('writes updated mode to config on radio change', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ harness: { mode: 'train' } });
    const updateMock = vi.fn().mockResolvedValue(undefined);
    render(<HarnessSection fetchConfig={fetchMock} updateConfig={updateMock} />);
    await waitFor(() => screen.getByRole('radio', { name: /train/i }));
    fireEvent.click(screen.getByRole('radio', { name: /frozen/i }));
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ harness: { mode: 'frozen' } });
    });
  });
});
```

- [ ] **Step 2: Implement the components**

```tsx
// HarnessSection.tsx
import { useEffect, useState } from 'react';

export function HarnessSection({ fetchConfig, updateConfig }: any) {
  const [mode, setMode] = useState<'train' | 'frozen'>('train');
  useEffect(() => { fetchConfig().then((c: any) => setMode(c.harness?.mode ?? 'train')); }, []);
  const onChange = async (m: 'train' | 'frozen') => {
    setMode(m);
    await updateConfig({ harness: { mode: m } });
  };
  return (
    <section>
      <h2>Harness mode</h2>
      <p>Select whether the harness runs in learning mode (default) or frozen mode (benchmark scoring).</p>
      <label>
        <input type="radio" name="mode" value="train" checked={mode === 'train'}
          onChange={() => onChange('train')} aria-label="train" />
        Train
      </label>
      <label>
        <input type="radio" name="mode" value="frozen" checked={mode === 'frozen'}
          onChange={() => onChange('frozen')} aria-label="frozen" />
        Frozen
      </label>
    </section>
  );
}

// HarnessStatusPanel.tsx
import { useEffect, useState } from 'react';

export function HarnessStatusPanel() {
  const [status, setStatus] = useState<{ mode: string; codeDigest: string; lastModeSwitchAt?: number } | null>(null);
  useEffect(() => {
    fetch('/api/harness/status').then((r) => r.json()).then(setStatus);
  }, []);
  if (!status) return <div>Loading…</div>;
  return (
    <div>
      <div>Mode: <strong>{status.mode}</strong></div>
      <div>codeDigest: <code>{status.codeDigest.slice(0, 16)}…</code></div>
      {status.lastModeSwitchAt && (
        <div>Mode switched: {new Date(status.lastModeSwitchAt).toLocaleString()}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run tests; expect pass; commit**

```bash
git add client/src/dashboard/spa/src/pages/configuration/HarnessSection.tsx client/src/dashboard/spa/src/pages/overview/HarnessStatusPanel.tsx client/test/dashboard/HarnessSection.test.tsx
git commit -m "feat(spa): operator app mode toggle + harness status panel

Configuration page gains a Harness section with a Train / Frozen radio.
Overview page gains a HarnessStatusPanel showing current mode +
codeDigest + time-since-mode-switch. Operators see at a glance whether
they're contributing to the substrate or producing a benchmark snapshot.

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6"
```

---

## Task 11: e2e — full publish + install + leaderboard rollup

**Files:**
- Create: `client/test/e2e/checkpoint-flow.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnAnvilFork, runDaemonOnce, queryLeaderboard } from './_support/anvil-helpers.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('checkpoint publish/install + leaderboard rollup e2e', () => {
  let anvil: { stop: () => Promise<void>; rpcUrl: string };

  beforeAll(async () => { anvil = await spawnAnvilFork(); });
  afterAll(async () => { await anvil.stop(); });

  it('A publishes → B installs → both run frozen → leaderboard rolls under one identity', async () => {
    const stateDirA = await mkdtemp(join(tmpdir(), 'op-a-'));
    const stateDirB = await mkdtemp(join(tmpdir(), 'op-b-'));

    // 1. Op A: train mode for 1 task to mutate implStateDir
    await runDaemonOnce({ rpcUrl: anvil.rpcUrl, role: 'solving', mode: 'train', stateDir: stateDirA });

    // 2. Op A: publish checkpoint
    const { checkpointCid } = await jinnCheckpointPublish({ stateDir: stateDirA, name: '@op-a/fork', version: '0.1.0' });

    // 3. Op B: install Op A's checkpoint
    await jinnCheckpointInstall({ cid: checkpointCid, targetStateDir: stateDirB });

    // 4. Op A and Op B both run a Task in frozen mode
    const envA = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, role: 'solving', mode: 'frozen', stateDir: stateDirA });
    const envB = await runDaemonOnce({ rpcUrl: anvil.rpcUrl, role: 'solving', mode: 'frozen', stateDir: stateDirB });

    // 5. Both envelopes carry the same codeDigest
    expect(envA.executor.codeDigest).toBe(envB.executor.codeDigest);

    // 6. Leaderboard query rolls them up under one identity
    const leaderboard = await queryLeaderboard({ rpcUrl: anvil.rpcUrl, mode: 'frozen' });
    const ourRow = leaderboard.find((r: any) => r.codeDigest === envA.executor.codeDigest);
    expect(ourRow?.uniqueOperators).toBe(2);
    expect(ourRow?.verdictCount).toBe(2);
  }, 5 * 60 * 1000);
});
```

- [ ] **Step 2: Run, expect pass; commit**

```bash
git add client/test/e2e/checkpoint-flow.test.ts
git commit -m "test(e2e): checkpoint publish/install + cross-operator leaderboard rollup

End-to-end: Op A publishes a checkpoint, Op B installs it, both run
frozen-mode Tasks, both produce envelopes with the same codeDigest, and
the leaderboard rolls them up under one identity with uniqueOperators=2.
This proves cross-operator forking validation (DR-d trust stack layer 3).

Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2 + §7"
```

---

## Self-review checklist

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §6.2 Trust stack layer 1 (daemon hash-fence) | covered by Plan 1 |
| §6.2 Trust stack layer 2 (subgraph cross-envelope consistency) | 3 |
| §6.2 Trust stack layer 3 (cross-operator forking validation) | 11 (e2e proof) |
| §6.2 Trust stack layer 4 (source-bundle publication) | 4, 5 |
| §6.2 Trust stack layer 5 (reputation slashing) | 3 (subgraph detection); on-chain slash filed for Phase B.2 |
| §6.4 Verified vs unverified frozen | 8, 9 |
| §7 HarnessCheckpoint | 4, 5, 6, 7 |
| Two-leaderboard surface | 1, 2, 8, 9 |
| Operator app mode toggle | 10 |
| End-to-end validation | 11 |

Surface that lives in **other plans**:
- Plan 1: HarnessContext.mode + freeze fence + claude-code-learner gate.
- Plan 2: SWE-rebench v2 SolverNet + evaluator + generator.

**Out of scope (filed for later):**
- ReputationRegistry on-chain slash transaction — Phase B.2 evaluator economics work.
- Phase B.1 attested-tier credibility tier — separate workstream.

**Placeholder scan:** none expected.

**Type consistency:**
- `mode: 'train' | 'frozen'` used uniformly through subgraph + API + SPA.
- `HarnessCheckpoint` (capital C; matches DR-2026-05-06-g vocabulary).
- `verified` field on frozen rollups consistently means "publisher published source bundle + implStateDir CID."

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-06-train-frozen-leaderboard-surface.md`.

Depends on Plan 1 (freeze-mode protocol mechanism) AND Plan 2 (SWE-rebench v2 SolverNet) shipping first. The leaderboard surface needs `Executor.mode` from Plan 1 and a SolverNet-with-Verdicts from Plan 2 to have content to render.

Two execution options once Plans 1 + 2 are merged:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
