# Impl-state sharing by codeDigest — spike follow-ups (#945)

> **For agentic workers:** This is a **spike close-out plan**, not a production TDD implementation plan. After Captain accepts the finding recommendation, file the ordered Issues below (via `file-issue`), then implement each `feat` with `writing-plans` → `test-driven-development` → `executing-plans` / `subagent-driven-development`. Do **not** merge production client code under #945.

**Goal:** Close spike #945 when a human accepts the finding recommendation (complete voluntary HarnessCheckpoint + digest discovery; do not auto-pin on every delivery) and the follow-up Issue train is filed with clear acceptance criteria.

**Architecture:** Reuse the ratified `HarnessCheckpoint` artifact (`packages/sdk/src/checkpoint.ts`, `jinn checkpoint publish|install`) as the network-legible source behind `codeDigest`. Prerequisite: exclude `secrets/` from `hashImplStateDir` so published bytes can re-hash to the advertised digest. Then make publish/install real (replace empty-buffer pin stub), then expose digest→checkpoint discovery via indexer + MCP.

**Tech Stack:** TypeScript client + `@jinn-network/sdk` checkpoint schema, IPFS pin path used by CLI, Ponder `harness_checkpoint` table, DiscoveryAPI / MCP, Vitest.

**Finding (Stage 1):** [`docs/superpowers/specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md`](../specs/2026-07-23-impl-state-sharing-by-codedigest-spike.md)

