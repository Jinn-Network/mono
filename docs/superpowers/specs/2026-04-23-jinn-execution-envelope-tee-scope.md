# Execution envelope + trajectory + TEE — **Scope** (pre-design)

**Version:** 0.1 (scope only — not a full design spec)  
**Date:** 2026-04-23  
**Status:** scope locked for follow-on design work  
**Beads:** `jinn-mono-38o` (epic: execution envelope + TEE integration)  
**Related:**

- `docs/research/2026-04-23-verifiability-traceability.md` — outcome vs trajectory, evidence tiers, non-goals
- `spec/2026-04-21-agentic-data-substrate.md` — substrate thesis; tier as buyer signal
- `spec/2026-03-23-jinn-implementation-spec-proposal.md` — §4.2 ERC-8004, §4.3 x402
- `client/src/types/portfolio.ts` — current `portfolio.v0` manifest schemas
- `client/src/restorer/engine/` — packaging, manifest assembly, signing, `evidenceHash` path
- `client/src/x402/` — payment-gated artifacts

## 1. Purpose of this document

The epic asks for a full **design** (schemas, verification split, TEE path, tiers). Conversation drifted into **optional** cross-ecosystem standards (SCITT transparency services, DSSE, etc.). This file **narrows scope**: what we are designing **now**, what is **already decided at a high level**, what is **explicitly deferred**, and what **must still be decided** before writing the full design spec.

## 2. Problem statement (one paragraph)

Jinn already packages `portfolio.v0` runs as signed manifests, IPFS artifacts, and on-chain `evidenceHash` commitments. The network’s long-term product is **trajectory-shaped training data**, not only outcome correctness. We need a **protocol-level execution envelope** that works across intent kinds, composes with **x402** (paid artifact fetch) and **ERC-8004-style discovery**, and reserves a path to an **attested** tier where a TEE binds *declared code* to *what ran*. The full design must stay honest about **two verifiability questions**: outcome (re-derivable per kind) vs trajectory (only provable at production time for training-grade claims).

## 3. Decisions already made (for the follow-on design)

These are **directional** commitments for the design doc; details (field lists, examples) come next.

| Topic | Decision |
|--------|-----------|
| **Trajectory content (`jinn.trajectory.v1`)** | Use **OpenTelemetry** — traces in **OTLP-JSON**, with **GenAI** and **MCP** semantic conventions where applicable. No bespoke event vocabulary for core spans. |
| **Attestation field** | Shape aligns with **RATS EAT** thinking: **generic outer** + **profile** string (vendor/TEE-specific evidence inside). First concrete profile can target one stack (e.g. Nitro); the field must not hard-code a single vendor forever. |
| **Tamper-evidence for stored artifacts (V1)** | **Signed manifest + digest + on-chain `evidenceHash`** (existing pattern). **IPFS** provides integrity **for a known CID**; the manifest/commitment binds **which CID** is canonical for a run. |
| **TEE vs trajectory binding** | Binding is **not automatic** from “ran in TEE” or “uploaded from enclave.” The design must specify how **trajectory digest or CID** is included in **attestation `REPORTDATA` and/or enclave-signed statement** so verifiers link quote → bytes. |
| **Optional rigor (deferred)** | **SCITT**, standalone **transparency services**, **DSSE/in-toto** envelopes around the trajectory — **out of scope for V1 design** unless a later revision explicitly reopens “third-party verifier interop without Jinn-specific code.” |

## 4. In scope for the **next** design deliverable

The full design spec (separate doc) should cover:

