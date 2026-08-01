# Research findings — task supply, verified environments, and the graded-evidence economy

- **Date:** 2026-07-31
- **Status:** Research record. Not a design. Produced by five read-only research lanes during
  the 2026-07-31 harvester session, which reframed twice and closed without a spec.
- **Role:** Carry-forward evidence for the verified-environment and task-supply design session
  ([`../prompts/2026-07-31-verified-environment-supply-design-prompt.md`](../prompts/2026-07-31-verified-environment-supply-design-prompt.md)).
  Findings are reported as found; where a lane's conclusion was later overtaken by the
  session's reframes, the note says so rather than deleting it.

## 1. Why this note exists

The session ran five lanes (stack demand-side surface, evaluation-spec expressiveness,
consent/identity standards, legacy pipeline inventory, requester on-ramp probe, plus two
web surveys of prior art and the RL-environments economy). The product framing then changed
twice, invalidating most of the session's *product* decisions but none of its *evidence*.
Rerunning the lanes would cost a full session's research budget to rediscover the same
facts. This note preserves them.

Facts here were true of `integration/evidence-v1` as of 2026-07-31 and of the public
literature on that date. Anything load-bearing should be re-verified before implementation —
particularly code line references, which drift.

## 2. Stack fit — what exists for the demand side

**Task authoring and sealing exist, packaged.** `packages/task-execution/protocol`
(`sealTask`, `sealSubmission`, `documentDigest`; identity = sha256 of exact sealed bytes)
and `packages/task-execution/profiles` (`buildRepositoryWorkProfile`, `migrateJinnRepoTask`,
`sealEvaluationSpec`). Submission into a marketplace is a first-class **backend-contract
verb** (`TaskExecutionBackend.submit`), not an application concern — TEP §14.

**The repository-work profile already anticipates mining.** Its payload schema carries
`provenance.kind: "mined" | "synthetic" | "live"` (required) plus optional
`sourceCommitment`; the migration maps legacy `merged-pr → mined`. `sourceCommitment` is
declared but **never populated anywhere in the codebase** — mining tooling would be its
first writer. Sealed golden fixture exists for the swe-rebench mapping.

**Held-out material is expressible.** Per-artifact access classification
(`accessClass: "public" | "private"`, optional, on each `testMaterial[i]` and on graders)
is implemented in `profiles/src/resource-descriptor.ts`; the `deterministic-process` family
block matches spec §7.2 (digest-pinned image, platform, workspace, test material, strict
parser identity, fail-to-pass/pass-to-pass transitions, timeout). **No `accessClass:
"private"` fixture exists** anywhere — the path is schema-supported but unexercised.

**Extension fields ride without schema changes.** `TaskSpecificationSchema` and the
Submission schema are `.loose()`; payload and provenance objects are
`additionalProperties: true`; sealing serializes the parsed data, so unknown fields survive
the seal round-trip mechanically (no explicit regression test — worth adding if anything
depends on it). Namespacing is *enforced* only inside evaluation-spec family blocks;
elsewhere bare unknown keys are accepted, so TEP §21.3 namespacing is a discipline, not a
guarantee.

**`capabilityGrants` transports but does not redeem.** Implemented on the Submission
(`z.record(z.string(), z.unknown())`), forbidden on the sealed Task. The marketplace binding
transports grant references byte-exactly and never redeems them; the local backend maps them
to a provisioner callback. **Nothing anywhere implements grant hosting, minting, or
redemption** — an application wanting genuinely private evaluation material builds that from
scratch.

