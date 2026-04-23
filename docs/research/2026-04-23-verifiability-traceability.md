# Verifiability and Traceability in Jinn

**Date:** 2026-04-23  
**Status:** Research — grounds verifiable execution and packaging questions against the Jinn codebase. Not a spec, not a commitment.

## Grounding in Jinn

### 1. WP1 is mostly already built, and it's built per *intent kind*, not universally

Jinn already ships a working executor package for `portfolio.v0`. The schemas
live in [`client/src/types/portfolio.ts`](../../client/src/types/portfolio.ts)
(`portfolio.v0.manifest.v1` and `portfolio.v0.eval.manifest.v1`). The
packaging pipeline lives in
[`client/src/restorer/engine/`](../../client/src/restorer/engine/):

- `packaging.ts` — workingDir provisioning, `OUTPUTS.json` artifact
  declaration, sha256 + IPFS upload, deterministic tarball of the full
  workingDir as `system_snapshot`, `env/` redaction (secrets at mode 0600,
  excluded from the tarball).
- `manifest-assembly.ts` — canonical-JSON serialization, keccak256 signature
  hash, secp256k1 signing via viem, IPFS upload of the signed manifest, returns
  `evidenceHash` (the keccak256) for on-chain commitment.
- `signing.ts` + `canonical-json.ts` — deterministic canonical serialization.
- The `evidenceHash` is written on-chain through `JinnRouter.claimDelivery(v2)`.
  That gives us a cheap, immutable, tamper-evident commitment to the manifest
  bytes without needing an external transparency log.

So for portfolio.v0 today, every restoration run already produces:

- a signed manifest with provenance (intent CID, on-chain creation tx+block,
  requestId, agentEoa, Safe address, window)
- content-addressed artifacts with roles and sha256 digests
- a full deterministic workingDir tarball for replay
- a keccak256 commitment posted on-chain

That is materially a full **verifiable packaging** layer: signed artifacts,
content addressing, tarball, and on-chain commitment — the usual "Tier 1"
auditable packaging story. The missing pieces are real but incremental, not greenfield:

- schema is per-kind; there is no *generic* `jinn.execution.v1` envelope that
  wraps arbitrary intent kinds with a common provenance shell
- no transparency log beyond the chain itself (good enough while
  `evidenceHash` is on chain; matters more if we ever move some evidence off
  chain)
- no SLSA-style build provenance for the executor binary — the manifest knows
  the agentEoa that signed, not the code that ran
- no redaction/selective-disclosure story for x402-gated artifacts beyond the
  access flag (x402 itself, in
  [`client/src/x402/`](../../client/src/x402/), gates fetch access but does
  not encrypt in place)

Treating WP1 only as "define the package" undersells Jinn.
Jinn already has a package. The real WP1 question is: what is the generic
envelope that subsumes `portfolio.v0.manifest.v1`, `prediction.v0.manifest`,
and future kinds, while keeping kind-specific gating fields free?

### 2. Verifiability in Jinn is a gradient by intent kind, not a single property

Abstract "is execution verifiable?" discourse often treats `execute` as a monolith. In Jinn,
execution-verifiability is a function of **what the intent is about**. There
are four distinct regimes already visible in the codebase, and each wants a
different verification story:

| Kind class | Example | External truth source | Attribution mechanism | Strongest achievable claim today |
|---|---|---|---|---|
| Venue-observable | `portfolio.v0` | Hyperliquid API (fills, portfolio grid) | HL api-wallet approval — only approved restorer can place orders in that subaccount | "The scores the evaluator recomputed from HL's live API match the claimed gating fields, re-derived from a spec-locked algorithm" |
| Chain-observable | future DeFi swap kind | L2 state | tx signed by agentEoa | "State transition occurred in a block; agentEoa signed the originating tx" |
| Oracle-resolved | `prediction.v0`, `prediction-apy.v0` | resolution oracle | market + resolver identity | "The resolver's signed resolution matches the claimed outcome" |
| Open-ended | future "the repo is green" | no re-derivable source | PR link, CI run id, pipeline signature | "A signed evidence bundle exists; human or LLM judge rated it PASS" |

This matters for three reasons:

