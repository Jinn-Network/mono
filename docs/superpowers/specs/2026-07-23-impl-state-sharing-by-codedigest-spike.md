# Spike: enable sharing impl-state source behind a codeDigest (forkable self-state)

- **Version:** 0.2 (spike finding + Stage-2 follow-up plan pointer)
- **Date:** 2026-07-23
- **Author:** Cursor Grok 4.5 (Autopilot stage-1 design + stage-2 plan, issue #945)
- **Status:** Finding — ready for Captain review; actionable follow-ups live in [`docs/superpowers/plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md`](../plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md) (Issues not filed by this stage)
- **Shape:** `spike` — output is this finding + plan; spike code does not merge
- **Issue:** [#945](https://github.com/Jinn-Network/mono/issues/945)
- **Anchors:**
  - `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` §6–§7 (freeze fence, HarnessCheckpoint)
  - DR-2026-05-06-c / DR-2026-05-06-d (frozen-state contract, trust stack)
  - `client/src/harnesses/freeze.ts` (`hashImplStateDir`)
  - `client/src/erc8004/identity.ts` (`ExecutionPayloadV2`)
  - `packages/sdk/src/checkpoint.ts` + `client/src/cli/commands/checkpoint.ts`
  - `spec/2026-05-28-harness-as-policy-learning-architecture.md` Phase 5 (cross-operator federation)
  - DR-2026-05-27 §4.8–§4.9 (federated L1; donation-carries-skills)

---

## TL;DR

`codeDigest` is already a network-legible, one-way fingerprint of `implStateDir`, stamped on every delivery via `ExecutionPayloadV2` and indexed for per-digest pass-rate (`get_codedigest_reward`, explorer boards). **Contents behind a high-performing digest are not retrievable today** — the delivery envelope carries no impl-state CID, and the designed `HarnessCheckpoint` publish path is scaffolded but not a real upload (`pinToIpfs({ kind: 'implStateDir', data: '' })`).

**Recommendation:** do **not** auto-upload impl-state on every train delivery. Complete the existing voluntary **HarnessCheckpoint** path (opt-in, frozen-preferred), make published state discoverable **by `codeDigest`**, and require consumers to re-run `hashImplStateDir` with the same ignore list. Before that is safe, **exclude `secrets/` (and equivalent sensitive bags) from the freeze hash** so publishable bytes can match the advertised digest without leaking credentials.

Smallest viable path is a thin amendment to the existing §7 design + 2–3 follow-up `feat` Issues — not a greenfield artifact type, and not a new DR unless the hash-ignore change is treated as a trust-stack amendment (recommended: short DR-amend note under DR-2026-05-06-d).

---

## 1. Problem (what #945 asks)

On delivery the daemon:

1. Hashes `implStateDir` via `hashImplStateDir` (deterministic walk → per-file SHA-256 → path-sorted combine → outer SHA-256).
2. Stamps `sha256:<hex>` on the signed envelope as `executor.codeDigest`.
3. Encodes the raw 32-byte digest into on-chain `ExecutionPayloadV2.codeDigest` alongside `{version, tier, manifestHash, attestationQuoteCid, sourceMeasurement, implName, modeFlag}`.

Network participants can already ask “which digests pass?” The missing half of Learning Maximised + Permissionless is: **given a digest that works, can an outsider fetch the constitutional state and fork from it?**

Today the answer is no, except the incomplete checkpoint CLI design that was meant to close exactly this gap for **verified frozen** claims.

### 1.1 What already exists (do not reinvent)

| Surface | Status | Relevance |
|---|---|---|
| `hashImplStateDir` + freeze-fence | Shipped | Integrity primitive consumers must re-run |
| `ExecutionPayloadV2.codeDigest` | Shipped | Network advertisement of digest (no source CID) |
| Envelope `executor.source` (build bundle) | Schema exists | Pattern for “CID + sha256 + measurement” — for **client/harness source**, not operator `implStateDir` |
| `HarnessCheckpointManifest` (`implStateDirCid` + `codeDigest` + `parentCheckpointCid`) | Schema + CLI scaffold | **Intended** forkable self-state artifact |
| Indexer `harness_checkpoint` (indexed `codeDigest`, `implStateDirCid`) | Schema live; enrichment path designed | Digest → CID join surface |
| `jinn checkpoint publish` / `install` | Scaffold; **impl-state pin is empty-buffer stub** | Gap between design and usable sharing |
| Capture `harness-bundle.v1` | Specced for captures | Sibling pattern: opt-in bundle whose sha256 **is** `codeDigest` — different tree (resolved harness config), useful prior art for allowlists/redaction |
| Corpus `search_records` / `inspect_record` / `acquire_artifact` | Shipped | Retrieval/acquire chain for envelopes & artifacts; no impl-state record type yet |
| Per-codeDigest reward MCP + L1 revert | Shipped | Measurement that shared digests feed |

### 1.2 Headless design decisions (audit log)

This stage ran non-interactively. Decisions taken without human gates:

1. **Prefer completing HarnessCheckpoint over inventing a parallel “impl-state envelope artifact.”** Same problem, already ratified in §7 / DR-c / DR-d.
2. **Reject auto-publish of train-mode state on every delivery** as default — cost, leak surface, digest churn.
3. **Treat hash-ignore parity as a prerequisite** for integrity-preserving publish (secrets must not be in the digest if they must not be published).
4. **Economics v0 = free + attributed**; x402 deferred as optional later, reusing `acquire_artifact`’s `access.priceUsdc`.
5. **Spec path:** amend existing agent-harness-solvernet §7 + short trust-stack note; file `feat` Issues (proposed below). No implementation in this spike.

---

## 2. Mechanism options (acceptance §1)

Three plausible ways to make contents retrievable by `codeDigest`. They are not fully mutually exclusive; the recommendation composes B with light discovery/MCP wiring.

### Option A — Snapshot on delivery; CID in envelope (or ExecutionPayload sidecar)

**Idea:** After each successful run (or each frozen run), tar/pin `implStateDir` to IPFS and attach `implStateDirCid` to the signed envelope (new optional `executor.implState` / artifact entry) and/or extend on-chain metadata beyond today’s fixed `ExecutionPayloadV2` tuple.

| Pros | Cons |
|---|---|
| Every advertised digest has a fetch path at the moment of claim | Train mode mutates every Task → flood of near-duplicate pins; gas/IPFS cost |
| Tightest coupling digest ↔ bytes | Redaction must run on the hot path; fail-open leaks, fail-closed drops deliveries |
| Matches “donation density” growth needs if operators never opt in | Extending `ExecutionPayloadV2` is a schema/ABI ceremony; envelope growth is cheaper but still hot-path |

**Fit with corpus:** CID becomes another artifact on the attempt envelope; `inspect_record` on the envelope can surface it; `acquire_artifact` can fetch if listed in `artifacts[]` with `access`.

**Verdict:** viable later as an **opt-in config** (`implStateShare.onDelivery: 'never' | 'frozen' | 'always'`) once the snapshot/redaction pipeline exists. Not the smallest first ship.

### Option B — Complete voluntary HarnessCheckpoint; discover by codeDigest (recommended)

**Idea:** Finish what §7 already specifies: operator runs `jinn checkpoint publish` (frozen window preferred) → pin real impl-state tree → sign manifest `{implStateDirCid, codeDigest, parentCheckpointCid, …}` → `IdentityRegistry.setMetadata(harness.checkpoint:<cid>)`. Indexer enrichment already has columns for digest and CID. Discovery = query checkpoints (and/or MCP) **by codeDigest**.

| Pros | Cons |
|---|---|
| Reuses ratified artifact + indexer table + CLI verbs | Does not auto-attach to every historical high-pass digest until someone publishes |
| Opt-in matches verified-vs-unverified incentive (DR-d) | Publish must be made real (today’s empty pin is a lie) |
| Lineage (`parentCheckpointCid`) already in schema | Need explicit digest→checkpoint lookup UX / MCP |
| Aligns with Phase 5 “federation is data density” framing | Operators must learn the publish discipline |

**Fit with corpus:** Checkpoint manifests are not today’s attempt-envelope corpus objects. Wire either:

- **B1 (preferred for v0):** Discovery/API + MCP `fetch_impl_state` / `get_checkpoint_by_digest` that reads indexer `harness_checkpoint` by `codeDigest` (and falls back to known CID).
- **B2 (later):** Also mint a corpus-visible projection record so `search_records` ranks checkpoints alongside donations — only if retrieval ranking needs them in the same index.

**Verdict:** **smallest viable path.** Closes #945’s retrieval gap for digests operators care to share, without taxing the delivery hot path.

### Option C — Sidecar registry / MCP-only `fetch_impl_state` without checkpoint manifests

**Idea:** Daemon maintains a local map `codeDigest → local path or private CID`; exposes MCP `fetch_impl_state({ codeDigest })` that either serves own state or resolves a gossip/registry sidecar unrelated to HarnessCheckpoint.

| Pros | Cons |
|---|---|
| Fast to prototype for self-serve | Parallel identity to HarnessCheckpoint → confusion and dual maintenance |
| Can stay operator-private | Network-legible Prestige/Legibility weak unless anchored |
| | Does not give “verified frozen” or explorer freeze-integrity story |

**Verdict:** useful as the **local install/verify helper** under Option B, not as a separate network artifact.

### Comparison (decision matrix)

| Criterion | A delivery CID | B checkpoint + digest index | C MCP-only sidecar |
|---|---|---|---|
| Retrievable by digest | Yes (if published) | Yes (if checkpoint exists) | Only if operator online / map known |
| Integrity story | Re-hash | Re-hash + manifest signature | Re-hash only |
| Safety control | Hard (hot path) | Easy (opt-in ceremony) | Easy |
| Economics / Prestige | Ambiguous (every delivery) | Clear publisher identity | Weak |
| Reuse of shipped design | Low–medium | **High** | Low |
| M2 / L1 measurement | Dilutes with train churn | Concentrates on published digests | N/A |

**Choose B as the spine; keep A as a later opt-in acceleration; use C only as local MCP glue.**

---

## 3. Integrity (acceptance §2)

### 3.1 Verification contract

A consumer who fetches bytes for digest `D` must:

1. Materialise a directory tree (IPFS DAG → local dir; preserve relative paths).
2. Call `hashImplStateDir(dir, { ignoreRelPaths })` with the **same ignore set** the publisher used when advertising `D`.
3. Accept iff `sha256:${result} === D` (or raw 32-byte form matches on-chain).

This is exactly Layer 4 of the trust stack (DR-2026-05-06-d): source publication enables independent re-derivation. Cross-operator forks running the same checkpoint in frozen mode produce matching digests (Layer 3).

### 3.2 Ignore-list parity is load-bearing

Today the learner harness sets `freezeStateHashIgnore = ['.git']` so git metadata does not break commit↔digest mapping for L1 revert (#764). **`secrets/` is not ignored.** Per `spec/2026-05-executor-trust-boundary.md`, per-impl secrets live under `implStateDir/secrets/`.

Consequence:

- If secrets are present and hashed into `D`, a correct publish of `D` **must include secret bytes** → unacceptable leak.
- If publish strips secrets, re-hash **cannot** equal `D` → integrity fails.

**Prerequisite for any sharing feat:** extend the freeze ignore set (protocol default and/or harness declare) to exclude at least:

- `secrets/` (and any harness-declared secret bags)
- ephemeral runtime caches that must not define identity (if any remain under `implStateDir`)

Publish packaging must pin **exactly the hashed tree** (apply the same ignores when walking for tar/CAR). Document the ignore set in the checkpoint manifest (new optional field `hashIgnoreRelPaths: string[]`, defaulting to publisher harness ignores) so verifiers do not guess.

### 3.3 What not to do

- Do not invent a second hash algorithm for “publish digest” vs “fence digest.”
- Do not trust CID alone without re-hash (CID proves content-addressing of the blob; `codeDigest` is the protocol identity used on-chain and in L1 joins).
- Do not skip signature check on the checkpoint manifest before install.

---

## 4. Safety / redaction (acceptance §3)

### 4.1 Must strip or never hash

| Class | Rule |
|---|---|
| `secrets/` and credential bags | **Never hash, never publish** (ignore-list) |
| Absolute home paths / usernames in skill text | Run public-knowledge scrub (trajectory scrub redesign lineage: #1784/#1959 / 2026-07-22 scrub spec) before pin; fail closed on reject-class hits |
| Train-mode working residue | Prefer publish from **frozen** windows only; train `workingDir` is already out of scope (not in `implStateDir`) |
| Operator-private notes that are not skills | Allowlist publish roots: e.g. `skills/`, `hooks/`, `configs/`, `tunables/`, `tools/`, `agents/` (align with harness-as-policy tiers 1–5). Refuse or quarantine unknown top-level dirs until classified |

### 4.2 Opt-in vs allowlist

**v0 posture (recommended):**

1. **Opt-in publish** — no automatic pin on delivery.
2. **Directory allowlist** inside the hashed tree (skills/hooks/configs/…) — deny unknown paths at publish time.
3. **Frozen-preferred** — CLI warns or refuses `mode === 'train'` unless `--i-know-this-mutates` (train digests are short-lived and harder to attribute).
4. **Scrub gate** — same fail-closed spirit as corpus publish; attach a redaction manifest hash on the checkpoint for Legibility.

Capture `harness-bundle` prior art (`allowedDirectories` + coarse enable toggle) is the right UX shape; reuse vocabulary where possible so operators learn one mental model.

### 4.3 Train-mode material

Train envelopes already advertise unstable digests. Sharing train state is allowed in principle (Permissionless) but is a poor default: high churn, harder peer validation, easier accidental secret inclusion. Keep train share behind explicit flags; market the frozen checkpoint as the Prestige surface.

---

## 5. Economics (acceptance §4)

### 5.1 Price modes

| Mode | When | Mechanism |
|---|---|---|
| **Free + attributed (v0)** | Default for checkpoints | IPFS public pin; manifest carries `publisher.safeAddress`; explorer shows publisher |
| **Attributed prestige only** | Same as free | Prestige from verified-frozen leaderboard + fork count; no payment |
| **x402-priced (later)** | Optional per-checkpoint or per-artifact | List impl-state as an artifact with `access.endpoint` + `access.priceUsdc`; consumers use existing `acquire_artifact` / `/v1/artifacts/acquire` |

v0 should ship **free + attributed**. Pricing too early fights Learning Maximised and donation density (Phase 5 is already gated on density, not on rent). SPEC.md’s “transactions stay forkable / no marketplace cuts” posture also argues against protocol-level take; if pricing appears, it is operator-set via existing x402 rails, not a new fee.

### 5.2 Interaction with per-codeDigest measurement (“M2” / L1)

Reading #945’s “M2 per-codeDigest measurement” against shipped substrate:

- **L1 / Phase 3** — per-`codeDigest` pass-rate aggregates and revert selection (`get_codedigest_reward`, #763–#765) are live.
- **Explorer Milestone 2** — harness+model resolved-rate gate (#647), not digest-keyed.
- **Federated L1 (DR-2026-05-27 §4.8)** — network-wide digest aggregates are intentionally cross-operator.

When many operators install the same checkpoint and run **frozen**:

- All envelopes share one `codeDigest` → **more samples per digest**, tighter CIs, stronger Layer-3 cross-op validation. This is a feature, not a bug.
- Train-after-fork: local Improve creates **new** digests; L1 revert continues to compare child vs parent **locally**. Imported root is a lineage start (`parentCheckpointCid` on the next published checkpoint), not a poisoned identity.
- Attribution: measurement joins are by digest (content), not by original publisher. Prestige for the **author** of the state should use checkpoint publisher + fork graph; Prestige for **operators** remains their own Safe’s frozen scores on that digest. Do not collapse “authored” and “ran” in explorer UX.

Risk to watch: a popular weak digest could attract cargo-cult installs. Mitigations already in design — verified-frozen badge, held-out exam discipline (#818), refusal to treat unverified train digests as headline claims.

---

## 6. Trust / lineage (acceptance §5)

### 6.1 Does importing foreign self-state break codeDigest lineage / revert-check?

**No, if install is modeled as a fork.**

| Concern | Resolution |
|---|---|
| Local git history / Improve commits | Install stages tree as new `implStateDir`; learner re-inits git (or imports as orphan root). Prior local commits are unrelated. |
| L1 revert (`codedigest-revert-check`) | Operates on **this daemon’s** subsequent commit digests vs parents. Foreign history is not required. |
| On-chain identity | After install+frozen run, envelopes advertise the **imported** digest (must match checkpoint). After train mutations, digests diverge — correct. |
| Provenance | Checkpoint `parentCheckpointCid` + publisher signature. Optional: local marker file outside hash (or ignored path) recording `installedFromCheckpointCid` for operator UX — must not affect digest. |

### 6.2 Provenance needs (minimum)

1. Manifest signature over canonical checkpoint fields.
2. `publisher.safeAddress` / agent id.
3. `parentCheckpointCid` nullable.
4. `codeDigest` + `implStateDirCid` + `hashIgnoreRelPaths`.
5. On-chain `harness.checkpoint:<cid>` anchor (already designed).

Optional later: link from attempt envelopes that *claim* a digest to the checkpoint CID when one exists (indexer join), so explorers can show “source available.”

### 6.3 What would break trust

- Publishing a tree that does not re-hash to the claimed digest.
- Installing without re-hash verify.
- Silently merging foreign skills into an existing local digest without a new hash (would desync fence vs reality).
- Treating shared digest pass-rate as single-operator skill without disclosing multi-op contribution.

---

## 7. Recommendation (acceptance §6)

### 7.1 Smallest viable path

1. **Hash-ignore prerequisite** — exclude `secrets/` (and document harness `freezeStateHashIgnore` contract) so publishable trees can equal advertised digests.
2. **Make `jinn checkpoint publish` real** — walk/pin the hashed tree (not `data: ''`); run allowlist + scrub; write `hashIgnoreRelPaths` into manifest; keep `IdentityRegistry.setMetadata` anchor.
3. **Make `jinn checkpoint install` verify** — fetch → signature check → materialise → `hashImplStateDir` → match `manifest.codeDigest` → stage.
4. **Digest discovery** — indexer/GraphQL already indexes `harness_checkpoint.codeDigest`; expose MCP `get_checkpoint_by_codedigest` (or extend `inspect_record`) + explorer “source” affordance on digest boards.
5. **Do not** extend `ExecutionPayloadV2` or auto-pin on every delivery in v0.

### 7.2 Spec / DR warrant

| Artifact | Needed? | Why |
|---|---|---|
| New greenfield design spec | **No** | §7 already specifies the artifact |
| Amend `2026-05-06-agent-harness-solvernet-design.md` §7 | **Yes (light)** | Add hashIgnore field, allowlist, scrub gate, digest-discovery, stub-removal acceptance |
| DR amend under DR-2026-05-06-d (trust stack) | **Yes (short)** | Changing default hash ignores is a trust-boundary change; record it |
| New DR for x402 pricing of checkpoints | **No for v0** | Defer |
| Follow-up `feat` Issues | **Yes** | See §8 |

### 7.3 Non-goals for the first feat train

- Auto-share train digests on delivery
- x402 pricing UI
- Corpus ranking of checkpoints inside `search_records` hybrid retrieval (can follow once density exists)
- TEE-attested impl-state (Phase B.1 territory)

---

## 8. Proposed follow-up Issues (for Captain / file-issue — not filed by this stage)

Canonical ordering, acceptance criteria, dependencies, and verification live in the Stage-2 plan:

[`docs/superpowers/plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md`](../plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md)

Summary (Issue Types match handbook shapes):

1. **`design` / `docs`** — short DR-amend under DR-2026-05-06-d + light §7 amend (hashIgnore, allowlist, scrub, digest discovery).
2. **`feat(client): exclude secrets from freeze codeDigest + document hashIgnore contract`**  
   Acceptance: `secrets/` never affects `hashImplStateDir` for learner (and default policy for other harnesses); tests for ignore parity; migration note for operators whose historical digests included secrets.
3. **`feat(client): real HarnessCheckpoint publish/install with re-hash verify`**  
   Acceptance: publish pins actual tree; install refuses digest mismatch; allowlist + scrub gate; replaces empty-buffer stub; unit + one integration test with local IPFS mock.
4. **`feat(discovery/mcp): resolve impl-state by codeDigest via harness_checkpoint`**  
   Acceptance: given `sha256:<hex>`, return checkpoint CID + `implStateDirCid` when enriched row exists; MCP tool usable from consolidator/Improve; graceful empty when unpublished.

Optional later: `feat` opt-in `implStateShare.onDelivery: frozen` (Option A) once (2)–(4) are stable.

---

## 9. Spec self-review + #945 AC coverage

| #945 investigate item | Finding section | Covered? |
|---|---|---|
| Mechanism options (snapshot/CID-in-envelope vs sidecar vs MCP; corpus fit) | §2 | Yes — A / B / C + matrix; B recommended |
| Integrity (re-run `hashImplStateDir`) | §3 | Yes — verify contract + ignore-list parity prerequisite |
| Safety / redaction (secrets, paths, train; opt-in vs allowlist) | §4 | Yes — never-hash secrets; allowlist; frozen-preferred; scrub gate |
| Economics (free / attributed / x402; M2 / shared digest) | §5 | Yes — free+attributed v0; x402 later; federated L1 densification |
| Trust / lineage (import vs revert-check; provenance) | §6 | Yes — fork model; parentCheckpointCid; install verify |
| Recommendation (smallest path + spec/DR + follow-up feat) | §7–§8 + Stage-2 plan | Yes — complete HarnessCheckpoint; amend §7 + short DR-d note; ordered Issues |

| Check | Result |
|---|---|
| Placeholders / TBD | None left intentional; follow-ups are concrete Issue sketches |
| Internal consistency | Option B spine throughout; A deferred; C local-only |
| Scope | Spike finding + plan docs only; no client runtime changes in this session |
| Ambiguity | “M2” interpreted as network per-digest measurement / federated L1 (+ noted explorer Milestone 2 distinction) |
| Acceptance coverage | All six #945 investigate checkboxes map to §§2–7; follow-up filing is Stage-2 plan |

---

## 10. Principles check

- **Learning Maximised** — high-performing self-state becomes forkable substrate, not a private dead-end hash.
- **Permissionless** — anyone can install a published checkpoint; no privileged shortcut beyond public pin + re-hash.
- **Prestige** — publisher attribution + verified-frozen badge; runners earn their own scores.
- **Legible** — re-hash + on-chain checkpoint anchor + optional redaction manifest.
- **Neutral / Governance Minimal** — reuse existing artifact; no new fee or committee; opt-in publish.