**Issue:** [#945](https://github.com/Jinn-Network/mono/issues/945)

## Global Constraints

- Spike #945 ships **docs only** (finding + this plan). No production `client/` / `packages/` runtime changes under the spike PR.
- Follow-up work targets base `next`; Issue Types and PR titles use handbook shapes (`design` / `docs` / `feat`).
- Recommendation spine is **Option B** (complete HarnessCheckpoint). Option A (CID-on-delivery) and corpus `search_records` ranking of checkpoints are **deferred**.
- Economics v0 = **free + attributed**; no x402 checkpoint pricing in the first feat train.
- Integrity always means re-run `hashImplStateDir` with the **same** `ignoreRelPaths` the publisher advertised — never trust CID alone.
- American English in identifiers and Issue titles (`digest`, `distill`, ` favor` not British variants).

---

## Spike success criteria (close #945)

A human reviewer may accept and close the spike when **all** of the following are true:

1. Finding answers every #945 investigate checkbox (mechanism, integrity, safety, economics, trust/lineage, recommendation) — see verification checklist below.
2. Recommendation is explicit and actionable: **complete HarnessCheckpoint; no auto-upload on every train delivery; secrets-out-of-hash first.**
3. This plan exists at the path above and maps ACs → ordered follow-up Issues with shapes, ACs, and dependencies.
4. No production runtime code was introduced solely to “prove” the spike.

Filing the follow-up Issues is **Captain / post-accept** work (or a subsequent `chore`/`docs` session with `file-issue`). Closing #945 does **not** require those Issues to be implemented — only that the path is clear.

---

## Out of scope for spike #945

| In scope (this PR / session) | Out of scope |
|---|---|
| Finding doc | Real `pinToIpfs` for `implStateDir` |
| This follow-up plan | Changing `freezeStateHashIgnore` / learner digests |
| Local commit of the two docs | Extending `ExecutionPayloadV2` |
| | Auto-share on delivery / `implStateShare.onDelivery` |
| | x402 pricing of checkpoints |
| | Explorer UI polish beyond naming the follow-up |
| | Corpus hybrid ranking of checkpoints in `search_records` |
| | Pushing, PR lifecycle, Project field mutation (coordinator owns) |

---

## AC → follow-up map

| #945 AC | Finding | Follow-up Issue(s) |
|---|---|---|
| Mechanism options | §2 | F0 (docs/design) records B as chosen; F2–F3 implement B; F4 optional A |
| Integrity | §3 | F1 (hashIgnore) + F2 (re-hash on install) |
| Safety / redaction | §4 | F1 (never hash secrets) + F2 (allowlist + scrub) + F0 (spec) |
| Economics | §5 | F0 (document free+attributed); pricing deferred — no Issue until density |
| Trust / lineage | §6 | F2 (fork install + provenance fields) + F0 (`hashIgnoreRelPaths` on manifest) |
| Recommendation | §7 | Entire train F0→F3; human accept closes spike |

---

## File map (for later `feat` implementers — do not touch in spike)

| Path | Role |
|---|---|
| `client/src/harnesses/freeze.ts` | `hashImplStateDir(dir, { ignoreRelPaths })` |
| `client/src/harnesses/impls/learner/harness.ts` | Today: `freezeStateHashIgnore = ['.git']` — add `secrets` / `secrets/` |
| `client/src/harnesses/types.ts` | `freezeStateHashIgnore?: readonly string[]` |
| `client/src/daemon/freeze-fence.ts` | Passes harness ignore list into hasher |
| `client/src/cli/commands/checkpoint.ts` | **Stub:** `pinToIpfs({ kind: 'implStateDir', data: '' })` — must become real walk/pin |
| `packages/sdk/src/checkpoint.ts` | `HarnessCheckpointManifest` schema — add optional `hashIgnoreRelPaths` |
| Indexer `harness_checkpoint` | Already has `codeDigest`, `implStateDirCid` columns (enrichment path) |
| `client/src/discovery/*` + `client/src/mcp/server.ts` | Digest→checkpoint lookup + MCP tool |
| `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §7 | Amend for ignore/allowlist/scrub/discovery |
| `log/decisions/` DR-2026-05-06-d amend note | Trust-stack record for default hash-ignore change |

---

## Ordered follow-up Issues

### F0 — `design` / `docs`: amend §7 + short DR-2026-05-06-d note

**Proposed title:** `docs(harness): amend checkpoint §7 + DR-d for hashIgnore / digest discovery`

**Shape:** Prefer single Issue Type `docs` if the amend is light and Captain already accepts the spike recommendation; use `design` only if Captain wants a fresh design session before any `feat`. Default after spike accept: **`docs`**.

**Depends on:** Human accept of #945 finding recommendation.

**Blocks:** F1–F3 (feats may start in parallel with F0 only if F0’s field names are locked in the finding — they are: `hashIgnoreRelPaths`, allowlist roots, scrub gate). Prefer F0 merges first.

**Acceptance criteria:**

- [ ] `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §7 documents: opt-in publish; directory allowlist; scrub gate; `hashIgnoreRelPaths` on manifest; digest-indexed discovery; stub-removal acceptance for publish.
- [ ] Short amend under DR-2026-05-06-d (or sibling note in `log/decisions/`) records that default / learner freeze ignores exclude `secrets/` so Layer-4 re-derivation matches publishable bytes.
- [ ] Explicit non-goals: no ExecutionPayloadV2 extension; no auto-pin on delivery in v0; economics = free + attributed.
- [ ] Links back to #945 finding + this plan.

**Verification:** Doc PR review; CODEOWNERS / Discussion only if a canonical root doc is touched (these paths are not SPEC/BRAND/THESIS — ordinary docs review suffices).

---

### F1 — `feat(client): exclude secrets from freeze codeDigest`

**Proposed title:** `feat(client): exclude secrets from freeze codeDigest + document hashIgnore contract`

**Shape:** `feat`

**Depends on:** F0 preferred (or finding field names if F0 deferred one sprint).

**Blocks:** F2 (publish cannot be integrity-safe while secrets remain in the digest).

**Acceptance criteria:**

- [ ] Learner harness `freezeStateHashIgnore` includes `.git` **and** `secrets` / `secrets/` (match existing ignore semantics in `hashImplStateDir` — confirm whether path is directory prefix or exact segment; tests must lock the chosen rule).
- [ ] Default policy documented for other harnesses: credential bags must be listed in `freezeStateHashIgnore` or must not live under hashed `implStateDir`.
- [ ] Unit tests: two trees differing only under `secrets/` produce the **same** digest when ignores apply; without ignore they differ.
- [ ] Operator migration note: historical digests that hashed secrets will **not** match post-change digests of the same skill tree — L1 / leaderboard continuity called out (same class of break as prior `.git` ignore).
- [ ] No secrets bytes appear in any new publish packaging helper introduced later in F2.

**Verification (implementer):**

```bash
cd client && yarn test path/to/freeze-secrets-ignore.test.ts
```

Expected: PASS; boundary cases cover empty `secrets/`, nested file, and ignore-list parity with freeze-fence call site.

**Suggested first test sketch (for the feat’s own TDD plan):**

```typescript
it('secrets/ contents do not change codeDigest when ignored', async () => {
  // arrange two temp implStateDirs with identical skills/, different secrets/token
  // hash with ignoreRelPaths including 'secrets'
  // assert digests equal
});
```

---

### F2 — `feat(client): real HarnessCheckpoint publish/install with re-hash verify`

**Proposed title:** `feat(client): real HarnessCheckpoint publish/install with re-hash verify`

**Shape:** `feat`

**Depends on:** F1 (required). F0 (preferred).

**Blocks:** F3 (discovery is useless until real CIDs exist).

**Acceptance criteria:**

- [ ] `jinn checkpoint publish` pins the **actual** hashed tree (replace `data: ''` stub in `client/src/cli/commands/checkpoint.ts`).
- [ ] Publish walk applies the **same** ignore list used for `codeDigest`; manifest includes `hashIgnoreRelPaths` (schema amend in `packages/sdk/src/checkpoint.ts`).
- [ ] Directory allowlist at publish time (skills/hooks/configs/tunables/tools/agents — align with harness-as-policy tiers); unknown top-level dirs fail closed or require explicit flag.
- [ ] Scrub gate before pin (fail closed on reject-class hits); optional redaction manifest hash recorded for Legibility.
- [ ] Frozen-preferred: warn or refuse `mode === 'train'` unless `--i-know-this-mutates`.
- [ ] `jinn checkpoint install`: fetch → signature verify → materialise → `hashImplStateDir` with advertised ignores → refuse on digest mismatch → stage as fork root (`parentCheckpointCid` preserved in provenance UX; local git re-init / orphan root as designed).
- [ ] Unit tests for allowlist/scrub/mismatch refusal; one integration test with mocked IPFS pin/fetch.

**Verification (implementer):**

```bash
cd client && yarn test test/cli/checkpoint*.test.ts
cd packages/sdk && yarn test  # schema parse for hashIgnoreRelPaths
```

Expected: publish no longer pins empty buffer; install rejects tampered tree.

**Key stub to delete (must not ship as success path):**

```typescript
// client/src/cli/commands/checkpoint.ts — today
const implStateDirCid = await args.deps.pinToIpfs({ kind: 'implStateDir', data: '' });
```

Replace with walk → serialize (tar/CAR per existing IPFS helpers) → pin bytes that re-hash to `args.codeDigest`.

---

### F3 — `feat(discovery/mcp): resolve impl-state by codeDigest`

**Proposed title:** `feat(discovery/mcp): resolve impl-state by codeDigest via harness_checkpoint`

**Shape:** `feat`

**Depends on:** F2 (meaningful end-to-end). Indexer columns already exist — confirm enrichment path writes `codeDigest` + `implStateDirCid` before claiming done.

**Blocks:** Optional explorer “source available” affordance (can be a thin follow-on `feat` under explorer area).

**Acceptance criteria:**

- [ ] DiscoveryAPI method (name locked in feat plan, e.g. `getCheckpointByCodeDigest`) returns checkpoint CID + `implStateDirCid` + publisher fields when an enriched `harness_checkpoint` row exists for `sha256:<hex>`.
- [ ] MCP tool (e.g. `get_checkpoint_by_codedigest` or `fetch_impl_state` that resolves then points at install/acquire) usable from consolidator/Improve workflows.
- [ ] Empty / unpublished digest → graceful empty result (not throw-as-outage).
- [ ] Onchain DiscoveryAPI stub returns empty (same pattern as other enrichment-only reads).
- [ ] Tests: http mock GraphQL hit; not-ready / empty cases.

**Verification (implementer):**

```bash
cd client && yarn test test/discovery/http.checkpoint-by-codedigest.test.ts
# plus MCP registration smoke if present in suite
```

---

### F4 — optional later `feat`: opt-in share on frozen delivery (Option A)

**Proposed title:** `feat(client): opt-in implStateShare.onDelivery=frozen`

**Shape:** `feat`

**Depends on:** F1–F3 stable in canary; operator demand evidence.

**Acceptance criteria (sketch only — file when ready):**

- [ ] Config `implStateShare.onDelivery: 'never' | 'frozen' | 'always'` default `never`.
- [ ] On frozen success path only (when `frozen`), may attach `implStateDirCid` to envelope artifacts / checkpoint auto-publish — never on train unless `always`.
- [ ] Reuses F2 packaging/redaction; does not extend `ExecutionPayloadV2` unless a separate design Issue says so.
- [ ] Economics remain free+attributed unless a separate pricing Issue ships.

**Do not file F4 until F1–F3 have soak time.**

---

## Dependency graph

```text
#945 spike accept (human)
        │
        ▼
       F0  docs/design amend (§7 + DR-d)
        │
        ▼
       F1  feat: secrets out of hashIgnore
        │
        ▼
       F2  feat: real checkpoint publish/install
        │
        ▼
       F3  feat: digest → checkpoint discovery/MCP
        │
        └──► F4 (optional) onDelivery share
```

---

## Human verification checklist (accept spike finding)

Reviewer walks this list against the finding + this plan. Check every box before closing #945 / merging the spike docs PR.

### Mechanism (#945 investigate 1)

- [ ] At least two mechanism options compared (finding has A delivery-CID, B checkpoint, C MCP-only).
- [ ] Corpus/discovery fit is stated (`inspect_record` / `acquire_artifact` vs `harness_checkpoint` index).
- [ ] A clear winner is named (B) with deferred options recorded (A later, C local glue only).

### Integrity (#945 investigate 2)

- [ ] Consumer verify path is “materialise + `hashImplStateDir` + match advertised digest.”
- [ ] Ignore-list parity called out as load-bearing; secrets-in-hash contradiction explained.

### Safety / redaction (#945 investigate 3)

- [ ] Secrets / credential bags: never hash, never publish.
- [ ] Path / identity scrub + fail-closed posture named.
- [ ] Train-mode sharing is not the default; frozen-preferred.
- [ ] Opt-in + directory allowlist recommended for v0.

### Economics (#945 investigate 4)

- [ ] v0 = free + attributed; x402 deferred to existing acquire rails.
- [ ] Shared-digest / federated L1 densification treated as feature; author vs runner Prestige not collapsed.
- [ ] “M2” ambiguity acknowledged (L1 per-digest vs explorer Milestone 2).

### Trust / lineage (#945 investigate 5)

- [ ] Import modeled as fork; local L1 revert unaffected.
- [ ] Minimum provenance: signature, publisher, parentCheckpointCid, codeDigest, implStateDirCid, hashIgnoreRelPaths, on-chain anchor.

### Recommendation (#945 investigate 6)

- [ ] Smallest path is ordered: hashIgnore → real publish/install → digest discovery.
- [ ] Spec/DR warrant is explicit (amend §7 + short DR-d note; no greenfield artifact type).
- [ ] Follow-up Issues listed with shapes and ACs (this plan F0–F3).
- [ ] Spike PR contains **only** finding + plan docs (no runtime code).

### Process / authority

- [ ] Worktree remained detached; logical branch `autopilot/945` was not checked out by the stage agent.
- [ ] No push / Project mutation / Autopilot session commands from the stage agent.

---

## Plan self-review

| Check | Result |
|---|---|
| Spec / finding coverage | All six #945 ACs map to F0–F3 (and F4 deferred) |
| Placeholders | None — Issue titles, shapes, ACs, deps, verify commands concrete |
| Spike vs feat boundary | Production code steps deferred to per-feat `writing-plans` sessions |
| Consistency with finding | Option B spine; secrets-first; free+attributed; no ExecutionPayloadV2 in v0 |

---

## Headless decisions (Stage 2 audit log)

1. **Chose `docs` as default for F0** after spike accept (not a second full `design` session) because the finding already selects Option B and only needs §7 / DR-d ratification text.
2. **Kept F4 unfiled** until F1–F3 soak — matches finding non-goals.
3. **Did not file Issues via `gh`/`file-issue`** — stage authority forbids shared GitHub mutation; Captain files after accept.
4. **Did not implement production code** — spike output is finding + this plan only.