1. Most of the "can you verify execution?" debate collapses if you stop
   treating `execute` as a monolith. Jinn doesn't verify execution; **Jinn
   verifies the gating claims in the manifest**, using a re-derivation
   strategy that depends on the kind.

2. The hardest part — "did the claimed actor *cause* the observed outcome"
   (attribution) — is solved differently per kind and is already explicitly
   flagged as unbuilt in the existing
   [`2026-04-23-outcome-vs-intent-execution-model.md`](./2026-04-23-outcome-vs-intent-execution-model.md).
   For `portfolio.v0` the attribution guarantee is narrow (only the HL
   api-wallet can trade the subaccount, and the manifest binds
   agentEoa → Safe → api-wallet on chain). For open-ended kinds attribution
   is evidence-based and inherently weaker.

3. The generic "verifiable execution" framing skips the question of whether
   we even *need* cryptographic proofs of the restorer's computation. For
   venue-observable kinds, the evaluator's re-derivation against the venue
   is the ground truth. The restorer's own computation is not on the trust
   path; the evaluator's is.

### 3. Two verifiability questions, not one — and the trajectory is the product

Those questions are often collapsed into one. For Jinn there are two, and the answers
are very different.

**Question A — outcome verifiability.** *Did the claimed gating actually
satisfy the intent?* For venue-observable kinds (`portfolio.v0`), the
evaluator can answer this by re-fetching from the venue and re-deriving the
metrics. For chain-observable kinds, the evaluator reads the chain. For
open-ended kinds, the evaluator produces a judgment. This is what the
current portfolio-v0 evaluator at
[`client/src/restorer/impls/portfolio-v0-evaluator/`](../../client/src/restorer/impls/portfolio-v0-evaluator/)
already does: re-derives canonical metrics from live HL state, compares
claimed vs. rederived, emits a check list → verdict.

**Question B — trajectory verifiability.** *Did the execution actually happen
the way the operator claims it happened?* Which tools the agent called, in
what order; which prompts it sent; what responses it got; what it tried and
abandoned; what reasoning it surfaced. This is **not re-derivable by the
evaluator.** It is produced exactly once, at execution time, and never
again. If the operator lies about the trajectory, nobody downstream can
detect it by re-fetching the venue — the outcome can be honest while the
trajectory is fabricated.

The distinction matters because Jinn's packaged product, per
[`spec/2026-04-21-agentic-data-substrate.md`](../../spec/2026-04-21-agentic-data-substrate.md),
is the trajectory corpus, not the outcome set. An outcome-verified but
trajectory-unverified record is approximately worthless to frontier labs
buying training data — an operator can post-hoc fabricate a plausible
trace that ends at a real on-chain outcome, and no amount of re-derivation
finds the lie. Trajectory integrity has to be enforced at production time
or it cannot be enforced at all.

Those two pictures diverge sharply. For `portfolio.v0` viewed as
a trading product, outcome verification is sufficient; the trajectory
doesn't affect correctness. For Jinn viewed as a data substrate, trajectory
integrity is the thing buyers pay for, and it *must* be attested at
execution time.

**What that reframe does to the evaluator's job.** The evaluator gets
smaller and cleaner. Its job becomes *"did this intent complete?"* —
a semantic/outcome question over a trusted trajectory — rather than the
current overloaded job of *"was this computed correctly"* which implicitly
tries to verify the trajectory by re-deriving everything it can and hoping
the rest is consistent. The trajectory's integrity is owned by the
execution layer; the evaluator owns the intent-completion judgment; the
network grades both.

**Where TEE and zk fit in this split.** The primary trust gap for the data
substrate is the **trajectory**. zk proving the trajectory of an open-ended
LLM agent is not feasible today at cost; it needs production-time
**attestation** (TEE). The evaluator kernel is small and deterministic; at
V2 it should run in the **same TEE substrate** as the restorer (§V2b) so
evaluator collusion — a real risk once evaluators have stake — is covered
without a parallel proving stack. **zkVM** proofs of the evaluator re-enter
as a **V3+ insurance** option (hardware-trust diversification, cheap on-chain
settlement) where they add capability beyond TEE; see §V2b.

