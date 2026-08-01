# Verified Environments and Task Supply — design

- **Version:** 0.1
- **Date:** 2026-07-31
- **Author:** design session (operator: Ritsu; coordinating agent: Claude), chartered by
  [`../prompts/2026-07-31-verified-environment-supply-design-prompt.md`](../prompts/2026-07-31-verified-environment-supply-design-prompt.md)
- **Status:** Draft for approval. Commit only on explicit operator approval.
- **Evidence base:**
  [`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md)
  (five research lanes + two market surveys) plus two Q1 lanes commissioned by this session
  (environment-attestation standards audit; in-repo environment shapes and record-kind
  precedent). Facts cited from those lanes were verified against
  `integration/evidence-v1`-derived worktree state on 2026-07-31.

## 1. What this designs, and why

Jinn's marketplace needs continuous task supply, and the purpose of that supply is not a
leaderboard — it is **verifiable graded evidence**: every attempt a solver makes against a
posted task produces a trajectory with a signed verdict, which is the data product the
whole loop exists to farm.

The research (note §5–§6) reframed where the value sits. Environment reliability is the
task-supply industry's unsolved problem (Docker build failures average 36% of
environment-construction failures; automated setup succeeds on as few as 6.7% of Python
repos; SWE-rebench ships known-issue flags rather than guarantees) and its concentrated
cost (environments sell for $20k–$300k against $200–$2,000 per task). **Nobody offers a
third-party-verifiable claim that an environment works.** Meanwhile, once an environment
does work, tasks are cheap derivatives of it, and the marketplace's own graded attempts
produce the curation signal (empirical pass rate) that labs currently pay to estimate with
private rollouts.

So this design has three layers:

1. **Verified environments** — the durable asset: a sealed description of an execution
   environment plus accumulating, independently-checkable verification attestations.
2. **Task derivation** — cheap derivatives on verified environments, admitted through
   source-agnostic differential admission.
3. **Curation from exhaust** — pass-rate projections derived from marketplace verdicts.

The center of gravity, from the charter §4: **verification is the product, not a feature of
it.** Every layer here has a well-funded non-verifiable competitor. The design succeeds when
each layer's claim is independently checkable and honestly bounded.

## 2. Session decisions and their provenance

All decisions below were made in the 2026-07-31 session, one material question at a time,
each operator-approved unless marked as a coordinator ruling.

| # | Decision | Where |
| --- | --- | --- |
| D1 | Two-artifact environment architecture: sealed description record (new tier-2 kind) + open, plural verification attestations | Q1 |
| D2 | V1 environment source is **import-only** (verify upstream's pre-built images); own construction is a named stage-2 extension | Q2 |
| D3 | Failed verifications are **published as first-class negative attestations** | Q2 |
| D4 | V1 derivation strategy is **import only**; procedural injection cut from v1 (named extension) | Q3, operator cut |
| D5 | No private evaluation material in v1; `accessClass: public` declared explicitly; no grant infrastructure | Q3 |
| D6 | **Task production and posting are separate units**; production ends at a pool of sealed pairs; a posting application consumes it | Q4, operator direction |
| D7 | The three type-only requester adapters + terms defaults are built by this program **in the marketplace binding tree** | Q4 |
| D8 | Curation projection: **specified now, minimal build in v1** | Q4 |
| D9 | Compose-don't-monolith is law; seams per §3; every rejected seam recorded | Charter §2/§4a, operator direction |
| D10 | One specification charters all units (this document), not a spec per package | Coordinator ruling under charter §3; flagged for review |
| D11 | Determinism claims are bounded ("K consecutive identical outcome-sets under controls C"), never absolute; facts not grades | Q1, audit-forced |
| D12 | License: inherited from upstream (permissive-filtered) and recorded per task as an SPDX expression | Q3 |

Carried from the predecessor charter (not reopened): the capabilities are standalone
tier-3, never daemon-embedded, outputs are sealed documents; the legacy harvest-loop is
frozen reference, superseded at a gate.

## 3. Decomposition

Per the composition law (charter §4a), the design is standalone units that combine. The
seam test: could a consumer plausibly want this piece without the others, or substitute
their own?

### 3.1 Units

| Unit | Package (working name, §15) | Tier | One job | Standalone consumer |
| --- | --- | --- | --- | --- |
| Environment record | `packages/environments/record` — `@jinn-network/environment-record` | 2 | Define, seal, parse, and validate the environment description record kind | Anyone describing an environment — including non-Jinn tools reading the published schema |
| Environment verification | `packages/environments/verification` — `@jinn-network/environment-verification` | 3 | Execute the K-run protocol against a described environment and produce a verification attestation | A lab or hub contributor attesting environments with no marketplace involvement |
| Task admission | `packages/task-supply/admission` — `@jinn-network/task-admission` | 3 | Candidate task + verified environment → differential-admission receipt | Anyone grading anything; source-agnostic |
| Task derivation | `packages/task-supply/derivation` — `@jinn-network/task-derivation` | 3 | Strategy seam: verified environment (+ strategy inputs) → admitted, sealed Task + EvaluationSpec pairs in a pool | A marketplace operator filling supply |
| Curation projection | `packages/task-supply/curation` — `@jinn-network/task-curation` | 3 | Verdict observations → per-task empirical pass rate and saturation signal | Data buyers and task selectors who never post |
| Posting application | `packages/task-supply/posting` — `@jinn-network/task-posting` | 3 (application) | Supply policy: pool of sealed pairs + terms → marketplace posts (mechanics from the work client at its mint; binding + D7 adapters interim — §8) | Any requester with sealed pairs from any source |

The tier-4 product — "the supply pipeline" — is a composition of these units plus
deployment configuration. It is not a package in this tree and is deliberately unnamed at
the protocol/application layers (tier law).

**V1 reference deployment and identity** (concluded here; mechanics owned by the
implementation plan): an operator-run pipeline. The verification capability signs
attestations with the operating party's working key (trust-layer bound); the posting
application's key is the requester of record. Daemon, hosted service, and CI are all legal
hosts, since every unit is a library with injected ports — none is privileged.
**The Jinn Plugin has no role in v1**: its parked mint extension point resolves to
*nothing, by design* for this product; a future strategy needing an in-session surface
revisits that explicitly (also stated in §12).

### 3.2 Seams considered and rejected (one line each, per charter §8.6)

- **Statement generation** — module inside future synthetic strategies, not a unit: no
  consumer wants a statement generator without a strategy producing candidates (moot in
  v1, which has no synthetic strategy).
- **The supply pool** — the derivation unit's output store (sealed pairs on disk,
  digest-addressed), not a unit: nobody consumes "a pool" apart from its contents, and its
  contents are sealed documents any store can hold.
- **The staged state machine / failure taxonomy** — not a unit: no external consumer runs
  "a state machine." Duplicated per consuming package (it is small); a shared "staged
  jobs" utility package was considered and rejected — a generic util with no domain
  identity invites grab-bag growth.
- **Import row fetching** — module inside the import strategy: fetching a HuggingFace
  dataset row is not separable from interpreting it.
- **Per-run outcome comparison** — module inside verification: comparing outcome-sets has
  no meaning outside the protocol that produced them.

### 3.3 Dependency direction

```
posting ─────────► marketplace-binding ──► task-execution protocol
derivation ──► admission ──► environments/record        │
     │              │                                    ▼
     └──────────────┴────────► environments/record ◄── profiles (references only)
verification ─► environments/record, trust/core (DSSE)
curation ─────► discovery contracts (verdict observations)
```

Conforms to the frozen direction (applications → discovery → TEP + evidence → trust).
`environments/record` depends only on zod + noble-class primitives (sealing re-implemented
locally per the per-package rule). Verification **and admission** additionally depend on
`trust/core` for DSSE (both sign). Each announced kind ships a small discovery facts-leaf
package depending on the discovery protocol + the record package, per the discovery
design's leaf pattern — those leaves are part of this program's package count. The
`profiles (references only)` arrow denotes **by-digest reference, not a package import in
either direction** — frozen profiles never imports the new trees. No unit imports another
unit's internals; admission and derivation consume `environments/record` types and digests
only. No unit imports `@jinn-network/core`, `plugin`, or `jinn-layer` (frozen trio).

Guards: each new tree (`packages/environments/`, `packages/task-supply/`) ships the guard
trio — package inventory, source-boundary allowlist, packed-types canary — and a CI
workflow, built with the packages (principles §10). Conformance kits precede
implementations (principles §9): the record package's fixtures and kit land first; the
verification and admission kits are green before derivation builds on them.

## 4. The environment description record (tier 2)

### 4.1 Identity and envelope

- **Kind URI:** `https://jinn.network/records/environment/1.0`
- **Media type:** `application/vnd.jinn.environment.v1+json`
- **Sealing:** I-JSON document, RFC 8785 JCS canonicalized once at sealing, sha256 of the
  sealed bytes is the record's identity, written `sha256:<64 lowercase hex>`. Sealed once,
  forever. Sealing is re-implemented in this package with cross-package equivalence
  fixtures (house precedent).
- **Signing:** the record itself is sealed but **unsigned** — attribution comes from
  DSSE-signed discovery announcements and from verification attestations, following the
  trajectory-record precedent (attribution not at the record layer). A producer MAY
  additionally wrap the record in a DSSE envelope via the trust layer; consumers MUST NOT
  require it.
- **Storage:** bytes stored via the evidence repository's `putArtifact` (digest-addressed,
  family-less). The closed evidence record families are untouched.
