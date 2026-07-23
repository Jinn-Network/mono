# PR 2074 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the exact-head review findings for PR #2074 without weakening the federated retrieval or Hermes lifecycle guarantees.

**Architecture:** Keep source-neutral policy in `packages/plugin`, adapter-specific identity and outage facts in `packages/layer`, and lifecycle ownership in the Hermes Jinn plugin. Every fix starts with a regression that reproduces the reviewed failure, then makes the smallest production change that satisfies the existing federated retrieval design.

**Tech Stack:** TypeScript, Vitest, Python 3.12, pytest, Hermes plugin hooks.

## Global Constraints

- One pickup globally ranks local and public candidates and delivers at most two packets.
- Mixed-source relevance has no source score; exact ties preserve the federated adapter's stable local-then-public order.
- `PortResult.degraded` values remain usable while the first concrete reason is retained.
- Malformed or ambiguous local records never cause unrelated content to be fetched under an advertised ref.
- A surviving source remains usable while failures from another source remain observable.
- Session finalization fences every asynchronous child and completion side effect from the finalized lifecycle.
- No capture, pickup, fallback persistence, or user-visible completion effect may attach to a freshly reopened same-ID lifecycle.
- Tests use the canonical package runners and Node 22 for Layer native-module compatibility.

---

### Task 1: Federated retrieval correctness

**Files:**
- Modify: `packages/plugin/src/plugin.ts`
- Modify: `packages/plugin/src/pickup.ts`
- Test: `packages/plugin/test/pickup.test.ts`
- Test: `packages/plugin/test/plugin/first-turn-pickup.test.ts`
- Test: `packages/plugin/test/plugin/first-turn-pickup-content-rescore.test.ts`
- Modify: `packages/layer/src/adapters/local-episode-corpus-adapter.ts`
- Modify: `packages/layer/src/adapters/corpus-adapter.ts`
- Test: `packages/layer/test/adapters/local-episode-corpus-adapter.test.ts`
- Test: `packages/layer/test/adapters/corpus-adapter.test.ts`

**Interfaces:**
- Consumes: `PortResult<T> = ok(T) | degraded(reason, T | undefined) | unavailable(reason)`.
- Produces: stable mixed-domain ranking; degraded-value pickup; unambiguous local refs; observable advertised-public fetch failure.

- [ ] **Step 1: Add degraded-record pickup regressions**

Add final-projection, near-miss, and preferred-local cases where `corpus.get()` returns `degraded("partial local store", record)`. Assert the usable record still produces a packet and the result retains the degradation reason.

- [ ] **Step 2: Run the regressions and verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn test \
  test/plugin/first-turn-pickup.test.ts \
  test/plugin/first-turn-pickup-content-rescore.test.ts
```

Expected: the new cases fail because non-`ok` values are discarded.

- [ ] **Step 3: Consume degraded values without consuming unavailable results**

In each fetch path, record `result.reason` for a degraded result, then use `result.value ?? null`. Continue only when no record is present. Preserve the existing public fallback when preferred-local resolution has no usable value.

- [ ] **Step 4: Add the mixed-domain stable-order regression**

Create one local hit followed by two public hits with equal score and tier, distinct recency domains, and public refs that sort before `local-episode:`. Assert the selected order is local then the first public hit.

- [ ] **Step 5: Run the ranking regression and verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn test test/pickup.test.ts
```

Expected: the local hit is excluded by lexicographic ref ordering.

- [ ] **Step 6: Preserve input order for incomparable recency domains**

Keep the stable score/tier order for a mixed-domain tie group. Apply recency ordering only when the complete tie group declares the same recency domain.

- [ ] **Step 7: Add a real duplicate-ID local-store regression**

Write a legacy `.json` capture and canonical `.episode.json` with the same projected episode ID but different summaries. Search for text found only in one record, then prove the adapter never advertises a ref that fetches the other record. The safe expected result is a degraded search that excludes the ambiguous ID.

- [ ] **Step 8: Run the local adapter regression and verify RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn test \
  test/adapters/local-episode-corpus-adapter.test.ts
```

Expected: search advertises one duplicate while `get()` resolves the first duplicate.

- [ ] **Step 9: Exclude ambiguous local identities**

Build the lazy snapshot's episode-ID multiplicity once. Exclude IDs with more than one record from search, return a degraded reason identifying duplicate episode IDs, and prevent `get()` from returning an arbitrary duplicate.

- [ ] **Step 10: Add an advertised-public outage regression**

Make public search return a hit and its subsequent get throw. Assert `createCorpusAdapter()` returns a failing `PortResult` containing the acquisition reason. Retain the CorpusPort contract that a direct, never-advertised unknown ref maps to `ok(null)`.

- [ ] **Step 11: Preserve advertised refs and surface their fetch failures**

Track refs emitted by successful/degraded search calls for this adapter invocation. A get exception for an advertised ref becomes `degraded("corpus get failed ...", null)`; a never-advertised direct unknown-ref exception remains `ok(null)`.

- [ ] **Step 12: Verify Task 1 GREEN**

Run:

```bash
cd packages/plugin
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn build
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn test
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn typecheck