1. **`jinn.execution.v1` (name TBD)** — Generic shell factored out of `portfolio.v0.manifest.v1` / verdict manifests: provenance, participant, window, executor metadata, `evidenceTier`, **`attestation`** (nullable), **`trajectory`** reference (CID + digest + optional inline hints), artifacts (open vs **x402-gated**), kind-specific **`payload`**, signature / hash rules (including **JCS** or equivalent deterministic JSON if we normatively require it).
2. **`jinn.trajectory.v1`** — Profile doc: OTLP-JSON constraints, required span kinds/attributes for Jinn grading, minimum coverage for `self-signed` vs `attested`, how the blob is hashed and referenced from the envelope, max size / chunking if needed.
3. **TEE integration (phased)** — First target platform (e.g. Nitro vs TDX vs Phala), deployment shape (image → enclave), key handling, quote verification (off-chain vs on-chain), what lands on-chain vs IPFS-only; **explicit** binding of trajectory digest to attestation.
4. **Operator-declared builds** — Reproducible image from published source as the gate for **`attested`**; challenger/audit narrative (“does source honestly emit OTel?”).
5. **Evaluator alignment** — Verdict manifests reference execution attestation where applicable; optional same-TEE-substrate evaluator (per research doc); not zkVM in this epic.
6. **Evidence tiers** — Machine-checkable rules for at least `self-signed`, `committed`, and schema hooks for `consensus` / `attested` / `proved`; how discovery/subgraph surfaces tier (as far as this epic needs).
7. **Non-goals** — No zk proof of unconstrained agents; no full solution for provider model-honesty without upstream cooperation (TLS transcripts, TLSNotary, future signed responses only as mitigations).

**Artifacts the design spec should include** (from the epic): example JSON, verification pseudocode, sequence diagram (operator → enclave → IPFS → chain → buyer), phased rollout recommendation, backlog split (e.g. “reference Nitro path” vs “schema generalization”).

## 5. Explicitly out of scope (this epic / V1)

- **SCITT architecture end-to-end** (Issuer / Transparency Service / Receipts) as a **requirement** for shipping trajectory storage.
- **Sigstore Rekor**, **hosted SCITT TS**, or **custom Merkle transparency log** unless we later add a dedicated “interop” milestone.
- **C2PA** for non-media agent traces (unless we explicitly decide media artifacts need it).
- **New issue tracker** or migration away from current manifest versions beyond what `jinn.execution.v1` defines.

## 6. Open decisions (must be resolved in the design spec)

| ID | Question | Notes |
|----|-----------|--------|
| **D1** | **Ship order:** envelope + trajectory first **(A)**, or TEE on `portfolio.v0` first **(B)**? | Epic opening question; scopes engineering sequence. |
| **D2** | **Canonical serialization** | Whether `jinn.execution.v1` normatively requires **JCS (RFC 8785)** for signing input, or keeps today’s repo-specific canonical JSON with a migration note. |
| **D3** | **Issuer / identity** in attestation and manifests | How `agentEoa` / Safe / `did:*` / x509 relate for `attested` verification. |
| **D4** | **First TEE target** | Nitro vs TDX vs Phala — pick one for “reference client” path in the design. |

## 7. Mini-glossary (terms that came up in discussion)

| Term | Meaning |
|------|--------|
| **Job 1 (trajectory)** | *What* is logged: spans, tool calls, model calls — **OpenTelemetry** addresses this. |
| **Job 2 (tamper-evidence)** | *Whether the stored blob is the one the protocol committed to* — addressed by **signed envelope + digest + on-chain commitment** (and strengthened by **TEE binding** of that digest). **IPFS** gives integrity for a **known** CID, not which CID is official without that binding. |
| **EAT** | IETF **Entity Attestation Token** — vendor-agnostic framing for TEE quotes / evidence; informs the **`attestation`** field shape. |
| **SCITT / Transparency Service** | IETF **supply-chain** pattern: log **signed statements**, issue **receipts**. Useful **later** for third-party verifiers; **not** required for Jinn V1 trajectory storage. |
| **DSSE / in-toto** | Standard **signing envelopes** for attestations; optional future interop, not core to V1. |

## 8. Success criteria for the follow-on design spec

- A reader can implement **`jinn.execution.v1`** and **`jinn.trajectory.v1`** without reading the beads thread.
- Verifiers can check **`self-signed`** and **`committed`** tiers with written steps.
- **`attested`** tier has a clear **checklist** (quote, binding digest, reproducible build, OTel profile).
- **x402** and **ERC-8004** hooks are called out where they touch artifact entries or discovery, not as parallel ad-hoc fields.

---

*End of scope doc. Full design: create `2026-04-23-jinn-execution-envelope-tee-design.md` (or successor date) after D1–D4 are resolved.*
