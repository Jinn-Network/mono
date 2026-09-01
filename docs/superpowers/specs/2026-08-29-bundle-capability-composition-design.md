# Bundle Capability Composition — parts, not pre-baked closures

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-29 |
| **Author** | Autopilot design session (Claude Opus 5); seam citations read against the attempt base of `autopilot/2889` |
| **Shape** | `design`. Output is this spec; implementation lands as a separate packet (§13) |
| **Status** | proposed — needs operator decision on D1–D4 (§14) |
| **Issue** | [#2889](https://github.com/Jinn-Network/mono/issues/2889) |
| **Depends on** | [benchmark product design](./2026-08-05-benchmark-product-design.md); [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md); [pluggable integrity providers](./2026-08-17-pluggable-integrity-providers-design.md); [disclosure specification record](./2026-08-19-disclosure-specification-record.md) §12.2, which records the exclusion this design removes |
| **Pairs with** | [#2869](https://github.com/Jinn-Network/mono/issues/2869) (neutral freeze-announcement surface / anchored lock registry) — that design adds a capability; this one decides how capabilities are carried |
| **Does not do** | It defines no new evidence record, no new check semantics, and no new claim content. Every capability named here already exists or is already designed elsewhere; this design changes only how a bundle *declares* which of them it carries and how a verifier *derives* what to check |

## 0. Decision in plain language

A public bundle today says what it is by picking a number. `…/2` is the base
graph. `…/4` is the base graph plus binary qualification. `…/6` is the base graph
plus anchors. `…/7` is the base graph plus both. Each number is hand-allocated,
each carries its own hand-written member list, its own hand-frozen check array,
its own claim-package schema id, and its own reader-instruction line. Capability
is encoded in the *choice of number*, which means capability does not compose:
every new pairing is a new number, and the number of numbers doubles with each
capability added.

The proposal is to stop encoding capability in the number and start **stating it
in the bundle**: one new format, `benchmark-product-public-bundle/8`, whose
manifest carries an explicit, canonically ordered, must-understand
**capability vector**. Members, grammars, checks, claim-package sections, and the
minimum reader release are then *derived* from that vector by one registry that
producer, verifier, and every reader surface share.

This is not a new idea in this codebase. `…/5` already made exactly this move on
its own lineage: it declares a `profile` IRI in its own `bundle.json` because
"which members a reader must find is a fact the bundle states rather than one the
reader infers from what happens to be present"
(`packages/benchmarking/protocol/src/portable.ts:92-95`). This design generalizes
that already-adopted principle from one binary choice to an open, ordered set,
and applies it to the classic lineage where the combinatorial cost is being paid.

Fail-closed exhaustiveness — the property the closure model was bought for — is
not weakened. It is relocated: from hand-enumeration in source to a
must-understand token rule at read time plus a generated lattice at test time
(§9). An old verifier still refuses a `/8` bundle outright. A new verifier still
refuses a bundle whose capability vector names anything it does not fully
implement, and still refuses a bundle that declares a capability without its
members or carries a capability's members without declaring it.

## 1. Problem

### 1.1 Three enumerations, coupled, each doubling

Adding one capability today means allocating in three separate namespaces, and
each allocation must cover every combination with the capabilities that already
exist.

**Bundle format numbers** — `packages/benchmark-product/core/src/bundle/manifest.ts:18-37`:

| Number | Composition |
|---|---|
| `/2` | base graph |
| `/3` | accounting-only publication profile — a different lineage, unrelated to this axis |
| `/4` | base + qualification |
| `/5` | evidence-native — a different lineage, with its own manifest schema and `profile` declaration |
| `/6` | base + anchoring |
| `/7` | base + qualification + anchoring |

**Claim-package schema ids** — `core/src/report/claim.ts:64-81`: `/1` (base),
`/2` (qualification), `/4` (anchoring), `/5` (qualification + anchoring), with
`/3` spent on the evidence-native lineage. The same 2×2, allocated a second time
in a second namespace, with the numbers not even in correspondence.

**Verifier check lists and reader instructions** —
`verify/src/reader-instructions.ts:1-9,39-49,63+`:
`PUBLIC_BUNDLE_VERIFICATION_CHECKS`, `PUBLIC_BUNDLE_V6_CHECKS`,
`PUBLIC_BUNDLE_V7_CHECKS`, plus a per-format `command` /`compatibleCommand`
record. `verify/src/outcome.ts:43-49` then re-enumerates the same formats a
fourth time to compute the denominator a reader sees.

Three capabilities would need eight format numbers, eight claim-package ids,
eight check lists, eight reader-instruction rows, and eight fixture families. The
issue's "each added capability doubles the combination matrix" is literal, and
it is paid three times over.

### 1.2 It has already cost a real exclusion, and then a real allocation

The disclosure-specification record recorded the anchored-plus-qualification
exclusion as a shipped product limitation: an anchored, qualified bundle "has no
closure version and cannot be published"
([disclosure record](./2026-08-19-disclosure-specification-record.md) §12.2). The
operator ruled the exclusion accepted and directed this refactor be filed as the
structural fix. Since then `/7` was minted (#3205) to remove that one cell — and
`claim-package/5` with it, because "before this number existed an anchored run of
a binary-instrument benchmark could not produce a claim at all"
(`core/src/report/claim.ts:73-80`). The prediction in the issue is now observed
behavior, not a forecast.

The same document also proposed disclosure as `/7`. That number is now taken by
a different capability pair. Disclosure has no allocation and, under the current
model, needs three of them (`base+disclosure`, `+qualification`,
`+anchoring`, `+both` — four, minus none already free).

### 1.3 The seam that already exists

Both ends of the pipeline already think in capabilities and only the wire format
does not.

- The producer computes two independent booleans and collapses them through a
  nested ternary into one of four literals
  (`core/src/bundle/materialize.ts:1064-1073`), under a comment that says in
  plain words: "Two independent axes … neither axis reinterprets the other."
- The verifier immediately re-expands that literal back into the same two
  booleans (`verify/src/verify.ts:427-432`) and drives every downstream decision
  from them: mandatory member list (`:433`), evidence-catalog grammar (`:439`),
  anchor allowlist (`:456`), trust grammar (`:477`), qualification checks
  (`:488,537`), and the `integrity-anchors` push (`:1748`).

The format literal is a lossy, hand-maintained encoding sitting between two
sides that both already speak the composed language. Removing it is a
simplification, not an addition.

## 2. What the closure model bought, and must keep buying

Five properties. Any composition model that drops one is not an improvement,
and each is called out again in §6 with the mechanism that preserves it.

- **P1 — Unknown-shape refusal.** A reader that does not fully implement a
  bundle's shape refuses it whole. It never prints a partial pass over bytes it
  did not understand. Today this is bought by the format literal: an unknown
  string fails the manifest union at `verify/src/manifest.ts:32-38`.
- **P2 — No silent downgrade.** Removing a capability's members from a bundle
  must be a closure *failure*, never a quieter but still-passing bundle. Today
  bought by member lists frozen per format — and stated explicitly for anchoring,
  where a declared-but-empty anchor set stays on the anchored closure precisely
  so stripping cannot drop the bundle to a version with nothing to say
  (`PUBLIC-BUNDLE.md`, anchored bundle v6).
- **P3 — No extraneous member.** A file matching a capability's path shape in a
  bundle that does not carry that capability is refused, not ignored. Today:
  "an anchor member in a v2 or v4 bundle is a non-allowlisted file"
  (`verify/src/verify.ts:453-454`).
- **P4 — Honest check accounting.** The denominator a reader is shown is derived
  once, centrally, from the bundle's own shape — never counted by the surface
  doing the printing, "because a surface that counts for itself is a surface that
  can print a pass over bytes nobody read"
  (`verify/src/outcome.ts:36-40`, issue #2986).
- **P5 — Truthful reader instructions.** The verification command a claim names
  must be a release that can actually verify that bundle. `/7` pinning `0.2.1`
  unconditionally, rather than inheriting an older line, is this property being
  enforced by hand (`core/src/report/claim.ts:456-465`).

## 3. The model

### 3.1 Lineage, then capability

Composition is defined **within a lineage**, not across all format numbers.

- **Classic public bundle** (`/2`, `/4`, `/6`, `/7`, and the proposed `/8`) — the
  Run/Matrix/Report graph. This is the lineage the capability model applies to.
- **Accounting-only publication profile** (`/3`) — a different projection with a
  different minimum closure. Out of scope; unchanged.
- **Evidence-native** (`/5`) — its own graph, its own manifest schema, its own
  seven checks, and its own two profiles. Out of scope for the cutover; §12
  records it as the natural second adopter.

Treating these as three lineages rather than seven points on one axis is what
keeps the lattice small. `/3` and `/5` are not "the base graph plus something".

### 3.2 Capability vector

`/8`'s manifest is `/2`'s manifest — `format` and `files` — plus one field:

```json
{
  "format": "benchmark-product-public-bundle/8",
  "capabilities": ["anchoring", "binary-qualification"],
  "files": [ { "path": "...", "sha256": "...", "bytes": 0 } ]
}
```

Rules on the field itself:

1. **Required and closed.** The manifest schema is a `z.strictObject`, following
   `/5` (`packages/benchmarking/protocol/src/portable.ts:111-118`), not the open
   legacy object. An unknown top-level member is refused.
2. **Canonical.** Tokens are lower-kebab, unique, and sorted by code unit. The
   manifest is already required to be canonical JSON bytes, so a differently
   ordered or duplicated vector is a different byte string and is refused before
   any capability logic runs.
3. **Possibly empty.** `"capabilities": []` is the plain base graph — the exact
   closure `/2` describes. The empty vector is spelled, not omitted, so "no
   capabilities" is a statement rather than an absence.
4. **Authenticated.** `bundle.json` is the authenticated root and the bundle
   identity is the SHA-256 of its own bytes. Editing the vector changes the
   bundle identity and breaks every digest binding above it. The vector is
   therefore exactly as tamper-evident as the file list already is.
5. **Must-understand.** Every token is critical. A verifier that does not
   implement a token in the vector refuses the bundle whole (§6, P1). There is
   no "ignore what you don't know" tier and none is reserved.

## 4. The part inventory

A **capability** is a registry entry. The registry is one module, imported by
producer, verifier, claim builder, and reader surfaces, so no site re-spells a
member list or a check name.

Each entry declares:

| Field | Meaning |
|---|---|
| `token` | stable wire string; never reused, never renamed |
| `order` | integer fixing this capability's position in derived check lists and claim sections; total across the registry |
| `requires` / `conflicts` | tokens that must / must not co-occur |
| `mandatoryFiles` | exact member paths this capability adds |
| `memberPatterns` | path shapes this capability allowlists (e.g. `anchors/<sha256>.bin`), with a `mayBeEmpty` flag |
| `refines` | zero or one *refinement target* (§5.2): a named member whose grammar this capability replaces |
| `claimSection` | the claim-package section key this capability adds, present iff declared |
| `checks` | ordered check names this capability appends |
| `minimumReaderRelease` | first `@colophon-claims/verify` release implementing this token |
| `activation` | the producer-side predicate on run state that turns it on |

### 4.1 Registered capabilities

**`binary-qualification`** — from `/4`. Adds `qualification.json`. Refines the
evidence-catalog grammar (`BundleV4EvidenceCatalogSchema` for
`BundleEvidenceCatalogSchema`) and the trust grammar, and extends the mandatory
member list (`PUBLIC_BUNDLE_V4_FILES`). Adds the `qualification` claim section.
Adds **no** top-level check: "v4 expands those checks internally rather than
adding a seventh top-level result" (`PUBLIC-BUNDLE.md`). Activation: the run
projects a binary qualification. Minimum reader: `0.1.0`.

**`anchoring`** — from `/6`. Allowlists `anchors/<sha256>.bin`, `mayBeEmpty:
true`. Adds the `anchors` claim section and the `integrity-anchors` check.
Refines nothing. Activation: the sealed Run carries at least one AnchorEvidence
record **or declares anchoring intent** — the declared-but-absent rule of
`PUBLIC-BUNDLE.md` is preserved verbatim, and §5.3 explains why the model needs
it. Minimum reader: `0.1.0`.

**`disclosure-specification`** — designed, unallocated
([disclosure record](./2026-08-19-disclosure-specification-record.md)). Adds the
sealed six-variable record as an evidence-catalog role and a claim-package
section, and adds the `disclosure-specification` check. Refines nothing.
Activation: the draft carries a disclosure declaration; opt-in, so a bundle
without one is byte-identical to the bundle it is today. Minimum reader: the
release that implements it. **This capability is the first that costs one
registry entry instead of four format allocations, and it is the acceptance test
for this design.**

**Future** — the anchored lock registry (#2869) and anything after it register
the same way. The registry is the only file a new capability's *carriage* edits;
its semantics still land wherever they belong.

### 4.2 What is deliberately not a capability

The `/5` profile pair (full-evidence vs metadata-first) is a *subtractive*
choice within one closure — the same format, the same grammar, the same seven
checks, differing only in which artifact bodies are carried. Capabilities here
are additive or refining, never subtractive; a subtractive knob whose omission
still passes is P2's failure mode. If the classic lineage ever needs one, it
gets a `profile` field of its own, following `/5`, not a capability token.

## 5. Interaction rules

### 5.1 The lattice is not free

Capabilities are not uniformly orthogonal, and pretending otherwise is how a
composition model becomes less safe than the enumeration it replaced. Two
kinds exist.

- **Additive** (`anchoring`, `disclosure-specification`): contribute members,
  claim sections, and checks. Touch nothing that already exists. Any two
  additive capabilities compose unconditionally.
- **Refining** (`binary-qualification`): replace an existing member's grammar
  with a narrower one, and extend the mandatory member list.

### 5.2 One refiner per target

**Registry invariant:** at most one registered capability may declare a given
`refines` target. Two capabilities refining `evidence.json`'s grammar is a
design-time conflict, caught by a registry test that runs on every build, not a
runtime surprise discovered by a publisher. When a second refiner of the same
target is genuinely wanted, the resolution is an explicit merged grammar with
its own token, decided deliberately — the same decision the closure model forced,
made at the same moment, but without spending a format number to record it.

This is the honest limit of the model, and it is stated up front: composition is
free on the additive axis and gated on the refining axis. The current two-axis
matrix is exactly one refiner and one additive, which is why it composed cleanly
into `/7`; a design that assumed all future capabilities would be as friendly
would be lying.

### 5.3 Declaration is authoritative; presence is derived

The vector says what the bundle carries. Member presence is then *required* by
each capability's own rule, never used to infer the capability. This is
`/5`'s stated principle and it is what makes P2 mechanical rather than
case-by-case: anchoring's `mayBeEmpty: true` means a declared anchoring
capability with zero anchor members is a valid, fully-checked bundle that
reports its lock subject as declared-but-absent — and stripping the declaration
is not a downgrade to a quieter bundle, it is a different bundle identity.

### 5.4 Determinism

`order` gives the registry a total order. Derived check lists, derived claim
sections, and the canonical vector are all sorted by it (tokens by code unit in
the wire vector; by `order` in derived lists). Two producers on the same registry
version emit byte-identical manifests for the same run.

## 6. Generic verification

The verifier's classic-lineage path becomes: authenticate bytes, read the
vector, resolve it against the registry, then run one composed closure check.
Each step names the property it preserves.

1. **Resolve, or refuse (P1).** Every token in the vector must resolve to a
   registered capability in *this* build. One unknown token ⇒ refuse the bundle
   whole, with the token named. `requires`/`conflicts` are evaluated here; an
   unsatisfiable vector is refused before any member is read.
2. **Compose the expected closure.** `mandatoryFiles` = base ∪ each capability's
   contribution. `allowlist` = base patterns ∪ each declared capability's
   `memberPatterns`. Grammars = base, with each `refines` target replaced by its
   single declared refiner.
3. **Two-way closure (P2, P3).** Every expected path must be present; every
   manifest path must be expected. This is today's rule at
   `verify/src/verify.ts:464-465`, unchanged in mechanism and computed over the
   composed sets rather than a per-format constant. Because the allowlist is
   built only from *declared* capabilities, an `anchors/…` member in a bundle
   that did not declare `anchoring` is non-allowlisted — P3, preserved exactly.
   Because `mandatoryFiles` is built from declared capabilities, a declared
   capability whose members were stripped fails as a missing member — P2,
   preserved exactly, with `mayBeEmpty` the single explicit exception each
   capability opts into in the registry rather than in the verifier.
4. **Run checks in composed order.** Base checks, then each declared
   capability's `checks` by `order`. The emitted `checks` array is compared for
   exact equality against `expectedChecks(vector)`; a mismatch is a refusal, not
   a shorter list.
5. **Report (P4).** `summarizeVerificationOutcome` calls `expectedChecks(vector)`
   for its denominator. The per-format ternary at `verify/src/outcome.ts:43-49`
   collapses to one call, and every reader surface keeps reading this one
   derivation rather than counting for itself.

## 7. Reader instructions and check lists

Both were per-format constants; both become derivations over the vector.

- **Checks.** `expectedChecks(vector) = BASE_CHECKS ++ flatten(declared, by
  order)`. `PUBLIC_BUNDLE_V6_CHECKS` and `PUBLIC_BUNDLE_V7_CHECKS` become the
  values this function returns for `["anchoring"]` and
  `["anchoring","binary-qualification"]`. Their frozen definitions are retained,
  unchanged, in the legacy module (§10) and additionally pinned as expected
  outputs of the new function, so the cutover is provably behavior-preserving on
  the cells that already exist.
- **Minimum reader release.** `minimumRelease(vector) = max(base,
  max(capability.minimumReaderRelease))` under semver order, and the claim's
  `verification.command` is derived from it. A linear registry column replaces an
  exponential instruction table, and P5 becomes arithmetic instead of a hand
  audit: `/7`'s "no released reader before 0.2.1 understands this" stops being a
  comment a future author must remember to write.
- **Compatible line.** Same derivation at major granularity. A vector whose
  minimum release has no released compatible major carries no
  `compatibleCommand`, rather than naming an older line that would fail.

## 8. Claim package

One new id, `benchmark-product.claim-package/6`, for `/8`. Its sections are
`claim-package/1`'s base plus one optional section per capability, with the
**biconditional** rule: capability declared ⟺ its section present. A declared
capability with a missing section is refused; an undeclared capability's section
present is refused. That is `claim-package/5`'s inherited-refusals behavior
(`PUBLIC-BUNDLE.md`, anchored binary qualification v7) generalized, and it is the
claim-side spelling of P2 and P3.

The section *contents* are unchanged. `claim-package/2`'s F6 qualification
projection and `claim-package/4`'s `anchors` section move across verbatim,
including `qualification.json` keeping its frozen
`benchmark-product.claim-package/2` literal — that field names which projection
shape the graph was built for, and that shape does not change here.

`verification.checks` and `verification.command` in the claim are pinned exactly
as today, but against `expectedChecks(vector)` and `minimumRelease(vector)`
rather than against a per-format constant. The four hand-written guard blocks in
`core/src/report/claim.ts` (`:372-385`, `:456-475`, and their siblings) collapse
into one guard parameterized by the vector.

## 9. Exhaustiveness: from hand-enumeration to generated lattice

The closure model's real product was not the numbers; it was that a human had
written down, per shape, exactly what must be there. Composition must reproduce
that certainty without reproducing that labor.

- **At read time**, exhaustiveness is the must-understand rule plus the two-way
  closure over composed sets (§6). Nothing is inferred, nothing is skipped, and
  an unimplemented token is a refusal rather than a gap.
- **At test time**, exhaustiveness becomes *generated*. A conformance test
  enumerates every subset of the registry that satisfies `requires`/`conflicts`
  and, for each, asserts: the composed member list, the composed check list, the
  claim section set, the derived minimum release, and — for every capability *not*
  in the subset — that planting one of its members is refused as non-allowlisted
  and that declaring it without members is refused as a missing member. That is
  2^n generated cases for n capabilities, and it covers the cells nobody
  hand-wrote fixtures for, which is precisely where the enumeration model was
  weakest: `/7` needed a new fixture family before its combination could be
  tested at all.
- **Registry invariants** run in the same suite: unique tokens, total `order`,
  at most one refiner per target (§5.2), `requires` closure acyclic, every
  `minimumReaderRelease` a real published release.
- **Legacy pinning** stays: the existing conformance kit under
  `verify/fixtures/public-bundle-conformance-v1/` and every tampered variant
  continue to run against the legacy path unchanged, and the golden `/2`, `/4`,
  `/6`, `/7` bundles are additionally asserted to be *byte-identical* after the
  refactor.

## 10. Migration

The governing rule is the one the anchored and qualification closures already
followed: **existing bundles never change**. No re-materialization, no
re-signing, no digest churn.

1. **Freeze the legacy path.** Move the `/2`, `/4`, `/6`, `/7` constants, member
   lists, check arrays, claim-package ids, and reader-instruction rows into one
   `legacy-closures` module on each side. It is verification-only: the producer
   stops importing it, the verifier keeps it forever, and its conformance
   fixtures keep running. Nothing in it is edited again.
2. **Add the registry and `/8` behind a flag.** Producer emits `/8` only when
   explicitly asked. Both paths live; the legacy path is still the default.
3. **Prove equivalence.** For each legacy cell, materialize the same run both
   ways and assert the composed closure has the same member set, same check list
   in the same order, same claim sections, and the same verification outcome.
   Assert the legacy golden bundles are byte-identical.
4. **Cut over.** New bundles emit `/8`. This is the decision point D1 (§14); the
   recommendation is a clean cutover rather than dual-emit, because dual-emit
   does not retire the zoo — it freezes it while continuing to pay for it, and
   the issue's impact statement is about the third experiment onward. The
   precedent is `/7` itself: it already accepted "no released reader before
   0.2.1 understands this format" as a shippable cost, so the composed
   generation requiring its own reader line is not a new kind of cost.
5. **Land disclosure as a capability.** The disclosure record's S2 packet
   registers one entry instead of allocating format numbers, and the §12.2
   non-goal is discharged: an anchored, qualified, disclosure-bearing bundle is
   simply the vector that names all three.

Rollback at any point before step 4 is deleting the flag. After step 4, the
legacy path is still present and still the verifier's default for legacy
formats, so rollback is flipping the producer default back.

## 11. Worked example

A run that is anchored, projects a binary qualification, and carries a
disclosure declaration:

```json
{
  "format": "benchmark-product-public-bundle/8",
  "capabilities": ["anchoring", "binary-qualification", "disclosure-specification"],
  "files": [ "…bundle.json's usual authenticated list…" ]
}
```

Derived, with no new allocation anywhere: mandatory members = base ∪
`qualification.json` ∪ the disclosure record's member; allowlist additionally
admits `anchors/<sha256>.bin`; `evidence.json` and the trust document parse under
the qualification grammars; checks = the six base checks, then
`integrity-anchors`, then `disclosure-specification`; claim package is
`claim-package/6` carrying `qualification`, `anchors`, and the disclosure
section, and no others; the pinned command is the max of the three minimum
releases.

Under the current model this bundle needs a new format number, a new
claim-package id, a new check array, a new reader-instruction row, and a new
fixture family — and it is the *eighth* such cell, of which four would still not
exist.

## 12. Boundaries

- **No new semantics.** No check changes what it means. No record changes shape.
  No claim says anything it could not say before. This design moves carriage
  only, and any capability's behavior question belongs to that capability's own
  spec.
- **`/3` and `/5` are untouched.** `/5` is the natural second adopter — it
  already declares a profile and already adopted the anchor surface in its own
  allocation (`core/src/report/claim.ts:68-71`) — but bringing it onto the
  registry is a separate decision after the classic lineage has shipped one
  composed generation.
- **Not a plug-in surface.** The registry is in-repo and compiled in. A bundle
  cannot introduce a capability a verifier build does not already implement;
  that is the must-understand rule and it is the point, not a limitation to fix
  later.
- **License law.** Program constraints carry unchanged; nothing here admits
  third-party bytes into any schema, fixture, or document.

## 13. Implementation sequencing

Five stacked packets. Each is independently verifiable and independently
revertible; none weakens an invariant to make a slice easier to land.

| # | Packet | Content | Gate |
|---|---|---|---|
| C1 | Registry + derivations | Capability registry module, `expectedChecks`, `minimumRelease`, composed member/allowlist/grammar resolution. No wire change. Registry invariant tests. | Registry invariants green; derivations reproduce `PUBLIC_BUNDLE_V6_CHECKS` and `PUBLIC_BUNDLE_V7_CHECKS` exactly |
| C2 | Legacy freeze | Extract `/2`,`/4`,`/6`,`/7` constants and per-format guards into `legacy-closures` on both sides. Pure move. | Full suite green; legacy golden bundles byte-identical; conformance kit unchanged |
| C3 | `/8` verifier | Strict manifest schema with the vector, must-understand resolution, composed two-way closure, composed check run, `outcome` denominator via the derivation. Generated lattice conformance suite. | 2^n lattice green, including every undeclared-member and stripped-member refusal |
| C4 | `/8` producer + `claim-package/6` | Vector emission from activation predicates, biconditional claim sections, derived `verification` pins. Flagged off by default. | Equivalence proof (§10 step 3) for all four legacy cells |
| C5 | Cutover + docs | Producer default to `/8`; `PUBLIC-BUNDLE.md`, `EXTERNAL-VERIFICATION.md`, `README.md`, `schemas/bundle-manifest.schema.json`, `docs-consistency.test.ts` pins updated; verifier release cut. | Docs-consistency green; released verifier reads a real `/8` bundle end to end |

Disclosure's S2 packet then lands as one registry entry plus its own semantics,
with no allocation work at all. That is the measurable payoff and the check on
whether this design did its job.

## 14. Decisions needed

- **D1 — Cutover shape.** Clean cutover at C5 (recommended, §10 step 4), or
  dual-emit where the four legacy cells keep their numbers indefinitely and `/8`
  carries only new combinations? Dual-emit preserves the `@0.1` reader line for
  the common case and costs a permanently forked producer.
- **D2 — Timing against #2869.** The anchored lock registry design adds a
  capability. Does it register into this model (implying C1–C4 land first), or
  ship as `/9` under the current model with a follow-on migration?
- **D3 — Disclosure's dependency.** Does the disclosure S2 packet block on C1–C4,
  or take a format allocation now and migrate later? The issue's timing note —
  after the judge-report program, before a third experiment mints another
  closure — reads as blocking; confirming that is an operator call.
- **D4 — `/5` adoption.** Confirm the evidence-native lineage stays out of scope
  for this program, as §12 assumes.