cd ../layer
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn test \
  test/adapters/corpus-adapter.test.ts \
  test/adapters/federated-corpus-adapter.test.ts \
  test/adapters/local-episode-corpus-adapter.test.ts \
  test/plugin-wiring.test.ts \
  test/process-contract.test.ts \
  test/consume.test.ts
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn typecheck
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" yarn build
```

Expected: plugin 300 plus new regressions pass; all affected Layer suites pass; typecheck and builds exit zero.

- [ ] **Step 13: Commit**

```bash
git add packages/plugin packages/layer
git commit -m "fix: preserve federated retrieval evidence"
```

---

### Task 2: Hermes lifecycle fencing and compatibility

**Files:**
- Modify: `apps/jinn-agent/plugins/jinn/__init__.py`
- Modify: `apps/jinn-agent/agent/conversation_loop.py`
- Modify: `apps/jinn-agent/agent/codex_runtime.py`
- Modify: `apps/jinn-agent/run_agent.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_pickup.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_doctor.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_session_view.py`
- Test: `apps/jinn-agent/tests/run_agent/test_codex_app_server_integration.py`

**Interfaces:**
- Consumes: foreground lifecycle token bound during Jinn's pre-LLM hook and propagated into background-review threads.
- Produces: parent-token-bound internal lifecycles, a completion lease that finalization invalidates or waits for, and per-turn Codex post/end cleanup.

- [ ] **Step 1: Add the late-child lifecycle regression**

Block a background review until after parent finalization, then let its Jinn pre-hook run. Assert it cannot create lifecycle state, perform pickup, or persist an episode. Include the stronger same-ID reopen case so an old child cannot bind to the new parent generation.

- [ ] **Step 2: Run the late-child regression and verify RED**

Run:

```bash
scripts/run_tests.sh tests/plugins/test_jinn_pickup.py -j 1 \
  -k "late_background or parent_finalize" --tb=short
```

Expected: the delayed child creates a new internal lifecycle.

- [ ] **Step 3: Bind internal lifecycles to the originating parent generation**

Carry the foreground parent lifecycle identity in propagated context. Internal `_session_identity()` must atomically verify that exact parent token is still current before creating or reusing a child. Keep parent-to-child ownership registered until the child's completion path ends.

- [ ] **Step 4: Add the fallback check/use regression**

Pause inside fallback persistence after the completion fence admits the old lifecycle. Finalize the old session and reopen the same ID. Assert finalization does not return while an admitted completion lease is active and no old write can commit after finalization has completed.

- [ ] **Step 5: Run the completion regression and verify RED**

Run:

```bash
scripts/run_tests.sh tests/plugins/test_jinn_pickup.py -j 1 \
  -k "fallback and reopen" --tb=short
```

Expected: the old fallback commits after the fresh lifecycle starts.

- [ ] **Step 6: Add a generation-aware completion lease**

Acquire completion ownership atomically against the lifecycle token before fallback persistence or terminal completion rendering. Session finalization invalidates new leases and waits for admitted leases before returning. Release internal parent ownership only after completion effects and lease cleanup finish.

- [ ] **Step 7: Add the Codex multi-turn lifecycle regression**

Drive two Codex app-server turns through the early-return path and assert each turn receives matching post/end hooks and `_session_turn_lifecycle_owners` remains bounded after each turn.

- [ ] **Step 8: Run the Codex regression and verify RED**

Run:

```bash
scripts/run_tests.sh \
  tests/run_agent/test_codex_app_server_integration.py \
  -j 1 --tb=short
```

Expected: owner entries accumulate because the normal finalizer is bypassed.

- [ ] **Step 9: Complete Codex plugin hooks on every exit path**

Pass `turn_id` into the Codex runtime path. Invoke the equivalent post-LLM and on-session-end hooks exactly once for success, interruption, and error returns, preserving existing result and persistence behavior.

- [ ] **Step 10: Repair the two stale compatibility tests**

Update the degraded-doctor test to patch `pickup_with_outcome()` with the real outcome shape, and bind the live session-view capture rows to the active lifecycle token. Do not weaken their production assertions.

- [ ] **Step 11: Verify Task 2 GREEN**

Run:

```bash
scripts/run_tests.sh \
  tests/plugins/test_jinn_pickup.py \
  tests/plugins/test_jinn_doctor.py \
  tests/plugins/test_jinn_session_view.py \
  -j 3 --tb=short
```

Then run the affected Codex runtime test file and the expanded Hermes/Jinn suite required by `AGENTS.md`.

Expected: zero failures, including the two previously red CI tests and every new concurrency regression.

- [ ] **Step 12: Commit**

```bash
git add apps/jinn-agent
git commit -m "fix: fence Hermes retrieval lifecycles"
```

---

### Task 3: Integrated verification and review

**Files:**
- Review all Task 1 and Task 2 diffs.

- [ ] **Step 1: Run full proportional verification**

Run the full plugin suite, affected Layer suites plus typecheck/build, expanded Hermes/Jinn suites, `git diff --check`, and inspect `git status --short`.

- [ ] **Step 2: Dispatch whole-branch review**

Provide an exact diff package from the pre-fix head through the final fix head to a fresh reviewer. Fix every Critical or Important finding test-first and re-review.

- [ ] **Step 3: Record final local state**

Report commits, fresh test counts, remaining known baseline failures, and whether the local PR branch was pushed.