### 4. Economic verification is already doing most of the work

JinnRouter + OLAS staking + claim deposits + on-chain `evidenceHash`
commitment already gives Jinn the trust substrate of **"sampling-and-slashing"**
economics. Specifically:

- `evidenceHash` on chain means nobody can rewrite the manifest after claim
  without producing a visibly inconsistent IPFS resolution.
- Claims carry stake (via ClaimRegistry / Safe); bad verdicts are slashable
  in principle once the challenge path lands (Phase 1b).
- The two-layer claim (ClaimRegistry + Marketplace) in
  [`client/src/restorer/engine/claim.ts`](../../client/src/restorer/engine/claim.ts)
  already enforces one-claim-at-a-time-per-window, which is the
  prerequisite for challenge economics.

This means the V1 of "verifiable execution" for Jinn is not cryptographic at
all. It is:

- structured signed evidence (shipped)
- on-chain commitment to that evidence (shipped)
- an economically slashable evaluator (in progress)
- challenge period for contested verdicts (Phase 1b)

Cryptographic proofs become interesting as a Phase 2+ upgrade over a working
economic layer, not a replacement for one.

### 5. WP3 as corpus economics, not a self-rewiring default client

One tempting WP3 picture is a default executor that *rewrites its own code*
based on observed network outcomes. That is a product framing borrowed from
another problem. For Jinn, what actually matters from WP3 is already in the
Ritsu data-substrate spec: the accumulated (intent, attempt, evaluation)
corpus is the asset. Whether any single client modifies itself from it is
secondary. The corpus is worth more (and to more people) than a
self-rewriting agent is.

The productive reading of WP3 for Jinn is: **evidence-weighted trajectory
corpus**, where each trajectory's training value depends on the verification
tier of its packaging and verdict. A rough tier ladder:

1. `self-signed` — operator-signed manifest, IPFS-addressed artifacts. Cheap, weak.
2. `committed` — (1) plus `evidenceHash` on chain. Tamper-evident.
3. `consensus` — (2) plus multi-evaluator consensus on the verdict.
4. `attested` — (2) plus the trajectory was produced inside a TEE whose
   remote-attestation quote is bound to the manifest, the operator's
   declared source reproducibly builds to the attested measurement, and
   the verdict was produced by an evaluator running under the same TEE
   substrate. This is the mainnet tier — the tier buyers pay for,
   because every tier below it can in principle be fabricated post-hoc.
   Note: `attested` does not mean "a Jinn-canonical client ran." It
   means "the code the operator claimed to run is the code that ran,
   and that code is publicly auditable." The population of attested
   executors is intentionally diverse.
5. `proved` — (4) plus a zkVM proof of the evaluator kernel. Reserved
   for a V3+ world where hardware-trust diversification or cheap on-chain
   settlement justifies running a second proving pipeline. Not a
   default path; a specialized overlay.

Buyers pay per tier. That is the thing that compounds — not a single
agent's self-modifications.

## What Jinn should actually do

Concrete, ordered, grounded in the existing code:

### V1 — generalize what already works (Phase 1b–adjacent)

1. **Generic execution envelope.** Lift the provenance + signature + window
   + artifact shell out of `portfolio.v0.manifest.v1` into
   `jinn.execution.v1`, with a typed `payload` slot that's kind-specific.
   This is a schema refactor, not new infrastructure. The goal is that every
   kind's manifest shares the outer shape, so a data-substrate consumer can
   query across kinds without kind-specific adapters.
2. **Executor provenance.** Add `executor` metadata to the envelope: code
   digest of the registered `RestorerImpl` (already versioned —
   `RestorerImpl.version`), git SHA of the client, executor name. Thin
   version of SLSA provenance. Zero dependency beyond what we already have.
3. **Evidence tier grading.** Every execution and verdict manifest carries
   a declared evidence tier drawn from the ladder in §5 above
   (`self-signed` → `committed` → `consensus` → `attested` → `proved`).
   V1 only needs `self-signed` and `committed`, but the schema slot must
   exist from day one so higher tiers land cleanly later. Surface the tier
   in the discovery API and subgraph so downstream buyers can filter. This
   is the single most important schema-level unlock for the data-substrate
   thesis.
