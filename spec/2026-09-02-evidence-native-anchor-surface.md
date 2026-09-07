# Evidence-native anchor surface: what issue #2974 actually needs

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-09-07 (v0.1: 2026-09-02) |
| **Author** | Autopilot implementation session for [#2974](https://github.com/Jinn-Network/mono/issues/2974) (seams read against the attempt base `2112f8468`) |
| **Shape** | `design` — the session dispatched as `fix` found the work is an allocation, not a fix. This note is the artifact; no code moves with it |
| **Status** | Adopted — the four questions v0.1 raised are ruled on [#2974](https://github.com/Jinn-Network/mono/issues/2974). Implementation follows against `benchmark-product-public-bundle/10` and is not in this document's scope |
| **Answers** | issue [#2974](https://github.com/Jinn-Network/mono/issues/2974) |
| **Depends on** | [pluggable integrity providers](../docs/superpowers/specs/2026-08-17-pluggable-integrity-providers-design.md) §7.4, §8, §19.5, §19.7; [`packages/benchmark-product/PUBLIC-BUNDLE.md`](../packages/benchmark-product/PUBLIC-BUNDLE.md) §"Anchored bundle v6" and §"Evidence-native bundle v5 and its two profiles"; the composed/capability generation `benchmark-product-public-bundle/10` (issues #3403 → #3406), which does not exist yet |
| **Does not do** | Allocate anything. Change any frozen format, identifier, check tuple, or sealed record. Touch the sealed Demo-1 artifacts. Define `/10` itself |

## 0. The finding in plain language

The issue asks for the published Demo-1 report to carry the freetsa RFC 3161
token and the three OpenTimestamps calendar proofs that already sit in
`docs/superpowers/plans/demo-report-1/anchors/`, and for the reader's
`integrity-anchors` check to pass against the public bundle.

Both halves of the issue's own suggested remedy are unavailable today:

- **"existing proofs sealed in"** — the published bundle's format,
  `benchmark-product-public-bundle/5`, has no anchor surface. Its claim,
  `benchmark-product.claim-package/3`, pins `verification.checks` as a fixed
  seven-name tuple with no `integrity-anchors` slot
  (`packages/benchmarking/protocol/src/portable.ts`). An `anchors/` member
  added to a `/5` bundle would be manifest-integrity-checked and otherwise
  inert: no check would read it, and the claim could not name it. That is a
  decorative anchor, which is worse than none.
- **"or the report republished on format /6"** — `/6` is the anchored member of
  the *classic* lineage (`/2` → `/4` → `/6` → `/7` → `/8`), whose closure is the
  v2 Run/Matrix/Report graph. Demo-1 is evidence-native: its records are
  Benchmark v2, Analysis Manifest, Cohort, Matrix v2 and Report v3, and it has
  no `run.json`. There is no re-emission of this report onto `/6`.

This is not an oversight. The approved design records it twice as deferred
work: §7.4 ("the evidence-native claim-package/3 and public-bundle/5 adopt the
same anchor surface in their own later allocation") and §19.7 ("The
evidence-native closures adopt the anchor surface in their own later
allocation"; "anchoring evidence for already-published historical bundles is
future work").

So #2974 is that later allocation. It is `design`-shaped, and the four rulings
it needed are now made (§4). The issue is currently typed `fix` with Effort
`Medium`; the implementation that follows this note is at least `feat` / `High`.

## 1. The anchor is real and it resolves

Verified in this session, offline, against the committed bytes:

```
$ openssl ts -reply -in lock-manifest.tsr -text
Policy OID: tsa_policy1
Hash Algorithm: sha256
Message data: 822b2f7469dc2e58a3e72eee32688614d296ba20fc381d9a074e3935a68622b3
Serial number: 0x070E8A18
Time stamp: Aug 18 11:11:07 2026 GMT
```

That imprint is exactly
`E1-demo1-preregistration.v1.json` → `digests.analysisManifest`
(`sha256:822b2f74…22b3`), which is the digest of the published bundle's
`analysis-manifest.json`. The proof dates the right bytes. Nothing about the
proof needs re-obtaining; only a surface to carry it is missing.

## 2. What the surface costs

Two record kinds the anchor's subject taxonomy needs already exist and are
already pinned, so the subject map for the evidence-native lineage is fully
determined and needs no allocation: `lock` →
`BENCHMARK_ANALYSIS_MANIFEST_RECORD_KIND`
(`https://spec.jinn.network/records/benchmark-analysis-manifest/v1`) and
`matrix` → `MATRIX_V2_RECORD_KIND`
(`https://spec.jinn.network/records/benchmark-matrix/v2`), both in
`packages/benchmarking/protocol/src/identifiers.ts`. Note that both differ from
the classic pair the check hard-wires today (`RUN_RECORD_KIND` and the *v1*
`MATRIX_RECORD_KIND`), so the taxonomy is genuinely a second one rather than a
reuse.

v0.1 of this note costed the surface as **four** frozen public identifiers — a
bundle format `benchmark-product-public-bundle/9`, a claim package
`benchmark-product.claim-package/7`, and two profile IRIs. Ruling 1 (§4)
removes all four. Under the capability rule the surface mints **no public
identifier of its own**: it registers as a capability entry inside the composed
generation `benchmark-product-public-bundle/10`, exactly as `external-import`
registers inside `/8` (#3417) rather than minting a format. `/10`'s own
allocation — its format IRI, its claim package, its profile IRIs, and the
mechanism by which a capability entry becomes bundle-visible — belongs to
the #3403 → #3406 chain and is a prerequisite of this work, not a product of
it.

What remains is code, across three packages, plus documentation:

- **`packages/benchmark-product/verify/src/anchor/check.ts`** — generalize
  `evaluateIntegrityAnchors` off its hard-wired `SUBJECT_KINDS` map of
  `lock`→`RUN_RECORD_KIND` / `matrix`→`MATRIX_RECORD_KIND`, and off its
  `runSha256` / `matrixSha256` input names, onto an explicit taxonomy
  parameter carrying both the subject→kind map and the subject→digest pairs.
  This is a pure generalization: the classic lineage passes today's taxonomy
  and its behavior is unchanged. It also carries the §3 splice-catch policy
  (below) as an explicit taxonomy field rather than an unconditional rule.
- **`packages/benchmark-product/verify/src/verify.ts`** and
  **`packages/benchmarking/evidence/src/portable.ts`** — a `/10` branch that
  selects the evidence-native taxonomy when the anchor capability entry is
  present.
- **`packages/benchmark-product/core/scripts/demo1-export-public-bundle.mjs`** —
  anchor sealing and carriage, under the §4 ruling-3 re-report path.
- **`packages/benchmark-product/verify/src/freeze-repo.ts` and `packages/benchmark-product/verify/src/reader-instructions.ts`** — the
  reader flags (`--tsa-root`, `--ots-headers`) the entry activates.
- **`packages/benchmark-product/PUBLIC-BUNDLE.md`** — the `/10` section, whose
  own rule is that every format carries its complete recipe pinned at the
  reader line that understands it. That reader line will not exist on npm when
  the entry lands, so the `/10` row arrives as "publication pending", which
  `/7` and `/8` already do. It is an accepted in-repo state, but it does mean
  the *live* bundle cannot be verified by any released reader until a
  `@colophon-claims/verify` release ships. The §3 divergence below must be
  stated in this section and in the reader's own output.

## 3. The splice-catch, and the rule that resolves it

Design §8 step 4, implemented at `check.ts` ("4. The splice-catch"), is today
unconditional for a lock anchor whose time basis is `authority-time`:

> `facts.genTime` must satisfy `genTime <= closeAt`, else `invalid`.

For Demo-1:

- `genTime` = `2026-08-18T11:11:07Z` (§1).
- The Analysis Manifest's `closeAt` = `SKILLSBENCH_DEMO1_SEALED_AT` =
  `2026-08-18T00:00:00.000Z`
  (`packages/benchmark-product/core/src/method/skillsbench-demo1-seal.ts`).

`genTime > closeAt`. Applied verbatim, the rule marks the only real anchor this
report has as **`invalid`**, and an `invalid` anchor fails the whole
verification. The remedy the issue asks for would, implemented naively, break
the bundle it is meant to strengthen.

The conflict is semantic, not arithmetic. In the classic lineage `closeAt` is a
Run's own pre-registered close instant, and an anchor obtained after it is
genuinely suspicious. In the evidence-native lineage `closeAt` is the sealed
*source cutoff* — here a nominal midnight — and the ordering discipline the
report actually claims is documented in
`docs/superpowers/plans/demo-report-1/anchors/README.md`: a first confirmatory
dispatch that began ~10:45 UTC was destroyed unread, and dispatch restarted only
after the 11:11:07 token existed. The anchor precedes every retained cell; it
does not precede the declared cutoff instant.

Three readings were available, none free:

- **(a) Do not apply the splice-catch against `manifest.closeAt` in the
  evidence-native closure.** The anchor carries, and the report gains the
  attested date it holds. Cost: the eighth check is weaker on this lineage than
  on the classic one, and the difference must be stated in PUBLIC-BUNDLE.md and
  in the reader output, or Legibility regresses.
- **(b) Apply it verbatim.** The check keeps one meaning across both lineages.
  Cost: this anchor can never be carried as a lock anchor, and #2974 closes as
  "cannot be satisfied for this report" — the honest outcome, but the report's
  seal date stays operator-clock only, forever.
- **(c) Compare against something other than `closeAt`** — the earliest retained
  evidence instant, say. Strictly better evidence, but it is a new rule, not an
  adaptation of an approved one, and nothing in the bundle currently surfaces
  that instant as a sealed, comparable field.

**Ruled: (a).** The disclosure obligation it carries is not optional and is
part of the deliverable, not a follow-up:

1. The taxonomy parameter of §2 carries the splice-catch as an explicit field,
   so "this lineage does not apply it" is a stated property of the closure
   rather than a missing branch someone can restore by accident. The classic
   taxonomy keeps the rule; the evidence-native taxonomy does not carry it.
2. `PUBLIC-BUNDLE.md`'s `/10` section states the divergence in the same place
   it pins the check tuple: on this lineage `integrity-anchors` does not
   include the splice-catch, and why.
3. The reader's own `integrity-anchors` output says so for a `/10` bundle, so a
   consumer who never reads `PUBLIC-BUNDLE.md` still learns that this check is
   the weaker of the two forms. An anchor whose meaning is narrower than the
   reader assumes is the failure mode this ruling has to avoid.

## 4. The four rulings, as made

Recorded on [#2974](https://github.com/Jinn-Network/mono/issues/2974) and
reproduced here so no session re-litigates them.

1. **Allocation — the surface is a capability entry inside `/10`.** The
   composed/capability generation takes `benchmark-product-public-bundle/10`,
   and features register as capability entries inside it rather than minting
   format numbers. (`/9` was allocated by PR #4090 for the declared/strict
   denominator pair before the rule was posted, and is grandfathered.) The four
   identifiers §2 of v0.1 costed are therefore **not** minted. A session that
   finds it genuinely needs a new generation number stops and escalates rather
   than allocating one.
2. **Splice-catch — option (a)**, with the three disclosure obligations of §3.
3. **Producer path — one documented re-report of Demo-1.** Design §19.5 closes
   the anchoring window at `report` and `runAnchor` enforces it; §19.7 lists
   anchoring an already-published bundle as future work. Demo-1 is reported, so
   the seal needs an explicit narrow path rather than a relaxation of the
   window: a single, documented re-report of this one artifact. Re-emitting the
   published bundle under a new identity digest is intended and sanctioned —
   the bundle identity is the SHA-256 of `bundle.json`, so every citation of
   the current identity changes, and the re-report must say so where the old
   identity is cited.
4. **OTS — RFC 3161 only for now.** The three OpenTimestamps calendar proofs
   are still `pending`, and the reader never upgrades a pending proof and never
   contacts a provider, so a pending proof stays pending in every reader
   forever unless the bundle is republished again. The re-report carries the
   freetsa RFC 3161 token only; the calendars are held-but-uncarried and
   documented as such in
   `docs/superpowers/plans/demo-report-1/anchors/README.md`. This satisfies the
   issue's second acceptance criterion by its "explicitly documented" branch.
   Carrying them Bitcoin-attested remains available to a later re-report and is
   not foreclosed.

## 5. What lands, and in what order

This note is the whole of #2974's `design` output. The implementation is
sequenced behind a prerequisite that does not exist yet, so it is deliberately
not attempted here.

| # | Work | Blocked on |
|---|---|---|
| 1 | The `/10` generation itself — format, claim package, profile IRIs, capability-entry mechanism | issues #3403 → #3406; **not this issue** |
| 2 | Generalize `evaluateIntegrityAnchors` onto an explicit taxonomy (subject→kind map, subject→digest pairs, splice-catch flag), classic behavior unchanged | nothing; it is a pure refactor, but it has no second consumer until 3, so it lands with 3 rather than speculatively ahead of it |
| 3 | The anchor capability entry: `/10` branches in `verify.ts` and `portable.ts`, the evidence-native taxonomy, the reader-flag activation, the `PUBLIC-BUNDLE.md` `/10` section with the §3 divergence stated | 1 |
| 4 | The documented re-report of Demo-1 carrying the RFC 3161 token, and the citation updates the new bundle identity forces | 3 |

Acceptance criterion 1 of the issue — the published artifact carrying its
anchors and the reader's `integrity-anchors` check passing against the public
bundle — is satisfied by rows 3 and 4 and cannot be satisfied before row 1
exists. Acceptance criterion 2 is satisfied now, by ruling 4 and the README
update that lands with this note.

## 6. What was deliberately not done

No identifier was allocated, no format or claim schema was extended, no check
semantics were changed, and the sealed Demo-1 artifacts were not touched. All
are byte-frozen public surfaces whose wrong first draft is permanent. The
generalization of `evaluateIntegrityAnchors` (row 2 above) was also not written:
it is correct and small, but with no second taxonomy to serve until `/10`
exists it would be a speculative abstraction, and the design rule here is that
a surface is generalized by its second consumer, not in advance of one.
