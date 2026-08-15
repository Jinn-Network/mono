# Chain Environment Family — implementation program

- **Date:** 2026-07-31
- **Design (law):** [`../specs/2026-07-31-chain-environment-family-design.md`](../specs/2026-07-31-chain-environment-family-design.md)
  (approved, `b3faed8b0`). A design defect found at planning or implementation time is a
  finding with a proposed disposition — never a silent patch.
- **Parent stack (law):** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  and its program [`2026-07-31-supply-program.md`](./2026-07-31-supply-program.md); the six
  supply packages are merged on `integration/evidence-v1` (`db22e8416`) and are law, not
  drafts. This family adds siblings; it modifies supply units only additively (CF1, CF2).
- **Component plans:** `2026-07-31-chain-ce1…ce6-*.md` in this directory.

## 1. Components

| # | Package / target | Tier | One job | Plan |
| --- | --- | --- | --- | --- |
| CE1 | `@jinn-network/chain-environment-record` — `packages/environments/chain-record` | 2 | The `chain-environment/1.0` **and** `crypto-environment/1.0` (composite) kinds: schemas, local sealing, identifiers, fixtures, kit, discovery facts leaves. Registers in the **existing** `packages/environments/` guard trio (tree already open — do not re-scaffold). | `…-ce1-chain-record.md` |
| CE2 | `state-predicate` family — additive in `packages/task-execution/profiles` | 2/3 | CF1: add `state-predicate` to the family enum, its typed family block, the **pure predicate evaluator** over canonical observations, and the family kit. No chain dependency: the evaluator is pure over observations. | `…-ce2-state-predicate.md` |
| CE3 | `@jinn-network/chain-environment-verification` — `packages/environments/chain-verification` | 3 | §5.1 closed-state protocol + §5.2 archive observation; the attestation predicate; **exports the materializer / probe-executor / replayer ports as public surface** (design §3 — four consumers need them without the protocols). | `…-ce3-chain-verification.md` |
| CE4 | `@jinn-network/chain-state-extraction` — `packages/environments/chain-extraction` | 3 | Archive fork → touched-state harvest → candidate record + state artifact; the §7 widen-and-re-verify loop, invoking CE3's closure check as a library. | `…-ce4-chain-extraction.md` |
| CE5 | `@jinn-network/chain-scenarios` — `packages/task-supply/chain-scenarios` | 3 | The `DerivationStrategy` implementation, scenario templates + parameterization + hardening checklists, and **CF2**: the family-discriminated admission receipt profile plus the injected chain observation port (additive in `task-supply/admission`). | `…-ce5-chain-scenarios.md` |
| CE6 | `@jinn-network/information-world` — `packages/environments/information-world` | 2+3 | The `information-world/1.0` kind, the canonical request key, and the loopback replay service. **Sequenced last (E14)**: the chain-only path proves out first. | `…-ce6-information-world.md` |

No tree scaffolding component: `packages/environments/` and `packages/task-supply/` are
both open and guarded on `integration/evidence-v1`. Each component **registers itself** in
the existing guards (inventory row + dependency graph, boundary sweep, packed-types
entrypoints) — the lesson from the supply program's C6, where a package that skipped
registration was invisible to the tree's boundary guard.

## 2. Phases and topology

Kit-first ordering; every PR targets its base branch, never integration directly (except
the roots). Branch names `chain/ce<N>-<slug>`.

```
integration/evidence-v1
├── chain/ce1-chain-record
│   ├── chain/ce3-chain-verification
│   │   ├── chain/ce4-chain-extraction
│   │   └── chain/ce5-chain-scenarios      (merges ce2)
│   └── chain/ce6-information-world        (last; E14)
└── chain/ce2-state-predicate              (independent: profiles only)
```

**Critical path:** CE1 → CE3 → CE5. CE2 is independent and early (CE5 merges it). CE4 and
CE6 ride beside the path. Restack after a base updates with
`git rebase --onto <new-base> <old-base> <branch>`.

