# Execution envelope + trajectory + TEE — **Scope** (pre-design)

**Version:** 0.2 (scope — expanded from v0.1 via design discussion)  
**Date:** 2026-04-24  
**Status:** scope locked for follow-on design work (open decisions in §6)  
**Beads:** `jinn-mono-38o` (epic: execution envelope + TEE integration)  
**Related:**

- `docs/research/2026-04-23-verifiability-traceability.md` — outcome vs trajectory, evidence tiers, non-goals
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` — default restorer whose OTel emission drives the trajectory profile; its promotion gate interacts with attested-tier measurement (TEE measures the *starting* binary, not post-promotion state)
- `spec/2026-04-21-agentic-data-substrate.md` — substrate thesis; the commercial unit is the triple (intent, execution, verdict)
- `spec/2026-03-23-jinn-implementation-spec-proposal.md` — §4.2 ERC-8004, §4.3 x402
- `client/src/types/portfolio.ts` — current `portfolio.v0` manifest schemas (restoration + verdict)
- `client/src/types/prediction.ts`, `client/src/types/prediction-apy.ts` — parallel patterns for other kinds
- `client/src/restorer/engine/` — packaging, manifest assembly, signing, `evidenceHash` path
- `client/src/x402/` — payment-gated artifacts

## Changes since v0.1

Design discussion locked seven directional decisions that were open in v0.1 (now in §3); split the original D3 into four sub-decisions (D3a–c resolved; D3d deferred for further discussion); added a new open-decision area D8 (trajectory / verdict access + gating + redaction) that requires separate discussion before the design spec.

## 1. Purpose of this document

The epic asks for a full **design** (schemas, verification split, TEE path, tiers). Conversation drifted into **optional** cross-ecosystem standards (SCITT transparency services, DSSE, etc.). This file **narrows scope**: what we are designing **now**, what is **already decided at a high level**, what is **explicitly deferred**, and what **must still be decided** before writing the full design spec.

## 2. Problem statement (one paragraph)

Jinn already packages `portfolio.v0` runs as signed manifests, IPFS artifacts, and on-chain `evidenceHash` commitments. The network's long-term product is **trajectory-shaped training data** — specifically the **triple** of intent (objective), execution (what happened), and verdict (evaluation / reward signal), not any one piece alone. We need a **protocol-level execution envelope** that works across intent kinds, composes with **x402** (paid artifact fetch) and **ERC-8004-style discovery**, and reserves a path to an **attested** tier where a TEE binds *declared code* to *what ran*. The full design must stay honest about **two verifiability questions**: outcome (re-derivable per kind) vs trajectory (only provable at production time for training-grade claims).

## 3. Decisions already made (for the follow-on design)

These are **directional** commitments for the design doc; field-level details come next.

| Topic | Decision |
|--------|-----------|
| **Envelope shape** | Single `jinn.execution.v1` envelope with `role: "restoration" \| "verdict"` discriminator. Payload is typed per `(kind, role)`. A verdict is structurally an execution of the evaluator kernel over the restoration manifest: different producer, different payload, same envelope. Attestation, trajectory, and evidence-tier fields live on the envelope and apply to both roles. Verdict payload carries a reference back to the restoration envelope (`restorationEnvelope: { cid, sha256 }`). |
| **Trajectory content (`jinn.trajectory.v1`)** | Use **OpenTelemetry** — traces in **OTLP-JSON**, with **GenAI** and **MCP** semantic conventions where applicable. No bespoke event vocabulary for core spans. |
| **Trajectory signing granularity (V1)** | **End-of-run one-shot signing.** OTLP-JSON is serialized at run completion, hashed, signed, uploaded as a single IPFS object. A crashed run loses the trajectory — acceptable at Phase 1b where outcomes from crashed runs are already lost. Partial / streamed / append-signed trajectories are explicitly V2+. |
| **Attestation field** | Shape aligns with **RATS EAT**: generic outer + `profile` string (vendor/TEE-specific evidence inside). First concrete profile targets a single stack (see D4); the field must not hard-code a single vendor forever. |
| **Signing chain (TEE tier, V2)** | **Host-mediated.** Enclave holds a sealed, measurement-bound **execution-signing key** that signs the envelope. Attestation quote's `REPORTDATA` binds `(measurement, execPubkey, envelopeHash)`. **Host** retains the durable agent EOA / Safe / OLAS infra and submits `claimDelivery(evidenceHash = envelopeHash)` on-chain. Earning bootstrap is unchanged. Enclave-direct on-chain signing deferred to a future revision. |
| **Manifest signing key (D3a)** | `signature.signer` is a single field. Kind is declared on `executor.signingKey.kind`: `agent-eoa` for `self-signed` / `committed` tiers (today's pattern) or `enclave-bound` for `attested` tier (the key from the Signing-Chain decision above). No schema bifurcation. |
| **Operator identity (D3b)** | `participant.safeAddress` is the canonical operator ID. It's already the on-chain anchor for staking, rewards, mech service, and ERC-8004-style discovery. `agentEoa` is signing / session identity. `did:*` identity deferred to V3 if a concrete need appears. |
| **Source-code identity (D3c)** | `executor.source = { bundleCid, sha256, humanUrl?, buildRecipe, measurement }`. IPFS bundle is authoritative (GitHub can rug commits); `humanUrl` is debuggability only. Attestation check: `rebuild(bundleCid) ⇒ measurement` and `quote.measurement == executor.source.measurement`. |
| **Tamper-evidence for stored artifacts (V1)** | **Signed envelope + digest + on-chain `evidenceHash`** (existing pattern). IPFS provides integrity **for a known CID**; the envelope / commitment binds **which CID** is canonical for a run. |
| **TEE ↔ trajectory binding** | Binding is **not automatic** from "ran in TEE" or "uploaded from enclave." The trajectory digest (or CID) is included in the attestation `REPORTDATA` and/or enclave-signed statement so verifiers link quote → bytes. |
| **Evaluator substrate (V2b)** | **Default is same-TEE-substrate evaluator:** verdict envelopes carry their own attestation quote binding evaluator measurement to inputs (restoration envelope hash, venue snapshot, spec, scoring params) and outputs (verdict, score, checks). Dual-substrate (parallel zk proving pipeline for evaluator) is deferred as a V3-insurance path per research doc §V2b. |
| **Migration** | **One-shot cutover** in Phase 1b. `jinn.execution.v1` replaces `portfolio.v0.manifest.v1`, `portfolio.v0.eval.manifest.v1`, `prediction.v0.submission.v1` / `.verdict.v1`, and `prediction.apy.v0.submission.v1` / `.verdict.v1` in a single pass. Old schemas deleted; **no back-compat shims, no dual-write, no feature flags.** `JinnRouter.claimDelivery(evidenceHash)` is already opaque `bytes32` — **no contract change** (evidenceHash = envelope canonical hash). Testnet dogfood data from the pre-v1 era is disposable. |
| **Optional rigor (deferred)** | **SCITT** transparency services, standalone transparency logs, **DSSE / in-toto** envelopes, **C2PA** — out of scope for V1. Rationale: `evidenceHash` on-chain already provides Jinn's tamper-evidence. These standards become relevant **only** if Jinn later needs third-party-verifier interop without Jinn-specific verifier code. |

## 4. In scope for the **next** design deliverable

The full design spec (separate doc) should cover:

1. **`jinn.execution.v1` schema** — Concrete field list: `schemaVersion`, `kind`, `role`, `generatedAt`, `intent`, `participant`, `window`, `executor` (incl. `signingKey`, `source`), `evidenceTier`, `attestation` (nullable), `trajectory` (nullable, with `access` and optional `encryption` blocks — shape pending D8), `artifacts[]` (open vs x402-gated), kind-/role-typed `payload`, `signature`. Signing input normatively uses the existing canonical-JSON impl (`client/src/restorer/engine/canonical-json.ts`, already ≈JCS-equivalent; see D2). Verdict payload includes `restorationEnvelope: { cid, sha256 }`.

2. **`jinn.trajectory.v1` profile** — OTLP-JSON constraints, required span kinds / attributes for Jinn grading, minimum coverage thresholds for `self-signed` vs `attested`, how the blob is hashed and referenced from the envelope, max size / chunking considerations (even under V1 one-shot signing, the serialized blob has a ceiling). Redaction semantics are in scope but attested-tier redaction allowlist is pending D8.

3. **TEE integration (phased)** — First target platform (D4), deployment shape (image → enclave), key sealing / execution-signing-key lifecycle, quote verification path. Given Nitro is the likely first target and has no production-grade on-chain quote verifier, **V2 assumes off-chain verification**; on-chain verifier work is deferred to a platform (e.g. TDX via `automata-dcap`) where it's viable. Explicit binding of envelope hash to attestation `REPORTDATA` per §3.

4. **Operator-declared builds + reproducibility tooling** — Reproducible image from published source as the gate for `attested`. **For Node.js / TypeScript operators specifically**, this is a multi-week workstream (lockfile-only installs, native-module determinism, `SOURCE_DATE_EPOCH`, tarball ordering, base-image digest pinning); the design spec must call out tooling choice (Nix / buildkit / Bazel) and the **challenger-side rebuild pipeline** (fetch `bundleCid` → rebuild → compare measurement). Challenger narrative: "does published source honestly emit `jinn.trajectory.v1`?"

5. **Evaluator alignment** — Verdict envelopes carry attestation where applicable (per §3 V2b). Same-TEE-substrate is the default path; dual-substrate is only reconsidered under specific V3-insurance conditions. Note: the research doc calls the evaluator a "deterministic kernel," but `portfolio-v0-evaluator` also re-fetches live venue state — design spec should be precise that **TEE attests the full I/O-bound evaluator process**, while a potential future zk-insurance path would prove only the scoring function over recorded inputs.

6. **Evidence tiers** — Machine-checkable rules for `self-signed` and `committed` (V1); schema hooks present for `consensus` / `attested` / `proved` to land cleanly later. Discovery / subgraph exposes tier as a first-class filter.

7. **Conformance test suite** — A harness operators run against their executor to confirm it emits schema-valid `jinn.execution.v1`, produces spec-conformant `jinn.trajectory.v1`, binds attestation correctly, and follows redaction rules. Without this, "envelope compliance enforceable at manifest-validation layer" is aspirational. Deliverable alongside the design spec, not after.

8. **Migration execution plan** — Concrete file-by-file cutover: type-file deletions and replacements, `manifest-assembly.ts` refactor, restorer / evaluator impl updates, subgraph re-indexing, test-fixture regeneration. One-shot per §3; no compatibility paths.

9. **Interaction with default learning restorer** — Its promotion gate mutates `implStateDir` mid-run. TEE measurement covers the *starting* binary; the trajectory must capture every promotion transition, or `implStateDir` must live outside the measured surface. Design spec resolves.

10. **Non-goals** — No zk proof of unconstrained agents; no full solution for provider model-honesty without upstream cooperation (TLS transcripts, TLSNotary, future signed responses only as mitigations).

**Artifacts the design spec should include** (from the epic): example JSON for each `(kind, role)` pair, verification pseudocode, sequence diagram (operator → enclave → IPFS → chain → buyer), phased rollout recommendation, backlog split (e.g. "reference Nitro path" vs "schema generalization").

## 5. Explicitly out of scope (this epic / V1)

- **SCITT architecture end-to-end** (Issuer / Transparency Service / Receipts) as a **requirement** for shipping trajectory storage.
- **Sigstore Rekor**, **hosted SCITT TS**, or **custom Merkle transparency log** unless we later add a dedicated "interop" milestone.
- **C2PA** for non-media agent traces (unless we explicitly decide media artifacts need it).
- **Back-compat manifest versioning** — one-shot migration per §3, not a versioning scheme across historical schemas.
- **Streaming / partial-run trajectory signing** — V1 is end-of-run one-shot per §3.
- **Enclave-direct on-chain signing** — V2 is host-mediated per §3.
- **Dual-substrate evaluator** (parallel zk proving pipeline) — V2b is same-TEE-substrate per §3.

## 6. Open decisions (must be resolved in the design spec)

| ID | Question | Notes |
|----|-----------|--------|
| **D1** | **Ship order:** envelope + trajectory first **(A)**, or TEE on `portfolio.v0` first **(B)**? | Epic opening question. Research doc §V1 makes the directional case for **(A)** — land generic envelope + trajectory profile + tier grading before TEE work. Design spec should confirm (A) or explicitly push back. |
| **D2** | **Canonical serialization** | Whether `jinn.execution.v1` normatively requires **JCS (RFC 8785)**, or keeps today's `canonical-json.ts` (≈JCS-equivalent — sorted keys, unquoted bigints, `undefined` dropped) with a migration note. Low-risk either way. |
| **D3d** | **ERC-8004 discovery compatibility / subgraph projection** | How do attestation-aware queries (by measurement / tier / role) surface? Operator-by-Safe stays ERC-8004; attested-build queries live in subgraph; on-chain measurement registry deferred. **Reserved for further discussion — interacts with D8.** |
| **D4** | **First TEE target** | Nitro (fastest to ship, AWS-only, off-chain verification only) vs TDX (broader coverage, DCAP verifier path) vs Phala (opinionated on-chain integration, stateful operators). Selection constrains §4.3's on-chain verification story. |
| **D8** | **Trajectory / verdict access + gating + redaction** | Three candidate access models (open / x402-pinned-plaintext / x402-encrypted-at-rest); evaluator access policy for gated trajectories (free as part of commitment path vs pay-and-reimburse); normative redaction allowlist at `attested` tier; verdict envelope gating semantics (not public by default); "triple-as-bundle" query shape in discovery. **Reserved for further discussion — ties to §4.1 envelope access fields, §4.2 trajectory profile, and §4.6 tier rules.** |

**Resolved since v0.1** (all documented in §3):

- **D3a** — manifest signing identity (single field, two kinds)
- **D3b** — operator-level identity (Safe address)
- **D3c** — source-code identity (`executor.source` IPFS bundle)
- **D5** — envelope vs envelope+verdict (single envelope, role-discriminated)
- **D6** — enclave-direct vs host-mediated signing (host-mediated)
- Trajectory signing granularity for V1 (one-shot end-of-run)
- Migration approach (one-shot cutover, no shims)
- Evaluator substrate for V2b (same-TEE default)

## 7. Mini-glossary (terms that came up in discussion)

| Term | Meaning |
|------|--------|
| **Job 1 (trajectory)** | *What* is logged: spans, tool calls, model calls — **OpenTelemetry** addresses this. |
| **Job 2 (tamper-evidence)** | *Whether the stored blob is the one the protocol committed to* — addressed by **signed envelope + digest + on-chain commitment** (and strengthened by **TEE binding** of that digest). IPFS gives integrity for a **known** CID, not which CID is official without that binding. |
| **Triple** | The commercial unit of the substrate: `(intent, execution envelope role=restoration, execution envelope role=verdict)`. Buyers pay for bundles of triples; the envelope supports per-piece gating so bundle pricing is emergent rather than requiring a new schema object. |
| **Execution envelope** | `jinn.execution.v1`. Shared shell for both restoration manifests (`role: restoration`) and verdict manifests (`role: verdict`). An evaluator is structurally an operator with a different role. |
| **Role discriminator** | The `role` field on `jinn.execution.v1` selects which payload type applies for a given `(kind, role)` pair. E.g. `(portfolio.v0, restoration)` vs `(portfolio.v0, verdict)`. |
| **Host-mediated signing** | TEE integration pattern where the enclave signs the envelope with an enclave-bound execution-signing key, and the host retains the durable agent EOA to submit `claimDelivery` on-chain. `evidenceHash` match closes the off-chain verifier loop. |
| **Execution-signing key** | The enclave-bound keypair used to sign an `attested`-tier envelope. Distinct from the agent EOA. Publicly bound to measurement via attestation `REPORTDATA`. |
| **Measurement** | A hash of the code actually running inside the enclave (enclave image measurement, e.g. PCR values). The attestation quote declares it; challengers reproduce it by rebuilding `executor.source.bundleCid`. |
| **EAT** | IETF **Entity Attestation Token** — vendor-agnostic framing for TEE quotes / evidence; informs the **`attestation`** field shape. |
| **SCITT / Transparency Service** | IETF **supply-chain** pattern: log **signed statements**, issue **receipts**. Useful **later** for third-party verifiers; **not** required for Jinn V1 trajectory storage. |
| **DSSE / in-toto** | Standard **signing envelopes** for attestations; optional future interop, not core to V1. |

## 8. Success criteria for the follow-on design spec

- A reader can implement **`jinn.execution.v1`** (both roles) and **`jinn.trajectory.v1`** without reading the beads thread or this scope doc.
- Verifiers can check **`self-signed`** and **`committed`** tiers with written steps.
- **`attested`** tier has a clear **checklist** (quote, binding digest, reproducible build, OTel profile, conformance).
- **x402** and **ERC-8004** hooks are called out where they touch artifact entries or discovery, not as parallel ad-hoc fields (pending D3d / D8 resolution).
- **Migration** is a concrete, executable plan — not "future work."
- **Conformance suite** ships with the design, not after.

---

*End of scope doc. Full design: create `2026-04-24-jinn-execution-envelope-tee-design.md` (or later) after D1, D2, D3d, D4, D8 are resolved.*
