# Spike: enable sharing impl-state source behind a codeDigest (forkable self-state)

- **Version:** 0.2 (spike finding + Stage-2 follow-up plan pointer)
- **Date:** 2026-07-23
- **Author:** Cursor Grok 4.5 (Autopilot stage-1 design + stage-2 plan, issue #945)
- **Status:** Human-accepted finding; actionable follow-ups live in [`docs/superpowers/plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md`](../plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md)
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

**Recommendation:** do **not** auto-upload impl-state on every train delivery. Complete the existing voluntary **HarnessCheckpoint** path (opt-in and frozen-only in v0), make published state discoverable **by `codeDigest`**, and require consumers to re-run `hashImplStateDir` with the manifest's named hash profile. Before that is safe, the learner's `learner-public.v1` profile must exclude `.git/`, `secrets/`, `transcripts/`, and `operator-requests/` from both the freeze identity and the published package so publishable bytes match the advertised digest without leaking credentials or operator-private history.

Smallest viable path is a thin amendment to the existing §7 design + 2–3 follow-up `feat` Issues — not a greenfield artifact type, and not a new DR unless the hash-ignore change is treated as a trust-stack amendment (recommended: short DR-amend note under DR-2026-05-06-d).

### Human ratification (2026-07-24)

The recommendation is accepted with the following implementation defaults:

- publication is voluntary through `HarnessCheckpoint`, never automatic on every train delivery;
- v0 publication refuses train-mode state and has no override;
- the named `learner-public.v1` profile is mandatory for learner checkpoints; callers cannot supply an ad hoc ignore list;
- `.git/`, `secrets/`, `transcripts/`, and `operator-requests/` are outside both the learner freeze identity and package, while every other supported learner top-level path is explicitly classified;
- unknown top-level paths fail closed before hashing or pinning, with no v0 override;
- consumers verify the materialized tree against the advertised digest using the manifest's supported profile;
- every production digest surface, including daemon status, resolves that same profile;
- the immutable, signed, pinned `harness.checkpoint.v2` manifest contains no transaction receipt; its CID is anchored on-chain and the receipt is derived from the event, avoiding a content-addressing cycle;
- install validates content-addresses and archive metadata before writing, extracts only into a unique owner-only staging directory under fixed byte/file limits, and commits only a verified tree to a contained destination;
- `jinn checkpoint publish|install|list` are registered CLI subcommands with production dependencies and CLI-level round-trip coverage, not factory-only helpers;
- v0 is free and attributed; automatic delivery sharing and x402 pricing remain deferred.

The ordered implementation train is filed as [#2117](https://github.com/Jinn-Network/mono/issues/2117) (canonical §7 / DR-d amendment) → [#2118](https://github.com/Jinn-Network/mono/issues/2118) (`learner-public.v1` parity) → [#2119](https://github.com/Jinn-Network/mono/issues/2119) (real publish/install) → [#2120](https://github.com/Jinn-Network/mono/issues/2120) (digest discovery/MCP). The optional on-delivery F4 remains deliberately unfiled until F1–F3 have soak evidence.

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
| `HarnessCheckpointManifest` (`implStateDirCid` + `codeDigest` + `parentCheckpointCid`) | v1 schema + CLI scaffold | **Intended** forkable self-state artifact; the current writer pins `registry: null` but returns a different registry-populated object, so the pinned bytes do not pass the current schema |
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

**Idea:** Finish what §7 already specifies: operator runs `jinn checkpoint publish` from a frozen learner state → pin the real public impl-state tree → sign and pin an immutable `harness.checkpoint.v2` manifest `{implStateDirCid, codeDigest, hashProfile, parentCheckpointCid, …}` → `IdentityRegistry.setMetadata(harness.checkpoint:<cid>)`. The manifest does not contain the transaction receipt: the CID selects immutable bytes, while the indexer derives `txHash`, block, and publisher from the anchoring event. Indexer enrichment already has columns for digest and CID. Discovery = query checkpoints (and/or MCP) **by codeDigest**.

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

#### Canonical checkpoint and anchor contract

The current v1 scaffold cannot make its returned object content-addressed: it
pins a manifest with `registry: null`, uses that CID in the metadata key, then
returns a different object containing the transaction receipt. v0 real
publication therefore writes a new wire version with these invariants:

1. `harness.checkpoint.v2` is the immutable signed and pinned artifact. It has
   no `registry.txHash`, `registry.blockNumber`, or CID-derived metadata key.
2. The signature covers the canonical v2 core, including `hashProfile`.
3. `checkpointCid` is the CID of exactly the bytes an installer fetches and
   parses.
4. `IdentityRegistry.setMetadata("harness.checkpoint:<checkpointCid>",
   checkpointCid)` anchors that CID.
5. The CLI may return an `anchorReceipt` beside the manifest. It is local
   response metadata, not part of the signed/pinned manifest. The indexer
   projects the authoritative transaction hash and block from the event.
6. Readers may continue to parse already-produced valid v1 objects for
   compatibility, but new writers emit v2 and install/discovery never
   synthesize a registry-populated manifest different from the CID bytes.

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

1. Validate the checkpoint and impl-state CIDs before building a gateway URL or
   path. Verify the raw manifest bytes against `checkpointCid`; fetch the
   package as a bounded CAR whose root equals `implStateDirCid`, and verify
   every reachable block multihash before reconstructing package bytes.
2. Preflight the deterministic package without writing: reject unsafe paths,
   links/special files, duplicates, and declared or observed size/count limit
   violations.
3. Materialise into a fresh owner-only temporary directory while enforcing the
   same streaming limits and destination containment.
4. Resolve `manifest.hashProfile.id` from the local, versioned profile registry
   and require its canonical `ignoreRelPaths` to exactly equal the manifest
   copy. Unknown profile ids or mismatched lists are rejected; there is no
   inferred/default policy for v2.
5. Validate every top-level path against that profile before hashing.
6. Call `hashImplStateDir(dir, { ignoreRelPaths: profile.ignoreRelPaths })`.
7. Accept iff `sha256:${result} === D` (or raw 32-byte form matches on-chain),
   then atomically stage the fork root into a validated contained destination.

This is exactly Layer 4 of the trust stack (DR-2026-05-06-d): source publication enables independent re-derivation. Cross-operator forks running the same checkpoint in frozen mode produce matching digests (Layer 3).

### 3.2 The named hash/package profile is load-bearing

Today the learner harness sets `freezeStateHashIgnore = ['.git']` so git metadata does not break commit↔digest mapping for L1 revert (#764). **`secrets/` is not ignored.** Per `spec/2026-05-executor-trust-boundary.md`, per-impl secrets live under `implStateDir/secrets/`.

Consequence:

- If secrets are present and hashed into `D`, a correct publish of `D` **must include secret bytes** → unacceptable leak.
- If publish strips secrets, re-hash **cannot** equal `D` → integrity fails.

The learner also deliberately migrates operator-private session material to
`implStateDir/transcripts/` and `implStateDir/operator-requests/`. Those paths
have the same contradiction as `secrets/`: including them leaks private data;
dropping them only while packaging breaks digest parity.

**Prerequisite for any sharing feat:** introduce a single registered
`learner-public.v1` hash/package profile:

```json
{
  "id": "learner-public.v1",
  "ignoreRelPaths": [".git", "operator-requests", "secrets", "transcripts"]
}
```

The array order above is canonical. It uses the existing exact-path-or-directory-
prefix semantics. The profile, not a caller-supplied raw array, feeds the
learner freeze fence, commit-to-digest helper, daemon/operator status,
checkpoint hash, package walker, and installer. `harness.checkpoint.v2` requires
`hashProfile: { id, ignoreRelPaths }`; there is no optional field and no
publisher-harness default for v2. Consumers reject unknown ids or a manifest
list that differs from their registered copy. A future policy is a new id, not
an in-place mutation.

Other harnesses do not inherit the learner profile. A real checkpoint writer
must refuse a harness without its own registered public profile; this train
ships only the learner profile.

Publish packaging pins **exactly the non-ignored, validated tree**. The hasher
and packager share the profile resolver and top-level classifier so neither can
silently gain a different default.

### 3.3 What not to do

- Do not invent a second hash algorithm for “publish digest” vs “fence digest.”
- Do not trust CID alone without re-hash (CID proves content-addressing of the blob; `codeDigest` is the protocol identity used on-chain and in L1 joins).
- Do not skip signature check on the checkpoint manifest before install.

---

## 4. Safety / redaction (acceptance §3)

### 4.1 Exhaustive learner-public.v1 top-level classification

| Top-level path | Class | Hash/package rule |
|---|---|---|
| `.git/` | local repository metadata | Ignore and exclude |
| `secrets/` | credentials | Ignore and exclude |
| `transcripts/` | operator-private reasoning history | Ignore and exclude |
| `operator-requests/` | operator-private access requests | Ignore and exclude |
| `.archive/` | archived durable learner state | Hash, scrub, and package |
| `skills/`, `hooks/`, `configs/`, `tools/` | executable/durable capability state written by Improve | Hash, scrub, and package |
| `plans/`, `strategies/`, `notes/`, `runs/`, `patterns/`, `tests/` | durable learner memory referenced by the current learn loop | Hash, scrub, and package |
| `policy.json` | learner policy and revert thresholds | Hash, scrub, and package |
| `tunables/`, `agents/` | reserved harness-policy capability roots | Hash, scrub, and package |
| Anything else | unclassified | Refuse before digest computation or pinning; no v0 override |

This table is the complete `learner-public.v1` root policy. Empty allowed
directories are harmless; regular files are allowed only where the table names
a file. Symlinks and special files fail closed rather than inheriting the
hasher's current skip behavior. Adding a root requires a new reviewed profile
version.

The fail-closed public-knowledge scrub runs over every packaged file before
pinning and rejects credential patterns, absolute home paths/usernames, and
other reject-class findings. It does not redact in place: mutation would change
the advertised digest. The operator must remove or relocate the finding and
produce a new digest.

### 4.2 Opt-in vs allowlist

**v0 posture (recommended):**

1. **Opt-in publish** — no automatic pin on delivery.
2. **One named profile** — no raw ignore-list or allowlist flags.
3. **Fail closed** — unknown roots, special files, profile mismatches, and scrub findings stop before pinning; v0 has no bypass flag.
4. **Frozen-only** — CLI refuses `mode === 'train'`; v0 has no mutation-acknowledgement override.
5. **Scrub gate** — same fail-closed spirit as corpus publish; attach a redaction manifest hash on the checkpoint for Legibility.

Capture `harness-bundle` prior art (`allowedDirectories` + coarse enable toggle) is the right UX shape; reuse vocabulary where possible so operators learn one mental model.

### 4.3 Train-mode material

Train envelopes already advertise unstable digests. Sharing train state remains
a possible later protocol version, but v0 publication refuses it
unconditionally: there is no `--i-know-this-mutates` or warning-only path.
Frozen checkpoints are the initial Prestige surface.

### 4.4 Untrusted install boundary

Checkpoint manifests, CIDs, harness names, and impl-state packages are
attacker-controlled until verified. v0 install therefore locks these rules:

1. Both `checkpointCid` and `implStateDirCid` must be canonical CIDv1
   raw/dag-pb sha2-256 values accepted by a shared CID parser. The manifest is
   a raw block whose exact bytes must hash to `checkpointCid`. The impl-state
   package is exported as a CAR: its declared root must equal
   `implStateDirCid`, every reachable block multihash is verified, missing or
   duplicate/conflicting blocks fail, and unreachable extra blocks are
   rejected. An injected fetch port cannot substitute content.
2. v0 package bytes are a deterministic **uncompressed POSIX ustar** archive;
   compression and extended/PAX records are refused. Manifest fetch is capped
   at 1 MiB, CAR transfer at 320 MiB, and reconstructed tar/expanded bytes at
   256 MiB. The archive may contain at most 10,000 regular files, 16 MiB per
   file, and 255 UTF-8 bytes per relative path (the ustar name+prefix bound).
   These named constants are
   shared by production and tests; limit overflow aborts and cleans staging.
3. A package preflight pass completes before any entry is written. Paths must
   be normalized relative POSIX paths. Absolute paths, drive/UNC forms, NUL,
   backslashes, empty/dot/`..` segments, duplicate or case-fold-colliding
   paths, and file/directory prefix collisions are rejected.
4. Only regular files and directories are accepted. Symlinks, hardlinks,
   devices, FIFOs, sockets, sparse/extended entries, and other special archive
   records are rejected.
5. Extraction never shells out to `tar`. It creates a unique staging directory
   with `mkdtemp` under a trusted parent, verifies owner-only `0700`
   permissions, streams with the same byte/file counters, prevents link
   following/existing-target replacement, and proves every resolved output
   remains beneath that staging root.
6. Free-form CIDs and `implName` are never interpolated into temporary paths.
   `implName` must match the canonical harness-name grammar before it can
   select a final location. The final target is resolved beneath the configured
   impl-state root, rechecked for containment and unsafe parent links, and
   committed atomically only after signature, profile, root-policy, scrub, and
   `codeDigest` verification. Existing state is not overwritten by default.

Malicious-package tests cover CAR root/block substitution, traversal,
absolute/Windows paths, links, special/extended records, collisions,
transfer/archive/file-count/per-file limits, unsafe final parents, cleanup,
and no writes outside staging.

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
4. `codeDigest` + `implStateDirCid` + mandatory
   `hashProfile: { id, ignoreRelPaths }`.
5. On-chain `harness.checkpoint:<cid>` anchor, whose event supplies the
   authoritative receipt outside the immutable manifest.

Optional later: link from attempt envelopes that *claim* a digest to the checkpoint CID when one exists (indexer join), so explorers can show “source available.”

### 6.3 What would break trust

- Publishing a tree that does not re-hash to the claimed digest.
- Installing without re-hash verify.
- Silently merging foreign skills into an existing local digest without a new hash (would desync fence vs reality).
- Treating shared digest pass-rate as single-operator skill without disclosing multi-op contribution.

---

## 7. Recommendation (acceptance §6)

### 7.1 Smallest viable path

1. **Profile prerequisite** — register `learner-public.v1`, route the learner
   freeze fence, commit-to-digest helper, and daemon status through it, and
   exclude all four private/runtime roots from both the digest and package.
2. **Make `jinn checkpoint publish` real** — frozen-only; validate the complete
   root policy; scrub; walk/pin the exact public tree; emit the immutable
   `harness.checkpoint.v2`; anchor its CID; return the receipt separately.
3. **Make `jinn checkpoint install` verify safely** — validate CIDs → bounded
   fetch/content binding → preflight archive → owner-only contained extraction
   → schema/signature/profile/root checks → `hashImplStateDir` → match
   `manifest.codeDigest` → atomic contained stage.
4. **Digest discovery** — project profile id/list plus the event-derived anchor
   receipt in `harness_checkpoint`; expose MCP
   `get_checkpoint_by_codedigest` (or extend `inspect_record`) + explorer
   “source” affordance on digest boards.
5. **Register the product surface** — `jinn checkpoint publish|install|list`
   must be real CLI commands with production wiring, argument validation, help,
   and a CLI-level publish/install round trip.
6. **Do not** extend `ExecutionPayloadV2` or auto-pin on every delivery in v0.

### 7.2 Spec / DR warrant

| Artifact | Needed? | Why |
|---|---|---|
| New greenfield design spec | **No** | §7 already specifies the artifact |
| Amend `2026-05-06-agent-harness-solvernet-design.md` §7 | **Yes (light)** | Lock v2 manifest/anchor separation, named profile, exhaustive root policy, frozen-only publish, scrub gate, digest-discovery, and stub-removal acceptance |
| DR amend under DR-2026-05-06-d (trust stack) | **Yes (short)** | Changing default hash ignores is a trust-boundary change; record it |
| New DR for x402 pricing of checkpoints | **No for v0** | Defer |
| Follow-up `feat` Issues | **Yes** | See §8 |

### 7.3 Non-goals for the first feat train

- Auto-share train digests on delivery
- x402 pricing UI
- Corpus ranking of checkpoints inside `search_records` hybrid retrieval (can follow once density exists)
- TEE-attested impl-state (Phase B.1 territory)

---

## 8. Filed follow-up Issues

Canonical ordering, acceptance criteria, dependencies, and verification live in the Stage-2 plan:

[`docs/superpowers/plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md`](../plans/2026-07-23-impl-state-sharing-by-codedigest-followups.md)

Summary (Issue Types match handbook shapes):

1. **[#2117](https://github.com/Jinn-Network/mono/issues/2117) (`docs`)** — short DR-amend under DR-2026-05-06-d + light §7 amend (v2 immutable manifest/anchor split, named profile, exhaustive roots, frozen-only publish, scrub, digest discovery).
2. **[#2118](https://github.com/Jinn-Network/mono/issues/2118) — `feat(client): lock learner-public.v1 hash/package profile`**
   Acceptance: the four ignored roots never affect learner digests; allowed/unknown roots are classified; freeze, revert, daemon status, package, and install share one immutable profile resolver; migration note records the digest break.
3. **[#2119](https://github.com/Jinn-Network/mono/issues/2119) — `feat(client): real HarnessCheckpoint publish/install with re-hash verify`**
   Acceptance: frozen-only publish pins the actual tree and exact v2 manifest bytes; anchor receipt is separate; registered CLI verbs are reachable; install uses validated CIDs, bounded malicious-archive-safe staging, and refuses profile/digest mismatch; unit + CLI integration round trip.
4. **[#2120](https://github.com/Jinn-Network/mono/issues/2120) — `feat(discovery/mcp): resolve impl-state by codeDigest via harness_checkpoint`**
   Acceptance: given `sha256:<hex>`, return checkpoint CID, impl-state CID, profile id/list, and event-derived anchor receipt when enriched row exists; MCP tool usable from consolidator/Improve; graceful empty when unpublished.

Optional later: `feat` opt-in `implStateShare.onDelivery: frozen` (Option A) once (2)–(4) are stable.

---

## 9. Spec self-review + #945 AC coverage

| #945 investigate item | Finding section | Covered? |
|---|---|---|
| Mechanism options (snapshot/CID-in-envelope vs sidecar vs MCP; corpus fit) | §2 | Yes — A / B / C + matrix; B recommended |
| Integrity (re-run `hashImplStateDir`) | §3 | Yes — verify contract + ignore-list parity prerequisite |
| Safety / redaction (secrets, paths, train; opt-in vs allowlist) | §4 | Yes — exhaustive learner root classification; four private/runtime roots excluded; unknown/scrub/special files fail closed; frozen-only |
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