## 3. Pinned interfaces (the cross-component contract)

Changing a pinned name is a program-plan amendment, not a local choice.

- **CE1 produces:** `ChainEnvironmentRecord`, `CryptoEnvironmentRecord` (composite),
  `sealChainEnvironmentRecord(record): Uint8Array`,
  `sealCryptoEnvironmentRecord(record): Uint8Array`, matching
  `parse*` / `*Digest(bytes): \`sha256:${string}\``, `bareHexDigest`,
  `CHAIN_ENVIRONMENT_KIND` / `CRYPTO_ENVIRONMENT_KIND` + media types, port **type**
  declarations (`ChainMaterializer`, `ProbeExecutor`, `ScriptReplayer`) so consumers depend
  on contracts without depending on CE3, fixtures + `./testing` kit, facts profiles.
- **CE2 produces:** `STATE_PREDICATE_FAMILY` (`"state-predicate"`),
  `StatePredicateBlockSchema`, `evaluatePredicates(observation, block): PredicateOutcome`
  (**pure**; no I/O, no chain types), `CanonicalChainObservationSchema`, family kit.
- **CE3 produces:** `CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
  (`https://jinn.network/attestations/chain-environment-verification/v1`),
  `verifyChainEnvironment(deps, record): Promise<SealedAttestation>` where `deps` injects
  `{runtime, artifactStore, signer, clock, verifier}` (host-declared `verifier` per the
  parent's R3), `verifyCryptoEnvironment(deps, composite)` (composite-level: routing
  collisions, whole-world closure), and the **public runtime surface**:
  `createAnvilMaterializer(config)`, `createProbeExecutor(...)`, `createScriptReplayer(...)`.
  Subjects dual (record + state artifact), bare-hex DigestSets, record-subject match rule.
- **CE4 produces:** `extractEnvironment(deps, request): Promise<ExtractionResult>`
  (candidate record + artifact + coverage manifest), `widenAndReverify(...)` implementing
  §7's loop, `ArchiveRpcPort` (injected).
- **CE5 produces:** `chainScenarioStrategy` (satisfying the supply program's
  `DerivationStrategy`), `ScenarioTemplate` + `parameterize(...)`, and in
  `task-supply/admission`: `CHAIN_RECEIPT_PROFILE` + `ChainObservationPort` acceptance
  (additive; admission stays attestation-agnostic and source-agnostic).
- **CE6 produces:** `INFORMATION_WORLD_KIND` + media type, `InformationWorldRecord`
  schemas + sealing, `canonicalRequestKey(request, policy): string`,
  `createReplayService(world, options)` (loopback-only), kit.

## 4. Cross-plan contracts

1. **Designs are law**; defects are findings with dispositions.
2. **Kits and fixtures precede implementations**; a layer's kit is green before dependents
   build.
3. **Sealing is re-implemented per package** with cross-package equivalence fixtures —
   never shared runtime sealing code.
4. **Custody law** — no key material, no ambient authority (incl. no ambient `fetch`, no
   ambient Docker), everything injected, fail closed.
5. **No product names in tiers 1–3**; never import the frozen trio or `client/`.
6. **Digest discipline:** record bodies `sha256:`-prefixed; in-toto DigestSet subjects bare
   hex; every producing package's kit carries the confusion fixture.
7. **Bounded claims** (design D11/E5/E15): no API, log line, or doc says "deterministic",
   "verified", or "authenticated against mainnet" without the qualification the design
   gives those words. `closed-reproducible` means exactly what §5.3 says.
8. **Fixture keys are freshly generated per record, never reused** (design §8); no test or
   fixture may reuse a key across records, and none may be a well-known dev mnemonic
   address that someone might fund.
9. **Register in the existing tree guards in the same PR** — inventory row + dependency
   graph, boundary sweep, packed-types entrypoints, CI job.
