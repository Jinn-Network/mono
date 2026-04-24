# Execution envelope + trajectory + TEE — **Scope** (pre-design)

**Version:** 0.7 (scope — verification topology explicit; evaluator puts verification on critical path)  
**Date:** 2026-04-24  
**Status:** scope locked for follow-on design work (open decisions in §6)  
**Beads:** `jinn-mono-38o` (epic: execution envelope + TEE integration)  
**Related:**

- `docs/research/2026-04-23-verifiability-traceability.md` — outcome vs trajectory, evidence tiers, non-goals
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — default restorer whose OTel emission drives the trajectory profile; its promotion gate interacts with attested-tier measurement (TEE measures the *starting* binary, not post-promotion state)
- `spec/2026-04-21-agentic-data-substrate.md` — substrate thesis; knowledge unit is a tree rooted at intent
- `spec/2026-03-23-jinn-implementation-spec-proposal.md` — §4.2 ERC-8004, §4.3 x402
- `client/src/types/portfolio.ts`, `prediction.ts`, `prediction-apy.ts` — current manifest schemas per kind (all collapsing into `jinn.execution.v1`)
- `client/src/restorer/engine/` — packaging, manifest assembly, signing, `evidenceHash` path
- `client/src/discovery/registry.ts`, `subgraph.ts` — current ERC-8004 Identity-Registry-only integration
- `client/src/x402/` — payment-gated artifacts (access/gating design deferred to D8)

## Changes since v0.1

**v0.2 locked (via initial design discussion):** envelope shape (D5), host-mediated signing (D6), signing-key kinds (D3a), operator identity (D3b), source-code identity (D3c), trajectory signing granularity, migration approach, same-TEE-substrate evaluator (V2b).

**v0.3 locks (via knowledge-data-model discussion):** the full knowledge graph and its storage model — intent formalization (K2), knowledge-tree primitive (K1), executor provenance required at all tiers (K3), source bundle as first-class entity (K4), trajectory↔artifact linkage (K5), normative OTel span profile (K6), verdict→restoration explicit link (K7), ERC-8004 three-registry separation (K8), role vocabulary (K9), and — load-bearing — the **uniform-schema principle** (§2.5). D3d resolved.

**v0.4 locks (via terminology + secrets discussion):** D2 resolved to **RFC 8785 JCS** for canonical JSON; rename `role` → `artifactType` in the envelope schema (free rename under one-shot migration); explicit **operator-secrets guidance** in §3.2 (three categories: runtime credentials never in source, proprietary IP published at attested tier or operator runs at lower tier, optional V2 `config_bundle` pattern for keep-IP-private-while-still-attested); §2.5 amended to distinguish schema-uniformity (required fields) from verifiability-tier-gating (actual fetchability of declared bundles).

**v0.5 locks (via sequencing + platform discussion):** D1 resolved to **(A) envelope + trajectory first**, with an optional narrow parallel Phala spike to de-risk reproducible-build tooling + REPORTDATA binding before full TEE integration lands. D4 resolved to **Phala Dstack** (TDX-under-the-hood + Phala protocol identity layer) — aligns with the diverse-decentralized-executor thesis, managed TEE lifecycle reduces operator DevOps burden.

**v0.6 locks (via verification-stance discussion):** attestation verification for V2 is **hybrid**, not "full on-chain." Off-chain SDK verification is the default (fast, cheap, accessible to any verifier); the ERC-8004 Validation Registry **records** challenger verification results on-chain (transparent + slashable even when the verification itself ran off-chain); the envelope schema keeps attestation bytes in a Solidity-verifier-consumable shape so a DCAP+Phala on-chain verifier on Base can be deployed later (V3+) without schema change. Rationale: DCAP quote verification costs ~500k–2M gas per quote — prohibitive per-envelope at realistic mainnet scale, affordable for challenger events; Phala's on-chain verifier lives on Phala's chain, not Base, so bridging is non-trivial infra; off-chain SDK delivers the same trust guarantee (quote verification is stateless + deterministic).

**v0.7 locks (via "who runs verification" discussion):** **Jinn-the-protocol operates no verification infrastructure.** Verification is a distributed, self-service capability — the SDK is a shared library; participants load it into their own processes based on incentive (buyers on ingestion, evaluators before producing verdicts, challengers opportunistically, indexers during indexing). Critically: **evaluators are required to verify the restoration envelope's attestation before producing a verdict**, and to attach the verification result to their verdict payload. This puts attestation verification on the Jinn loop's critical path without centralizing it — every restoration→verdict pair carries its own verification record, produced by whoever runs the evaluator.

**Still open:** D8 (access / gating / redaction / monetization — deferred for separate discussion).

## 1. Purpose of this document