- **Discovery:** announced with a facts profile (§4.4). Discovery's rule that unknown kinds
  are skipped means this kind deploys with no protocol change.

### 4.2 Fields

One record = one environment = one `(source, image, platform, invocations, parser)`
binding. All digest fields in the record body use `sha256:` prefixed lowercase hex
(in-toto DigestSet subjects, by contrast, use bare hex — §5.1). Unknown extension fields are permitted
only under namespaced keys (reverse-DNS or absolute-URI, TEP §21.3) and survive
round-trips.

```jsonc
{
  "kind": "https://jinn.network/records/environment/1.0",
  "source": {
    "repo": "owner/name",                 // display slug
    "repoUrl": "https://github.com/owner/name",
    "commit": "<40-hex>"                  // the exact tree the environment contains
  },
  "image": {
    "manifestDigest": "sha256:…",         // platform-specific OCI *manifest* digest
    "platform": "linux/amd64",            // one record per platform (behavior is per-platform)
    "reference": "registry/…@sha256:…",   // advisory pull hint; MUST end with @manifestDigest
    "indexDigest": "sha256:…"             // optional provenance: the multi-arch index it came from
  },
  "workspace": "/testbed",
  "invocations": {
    "install": [ /* CommandSpec[], optional — empty when the image is pre-installed */ ],
    "test":    [ /* CommandSpec[], required — the declared verification scope */ ]
  },
  "parser": { "id": "…", "version": "…", "digest": "sha256:…", "uri": "…" },
                                          // uri = advisory acquisition hint; digest authoritative.
                                          // See the F3 addendum below — advisory is NOT sufficient.
  "build": {
    "reproducibilityTier": 0,             // 0 pinned-image | 1 rebuildable | 2 bit-reproducible
    "recipe": { /* ResourceDescriptor, required for tier ≥ 1 */ },
    "dependencyPinning": { /* declaration of time-travel mechanism, tier ≥ 1 */ },
    "provider": { "id": "…", "version": "…" }
  },
  "rights": {
    "sourceLicense": "SPDX expression",   // owner-declared upstream; declared-vs-detected honesty per note §7
    "basis": "…"                          // optional, open namespaced vocabulary — a producer's provenance
  },                                      // note, not pipeline policy (v1 writes "upstream-permissive-filter")
  "lineage": {                            // optional; present for imported environments
    "upstream": { "dataset": "…", "revision": "…", "keys": ["…"] }
  }
}
```