10. **TDD per task; verification before completion** — typecheck, tests, kit, guards run
    locally with output shown before any task is reported done.
11. **Stop on missing Consumes** — a symbol not on the base branch is a stop-and-report.
12. **Docker-dependent tests are opt-in and skip cleanly** without a daemon; the kits run
    against fakes (the supply program's C2 pattern: scripted stable / flaky / vanishing
    runtimes).

## 5. Gates

- **Per component:** kit + guards green, then one independent high-effort review against
  the design before dependents merge onto it.
- **Program end:** integrated review, then a **first sealed chain environment**: a real
  anchored-subset world extracted, verified `closed-reproducible` at K≥5 under blackhole,
  with one scenario task admitted against it.
- **CE6 gate:** the chain-only path (CE1/CE3/CE5) proven end-to-end before information
  worlds implement — E14's sequencing, so the composite is exercised with an empty
  `informationWorlds` list first.

## 5a. Rulings (amendments; recorded as component plans land)

**CR1 — accept F-CE5-1: the derivation seam is widened, strictly.** The design's §9 claim
that task-derivation needs "Nothing" is **wrong**, asserted without checking the merged
code. The seam is SWE-monomorphic in three places: `DerivationEnvironment.record` is typed
to the SWE record kind, `Candidate` requires a non-empty `goldPatch` + `failToPass`, and
pool provenance pins `"mined"` with a required `upstream` block. Ruling: **widen, do not
fork** — a second strategy seam would be exactly the duplication the platform law forbids,
and a chain candidate carrying a fake gold patch would be worse. The amendment is
strictly widening and **byte-neutral for the mined path** (C4's golden fixtures must
still pass unchanged, and the plan proves it with a `git diff --stat` acceptance step):
two defaulted type parameters on `DerivationStrategy`; `"synthetic"` admitted to pool
provenance — which merely **restores parity with `repository-work/1.0`'s own payload enum**
(`mined | synthetic | live`), so the pool was narrower than the profile it serves, a
pre-existing inconsistency this family surfaced rather than introduced; and discriminated
pool provenance. `runDerivation` is untouched; CE5 ships its own runner over the same
`SupplyPool`. A dated addendum goes to the design §9 table.

**CR2 (provisional — confirm against CE3's plan) — `abiRef+args` is in v1, and encoding
lives outside CE2.** CE2 deferred `abiRef+args` (CE2-F2, `encodedCall` only); CE5 reports
it *needs* the declarative form because `viem` is banned tree-wide in `task-supply` by the
source-boundary guard, so a scenario package cannot encode calldata — and parameterized
templates (vary the amount) cannot pre-encode at authoring time. Both cannot hold.
Ruling: the declarative `abiRef+args` form ships in v1; **CE2 derives structured read
requests purely, without encoding**, and the observation *producer* (CE3's probe executor
/ replayer, in the `environments` tree, which may hold an encoder behind its runtime port)
performs the encoding. This keeps CE2 pure, keeps `viem` out of `task-supply`, and puts
encoding where the RPC call already happens. Provisional because CE3's plan is still
being authored and may place the encoder differently; confirm at consolidation, and treat
CE2-F2 as reversed either way.

**CR3 — accept F-CE3-12: CE1 widens the port types; CE3 must not fork them.** CE3's
protocol reads seven facts that CE1's `ChainInstance` / `MaterializationRequest` did not
carry. Program §3 puts the port *type* declarations in CE1 exactly so consumers depend on
contracts without depending on CE3 — so when a consumer's protocol needs a fact the type
lacks, **CE1 widens**; a parallel wider interface in CE3 would fork the contract. Adopted:
`ChainInstance` gains a data-only `report` member (verifier-assigned instance id, runtime
identity + `unsupportedControls`, artifact entry index, post-fixture commitment, isolation
report, loaded resources + cost) plus `reset`; `MaterializationRequest` carries the network
policy. Tier-2-safe by construction — data only, no behavior, no I/O types. Ports stay
generic over the observation type (CE2 owns the observation schema). CE1's plan is amended
and pins the widened shapes with a compile-time test so CE3's stop-and-report clears
deterministically. **This subsumes F-CE4-2**, which asked for the post-fixture commitment
from the same handle.

*CR3, as amended by CE1 while adopting it — three corrections, all accepted:*
1. `postFixtureCommitment` and `reset`'s return are `0x${string}`, not `sha256:${string}`:
   §5.1 step 5 compares them **directly** against `initialStateCommitment`, which the
   record spells as `Bytes32`, and a cross-spelling comparison would be an unspecified
   conversion sitting in the middle of a digest check (contract 6).
2. The artifact-entry members are renamed to `accounts` / `codeEntries` / `storageSlots`
   to match `StateEntryCounts` one-for-one, because E13 coverage is computed against that
   census — shapes that don't align one-for-one make the coverage arithmetic silently
   wrong.
3. **`report` is optional on the floor handle**, with `VerifiedChainInstance = ChainInstance
   & {report}` exported from CE1. My ruling as written would have required every consumer
   to produce verifier-only evidence — which would have broken the very seam argument that
   justified the public runtime surface, since the solver's local runner (§3's decisive
   consumer) has no business producing isolation evidence. One declaration, no fork, and
   the non-verifier consumers stay honest.