**Benchmarking explicitly disclaims task sourcing** (§19 non-goals: "No task-authoring
framework"); Benchmark records reference already-sealed Tasks. Nothing in the stack owns
where tasks come from.

## 3. Requester on-ramp — what a production requester must wire

Probed against `packages/marketplace/binding` at worktree HEAD.

**Exists and is well-built:** `postTask` (digest-join enforcement, broadcast-intent
write-ahead log with atomic claim/fence/resolve, idempotent replay, `createTask` calldata),
`makeMarketplaceBackend` (canonical admission, honor-or-reject gating, TEP-shaped errors),
`createRegistryPinPort` (Autonolas Kubo pinning; CID computed locally, never trusted from
the gateway), `executeSafeTransaction`, pinned `BASE_SEPOLIA_TODAY` chain config.

**Type-only or in-memory — every production consumer must supply these:**

| Gap | State | Cost to close |
| --- | --- | --- |
| `SafeBroadcastPort` | Type only; reference wiring lives in a *test file* | ~35 lines viem tx + `TaskCreated` decode |
| `PostingIntentStore` | In-memory only; durable adapter missing | Real WAL semantics are fully specified, unimplemented |
| `ScanForOnChainMatch` (recovery) | Bare type | Log scan keyed on taskCidDigest + creator |
| `MarketplaceObservePort` | In-memory stub; M4 projector exists but no adapter joins them | Nobody has written the projector→port adapter |
| `PostingTerms` defaults | No exported guidance; rates in wei | Market-signal question, not just code |

None of these were ever promised by M2.4/M2.5 — M2.4 is explicitly "injected ports." Real
wiring for the **requester** side has no named owner.

**Escrow mechanics (corrects a chartering assumption):** escrow is **native ETH via
`msg.value`**, not OLAS — no ERC-20 transfer anywhere in the posting path.
`escrowValue = (solutionRate + verdictRate) × maxClaims`, where `maxClaims` comes from
`Submission.attempts.maxTotal` and **silently defaults to 1**. `createTask` is keyed on
`msg.sender`, so a plain EOA can post; no Safe required. Refunds via
`refundUnusedTaskBudget` reachable when lifecycle ports are wired.

**Evaluation leg:** today-mode allows `minVerdicts: 1` only. Private evaluation material
forces requester-side sealing of the evaluation Submission (`publicSpec: false` ⇒
`sealerRole: "requester"`). The subject Submission must carry an admission-receipt
`ResourceDescriptor` under a named annotation. DSSE signing of Task/Submission is entirely
out-of-band — `submit()` accepts unsigned sealed bytes.

## 4. Legacy pipeline inventory (`client/src/daemon/harvest-loop.ts` and neighbors)

**Stages:** discovery (fix-shaped commit heuristics over a local clone) → extraction (base =
fix^, enforced; unified diff split into gold vs test patch by path) → job persistence
(atomic, staged, crash-safe) → recipe/environment binding → **empirical derivation** (Docker
runs: 2× broken + 2× fixed per test path, run-stability required) → **differential admission
receipt** → admission gates (denylist, public-repo, environment attestation verify, gold-patch
resolves, empty-patch-must-fail discrimination check, image digest mandatory) → mint + IPFS
publish.

**The crown jewel is the differential-admission receipt** (`DifferentialAdmissionReceiptV2`):
per-path stable observations, ≥1 fail-to-pass per path, globally unique assertion ids,
command-hash binding, gold patch present **as digest only**. Pure, Zod-validated,
standalone-ready. It is *ahead of published prior art* — every benchmark's quality story is
"trust our team"; this one is independently checkable.

**Failure taxonomy** (worth preserving wholesale): `terminal_policy` / `awaiting_input` /
`quarantined` / `failed_infrastructure`, with typed awaiting-input reasons.

**Provisional carry-over / re-derive / drop** (lane's classification; a design session rules):
carry the extraction seam, exact-parent guard, staged state machine shape, empirical
derivation, differential receipt, environment binding verifier, sealed public projection;
re-derive the validation checks out of HuggingFace plumbing, the EIP-191/operator-Safe
attestation onto DSSE + trust-layer keys, and the tri-state `published` consent marker;
drop the legacy borrow-an-image bootstrap, v1 rows, HF fetchers, escrow sizing, daemon
shell/config/events. **`publicRowHash` dissolves** — the sealed Task digest is the public
projection hash under the stack.

**Product coupling to shed:** daemon loop and heartbeat, SQLite store and event emission,
config block and env vars, operator Safe identity (`minterSafe`, `sourceSolverSafe`),
Autonolas-specific IPFS, the upstream evaluator-harness clone dependency, marketplace
quotas and posting guards.

## 5. Prior art — the SWE-bench family

| System | Contribution | Numbers worth remembering |
| --- | --- | --- |
| SWE-bench / Verified | Issue+PR mining, 3-gate validation | Human review filtered ~68% of raw instances; 32.7% had solution leakage, ~31% weak tests |
| SWE-rebench (V1/V2) | Continuous automated mining at scale; LLM env-setup; LLM quality classifiers as *metadata* | V1: 153.4k candidates → 21.3k tasks; env setup succeeded for ≥1 task in only **31% of repos**. V2: 32k tasks, 20 languages, pre-built images, ships known-issue flags rather than guarantees |
| SWE-smith | **One environment per repo, then many synthetic instances** | 50,137 instances / 128 repos ≈ **$1,360 total, ~20 human-hours, 295 GB** (vs SWE-gym 2.4k = 6 TB). Procedural AST mutation: **$0.00/instance**, 40% yield. LLM-written statements ≈ real issues (7.7% vs 7.8% resolve) |
| R2E-Gym | Backtranslation (commit → statement); LLM test generation; hybrid verifiers | Execution + LLM-judge verifiers are complementary: 42–43% each, 51% combined |
| SWE-bench-Live | RepoLaunch agentic setup; **time-machine dependency proxy**; repeated-run flakiness gate; monthly refresh | 8,577 repos → 1,319 instances / 93 repos |
| SWE-Lancer | Real paid tasks; held-out end-to-end tests as grader | $1M real payouts; per-task $50–$32k |
| BugPilot | Bugs harvested from agents' *failed feature attempts* | Beats deliberate injection by 4%+ for SFT |

**Standing lessons:** amortize the environment, not the instance; mining yields are low at
every stage and quality-yield lower still; synthetic injection and mining are complements;
freshness is the only proven decontamination; validation must cover the *grader*
(discriminativeness, determinism, runtime caps), not just the bug.

## 6. The RL-environments economy — what the SWE-bench survey missed

**Market size and prices:** ~$8.5B/yr across training-data/environment vendors; Anthropic
reportedly discussing >$1B/yr on environments; per-task **$200–$2,000, up to $20k** for
complex SWE tasks; environments **$20k–$300k**; exclusivity premium 4–5×; RL demand ~10–20×
benchmarking demand. Prime Intellect pays **$1k–$5k bounties per environment** — the open
ecosystem's price floor.

**Emerging standards, neither with verification or settlement:**
- **`verifiers`** (Prime Intellect) — environment as an installable Python package (dataset +
  tools + reward rubrics); **2,500+ community environments**; the largest open corpus.
- **OpenEnv** (Meta PyTorch + HuggingFace, spec 0.1 with public RFCs) — Gymnasium-style
  `reset/step/state` over HTTP, **containerized**, MCP-first; committee spans Meta, Nvidia,
  Microsoft, HuggingFace, Prime Intellect, Mercor, Fleet AI.
- **Harbor / Terminal-Bench** — container + problem statement + reference solution + tests as
  a de facto packaging format.

Interop assessment: a Jinn task (repo snapshot + statement + tests in a pinned container) is
near-isomorphic to a Harbor task and to an OpenEnv container; adapters are thin. Neither
standard has a decentralized verification or settlement story.

**What makes a task valuable as training data (the numbers that should drive curation):**
- Group-relative RL gets **zero gradient** from always-solved or never-solved tasks.
- Useful pass-rate band ≈ **[2%, 70%]**, peak value near **50%**; tasks are commonly
  discarded above ~70%. Steering toward ~50% produced 1.55–2.0× training speedups in one
  study.
- **Difficulty curation beats volume**: 16.4 points of pass@1 between curated and random
  task selection in one code-RL study.
- **Volume needs are modest, returns log-linear**: SWE-Gym gained +12–14 points from **491
  trajectories**; SWE-Dev 13.0% @ 574 → 22.8% @ 16,639. Diversity and freshness sustain the
  curve more than raw count.
- **Buyers rank verifier robustness above difficulty calibration and volume.** Weak tests
  produce reward hacking and proxy gains that do not transfer.

**Environment reliability is the industry's central failure:** Docker build errors average
**36%** of environment-construction failures; best automated setup succeeds on **29.5% JVM /
6.7% Python** repos in one study; SWE-Bench++ recovers 2.37× more deterministic environments
than its predecessor. Strongest reproducibility techniques, in order: pre-built images pinned
by **content digest** (the image, not the Dockerfile, is the artifact); hermetic/Nix builds;
**attested builds** for third-party-verifiable provenance.

**Nobody treats a verified-working environment as a separately-owned durable product**, and
nobody offers third-party-verifiable environment attestation. Closest moves: RepoLaunch
(env per repo, tasks derived monthly) and OpenEnv RFC 008 (auto-validation of environment
quality).

**Graded trajectories barely exist as a product.** Raw developer coding sessions are already
bought and sold; verdict-grounded trajectories — strictly more valuable, RL-ready — have no
public market price.

## 7. Consent and identity standards (retained, now lower-priority)

The session's original framing made repo-owner consent central; the reframe demoted it to an
optional endorsement (see §8). The audit stands and should be reused if and when consent
returns as a load-bearing surface — for private repos, live-work forwarding, or session
mining, where the license does *not* already grant permission.

- **Envelope:** the trust layer is a deliberate monoculture — DSSE + in-toto only, no VC
  stack, no DID resolution. TEP §21.2 names the slot: assertions about records are in-toto
  Statements whose subjects carry record digests. `packages/evidence/attestation-issuer`
  is the worked pattern to copy.
- **Shape:** subject = in-toto `ResourceDescriptor` (`uri` = repo URL, `digest.gitCommit` =
  consented ref tip — standard fields); custom `predicateType` under a Jinn URI. The
  implemented authorization statement can **not** be reused wholesale: its subject schema
  requires `digest.sha256`, and its capability-string model has no typed slot for license or
  ref scope.
- **Identity:** working keys sign; accounts vouch. A GitHub *account* association is always
  `strength: weak` in the trust design — which is why a repo-control proof is a separate
  mechanism.
- **Repo-control proof, ranked:** (1) committed well-known file naming the signer, with the
  record naming the commit — host-agnostic, one fetch, offline-verifiable if archived, but
  proves only that *a* committer endorsed it; (2) GitHub Actions OIDC ceremony — the
  mechanism `gh attestation verify` and Fulcio use, classified *strong* by the trust design,
  GitHub-only; (3) signed git tag; (4) DNS TXT (online dependency, niche).
- **License:** owner-**declared** SPDX expression, with the declared-vs-detected distinction
  explicit (a detector's opinion is a claim, recorded separately if it disagrees).
- **Revocation:** the trust layer already rules that revocation is **never retroactive** —
  effect starts at its own anchor time. That is exactly "delists, never unseals." Composition:
  anchored companion revocation record + discovery delisting + a bounded-staleness freshness
  obligation on the miner. No live revocation endpoint — that would couple verification to a
  service's liveness, which the trust design forbids.

## 8. Session history — the two reframes, and what they invalidated

Recorded so the next session does not relitigate them.

**Framing 1 — "users contribute their repos" (chartered).** Harvesting as the demand-side
twin of capture: repo owners consent, tasks are mined from their public work, the plugin
hosts the flow.

**Collapse 1 — consent is not a feature for public repos.** An open-source license *is* the
permission; SWE-bench mined thousands of repos without asking anyone. The consent ceremony is
legally load-bearing only where the license is missing or unclear, and socially valuable
everywhere — an enhancement, not a product core. With consent demoted, the repo owner drops
out of the v1 loop, and with them the plugin attach point. Mining needs a public clone,
Docker, and compute — none of which must run on the owner's machine.

**Framing 2 — "task-supply pipeline."** Continuous permissionless supply feeding the
marketplace's evidence flywheel.

**Collapse 2 — that is what SWE-rebench already is**, and our own daemon already imports its
rows. Rebench is fully automated commit-echo *plus* the curation layer (heuristic filters,
LLM env setup, LLM quality classifiers) that makes it worth doing. Echo mining without that
layer produces a candidate stream whose majority is flawed. Two operator observations then
redirected the design: **(a)** procedural injection's only prerequisite is a working
environment, and every imported row arrives with one already paid for — so injection is a
*multiplier on import*, not a later stage; **(b)** rebench's real weakness is that the
environments do not reliably work, so investing in environment reliability fixes evaluation
for *all* tasks from that repo at once.

**Framing 3 — verified environments for the graded-evidence economy** (the surviving
framing; the recharter's subject). Three layers: verified environments as the durable asset;
tasks as cheap derivatives (imported, injected, later mined); the marketplace's own graded
attempts as the curation product (empirical pass rate is precisely the difficulty signal
labs pay to compute).

**Decisions taken under framings 1–2, all now reopened:** tier-2 DSSE consent as the core
record; echo-only v1; plugin as primary consumer; public-vs-private test material; problem
statement derivation; license gating; self-farming enforcement (dropped — trivially bypassed,
and the real exploit is activity farming at the reward layer, which no mining package can
fix); import-first sequencing. Each was reasonable for the product it was answering.

**Decisions that survive framing-independently:** mining/verification is a standalone tier-3
capability, not daemon-embedded, whose output is sealed documents (submission stays with the
backend contract); the legacy harvest-loop is frozen reference, superseded at a gate rather
than migrated; nothing may fork stack-owned concerns.

## 9. Q1 session lanes — environment-attestation standards and in-repo shapes

Added after the verified-environment session's Q1 lanes (2026-07-31); the design spec's
§10 audit table points here for supporting facts.

**Image identity.** Pin the platform-specific OCI *manifest* digest — the Merkle root over
config (which contains the uncompressed-layer `diff_ids`) and compressed-layer
descriptors; it is what registries key on. Config digest is not registry-addressable;
layer digests are gzip-nondeterministic across rebuilds; an index digest pins a *set* of
platform manifests (`docker pull image@…` accepts either, resolving an index to the
platform manifest that actually runs). One record per platform: behavior is a per-platform
fact.

**Existing attestation predicates.** in-toto Test Result v0.1 covers one invocation
(`result`, `passedTests[]`, `failedTests[]` — "failed" means failed, not expected-to-fail);
SCAI v0.3 carries evidence-based behavior attributes but with free-form attribute strings;
Runtime Trace v0.1 (early) can evidence network isolation. **No predicate anywhere
expresses K-run repeatability or expected-failure baselines** — that is the bespoke core
of the environment-verification predicate. SLSA Provenance v1 asserts how an artifact was
*built*, deliberately not how it behaves. OpenEnv "RFC 008" (environment auto-validation)
is one sentence of blog intent; no RFC file exists. Prime Intellect's hub has only an
informal pre-publish smoke eval.

**Reproducibility ladder.** Tier 0 pinned image = the industry norm (proves a verifier can
obtain exact bytes and re-run; says nothing about how the image was made). Tier 1
rebuildable recipe + time-travel dependency resolution (SWE-bench-Live's pip-by-date
proxy, `npm --before`, snapshot.debian.org, Nix locks) = behavioral equivalence years
later, but rebuilds do NOT reproduce digests (gzip timestamps, apt metadata). Tier 2
bit-reproducible (SOURCE_DATE_EPOCH + BuildKit ≥0.13 `rewrite-timestamp`, or Nix) = the
recipe⇒digest equation, rare in practice, claimed only when two independent builds hash
identically.

**Flaky-test rerun asymptotics** (the basis for bounded determinism claims): rerun
detection studies report roughly **~26% of flaky tests surface within 10 reruns, ~45%
within 100, ~67% within 1000** — no finite K converges. Taxonomy of causes in Luo et al.,
FSE'14 ([mir.cs.illinois.edu/lamyaa/publications/fse14.pdf](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf));
rerun-asymptotics in the empirical rerun literature (e.g.
[Springer EMSE 2023 rerun study](https://link.springer.com/article/10.1007/s10664-023-10307-w)).
Hence: attestations state "K consecutive identical outcome-sets under controls C" — never
"deterministic" — with K ≥ 5 as the v1 profile and controls (network none, seeds, order,
parallelism, locale/TZ) declared per run.

**OCI referrers interop.** OCI 1.1 referrers can attach a DSSE attestation to an image
manifest discoverable by `oras`/cosign-class tools; 2026 registry support remains uneven
and cosign's OCI-1.1 path is partially experimental — hence the `sha256-<digest>` fallback
tag and the rule that registry attachment is distribution convenience, never source of
truth.

**In-repo shapes (verified 2026-07-31).** The stack has no standalone environment object:
environment content lives inline in the deterministic-process family block, so environment
identity today = the enclosing per-instance EvaluationSpec digest (entangled with grader
fields). The legacy `TaskEnvironmentSpecV1` (`client/src/task-creator/environment/contracts.ts`)
is the closest ancestor — source/inputs/execution/build/publication + EIP-191 attestation
over a canonical `environmentHash`, where build/smoke/scan "pass" fields are claims inside
the signed body, verified by nobody. The tier-2 record-kind minting pattern (trajectory-record
precedent): new leaf package, sealing re-implemented locally with cross-package equivalence
fixtures, kind URI `https://jinn.network/records/<segment>/<major>.<minor>`, media type
`application/vnd.jinn.<segment>.v<major>+json`, storage via family-less `putArtifact`
(closed evidence families untouched), DSSE-signed discovery announcements with a facts-leaf
package ("unknown kinds are not errors"). Legacy determinism evidence: 2×broken + 2×fixed
runs with canonical-JSON-identical repeat observations enforced by differential admission.