`CommandSpec` is the legacy shell-free shape carried over: `{bin, args[], cwd?, env?}` —
no shell interpolation, ever.

Rationale for contested inclusions:
- **`parser` is in the record**, not only in EvaluationSpecs, because baseline outcome sets
  (§5) are meaningless without the parser identity that produced them. An attestation about
  outcomes binds to the record; the record must therefore fix the outcome vocabulary.
- **`invocations.test` is the declared verification scope.** It may be the full suite or a
  targeted subset; the attestation's claims extend exactly as far as this scope and no
  further. A record MAY exist for a broad scope and another for a narrow one over the same
  image; they are different environments by identity, which is correct.
- **Platform-specific manifest digest**, never the index digest, never config or layer
  digests: the manifest digest is what registries key on (`docker pull image@…` accepts
  either form, resolving an index to its platform manifest — the manifest is what actually
  runs); behavior claims are per-platform facts and an index-level record would be a lie
  by aggregation (Q1 audit §b).

> **Addendum (2026-07-31, first end-to-end run — findings F1/F3/F4; full record in
> [`../notes/2026-07-31-supply-first-e2e-findings.md`](../notes/2026-07-31-supply-first-e2e-findings.md)).**
> The first real run of this pipeline produced three normative corrections:
>
> - **Parsers are digest-addressed artifacts stored via `putArtifact`** (F3), like state
>   artifacts. "Advisory `uri`, digest authoritative" was insufficient — a digest with no
>   resolvable source is a claim, not a capability, and it left third-party
>   re-verification, this family's entire differentiator, not executable by a third party.
>   The existing artifact machinery suffices; no new concept is required.
> - **An environment whose latest attestation shows an unusable baseline is not a task
>   source** (F1). The design published negative attestations but never said derivation
>   must skip those environments; it must. Broken environments stay published — that is
>   the free public signal — they are simply never derived from. Note what this does *not*
>   license: enabling the network for an install phase would void closure (unpinned bytes,
>   divergent runs) and must never be added. Narrowing the declared test scope is the
>   legitimate authoring move, and a pinned local dependency mirror is the named extension
>   for images whose install genuinely needs upstream packages.
> - **Retry-then-`error` is internal to verification, not optional wiring** (F4). A
>   transient registry failure must not seal a negative attestation: infrastructure
>   classification and bounded retry happen *before* sealing. Attestations are permanent
>   and plural, so a signed false negative is never recovered by a later positive.

### 4.3 Lifecycle

Sealed forever. No expiry field, no status field. Staleness — image blobs vanishing,
mirrors dying, dependency archives rotting — is a **derived signal** computed by consumers
(e.g., "latest successful attestation age", "image resolvable as of T"), never a mutation.
Later observations append as new attestations (§5), including contrary ones. Nothing in
this design ever rewrites a sealed record (principles §5, §7).

### 4.4 Discovery facts profile

The announcement facts card for this kind names, at minimum: `source.repo`,
`source.commit`, `image.manifestDigest`, `image.platform`, `build.reproducibilityTier`.
`image.manifestDigest` is declared as a reference-bearing field so the discovery
`referrers` relation inverts it — "find environment records (and, transitively,
attestations) about image `sha256:X`" is a first-class query. Announcements are DSSE-signed
and confer no validity, per the discovery design.

### 4.5 Conformance fixtures (kit-first)

Golden: a sealed rebench-imported environment record; a tier-1 record with recipe +
dependency pinning; a namespaced-extension record. Adversarial: index digest passed as
manifest digest; `reference` not ending in `@manifestDigest`; shell-bearing command;
bare (un-namespaced) extension key; re-canonicalized bytes presented as the same record.
Cross-package: seal-equivalence fixtures against the evidence tree's sealing.

> **Addendum (2026-07-31, planning finding C1 F1, ruling R8):** "index digest passed as
> manifest digest" is not fully detectable at the record layer — a digest's referent kind
> is not encoded in its bytes. The record package enforces two structural proxies; the
> general case is caught at verification time, where pulling an index digest as a platform
> manifest fails `error/acquire` (§5.3 step 1).

## 5. The verification attestation

### 5.1 Envelope and identity

- **Shape:** in-toto Statement v1 inside a DSSE envelope (`payloadType
  application/vnd.in-toto+json`) — the house monoculture, reusing `trust/core` seal/verify
  and the `attestation-issuer` statement-building pattern unchanged.
- **Predicate type:** `https://jinn.network/attestations/environment-verification/v1`,
  registered alongside the existing evidence predicates.