CE1 also added `requiresStateBackend(record)` (true iff `archive-dependent`) so CE3 and
CE4 key off one rule rather than each deciding independently when a backend is needed, and
`src/ports.test.ts` is the compile-time pin that clears CE3's stop-and-report by
`yarn typecheck`.

**CR4 — accept F-CE4-1: the materializer takes an injected state backend and never dials
a locator.** If the materializer resolved `providerLocators` itself, the archive fetches
would happen inside it and CE4 could not observe them — and **the access journal of that
backend *is* the closure set**, so the harvest would lose its ground truth. It is also
plain custody law: locators are hints a caller may use, never something a library dials.
Ruling: the materializer accepts an injected fork/state backend; CE4 supplies one and reads
its journal. This is what makes CE4's central mechanic decidable rather than heuristic.

**CR5 — two ownership gaps closed at the planners' own request, both accepted.** (a) CE1
delegated the coverage-artifact formats; CE4 pins three runtime-neutral JCS formats. (b)
**CE4 performs the offline trie verification itself and sets `SourceProofManifest.verified`
from the actual walk.** The second is load-bearing: `verified` is sealed *before* CE3 ever
runs, so had CE4 merely propagated the field, "verified" would have meant "we asked the
archive for it" — quietly reopening the forged-slice attack the design's E13 coverage rule
exists to close. A field name is not a proof.

**CR6 — CR2 is not yet discharged.** CE3's plan does not place the ABI encoder, so the
CE2/CE5 conflict (declarative `abiRef+args` vs `encodedCall`-only) stands as ruled but
unimplemented. Before CE2 or CE5 execute, one of them must carry an amendment task placing
encoding in the observation producer per CR2. Tracked here rather than assumed settled.

**CR7 — accept F-CE4-10: `ChainStateBackend.getAccount`'s `storageRoot` becomes
optional.** As declared it is mandatory, and only `eth_getProof` can supply it, which
fails on three independent grounds: **cost** (every distinct account a fork touches pays an
extra proof call), **capability** (extraction fails outright against archives without
`eth_getProof` — precisely the providers CE4's `archive-proof-unsupported` reason exists
for), and **structure** (a revm/Anvil fork backend has nowhere to put a storage root at
all). Optional, with CE4's interim adapter paying and caching the call where a provider
does support it. A required field that one legitimate implementer cannot populate is a
contract defect, not an implementer's problem.