The epic asks for a full **design** (schemas, verification split, TEE path, tiers). Conversation drifted into **optional** cross-ecosystem standards (SCITT transparency services, DSSE, etc.). This file **narrows scope**: what we are designing **now**, what is **already decided at a high level**, what is **explicitly deferred**, and what **must still be decided** before writing the full design spec.

## 2. Problem statement (one paragraph)

Jinn already packages `portfolio.v0` runs as signed manifests, IPFS artifacts, and on-chain `evidenceHash` commitments. The network's long-term product is **trajectory-shaped training data** — specifically a **knowledge tree rooted at each intent**, with restoration envelopes, verdict envelopes, trajectories, and artifacts as its branches, not any one piece alone. We need a **protocol-level execution envelope** that works across intent kinds, composes with **x402** (paid artifact fetch) and **ERC-8004** (discovery, validation, reputation), and reserves a path to an **attested** tier where a TEE binds *declared code* to *what ran*. The full design must stay honest about **two verifiability questions**: outcome (re-derivable per kind) vs trajectory (only provable at production time for training-grade claims).

## 2.5. Uniform-schema principle

**Every operator, at every tier, populates the same envelope schema.** The only fields whose *presence* is tier-gated are fields whose existence is definitionally a TEE capability:

- `attestation` — the EAT-shape quote itself. Only a TEE can produce a valid one.
- TLS-transcript span attributes (`net.tls.transcript.cid`) inside `jinn.llm_call` / `jinn.venue_io` spans — only the enclave can faithfully record these.

Everything else — `executor.source.bundleCid`, `executor.source.measurement`, the full `jinn.trajectory.v1` blob with normative span profile, the artifact set with required roles — **is required of all operators at all tiers**, regardless of TEE.

The semantic difference between tiers is **provability**, not completeness:

- `self-signed` — all required fields present, operator signs. Malicious operators can fabricate any field; honest ones self-report.
- `committed` — `self-signed` + envelope hash on-chain via `JinnRouter.claimDelivery(evidenceHash)`. Tamper-evident after claim.
- `attested` — `committed` + valid TEE attestation quote binding `(measurement, execPubkey, envelopeHash)` into `REPORTDATA`. The measurement matches a **publicly fetchable + reproducibly buildable** source bundle declared in `executor.source`.
- `consensus` / `proved` — higher tiers built on top of the above (multi-evaluator / zk insurance).

**Schema uniformity ≠ verifiability uniformity.** All tiers declare `source.bundleCid` in the envelope — the FIELD is required. Whether the bundle is actually publicly fetchable and reproducibly buildable is tier-gated: **attested requires public + reproducible**; lower tiers declare the CID but fetchability is at operator discretion. An operator keeping strategy IP secret can still run at `committed` — they declare a bundleCid; a challenger can't verify, but also can't challenge a `committed` envelope (which only claims self-consistency + on-chain commitment). See §3.2 operator-secrets guidance.

This keeps the data substrate uniform: a buyer ingesting trajectories doesn't care which tier produced them schema-wise; they care about tier as a *credibility weight* on the same structured content.

## 3. Decisions already made (for the follow-on design)

These are **directional** commitments for the design doc; field-level details come next.

### 3.1 Envelope & knowledge model

| Topic | Decision |
|--------|-----------|
| **Envelope shape (D5)** | Single `jinn.execution.v1` envelope with `role: "restoration" \| "verdict"` discriminator. Payload is typed per `(kind, role)`. A verdict is structurally an execution of the evaluator kernel over the restoration envelope: different producer, different payload, same envelope. Attestation, trajectory, and evidence-tier fields live on the envelope and apply to both roles. Verdict payload carries a reference back to the restoration envelope (`payload.restorationEnvelope: { cid, sha256 }`) — **K7**. |
| **Knowledge primitive (K1)** | **Knowledge tree rooted at an intent**, with 1:N:M fanout over restoration envelopes × verdict envelopes. Per restoration: one trajectory + many artifacts. Each verdict references exactly one restoration via payload link (K7). Not "triple" — triples are the N=1, M=1 special case. |
| **Intent formalization (K2)** | Promote current implicit `DesiredState` to canonical `intent.v1` schema: `{schemaVersion, id, kind, description, window, spec, eligibility, creator, createdAt, signature}`. Intent CID is the stable root of every knowledge tree query. |
| **Trajectory content (`jinn.trajectory.v1`)** | Use **OpenTelemetry** — traces in **OTLP-JSON**, with **GenAI** and **MCP** semantic conventions where applicable. No bespoke event vocabulary for core spans. **Required at all tiers** per §2.5. |
| **Normative span profile (K6)** | `jinn.trajectory.v1` specifies required attributes per `jinn.span.kind` value: `jinn.phase`, `jinn.llm_call`, `jinn.mcp_call`, `jinn.artifact.emit`, `jinn.venue_io`, `jinn.state_transition`. Conformance is a manifest-validation check for every tier; attested tier additionally requires TLS-transcript attributes where spans record external I/O. |
| **Trajectory signing granularity (V1)** | **End-of-run one-shot signing.** OTLP-JSON serialized at run completion, hashed, signed, uploaded as a single IPFS object. Crashed run loses the trajectory — acceptable at Phase 1b. Partial / streamed / append-signed trajectories explicitly V2+. |
| **Trajectory↔artifact linkage (K5)** | Bidirectional: span carries `jinn.artifact.cid` attribute for every emitted artifact; artifact metadata optionally carries `producedBy: { spanId, trajectoryCid }`. Required at all tiers. |
| **Artifact type vocabulary (K9)** | Field renamed from `role` → `artifactType` at the envelope schema level (free rename under one-shot migration; §3.4). **Required types** (normative at all tiers): `trajectory`, `system_snapshot`, `output.<kind>`. **Reserved standard types** (declared, extensible): `design_document`, `session_transcript`, `runtime_log`, `code_patch`, `research_note`, `skill_bundle`, `mcp_config`, `promotion_record`, `source_bundle`. **Custom types** permitted; buyers filter by prefix. `session_transcript` (raw LLM conversation log) and `trajectory` (structured OTLP-JSON spans) are **complementary, not overlapping** — trajectory spans may reference session_transcript artifacts by CID for the raw bytes. |