4. **External-action receipts per kind.** For `portfolio.v0`, document the
   trust path (HL api-wallet approval on the Safe's subaccount) as part of
   the manifest rather than implicit. For any future kind that touches an
   external venue, require the kind-specific adapter to declare how
   attribution works. This is the codification of what
   `2026-04-23-outcome-vs-intent-execution-model.md` already proposes.

### V2 — trajectory attestation via TEE-backed execution

This is the primary V2 work and the place where Jinn's substrate thesis
either earns trust premiums or doesn't.

The claim we need is: *this specific trajectory was produced by the
exact executor code the operator declared, running over these specific
inputs, recorded by the attested environment, and signed as it was
emitted.* That is a remote attestation claim, which is a solved problem
using today's hardware. Crucially, the claim is **not** "a Jinn-blessed
client ran" — it is "the code the operator claimed to run is the code
that ran." Jinn is not trying to constrain the population of executors
to one canonical implementation; it is trying to make the substrate of
trajectories a population of *diverse, verifiably-honest* executions.

**The envelope/implementation split.** What Jinn specifies and what
operators supply are deliberately separated:

- **Jinn owns the envelope.** The `jinn.execution.v1` manifest schema,
  the `jinn.trajectory.v1` structured log format, the attestation-to-
  manifest binding rules, the canonical-JSON serialization, the on-chain
  commitment protocol. These are the protocol-level guarantees that make
  any attested trajectory uniformly ingestible by buyers regardless of
  who produced it.
- **Operators own the implementation.** Which LLM, which agent harness,
  which MCP servers, which tools, which reasoning strategy. Operators
  publish their own stack (source + reproducible build + measurement)
  and the TEE attestation binds execution to *their declared code*.
  Jinn does not maintain a canonical allowlist of approved builds.

This matters because Jinn's substrate thesis depends on operator
diversity. A corpus of 10,000 trajectories from one canonical client is
less valuable training data than a corpus of 10,000 trajectories from a
heterogeneous population of agent designs, each verifiably honest about
what they did. The market sorts execution quality; the protocol enforces
execution honesty.

Concretely, the target is an "attested executor mode" defined at the
protocol level, implementable by any operator:

1. The operator packages their executor as a reproducibly-built image
   whose measurement is derivable from public source. This is the
   single non-negotiable constraint for the attested tier:
   **reproducible build from published source**. Without it, "I
   published source" is an empty claim — an operator could publish
   innocent source and run something else. Standard hygiene applies:
   pinned base images by digest, lockfile-only dep installs, no build
   timestamps, deterministic file ordering.

   **Important terminology note.** "Reproducible" here means
   *build-time* reproducibility — given source S, the compile/package
   step always produces a binary with the same measurement hash. It
   does **not** mean runtime reproducibility. LLM agents have no
   runtime reproducibility (temperature, provider-side non-determinism,
   live external state), and the TEE attestation model does not
   require any. The chain of trust is: operator publishes S → anyone
   can rebuild to verify `build(S) = M` → TEE attests "code with
   measurement M ran" → trajectory is signed by that execution.
   Nowhere do we claim "the same inputs produce the same outputs."
   This is precisely why TEE works where zk cannot: zk proofs require
   the proven function to be a mathematical function (same inputs →
   same outputs), which rules out LLM agents; TEE attestation only
   requires that the code that ran can be identified by hash, which
   is a property of the *build pipeline*, not of the runtime.
2. The operator runs the image inside one of: AWS Nitro Enclaves
   (fastest to ship — AWS-only, but that's a narrow constraint for a
   first cut), Intel TDX or AMD SEV-SNP guest VMs (broader cloud and
   bare-metal coverage), or a managed TEE network like Phala (trades
   operator control for on-chain integration).
3. The enclave emits the remote-attestation quote as part of the
   execution package, binding the enclave measurement to the manifest's
   `evidenceHash` and to the operator's published source reference
   (repo URL, commit hash, build instructions). The envelope gets a new
   field — `attestation` — carrying the quote, the signer certificate,
   the measurements the verifier should match, and the source pointer.
4. Inside the enclave, the executor records a structured trajectory log
   of every tool call, MCP request/response, LLM API round-trip, and
   state transition, **in the Jinn-specified `jinn.trajectory.v1`
   schema**. The log is content-addressed, signed-as-it-grows so a
   mid-run crash still produces a partial-but-valid trace, and uploaded
   to IPFS alongside the existing `system_snapshot` tarball. Envelope
   compliance is enforceable at the manifest-validation layer — an
   operator who doesn't emit a schema-valid trajectory log doesn't get
   attested-tier grading, regardless of their attestation quote.
5. The "Tier 4" evidence tag (§5) is awarded when: (a) the attestation
   quote is valid against its vendor root cert, (b) the measurement
   reproducibly builds from the operator's published source, (c) the
   manifest and trajectory log conform to Jinn's envelope schema, and
   (d) the operator-published source is public and auditable. Nothing
   in this list requires the source to be Jinn-authored.

**Jinn still ships a default reference client.** Many operators will
just run it. The reference client's source, build, and measurement are
published by the Jinn team so those operators get attested-tier grading
without having to manage their own build pipeline. But the network is
*not defined by* the reference client — it is defined by the envelope.

**What this does to the MCP-subprocess question.** Under the operator-
declared-stack model, MCPs are just part of whatever the operator
declared. Their hashes are part of the operator's published measurement.
There is no protocol-level "measured vs unmeasured MCP" distinction to
make; operators publish their full stack including tools, and buyers
reading the published source can see what the tools do. This is substantially simpler than a hybrid "measured canonical client vs
unmeasured MCP" TCB story, and it comes from taking operator diversity seriously.

**Challenger mechanics work cleanly under this model.** A challenger
who suspects a trajectory is fraudulent:

1. Reads the operator's declared source (public requirement for attested).
2. Verifies the source builds reproducibly to the declared measurement.
3. Verifies the TEE quote binds to that measurement.
4. Inspects the source for envelope-compliance violations — does the
   executor actually emit `jinn.trajectory.v1` honestly, or does it
   deliberately mis-log its tool calls?

If the source is clean and the attestation is valid, the trajectory is
genuine even if it is low-quality. "Low-quality execution" is not
slashable; it earns less on the market. "Fraudulent execution" — source
that deliberately lies about what the executor did — is slashable via
the challenge path. The distinction is crisp because the source is
public.

Cost reality: running a TypeScript Node.js client inside Nitro Enclaves is
cheap — enclave VMs price at roughly a 20–40% premium over equivalent
EC2, and a single attestation quote is free to produce. Intel TDX is
cheaper and more widely available but requires more integration work.
Phala is the cleanest story for "decentralized operator runs attested
client" but adds a dependency on their network. None of these are
cryptographic-proof-level expensive; they are "one more deployment mode"
expensive.

**Why attestation has to happen at production time, not via challenger
replay.** The obvious cost-saver — "let most operators run in a regular
OS, let a challenger pull disputed trajectories into an enclave and
re-run them" — is how optimistic rollups work, and it *doesn't
generalize* to Jinn-style agent execution. Three reasons, each
independent:

1. *LLM non-determinism.* Even at temperature 0, Anthropic does not
   guarantee bitwise-identical outputs across runs. Replay of the same
   prompt produces a different response, the agent diverges from the
   original trajectory at step one, and there is nothing well-defined
   to compare against.
2. *Live external state.* Venue APIs, chain state, and the world in
   general move between T₀ and T₁. A replay agent sees a different
   world, makes different decisions, and again has nothing to compare to.
3. *The authenticity gap.* You can try to dodge (1) and (2) by recording
   the original LLM/venue responses in the trajectory and replaying
   against the tape. But now replay verifies only that the trajectory is
   **self-consistent**, not that the recorded inputs were ever real.
   A fabricated tape replays perfectly — the operator chose what to put
   on it.

What non-TEE sampling *can* still usefully do is fraud-*detection*, not
trajectory authentication: rolling on-chain commitments catch retroactive
tape editing, probabilistic LLM-call spot-checks catch implausible
responses, venue-outcome cross-checks catch fabricated fills, cross-
operator consistency checks catch statistical outliers. All of these
raise the cost of lazy fraud. None of them raise a specific self-signed
trajectory to training-grade authenticity. That is why evidence tiers
(§5) are a **market signal with honest grading**, not a universal
slashing target: TEE operators earn at the attested tier, non-TEE
operators earn at self-signed, and buyers price the difference. For
live-money intents like `portfolio.v0` the venue-outcome check is
usually enough and TEE is a premium. For training-data intents — where
the trajectory *is* the product and a sophisticated adversary can use a
real LLM to generate a plausible-but-synthetic trace — TEE production
is the only mechanism that distinguishes real execution from
well-crafted fabrication.

**The LLM-call seam.** The enclave can attest that the client ran and
that it sent/received specific bytes over TLS, but it cannot attest that
the response bytes were honestly generated by the claimed model at the
claimed provider. That is the genuine gap and it is not solved today.
Practical options, in increasing order of strength:

1. Record the exact request body, response body, and TLS handshake
   transcript inside the enclave. This gives a verifier "these bytes
   traveled between client and `api.anthropic.com`." It does not bind
   the bytes to a specific model version. For many training-data use
   cases this is actually enough — buyers care that the prompt/response
   pair is real, not that a specific Claude revision produced it.
2. TLSNotary-style proof over the Anthropic/OpenAI/other API call, giving
   a third-party-verifiable receipt of the server certificate and
   response bytes. Expensive per-call but exists.
3. Frontier labs eventually signing their API responses (Anthropic and
   OpenAI don't today; the pressure for them to do it grows as agent
   networks like Jinn emit training data that buyers want to trust).
   Nothing Jinn can force; worth watching.

The honest answer is that trajectory attestation via TEE + (1) gets us
~95% of the way to a training-grade trace today, and closing the last
5% depends on upstream decisions at the model providers.

### V2b — evaluator attestation via the same TEE substrate

The evaluator kernel — `canonical-metrics.ts` + `checks/*` + `score.ts`
for `portfolio.v0`, and the equivalent deterministic scoring code for
future kinds — is itself verifiable work. It is deterministic, small,
and auditable. The cleanest V2 path is to run it in the **same TEE
substrate** as the restorer rather than standing up a separate zk proving
pipeline.

Concretely: package the evaluator client as its own measured image,
register its build hashes in the same on-chain registry, emit verdict
manifests that carry an attestation quote binding the evaluator
measurement to the inputs (manifest hash, venue snapshot hash, spec hash,
scoring params hash) and outputs (verdict, score, canonical checks). The
network gets evaluator-collusion defense from the same mechanism that
gives it trajectory integrity, reusing the verifier code, the key-binding
flow, and the evidence-tier schema.

Standing up a **parallel** zk proving pipeline for the evaluator would
duplicate what the TEE substrate already provides for a deterministic
kernel. TEE is roughly four orders of magnitude cheaper than zk for that
class of computation, and once the network has attested restorers the
marginal cost of also attesting the evaluator is close to zero. A second
stack only pays for itself if it adds a capability TEE does not; at V2
for Jinn, it does not.

**Explicit non-goal: do not try to prove the restorer's internal
computation.** The restorer runs an open-ended LLM agent. The right
guarantee over it is *attestation of the environment and the I/O*, not a
proof of its internal computation. TEE attestation is the tool; zk is
not.

**When zk re-enters the picture (V3+, insurance-shaped).** There are two
real arguments for adding zkVM proofs on top of a TEE substrate, both
specialized and neither a V2 priority:

1. *Hardware-trust diversification.* If a TEE vendor's attestation root
   is compromised — zero-day across Intel SGX, a disclosed AMD backdoor,
   a legal compulsion against a provider — every attested trace from
   that vendor becomes retroactively forgeable. Porting the evaluator
   kernel to SP1 as a fallback proving path lets the network continue
   producing trustable verdicts (for the deterministic parts of its
   work) even under a TEE-root compromise. You would only produce zk
   proofs for the highest-value verdicts (challenged, sampled, premium
   intents), not by default. This is insurance, not infrastructure.
2. *Cheap on-chain settlement without trusting a TEE verifier.* TEE
   attestation can be verified inside an EVM contract, but the verifier
   is non-trivial code and becomes part of the chain-level trust
   surface. zk proofs (especially Groth16) verify in hundreds of
   thousands of gas with a minimal verifier. If Jinn verdicts grow into
   widely composable DeFi primitives that other protocols consume
   directly on-chain, zk verification has a cleaner story. Jinn does
   not need this today.

The V3-shaped zk engineering work is: port the evaluator kernel to SP1
and measure proving cost against a realistic manifest + HL snapshot
input, so that if/when either of the above arguments becomes real the
path is short. That is research-and-benchmark work, not a proving
pipeline deployment.

### V3 — external-state and LLM-call authenticity

Once trajectory attestation is in place, the remaining authenticity gaps
are at the edges of the attested environment:

1. **LLM-call provenance.** Covered above — enclave-recorded TLS
   transcripts today, TLSNotary over API calls for higher-value intents,
   upstream-signed responses if/when providers ship them. This is the
   highest-value V3 work because it closes the loop on trajectory
   training value.
2. **Signed venue APIs** where they exist. Hyperliquid does not sign
   responses today; if it did, the restorer could attach the signed
   response to the manifest and the evaluator could skip re-fetch
   entirely. Per-venue integration work.
3. **Issuer-signed credentials** for oracle-resolved intents (prediction
   markets, CI systems). Straightforward where the issuer already signs.
4. **TLSNotary** for venues that won't sign. Operationally painful;
   reserve for critical kinds where collusion between restorer and venue
   is a named threat.

None of these are blocked by Succinct, Jinn's own architecture, or token
economics. They are per-integration work that compounds with each new
intent kind.

## What about the "learning client"?

A self-rewriting default executor is a specific product — a fine thing to
build *on top of* Jinn — but it is not the protocol's verifiability or
substrate concern. The protocol-level version of WP3 is:

1. Emit an evidence-tier column on every trajectory in the dataset.
2. Make trajectories queryable by kind + tier + outcome + challenge status.
3. Let anyone — Jinn's default client, an external operator, a lab, a
   research group — consume that stream and train whatever they like.

Self-modifying clients are downstream consumers of that substrate. They do
not need to be blessed by the protocol.

## Critical assessment in one paragraph

Jinn's substrate thesis makes the trajectory, not the outcome, the product
— so the main verifiability question is trajectory integrity, and
trajectory integrity has to be enforced at production time because no
downstream re-derivation recovers it. The right V1 is signed packaging plus
on-chain evidence hashes plus evidence-tier grading (largely shipped at
the `portfolio.v0` layer, needs generalizing). The right V2 is
TEE-attested execution for a meaningful share of operators — which is
feasible today with Nitro Enclaves, Intel TDX, or Phala — with the
evaluator kernel running in the same TEE substrate rather than a
parallel zk proving pipeline.
The right V3 is closing the LLM-call seam through enclave-recorded TLS
transcripts and, where justified, TLSNotary-style receipts. The mistake to
avoid is "prove the restorer's computation" — that is the wrong tool
applied to an open-ended LLM runtime; use attestation for open-ended
runtimes, TEE for the evaluator kernel at V2, and optional zk only where
it adds capability beyond TEE (§V2b). The evaluator's job shrinks to
"did the intent complete," which is actually the right size for it.

## Related material

- [`spec/2026-04-17-portfolio-v0-design.md`](../../spec/2026-04-17-portfolio-v0-design.md) — portfolio.v0 manifest + evaluator spec (the reference implementation of this model)
- [`spec/2026-04-21-agentic-data-substrate.md`](../../spec/2026-04-21-agentic-data-substrate.md) — data-substrate thesis; evidence grading is the unlock
- [`docs/research/2026-04-23-outcome-vs-intent-execution-model.md`](./2026-04-23-outcome-vs-intent-execution-model.md) — the outcome-vs-intent framing this note builds on
- [Succinct / SP1 docs](https://docs.succinct.xyz/) — for the zkVM path
- [SLSA](https://slsa.dev/) / [in-toto](https://in-toto.io/) — for the
  generic envelope refactor
- [RATS / EAT](https://datatracker.ietf.org/wg/rats/about/) — if TEEs ever
  become relevant