*Two consequences of CR3's rename worth recording, both found by CE4:*
- The aligned buckets bought a **free loader-vs-producer cross-check**: the commitment step
  can assert the loaded census equals the artifact census member-for-member, because a
  mismatch means no census over the artifact is true of the world that actually booted.
- Which only holds if `report.artifactEntries` is populated **from what was actually
  loaded, never from the artifact** — a report derived from its own input cannot validate
  that input. Relayed to CE3, whose adapter produces it.
- CE4 also adopted CE1's absence semantics (`getAccount` returning `undefined`) over
  zero-values, because it matches the EIP-1186 absence-proof path *and* the design's
  boundary rule: an account execution reads and finds empty is legitimate coverage, and the
  sealed world must answer identically.

**CR8 — CR6 discharged; the hand-rolled ABI encoder is accepted with one condition.**
CE3 placed the encoder behind its runtime port (`resolveStateReads` issues one `eth_call`
through the injected transport), so CE2 stays pure and the boundary guard is untouched.
Two mechanisms it added are better than what CR6 specified and are adopted as the rule:
- **Tagging is honoured by execution ordering, not a field copy** — baseline reads resolve
  on the freshly materialized world *before any probe transaction*, post-replay reads
  *after the last script operation*, asserted by a transport-log ordering test. A mis-tag
  is a red test rather than a silent re-opening of the `reportedValue` gaming case.
- **The key corpus gets cross-package equivalence treatment** — a committed
  `fixtures/state-read-keys-v1/keys.json` that CE5 asserts CE2's derivation against (CE5
  being the first branch that can see both packages). This is the house seal-equivalence
  pattern applied to a key, and it is warranted: a key differing by one character makes
  the pure evaluator report `unevaluable` for a read that actually happened.

On F-CE3-13 (hand-rolled encoder over the closed v1 type set rather than a general-purpose
library): **accepted** — the vocabulary is closed, the module refuses ABI features no
predicate can grade, allowed-externals stay tight, and the stated fallback (add `ox`,
delete the module) is a guard edit plus a dependency edit in one PR, not a redesign.
**Condition:** dynamic encoding — head/tail offsets, `bytes`/`string`, arrays, and their
boundary cases (empty array, empty bytes, a dynamic member at the head/tail seam) — is
where encoder bugs actually live, and a wrong encoding does not fail loudly: it calls the
wrong function and the task is graded on that answer. So the golden corpus MUST carry
those adversarial cases explicitly, and where the tree's guard permits a **test-only**
dependency, the corpus SHOULD additionally be differential-tested against an independent
encoder. Spec-derived vectors alone prove the happy path.

### Planning-round observations worth keeping

- **CE4's decidability argument** is a genuine design contribution the spec did not have:
  because out-of-slice reads return empty *deterministically*, a missing-state world is
  **stably wrong** (K blackholed runs agree with each other but differ from the connected
  baseline ⇒ localize and widen) as distinct from **unstable** (runs disagree with each
  other ⇒ terminate `divergence-unexplained` *without spending an archive call*). That
  separates "widen the slice" from "this environment is nondeterministic" using evidence
  already in hand, and it bounds cost on the failure path.
- **The dump is never trusted anywhere.** CE4 treats the injected backend's access journal
  as the closure set and a state dump as an optional cross-check whose disagreements are
  reported (`dumpOmissions`) and can never corrupt the artifact — with a kit scenario
  proving the artifact is complete and digest-identical with the dump port absent.
- **Peer coordination worked without a coordinator round-trip.** CE1 answered CE4's
  interface questions directly, and CE3 relayed CE4 the literal signatures it needed, so
  the plans reconciled against each other rather than against three incompatible guesses.

## 6. Open items carried

- CF1 (profiles family enum), CF2 (admission receipt profile) execute inside CE2/CE5.
- CF3–CF6 are filings, not work items here.
- The Anvil `prevrandao` and dump-fidelity caveats (design §10) are verified at CE3
  implementation against the pinned version, not assumed.