### 3.2 Identity, signing, attestation

| Topic | Decision |
|--------|-----------|
| **Attestation field** | Shape aligns with **RATS EAT**: generic outer + `profile` string (vendor/TEE-specific evidence inside). First concrete profile targets a single stack (see D4); the field must not hard-code a single vendor forever. Nullable — **only populated at `attested` tier** (§2.5 exception). |
| **Signing chain (TEE tier, V2) (D6)** | **Host-mediated.** Enclave holds a sealed, measurement-bound **execution-signing key** that signs the envelope. Attestation quote's `REPORTDATA` binds `(measurement, execPubkey, envelopeHash)`. **Host** retains the durable agent EOA / Safe / OLAS infra and submits `claimDelivery(evidenceHash = envelopeHash)` on-chain. Earning bootstrap unchanged. Enclave-direct on-chain signing deferred. |
| **Manifest signing key (D3a)** | `signature.signer` is a single field. Kind is declared on `executor.signingKey.kind`: `agent-eoa` for `self-signed` / `committed` / non-TEE `attested`-claims (today's pattern) or `enclave-bound` for enclave-produced signatures. No schema bifurcation. |
| **Operator identity (D3b)** | `participant.safeAddress` is the canonical operator ID (on-chain anchor for staking, rewards, mech service, ERC-8004 discovery). `agentEoa` is signing / session identity. `did:*` identity deferred to V3 if a concrete need appears. |
| **Executor provenance (K3)** | `executor = {implName, implVersion, clientGitSha, codeDigest, signingKey, source}`. **Required at all tiers** — every envelope states what code ran. Values are self-reported at `self-signed` / `committed`; provably bound at `attested` via `source.measurement` ↔ attestation quote. |
| **Source-code identity (D3c, K4)** | `executor.source = { bundleCid, sha256, humanUrl?, buildRecipe, measurement }`. IPFS bundle is authoritative (GitHub can rug commits); `humanUrl` is debuggability only. Required at all tiers. **Source bundle is a first-class ERC-8004 entity** (K8) — registered once per release as `adw:SourceBundle`, referenced by every envelope from that build. Enables "show me envelopes running bundle X" lineage queries. |
| **Operator-secrets guidance** | Three categories handled distinctly: **(a) Runtime credentials** (wallet keys, API tokens, `JINN_PASSWORD`) **never** enter source — host uses encrypted keystore + `env/` at mode 0600 excluded from tarballs (`packaging.ts:151`); TEE uses enclave-sealed storage (KMS attestation-gated or measurement-bound sealed keys); source references `process.env.*` or sealed-store reads, never literal values. **(b) Proprietary IP** (prompts, strategies, thresholds) lives in source — operator chooses: publish (required for `attested`) or run at lower tier (declared `bundleCid` but non-public). **(c) Environmental context** (Safe address, RPC, venue account) in operator-local config, not source. A future **V2 `config_bundle` refinement** (deferred) could split public source + separately-measured (optionally encrypted) config to let operators keep IP private at attested tier — documented as a direction, not V1 scope. |
| **TEE ↔ trajectory binding** | Binding is **not automatic** from "ran in TEE" or "uploaded from enclave." The trajectory digest (or CID) is included in the attestation `REPORTDATA` and/or enclave-signed statement so verifiers link quote → bytes. |

### 3.3 Discovery / storage

| Topic | Decision |
|--------|-----------|
| **Tamper-evidence for stored artifacts (V1)** | **Signed envelope + digest + on-chain `evidenceHash`** (existing pattern). IPFS provides integrity for a **known CID**; the envelope / commitment binds **which CID** is canonical for a run. |
| **ERC-8004 three-registry separation (K8, D3d)** | The client currently uses only the **Identity Registry**. V1 scope wires all three: **(a) Identity Registry** adds `adw:Intent`, `adw:ExecutionEnvelope`, `adw:SourceBundle` entity kinds alongside existing `adw:AgentCard`, `adw:Artifact` (with `parentEnvelopeCid` added to artifact metadata). Attestation evidence lives on the envelope itself (`evidenceTier`, `measurement`) — **not** a separate "attestation field" in the registry. **(b) Validation Registry** hosts challenger verifications — a `validationRequest` ("re-verify this envelope's attestation + reproducible build") and `validationResponse` with the verdict. **(c) Reputation Registry** aggregates operator-level signals (including emergent attestation-track-record: "% of envelopes from Safe X that have been challenger-verified as attested"). Reputation is emergent, not hand-written. |
| **Envelope registration on ERC-8004** | Every published envelope gets registered on the Identity Registry with metadata `{documentType: 'adw:ExecutionEnvelope', kind, role, evidenceTier, intentCid, parentEnvelopeCid?, measurement?, participant, generatedAt}`. Gas cost: 5–10k per envelope at current field count; acceptable at Phase 1b scale. Design spec may trim metadata density if mainnet scale demands it. |
| **Subgraph knowledge graph** | Subgraph projects on-chain entities into queryable types: `Intent`, `ExecutionEnvelope`, `Artifact`, `SourceBundle`, `Agent` (node), plus a synthetic **`KnowledgeTree`** rooted at an intent and joining all envelopes by `intent.cid` (restorations) or `payload.restorationEnvelope.cid` (verdicts). Unlocks: "attested restorations for kind X in window T," "verdicts for this restoration," "all envelopes running source bundle Y," "full tree for intent Z." |
| **Trajectory content indexing** | The subgraph indexes envelope / artifact / trajectory *metadata* (CIDs, sha256, roles). **Queries over trajectory content** ("spans where model = claude-opus-4-7") are out of scope for V1 — require a separate off-chain indexer walking IPFS blobs; deferred to a buyer-side or V2 service. |
| **Evaluator substrate (V2b)** | **Default is same-TEE-substrate evaluator:** verdict envelopes carry their own attestation quote binding evaluator measurement to inputs (restoration envelope hash, venue snapshot, spec, scoring params) and outputs (verdict, score, checks). Dual-substrate (parallel zk proving pipeline for evaluator) deferred as a V3-insurance path per research doc §V2b. |

### 3.4 Lifecycle

| Topic | Decision |
|--------|-----------|
| **Canonical JSON (D2)** | Normatively use **RFC 8785 JCS** for envelope signing input. Swap `client/src/restorer/engine/canonical-json.ts` (≈JCS-equivalent today) for a standard JCS library (e.g. `canonicalize` on npm) during the one-shot cutover. Rationale: third-party verifiers (frontier labs, challenger tooling) can use any off-the-shelf JCS library without reimplementing Jinn-specific rules. Migration cost is ~10 lines; no risk of silent divergence on number-formatting edge cases between Jinn's impl and JCS. |
| **Ship order (D1)** | **(A) Envelope + trajectory first, TEE at V2.** Rationale: TEE work depends on the envelope (attestation `REPORTDATA` binds envelope hash; source bundle needs a schema; trajectory must be schema-valid for "attested trajectory" to mean anything). Shipping (A) unblocks `self-signed` + `committed` tiers immediately and lets Phase 1b operators start producing uniform-schema trajectories the day it lands. Optional: in parallel with (A), a narrow 1–2 week Phala spike against a minimal echo-executor to validate reproducible-build tooling + REPORTDATA binding + Phala Dstack quote shape before the full TEE integration lands — de-risks the hard parts without blocking envelope work. |
| **First TEE target (D4)** | **Phala Dstack** (TDX + DCAP under Phala's protocol identity layer). Rationale: (i) aligns with the diverse-decentralized-executor thesis (not AWS-dependent); (ii) managed TEE lifecycle reduces operator DevOps burden; (iii) Phala-native on-chain verification exists (see attestation-verification row for why V2 doesn't consume it by default). Attestation `profile` string reflects the Phala layer; verifiers must understand both Phala's protocol identity and the underlying TDX quote. Trust surface includes Phala as an entity in addition to Intel TDX roots + operator source honesty — V3 "trust diversification" can add self-hosted TDX (automata-dcap) or Nitro as alternate profiles. Reproducible-build workstream is language-level, not TEE-level — Phala doesn't let us skip Node/TS reproducibility. |
| **Attestation verification (V2)** | **Hybrid.** **Default flow: off-chain.** Ship a published TS SDK that takes `(envelope, attestationQuote)` → `{valid, measurement, reportData}`. Any buyer / verifier / challenger runs it locally; milliseconds, no gas. **On-chain record of challenger verifications** via ERC-8004 Validation Registry — `validationRequest` from a challenger, `validationResponse` with their off-chain-computed verdict, on-chain and slashable. **Envelope schema keeps attestation bytes in a Solidity-verifier-consumable shape** so a DCAP+Phala verifier contract on Base can be deployed later (V3+) without schema change. Full on-chain verification for every envelope is **not V2**: DCAP quote verification costs ~500k–2M gas per quote, prohibitive per-envelope at realistic mainnet scale, and bridging Phala's on-chain verifier to Base is non-trivial infra. Off-chain SDK verification delivers the same trust guarantee (quote verification is stateless + deterministic; anyone can reproduce it). On-chain verification at V3+ when a DeFi consumer justifies the gas. |
| **Verification topology (who runs the SDK)** | **Jinn-the-protocol operates no verification infrastructure.** The off-chain SDK is a shared library; participants load it into their own processes based on incentive: **buyers** on ingestion (filter corpus to attested); **evaluators** before producing verdicts (required — see next row); **challengers** opportunistically (fraud-hunting for stake reward); **indexers / catalogs** during indexing (derived `verifiedTier` field surfaced to downstream buyers); **operator clients** optionally during peer-sync. Trust chain: cryptography + SDK correctness + challenger incentive + reputation economics — not Jinn infrastructure. Distributed self-service verification works because attestation verification is stateless and deterministic: every verifier running the SDK gets the same answer. |
| **Evaluator verification on critical path** | **Evaluators MUST verify the restoration envelope's attestation before producing a verdict.** Verdict envelope payload carries the verification result: `verificationOfRestoration: { sdkVersion, timestamp, valid, measurement, failureReason? }`. If verification fails, the evaluator produces a `REJECTED` verdict citing the attestation failure (not a scoring verdict). This puts attestation verification on the Jinn loop's critical path without centralizing it — every restoration→verdict pair carries its own verification record, produced by whoever runs the evaluator. Same-TEE-substrate evaluator (§V2b) fetches the SDK as part of its own measured image, so the verification itself is attested. |
| **Migration** | **One-shot cutover** in Phase 1b. `jinn.execution.v1` replaces `portfolio.v0.manifest.v1`, `.eval.manifest.v1`, `prediction.v0.submission.v1` / `.verdict.v1`, and `prediction.apy.v0.submission.v1` / `.verdict.v1` in a single pass. `DesiredState` formalizes to `intent.v1`. Artifact entries rename `role` → `artifactType`. Canonical-JSON impl swaps to JCS. Old schemas deleted; **no back-compat shims, no dual-write, no feature flags.** `JinnRouter.claimDelivery(evidenceHash)` is opaque `bytes32` — **no contract change** (evidenceHash = envelope canonical hash under JCS). Testnet dogfood data pre-v1 is disposable. |
| **Optional rigor (deferred)** | **SCITT** transparency services, standalone transparency logs, **DSSE / in-toto** envelopes, **C2PA** — out of scope for V1. Rationale: `evidenceHash` on-chain already provides Jinn's tamper-evidence. These standards become relevant **only** if Jinn later needs third-party-verifier interop without Jinn-specific verifier code. |

## 4. In scope for the **next** design deliverable

The full design spec (separate doc) should cover:

1. **`intent.v1` schema** — Concrete field list (see §3.1 K2); canonical JSON shape; migration of `DesiredState` consumers to the new type.

2. **`jinn.execution.v1` schema** — Concrete field list: `schemaVersion`, `kind`, `role` (restoration | verdict), `generatedAt`, `intent`, `participant`, `window`, `executor` (incl. `signingKey`, `source`), `evidenceTier`, `attestation` (nullable), `trajectory` (required per §2.5, with optional access/encryption blocks — shape pending D8), `artifacts[]` (each with `artifactType`, `cid`, `sha256`, optional metadata), kind-/role-typed `payload`, `signature`. Signing input normatively uses **RFC 8785 JCS** (D2). Verdict payload includes `restorationEnvelope: { cid, sha256 }` AND `verificationOfRestoration: { sdkVersion, timestamp, valid, measurement, failureReason? }` (see §3.3 evaluator-critical-path row).

3. **`jinn.trajectory.v1` profile** — OTLP-JSON constraints, required attributes per `jinn.span.kind`, minimum coverage thresholds, conformance test obligations. Trajectory↔artifact linkage (span attribute `jinn.artifact.cid` + artifact metadata `producedBy`). Attested-tier additions for TLS-transcript CIDs inside LLM / venue spans. Max size / chunking guidance even under one-shot signing.

4. **Artifact-type vocabulary specification** — Required `artifactType` values (`trajectory`, `system_snapshot`, `output.<kind>`), reserved standard types with their semantic contracts (what `code_patch` / `research_note` / `promotion_record` etc. mean and what metadata each should carry), custom-type conventions, clarification that `session_transcript` and `trajectory` are complementary (not overlapping).

5. **TEE integration (phased)** — Target platform: **Phala Dstack** (D4). Deployment shape (Docker image → Phala-managed enclave), key sealing / execution-signing-key lifecycle, quote verification path. **V2 verification is hybrid per §3.3**: off-chain SDK by default, Validation Registry records challenger verifications on-chain, envelope schema keeps attestation consumable by a future on-chain verifier. Design spec specifies: the TS verification SDK (inputs, outputs, error modes), the Validation Registry request/response shape for attestation challenges, and the envelope field layout that a Solidity verifier would consume. Explicit binding of envelope hash to attestation `REPORTDATA` per §3.

6. **Operator-declared builds + reproducibility tooling** — Reproducible image from published source is the gate for `attested`. **For Node.js / TypeScript operators specifically**, this is a multi-week workstream (lockfile-only installs, native-module determinism, `SOURCE_DATE_EPOCH`, tarball ordering, base-image digest pinning); design spec must call out tooling choice (Nix / buildkit / Bazel) and the **challenger-side rebuild pipeline** (fetch `bundleCid` → rebuild → compare measurement). Challenger narrative: "does published source honestly emit `jinn.trajectory.v1`?"

7. **Evaluator alignment** — Verdict envelopes carry attestation where applicable (per §3 V2b). Same-TEE-substrate is the default path. Note: research doc calls the evaluator a "deterministic kernel," but `portfolio-v0-evaluator` also re-fetches live venue state — design spec should be precise that **TEE attests the full I/O-bound evaluator process**; a potential future zk-insurance path would prove only the scoring function over recorded inputs.

8. **Evidence tier machine-checkable rules** — `self-signed`, `committed`, `attested`, `consensus`, `proved` — what the manifest-validation layer checks for each. Tier is a credibility weight on uniform-schema content (§2.5).

9. **ERC-8004 registration + subgraph schema** — Full GraphQL schema for `Intent`, `ExecutionEnvelope`, `Artifact`, `SourceBundle`, `Agent`, synthetic `KnowledgeTree`. Identity Registry metadata tuples per entity kind. Validation Registry request/response shapes for challenger verifications of attestation + reproducibility. Reputation Registry aggregation pattern (emergent attestation-track-record per operator).

10. **Conformance test suite** — A harness operators run against their executor to confirm envelope schema, trajectory span profile, artifact roles, and attestation binding. Ships concurrent with the design spec, not after.

11. **Migration execution plan** — Concrete file-by-file cutover: type-file deletions and replacements, `manifest-assembly.ts` refactor, restorer / evaluator impl updates, `DesiredState` → `intent.v1` migration, 8004 registration extensions, subgraph redeployment, test-fixture regeneration. One-shot per §3; no compatibility paths.

12. **Interaction with default learning restorer** — Its promotion gate mutates `implStateDir` mid-run. TEE measurement covers the *starting* binary; trajectory must capture every promotion transition via `promotion_record` artifacts + span events, or `implStateDir` must live outside the measured surface. Design spec resolves.

13. **Canonical training-record extractor** — A companion (non-normative) library: "given a knowledge tree, extract standard training records." Optional but high-leverage for buyer adoption. Prevents each frontier lab from reinventing extraction.

14. **Non-goals** — No zk proof of unconstrained agents; no full solution for provider model-honesty without upstream cooperation (TLS transcripts, TLSNotary, future signed responses only as mitigations).

**Artifacts the design spec should include** (from the epic): example JSON for each `(kind, role)` pair, verification pseudocode, sequence diagram (operator → enclave → IPFS → chain → buyer), knowledge-tree diagram rooted at intent, phased rollout recommendation, backlog split (e.g. "reference Nitro path" vs "schema generalization" vs "subgraph schema" vs "x402/8004 refactors").

## 5. Explicitly out of scope (this epic / V1)

- **SCITT architecture end-to-end** (Issuer / Transparency Service / Receipts) as a **requirement** for shipping trajectory storage.
- **Sigstore Rekor**, **hosted SCITT TS**, or **custom Merkle transparency log** unless we later add a dedicated "interop" milestone.
- **C2PA** for non-media agent traces (unless we explicitly decide media artifacts need it).
- **Back-compat manifest versioning** — one-shot migration per §3, not a versioning scheme across historical schemas.
- **Streaming / partial-run trajectory signing** — V1 is end-of-run one-shot per §3.
- **Enclave-direct on-chain signing** — V2 is host-mediated per §3.
- **Dual-substrate evaluator** (parallel zk proving pipeline) — V2b is same-TEE-substrate per §3.
- **Trajectory content indexing** (querying over span content) — V1 indexes metadata only; content-level indexing is a buyer-side or V2 service.
- **`did:*` identity layer** — deferred to V3 if a concrete need appears.

## 6. Open decisions (must be resolved in the design spec)

| ID | Question | Notes |
|----|-----------|--------|
| **D8** | **Trajectory / verdict / artifact access + gating + redaction + protocol monetization** | Three candidate access models (open / x402-pinned-plaintext / x402-encrypted-at-rest); per-item pricing enforcement (current handler is flat); closing the "free route always exists" gap; evaluator access policy for gated content; normative redaction allowlist at `attested` tier; verdict envelope gating defaults; triple-as-bundle x402 fetch primitive; protocol fee-split (operator / evaluator / Treasury / challenge pool) on x402 payments. **Reserved for separate discussion** — does not block the envelope / knowledge-graph design. |

**Resolved since v0.1** (all documented in §3):

- **D3a** — manifest signing identity (single field, two kinds)
- **D3b** — operator-level identity (Safe address)
- **D3c** — source-code identity (`executor.source` IPFS bundle)
- **D1** — ship order (envelope + trajectory first; optional parallel Phala spike)
- **D2** — canonical JSON (RFC 8785 JCS)
- **D3d** — ERC-8004 three-registry separation (Identity / Validation / Reputation)
- **D4** — first TEE target (Phala Dstack)
- **Attestation verification** — hybrid: off-chain SDK default + Validation Registry records + schema-ready for future on-chain verifier
- **Verification topology** — Jinn operates no verifier infrastructure; verification is distributed self-service via the SDK; evaluator verification is the critical-path anchor
- **D5** — envelope vs envelope+verdict (single envelope, role-discriminated)
- **D6** — enclave-direct vs host-mediated signing (host-mediated)
- **K1–K9** — full knowledge-data-model decisions (see §3.1–§3.3)
- Trajectory signing granularity for V1 (one-shot end-of-run)
- Migration approach (one-shot cutover, no shims)
- Evaluator substrate for V2b (same-TEE default)
- **Uniform-schema principle** (§2.5): all operators produce the same schema at every tier; only `attestation` field and TLS-transcript CIDs differ.
- **Schema uniformity ≠ verifiability uniformity** (§2.5 amendment): attested tier requires `source.bundleCid` to be publicly fetchable + reproducibly buildable; lower tiers declare the CID but fetchability is operator discretion.
- **Artifact field rename** `role` → `artifactType` (schema clarity; free rename under migration).
- **Operator-secrets guidance** (§3.2): credentials never in source; proprietary IP published at attested OR lower tier with non-public bundleCid OR future V2 `config_bundle` split.

## 7. Mini-glossary

| Term | Meaning |
|------|--------|
| **Knowledge tree** | The data structure rooted at an intent: `intent.v1` → N restoration envelopes → M verdict envelopes per restoration; each envelope has its trajectory + artifact descendants. The unit of query via subgraph. |
| **Triple** | Special case of knowledge tree: (intent, one restoration envelope, one verdict envelope). Commercial shorthand; not the data primitive. |
| **Uniform-schema principle** | §2.5: all operators at all tiers populate the same envelope and trajectory schemas. Only `attestation` and enclave-recorded TLS-transcript CIDs are tier-gated. Tier = provability, not data completeness. |
| **Job 1 (trajectory)** | *What* is logged: spans, tool calls, model calls — **OpenTelemetry** addresses this. |
| **Job 2 (tamper-evidence)** | *Whether the stored blob is the one the protocol committed to* — addressed by **signed envelope + digest + on-chain commitment** (and strengthened by **TEE binding** of that digest at attested tier). |
| **Execution envelope** | `jinn.execution.v1`. Shared shell for both restoration manifests (`role: restoration`) and verdict manifests (`role: verdict`). An evaluator is structurally an operator with a different role. |
| **Role discriminator** | The `role` field on `jinn.execution.v1` selects which payload type applies for a given `(kind, role)` pair. |
| **Source bundle** | The IPFS-pinned tarball of operator source + build recipe + pinned deps. Referenced from `executor.source.bundleCid`; registered once per release on ERC-8004 as `adw:SourceBundle`; enables "envelopes running bundle X" lineage queries. Field declared at all tiers; public + reproducibly-buildable only required at `attested`. |
| **Code digest** | sha256 of the **compiled** bundle the operator is running (e.g. built JS + resolved `node_modules`). Contrast with source bundle (hash of **source input** + recipe). Reproducible build: `build(bundleCid) → codeDigest` deterministically. At attested tier, `codeDigest` is implied by the TEE measurement. |
| **Measurement** | The value a TEE attestation quote declares as the identity of code running inside the enclave. Form is TEE-specific: PCRs (Nitro), MRTD+RTMRs (TDX), launch measurement (SEV-SNP). Challengers reproduce it by rebuilding `executor.source.bundleCid`. Non-TEE operators declare an expected measurement too — they just can't prove it at runtime. |
| **JCS** | **RFC 8785 JSON Canonicalization Scheme** — IETF standard for deterministic JSON serialization (lexicographic key sort, I-JSON number rules, no whitespace). Normatively required for `jinn.execution.v1` signing input (D2). Max third-party-verifier interop: any standard JCS library works. |
| **`artifactType`** | Field on envelope `artifacts[]` entries (renamed from `role` in v0.4) declaring what kind of output an artifact is. Drawn from required (`trajectory`, `system_snapshot`, `output.<kind>`), reserved standard (`design_document`, `session_transcript`, `runtime_log`, `code_patch`, `research_note`, `skill_bundle`, `mcp_config`, `promotion_record`, `source_bundle`), or custom values. |
| **`session_transcript` vs `trajectory`** | Complementary, not overlapping. `session_transcript` = raw unstructured LLM conversation log (today written to `sessions/`). `trajectory` = structured OTLP-JSON `jinn.trajectory.v1` blob with normative span profile. Trajectory spans (`jinn.llm_call` kind) may reference `session_transcript` artifacts by CID for the raw bytes. |
| **Host-mediated signing** | TEE integration pattern where the enclave signs the envelope with an enclave-bound execution-signing key, and the host retains the durable agent EOA to submit `claimDelivery` on-chain. |
| **Execution-signing key** | The enclave-bound keypair used to sign an `attested`-tier envelope. Distinct from the agent EOA. Publicly bound to measurement via attestation `REPORTDATA`. |
| **Measurement** | A hash of the code actually running inside the enclave. The attestation quote declares it; challengers reproduce it by rebuilding `executor.source.bundleCid`. Non-TEE operators still declare an expected measurement — they just can't prove it at runtime. |
| **EAT** | IETF **Entity Attestation Token** — vendor-agnostic framing for TEE quotes / evidence; informs the `attestation` field shape. |
| **ERC-8004 three registries** | (a) **Identity Registry** — what is this entity (agent, intent, envelope, artifact, source bundle). (b) **Validation Registry** — request/response for verification events (e.g. challenger re-verifies attestation). (c) **Reputation Registry** — aggregated signals on operators (emergent, not hand-edited). |
| **Phala Dstack** | The TEE substrate selected for V2 (D4). TDX hardware + DCAP attestation under Phala's protocol-level identity layer. Exposes on-chain attestation verification as a primitive; operates as a decentralized network rather than cloud-provider-specific. Trust surface includes Intel TDX roots + Phala protocol + operator source honesty. Design spec: EAT `profile` string reflects the Phala layer; verifiers understand both Phala's protocol identity and the underlying TDX quote. |
| **SCITT / Transparency Service** | IETF **supply-chain** pattern: log **signed statements**, issue **receipts**. Useful **later** for third-party verifiers; **not** required for Jinn V1 trajectory storage. |
| **DSSE / in-toto** | Standard **signing envelopes** for attestations; optional future interop, not core to V1. |

## 8. Success criteria for the follow-on design spec

- A reader can implement **`intent.v1`**, **`jinn.execution.v1`** (both roles), and **`jinn.trajectory.v1`** without reading the beads thread or this scope doc.
- The **uniform-schema principle** is demonstrably applied: every field list states "required at all tiers" unless explicitly justified as a TEE-capability exception.
- Verifiers can check **`self-signed`** and **`committed`** tiers with written steps using only envelope + on-chain `evidenceHash`.
- **`attested`** tier has a clear **checklist** (quote, binding digest, reproducible build, OTel profile conformance, source-bundle match).
- **ERC-8004** wiring is explicit across all three registries (Identity / Validation / Reputation); subgraph schema compiles against the design.
- **Migration** is a concrete, executable plan — not "future work."
- **Conformance suite** ships with the design, not after.
- **x402 / access / gating / monetization** (D8) will require a separate design pass — the envelope must accommodate it without re-design.

---

*End of scope doc. Full design: create `2026-04-24-jinn-execution-envelope-tee-design.md` (or later) once D8 is resolved (or explicitly scoped out into a sibling epic).*