- **Subject:** two ResourceDescriptors — the environment record
  (`{name: "environment", digest: {sha256: <64 bare lowercase hex>}}`) and the image
  (`{name: "image", digest: {sha256: <64 bare lowercase hex>}}`). Per in-toto, DigestSet
  values are bare hex — never `sha256:`-prefixed (a prefixed value is non-conformant; the
  kit's adversarial fixtures include one). Dual subjects make the attestation discoverable
  both by record and by image digest (OCI-referrers-style inversion, §4.4), and pin the
  attestation to the exact bytes exercised.
- **Subject-match rule (normative).** A consumer evaluating a claim about an *environment*
  MUST match the environment-record subject. The image subject exists for discovery
  inversion only: two records can share one image (different test scopes are different
  environments, §4.2), and any-subject-match verifiers would otherwise silently extend a
  narrow-scope attestation to a broad-scope record.
- **Signer:** a working key with a trust-layer key binding. Who may attest is **open**;
  which attesters a consumer honors is trust policy (a `purpose` for environment
  verification slots into the trust-policy vocabulary as a deployment extension). The
  attestation asserts observations; it never asserts trustworthiness.

### 5.2 Predicate

```jsonc
{
  "protocol": "https://jinn.network/environment-verification/protocol/1.0",
  "result": "stable" | "unstable" | "error",
  "window": { "startedAt": "RFC3339 UTC", "endedAt": "RFC3339 UTC" },  // when the runs happened
  "runs": {
    "count": 5,                            // K; profile minimum 5
    "outcomeSetDigest": "sha256:…",        // digest of the canonical outcome set (all runs identical when result=stable)
    "perRun": [ { "outcomeSetDigest": "sha256:…", "wallSeconds": 292 } ]
  },
  "baseline": {
    "passing": 412, "failing": 3, "skipped": 9,   // counts inline
    "outcomes": { /* ResourceDescriptor → full test-id→status map stored via putArtifact */ }
  },
  "controls": {
    "network": "none",
    "seeds": { "PYTHONHASHSEED": "0" },           // declared, per-runner
    "order": "declared" | "fixed" | "default",
    "parallelism": 1,
    "locale": "C.UTF-8", "tz": "UTC"
  },
  "runtime": { "minSeconds": 288, "maxSeconds": 301, "timeoutSeconds": 1800 },
  "verifier": { "id": "…", "version": "…", "digest": "sha256:…" },  // toolchain identity
  "failure": {                              // present iff result != "stable"
    "stage": "acquire" | "install" | "run" | "compare",
    "reason": "…",                          // taxonomy-coded
    "divergence": { /* which runs differed, digest refs to both outcome sets */ }
  },
  "evidence": [ /* optional ResourceDescriptors: per-run logs, runtime traces */ ]
}
```

Semantics, stated the way the audit forces them:

- **The claim is bounded.** `result: "stable"` means exactly "K consecutive runs of the
  declared test scope produced identical outcome-sets under the declared controls." It is
  never "this environment is deterministic" — rerun studies show flaky-test detection is
  asymptotic in the number of reruns, so no finite K converges (evidence and citations in
  the research note §9). K and controls are facts in the record; grading them is consumer
  policy.
- **The claim binds the image, not the source.** The protocol exercises the image at
  `manifestDigest`; it does not compare the image's workspace against a clone of
  `source.repo@commit`. At reproducibility tier 0 — all of v1 — the source binding is a
  *declaration the protocol does not verify*. Consumers relying on "this graded evidence
  is about repo X" are relying on the declarer; a workspace-vs-clone correspondence check
  is a named extension (§14). Stated here because an unstated gap is exactly the
  overclaiming this design exists to avoid.
- **Timestamps are part of the claim.** `window` records when the runs happened; staleness
  reasoning (§4.3) and the expected honest history (early-`stable`, later-`error` as
  images rot) key on it. Announcement time is the announcer's claim, not the verifier's —
  a re-announced old attestation cannot present as fresh because `window` is inside the
  signed payload.
- **Presence rule:** `runs` and `baseline` are present iff `result != "error"`. An
  `error` attestation carries `window`, `failure`, and any partial evidence only.
- **Outcome-set comparison is set equality over (test-id → pass|fail|skip)**, never
  timing. Runtime is recorded as observed bounds, not compared for equality.
- **Expected-fail baselines are first-class.** `baseline.outcomes` records which tests
  fail at this commit. A baseline with failures is a *known* baseline, not a rejected
  environment — this is what lets imported per-task images (where the instance's bug is
  present and its tests fail) be verified honestly.
- **Negative attestations are the same predicate** with `result: "unstable" | "error"` and
  the `failure` block populated (D3). They are published and announced identically. "This
  environment is broken" is thereby a provable, attributable claim, and re-verification
  waste dies.
- **Plurality:** any number of attestations may exist per record, from any signers,
  including mutually contradictory ones over time (image rot makes early-stable,
  later-error the *expected* honest history). Consumers reduce over the set via trust
  policy; nothing in this layer picks winners.

### 5.3 Verification protocol (v1 profile)

1. Resolve `image.manifestDigest` and pull by digest (`reference` is advisory only; digest
   mismatch is `error/acquire`).
2. Materialize the workspace; run `invocations.install` if present (`error/install` on
   failure).
3. Run `invocations.test` K times (K ≥ 5), sequentially, under the declared controls, each
   run in a fresh container from the same image.

> **Addendum (2026-07-31, planning finding C2 F-C2-2, ruling R7):** steps 2–3 as written
> conflict — an install performed once cannot survive fresh-container-per-run. Install
> executes **inside each run's container** before that run's test invocation (a no-op for
> pre-installed import images). The attestation's claims are unchanged.
4. Parse each run's output with the pinned parser; produce K outcome sets.
5. Compare: all identical → `stable`; any divergence → `unstable` with divergence
   evidence; infrastructure failure → `error` with stage + taxonomy-coded reason.
6. Build the Statement, DSSE-sign with the injected signer, store artifacts via
   `putArtifact`, announce.

Costs, stated honestly (charter Q1): **cheap verification** = verify the DSSE chain and
digests offline — no registry, no network, no liveness dependency, ever. **Expensive
verification** = re-execute this protocol (pull + K runs) and compare outcome-set digests —
minutes-to-hours of compute, bounded by `runtime × K`. The record supports both; the spec
claims nothing stronger than what each tier checks.

### 5.4 Registry interop (optional, non-normative)

The DSSE envelope MAY additionally be pushed to a container registry as an OCI 1.1
referrer of the image manifest (with the `sha256-<digest>` fallback tag for registries
without referrers support), making it discoverable by `oras`/`cosign`-class tools. This is
distribution convenience only: the sealed record and attestation never depend on registry
liveness (Q1 audit §f).

### 5.5 Conformance fixtures

Golden: stable attestation over the golden record; unstable with divergence; error at
acquire. Adversarial: subject digest mismatch; controls omitted; result `stable` with
divergent per-run digests; re-signed payload with altered baseline counts; K below profile
minimum. Kit exercises DSSE verification against trust/core test keys.

## 6. The environment verification capability

The tier-3 unit that executes §5.3. Boundary: *(environment description or import
candidate) → sealed record + attestation(s)*. It does not derive tasks, post, or price.

- **Ports (injected, custody law):** container runtime (pull-by-digest, run), git (clone
  at commit, when workspace materialization needs it), artifact store (`putArtifact` +
  announcement sink), DSSE signer object, clock. No ambient credentials; no key material;
  fail closed.
- **Import source (v1, D2):** candidates come from upstream dataset rows (SWE-rebench
  first; SWE-smith and SWE-bench-Live are cheap follow-ons). Rows are grouped by the
  **full record identity** — `(source repo+commit, image manifest digest, platform,
  invocations, parser)`; divergence in any component splits the group into distinct
  environments. One record per distinct environment, not per row — a narrower grouping key
  would silently attest a test scope some rows never declared. The capability builds the record from row metadata, then runs the protocol.
  Verifying upstream's environments — including publishing the failures — is the v1
  product statement: the environments everyone already uses, made independently checkable.
- **Pipeline state:** the legacy staged, crash-safe, atomic-write state machine and the
  four-way failure taxonomy (`terminal_policy` / `awaiting_input` / `quarantined` /
  `failed_infrastructure`) carry over as an internal library. `quarantined` maps to
  published `unstable` attestations; `failed_infrastructure` to retry-then-`error`.
- **Own construction** (setup agents, time-travel dependency resolution, recipe
  discovery) is the named stage-2 extension (§14) — the from-scratch yield problem
  (6.7–31%) is deliberately not taken on in v1.

Conformance: the kit runs the capability against a fake container runtime with scripted
outcomes (stable / flaky / vanishing-image) and asserts the exact attestation each
produces; kit green before derivation builds on it.

## 7. Task derivation and admission

### 7.1 Admission (standalone unit)

*Candidate task + environment record → differential-admission receipt.* The port of the
legacy crown jewel onto the stack, with one structural change: **the receipt references the
environment record by digest** instead of inlining an environment binding. Environment
facts are attested once (§5); admission proves only what is per-task:

- gold patch applied at the environment's commit → the candidate's fail-to-pass tests
  pass, pass-to-pass tests still pass (2 runs);
- no patch (empty) → fail-to-pass tests fail (2 runs) — the suite *discriminates*;
- repeat observations canonical-JSON identical; command hashes bound; gold present as
  digest only.

Receipt (`DifferentialAdmissionReceipt/3`): policy version, task binding
(statement digest, test-material digests, transitions), `goldPatchHash`, per-path 2×2
observations, derived F2P/P2P, `environment: {recordDigest}`, semantics version. Sealed,
digest-identified, stored via `putArtifact`, referenced from the task's Submission under
the existing admission-receipt annotation. The receipt is DSSE-signed by the admitting
party (the marketplace evaluation leg already validates issuer scope and purpose for
admission receipts — this unit conforms to that existing contract rather than defining a
new one).

Two normative rules close the surfaces both reviews converged on:

- **Inline-match enforcement (blocker fix).** The candidate EvaluationSpec's inline
  `image` (manifest digest via its reference), `platform`, and `parser` MUST equal the
  referenced environment record's; admission refuses the receipt with
  `env-record-mismatch` otherwise, and the receipt records that the check ran. Until F1
  lands in profiles, the inline fields remain authoritative for grading and the extension
  key is informative — but because admission enforces equality, a pair that grades against
  one image while borrowing another record's attestations cannot earn a receipt. The
  mismatch case is a mandatory adversarial fixture in this unit's kit.
- **Admission is attestation-agnostic.** It takes the environment record digest as given
  and asserts nothing about attestations — the receipt cites `environment.recordDigest`
  only. "Verified" is the *consumer's* trust-policy join of receipt + attestations, never
  a fact the receipt claims. Baking attester policy into admission would be policy leakage
  into a tier-3 primitive.

Source-agnostic by construction: nothing in the receipt knows whether the candidate was
imported, injected, or mined.

> **Addendum (2026-07-31, planning finding C3 F-C3-1, ruling R6):** the existing
> marketplace admission-receipt contract (validated by the binding's evaluation leg)
> requires the sealed receipt to be a DSSE envelope whose payload is an in-toto Statement
> with the sealed Task and EvaluationSpec digests as subjects. This section's field list is
> therefore the receipt **predicate**; the subjects are derived from the task binding so
> they cannot diverge. No semantic change — an envelope detail this section omitted.

### 7.2 Derivation (strategy seam; v1 = import only)

A strategy maps *(verified environment + strategy inputs) → candidate tasks*. The unit
defines the strategy interface, runs candidates through admission, seals survivors, and
writes sealed pairs to the supply pool (its output store).

**The import strategy (v1's only member, D4):** an upstream row whose environment is
verified becomes a candidate: statement = the row's original issue text (deterministic —
no generation in v1); test material, transitions, timeout from the row;
`provenance.kind: "mined"`; `provenance.sourceCommitment` = the upstream lineage digest
(this field's first-ever writer); the upstream instance id carried in payload lineage.
Admission re-proves gold-resolves + discriminates locally — an imported task ends up
carrying strictly more evidence than it had upstream.

**Sealed pair shape:** Task and EvaluationSpec per the profiles design, unchanged, except
the EvaluationSpec's deterministic-process block carries a namespaced extension key
`"network.jinn.environment.record": {"digest": {"sha256": "…"}}` referencing the
environment record (rides today; first-class field proposed as finding F1, §13). Image,
platform, and parser fields remain inline in the family block as today — duplicated from
the record for now, with the record as the join point; admission enforces inline ==
record (§7.1), so the duplication cannot diverge in any admitted pair, and de-duplication
follows F1's disposition. All test material `accessClass: "public"`, explicitly (D5).
License per D12.

**Cut from v1, named as extensions (§14):** procedural injection (and its statement
generator), LLM injection strategies, commit-echo mining with its curation layer,
emergent-bug harvesting.

### 7.3 The honesty surface (normative)

For public repositories, every v1 task's answer is discoverable: imported/mined answers
sit in the repository's history one `git log` away. This design builds **no secrecy
mechanism** and makes no secrecy claim (D5).

Equally normative: **admission proves grading properties, never content safety.** An
imported statement is upstream-authored text, attacker-influencable in principle (public
datasets, upstream pull requests), delivered into every solver's context — a
prompt-injection channel; consumers treat task text as untrusted data per the house
instruction-source rules. Test material is upstream-authored code executed in containers.
Solve-time and evaluation-time sandboxing are the executor's and evaluator's concerns,
owned by their designs, not granted by any receipt this pipeline mints. What actually protects value, and what
consumers may rely on: `provenance.kind` labeling (filterable), admission receipts (the
grader provably discriminates), environment attestations (the ground provably holds), and
pass-rate curation (§9) telling consumers what a task is currently worth as signal. Any
future strategy or consumer needing genuinely private material must first build grant
infrastructure (extension, §14) — none exists today, anywhere in the stack.

## 8. Posting (separate application, D6)

*Pool of sealed pairs + operator terms → marketplace posts.* Production never posts;
posting never derives — the seam is D6.

**Division of labor with the work client (duplication check, resolved).** The
consumption-boundary design (2026-07-30, committed on its session branch pending merge)
already owns *how to post safely*: the work client
(`packages/marketplace/work-client`) — posting/settlement mechanics, the preflight core
(funds preflight, durable-intent posting, validation), requester-side evaluation sealing,
custody discipline — with a no-wrapper-layers rule. This unit owns only what the work
client explicitly does not: **supply policy** — which pool entries post, when, at what
terms, under whose identity, with escrow surfaced before spending. It is an application
with its own job, not a wrapper.

Therefore: **task-posting consumes the work client** once it mints. The work client's mint
is gated on daemon cutover stage 3 + published canaries; until then this unit composes the
binding's `postTask` + the D7 adapters directly — recorded as the **same named-residual
class the consumption-boundary design already records for benchmarking's marketplace
venue**, with the same disposition: at work-client mint, task-posting adopts the work
client's posting core beneath its policy surface — same code, no fork (filed as F7). The
D7 adapters themselves are not duplication: the work client's stated composition includes
the durable intent store, so landing them in the binding tree serves both programs;
coordination with the consumption-boundary follow-ups is part of F2/F7, not accidental.

The poster's key is the requester of record.

- **Flow:** explicit post is the default — the poster surfaces terms
  (`solutionMaxDeliveryRateWei`, `verdictMaxDeliveryRateWei`, timeout) and the computed
  escrow total (`(solution + verdict rate) × maxClaims`, native ETH via `msg.value`)
  before spending. Auto-post is an opt-in standing policy with the same visibility in
  logs. (Visible-money-actions principle; cheap on testnet, right habit for mainnet.)
- **On-ramp adapters (D7):** this program's first implementation tasks land, **in the
  marketplace binding tree** under its guards: `createEoaBroadcastPort(publicClient,
  walletClient)` (viem tx + `TaskCreated` decode), a durable `PostingIntentStore`
  (file-or-sqlite WAL honoring the specified claim/fence/resolve semantics), a
  `ScanForOnChainMatch` implementation (log scan keyed on taskCidDigest + creator), and
  exported `DEFAULT_POSTING_TERMS`. Findings filed regardless (F2, §13) so the gap and its
  closure are on the record.
- **Evaluation leg:** v1 tasks are public-spec (D5), so evaluation submissions take the
  public-spec sealing path; `capabilityGrants` never populated in v1.
- **Economics honesty:** `DEFAULT_POSTING_TERMS` sets `maxClaims` explicitly — never
  relying on the binding's silent default of 1 — and documents the escrow formula. The
  residual risk that a colluding solver+evaluator pair drains a poster's escrow with a
  junk delivery and a friendly verdict under today-mode `minVerdicts: 1` is
  marketplace-owned; it is named here so posters price it in, not solved here.

## 9. Curation projection (D8)

*Verdict observations → per-task empirical pass rate.* A **projection, never a record**
(principles §7): verdicts in discovery are the append-only truth; this unit derives, and
anyone can re-derive.

Contract (v1 minimal build): for each task digest — attempts observed, verdicts observed,
`passRate` (with numerator/denominator, never bare), first/last verdict times, and a
`saturation` boolean derived from a consumer-supplied threshold (default reference: the
research band — value concentrates in [2%, 70%] pass rate, peak ~50%; tasks aging past
~70% are exhausting their signal). Aggregate across solvers in v1; per-solver-model
breakdown is an extension gated on attempt metadata (§14). Output is queryable state
served by the projector's host, re-derivable from scratch; it is consumed by posting
policy (age-out), by task selectors, and by data buyers.

**Manipulation, named.** Colluding or sybil solvers can throw attempts (or spam solves)
to steer a task's published pass rate into or out of the valuable band; a producer could
game saturation to keep their tasks in a paid pool. The mitigations this design actually
has: verdicts are signed and attributable, so manipulation is *visible in the inputs*; the
projection is re-derivable from scratch under any consumer's own solver filter (a buyer
who distrusts a cohort excludes it and recomputes); the published projection always
carries numerator + denominator + input references, never a bare rate; and the
per-solver-model breakdown extension (§14) narrows the aggregate a manipulator can hide
in. What this layer cannot do is stop sybil attempts from existing — that is the
marketplace's admission/economics territory. Curation-integrity ownership is filed as F6.

The strategic point (research §6): per-task empirical pass rate from many independent
solvers is exactly the difficulty signal labs currently estimate with private rollouts.
Publishing it, verdict-grounded, is the flywheel product.

**Relation to benchmarking (no overlap, one filter).** The benchmarking application
answers "how good is this solver/config on a fixed slate" (a deliberate experiment,
aggregated consumer-side per its own design); curation answers "how hard is this task,
given all observed attempts" (ambient exhaust). Same verdict stream, different questions.
Because benchmark arms are Submissions with run pinning, benchmark-driven attempts are
distinguishable in curation's attribution-preserving inputs — consumers computing
*organic* difficulty SHOULD filter or separately bucket them, since a benchmark hammering
one task with pinned repeated attempts is not market evidence of its difficulty.

## 10. Standards audit record

Per principles §3. The table below **is** the audit record; supporting facts and citations
are preserved in the research note §9 (the Q1 lanes). Dispositions:

| Standard | Disposition |
| --- | --- |
| DSSE v1, in-toto Statement v1 | Adopted unchanged (house monoculture) |
| OCI manifest digests | Adopted unchanged; platform manifest digest is the identity (never index/config/layer) |
| OCI 1.1 Referrers (+ fallback tag) | Adopted as optional distribution nicety (§5.4); never source of truth |
| SLSA Provenance v1 | Adopted for tier ≥1 build description (`build.recipe` may be a SLSA provenance ref); asserts build, not behavior |
| in-toto Test Result predicate v0.1 | Not adopted as-is (single-invocation, no repeatability/baseline semantics); field vocabulary borrowed |
| in-toto SCAI v0.3 | Not adopted (free-form attributes); evidence-attachment pattern borrowed |
| SOURCE_DATE_EPOCH / BuildKit rewrite-timestamp / Nix | Tier-2 reproducibility only; claimed only when demonstrated |
| Time-travel dependency resolution (pip-by-date proxy, `npm --before`, snapshot.debian.org, Nix locks) | Deferred to stage-2 construction; declared via `build.dependencyPinning` |
| OpenEnv / `verifiers` / Harbor | Interop targets via extension adapters (§14); no environment-quality standard exists to adopt (OpenEnv RFC 008 is one sentence of intent) |
| SPDX license expressions | Adopted for `rights.sourceLicense` (declared, not detected) |

**Bespoke, with justification (composition fails):** the environment record kind itself
(no standard binds source+image+invocation+parser as one identity); the
K-run-with-expected-fail-baselines predicate (no existing predicate expresses
repeatability or expected-failure semantics); the determinism-bounds framing (D11). Each
is deliberately small and borrows adjacent vocabularies.

## 11. Verification before completion (implementation gates)

Every unit: typecheck, tests, its conformance kit, and the tree guards — run locally,
outputs shown, before any completion claim. Kit-first ordering: record kit → verification
kit → admission kit → derivation → posting/curation. One independent high-effort review
per completed unit against this document (principles §13.2); one program review across the
integrated whole at the end.

**Legacy supersession gate** (charter §7: this session sets it; the daemon's programs
execute it): the harvest-loop's import path is superseded when the verification +
derivation + admission kits are green **and** the new units reproduce the legacy rebench
import end-to-end — environment verified, tasks admitted with receipts, sealed pairs in
the pool — for a representative upstream sample, with the sealed outputs passing the
profiles conformance fixtures. Until then the legacy loop runs untouched; after, its
refit/retirement is the daemon program's task, not this one's. The commit-echo half of the
legacy loop is not superseded by v1 at all (echo is an extension, §14) and stays frozen
reference either way.

## 12. Non-goals (load-bearing)

- No environment **construction** in v1 — no setup agents, no recipe discovery, no
  dependency time-travel infrastructure (stage 2).
- No synthetic strategies in v1 — no injection, no statement generation, no echo mining,
  no curation classifiers (extensions).
- No private evaluation material, no grant hosting/minting/redemption (D5).
- No secrecy claims of any kind for public-repo tasks (§7.3).
- No pricing engine — terms are operator-supplied; pass-rate-driven pricing is future
  work with the marketplace-economics owner.
- No reward/staking changes; the activity-farming vector is filed (F3), not solved here.
- No interop adapters in v1 (OpenEnv / `verifiers` / Harbor — extensions with owners).
- No plugin involvement in v1: the Jinn Plugin's parked mint extension point resolves to
  **nothing, by design**, for this product (§3.1); revisited only by a future strategy
  that genuinely needs an in-session surface.
- No mutable status anywhere: no environment "current health" field, no task "active"
  flag — all such state is derived projection.
- No product naming at tiers 1–3; "supply pipeline" is a composition description, not a
  name.

## 13. Findings filed (designs-are-law, principles §13.1)

- **F1 → profiles spec:** the deterministic-process family block should support an
  environment-record reference as a first-class optional field (additive; the namespaced
  key in §7.2 is the interim carrier). Disposition proposed: field
  `environmentRecord: ResourceDescriptor` beside `image`/`platform`, with a rule that
  inline fields, when both are present, MUST match the referenced record.
- **F2 → marketplace binding program:** the requester on-ramp gaps (broadcast port,
  durable intent store, recovery scan, terms defaults) — closed by this program in the
  binding tree (D7), filed so the contract change is on the binding program's record.
- **F3 → reward/activity layer:** self-mint-self-solve activity farming cannot be
  prevented by any supply-side mechanism (sybil-trivial); the reward layer owns weighting
  or discounting self-associated completed-loop activity.
- **F4 → profiles/protocol tests:** unknown-extension-field survival through
  `sealTask` round-trip is mechanically guaranteed but untested; add a regression test
  before §7.2's namespaced key ships (research note §2).
- **F5 → discovery:** this design's facts profiles (environment kind, §4.4) follow the
  small-leaf-package pattern; no discovery change needed — recorded for the avoidance of
  a fork.
- **F7 → consumption-boundary program:** task-posting is a new consumer of the work
  client. Interim direct-binding posting is recorded here as a named residual of the same
  class as benchmarking's marketplace venue (that design's own precedent), with adoption
  of the work client's posting core at its mint; the D7 adapters land in the binding tree
  as shared components serving both programs. Filed so neither program discovers the other
  by accident — this finding exists because the work client's design lives on an unmerged
  session branch and was initially missed by this session's composition census.
- **F6 → curation unit contract (this program):** curation-signal integrity. Sybil/collusion
  pass-rate manipulation (§9) cannot be prevented at the projection layer; the contract
  therefore REQUIRES attribution-preserving inputs (numerator, denominator, input verdict
  references) so any consumer can re-derive under their own solver filter, and the
  per-solver-model breakdown extension narrows the hiding space. Preventing sybil attempts
  themselves is marketplace admission/economics territory, distinct from F3's
  reward-farming vector.

## 14. Extensions, parked with owners

| Extension | Content | Owner / trigger |
| --- | --- | --- |
| Environment construction (stage 2) | Setup agents, recipe discovery, time-travel deps; tier-1/2 reproducibility | This program's successor; triggered by repos upstream doesn't cover |
| Procedural + LLM injection strategies | Mutation against verified green states; statement generator (LLM as injected port; generated text labeled) | Derivation unit; triggered by supply volume needs |
| Commit-echo mining + curation layer | Own mining with clarity/difficulty classifiers | Same; triggered by freshness/independence needs |
| Emergent-bug harvesting | Bugs from failed agent attempts (marketplace produces these free) | Derivation unit; research-gated |
| Interop adapters | OpenEnv container shim; `verifiers` env module; Harbor packaging. The records already carry everything an adapter needs (pinned container, shell-free commands, statement, grader) — no extra carriage requirements on this program; packaging is the adapter owner's concern | Named owner at first external-consumer request |
| Source-correspondence check | Workspace-vs-clone diff proving the image contains `source.repo@commit` (closes §5.2's tier-0 source-binding gap) | Verification capability; triggered by consumers relying on source identity |
| Grant infrastructure | Capability hosting/minting/redemption for genuinely private material | Only with a strategy that needs it; none in scope |
| Per-solver-model pass-rate breakdown | Curation projection keyed by solver model metadata | Curation unit; gated on attempt metadata |
| Owner-endorsement (consent) record | The predecessor session's DSSE consent design (research note §7) | Revived by private-repo / live-task / session-mining products |
| Registry referrers publishing | §5.4 automation | Verification capability; nice-to-have |

## 15. Naming pass (principles §13.5)

Settled working names, used consistently hereafter: trees `packages/environments/` and
`packages/task-supply/`; packages `@jinn-network/environment-record`,
`@jinn-network/environment-verification`, `@jinn-network/task-admission`,
`@jinn-network/task-derivation`, `@jinn-network/task-curation`,
`@jinn-network/task-posting`. Record kind `environment/1.0`; predicate
`environment-verification/v1`; receipt `DifferentialAdmissionReceipt/3`. The tier-4
composition is described, not branded (§12). "Task harvester" is retired with its charter.

## 16. Provenance

Designed 2026-07-31 in worktree `plugin-stack-reconciliation-5ee384` under the
verified-environment charter, following two same-day framing collapses recorded in the
research note §8 and the retired predecessor charter. Session method: research lanes →
one material question at a time (Q1–Q4, decisions D1–D12) → this specification → two
fresh reviews (architecture; standards/adversarial) before presentation.

## 17. Review dispositions

Two fresh reviews ran against v0.1 before presentation; all blocking and major findings
were resolved in-text before the operator saw the document.

| Finding (both reviews where merged) | Severity | Resolution |
| --- | --- | --- |
| Inline env fields can diverge from the referenced record — "verified" spoofing (arch #1 = adv #1) | BLOCKER | §7.1 inline-match enforcement by admission + mandatory adversarial fixture; §7.2 restated |
| Import grouping key narrower than record identity (arch #2) | MAJOR | §6 groups by full identity tuple; divergence splits |
| Plugin relationship silently dropped (arch #3) | MAJOR | §3.1 + §12: nothing in v1, by design |
| No source binding at tier 0 — image behavior ≠ repo@commit correspondence (adv #2) | MAJOR | §5.2 bounded-claim bullet; source-correspondence check parked as extension (§14) |
| No verification timestamp in predicate (adv #3) | MAJOR | `window` added to §5.2; timestamps-in-claim semantics stated |
| Dual-subject any-match hazard (adv #4) | MAJOR | §5.1 normative subject-match rule; bare-hex DigestSet note |
| Pass-rate manipulation unaddressed; curation integrity ownerless (adv #5) | MAJOR | §9 manipulation paragraph; F6 filed |
| Host/identity not concluded (arch #4) | MINOR | §3.1 v1 reference deployment |
| Legacy supersession gate unset (arch #5) | MINOR | §11 gate criteria |
| Interop carriage half-answered (arch #6) | MINOR | §14 interop row extended |
| Topology loose ends: shared library home, trust/core + facts-leaf edges, profiles arrow (arch #7) | MINOR | §3.2 + §3.3 revised |
| Admission's attestation stance unstated (arch #8 = adv #6) | MINOR | §7.1 attestation-agnostic rule |
| Uncited flaky-test percentages (adv #7) | MINOR | Replaced with qualitative claim; numbers + citations moved to research note §9 |
| Parser not acquirable for re-verification (adv #8) | MINOR | §4.2 parser `uri` acquisition hint |
| Import content safety unstated (adv #9) | MINOR | §7.3 content-safety paragraph |
| Escrow default / collusion drain (adv #10) | NOTE | §8 economics-honesty bullet |
| Audit record dangling in uncommitted lane report (adv #11) | NOTE | §10 table declared the record; facts persisted to research note §9 |
| Cyrillic characters in "digest"; `docker pull` index-resolution nit; error-attestation field presence; `rights.basis` policy leakage (arch #9–#11, adv #11 nit) | NOTE | All fixed in §4.2/§5.2 |

Both reviews endorsed D10 (one spec chartering all units) and the decomposition,
record/attestation split, and tier placement; neither found a framing-level defect.

Two further findings came from operator review of the presented draft:

| Finding | Severity | Resolution |
| --- | --- | --- |
| Curation vs benchmarking aggregation — benchmark-pinned attempts skew organic difficulty | MINOR | §9 relation-to-benchmarking paragraph: distinguishable via run pinning; consumers filter |
| Task-posting overlaps the consumption-boundary design's work client (on an unmerged session branch, missed by the composition census) | MAJOR | §8 division of labor (policy vs mechanics), work-client adoption at mint, named residual per that design's own benchmarking precedent; F7 filed |
