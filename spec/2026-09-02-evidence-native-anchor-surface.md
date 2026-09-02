# Evidence-native anchor surface: what issue #2974 actually needs

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-02 |
| **Author** | Autopilot implementation session for [#2974](https://github.com/Jinn-Network/mono/issues/2974) (seams read against the attempt base `316ced2c3`) |
| **Shape** | `design` — the session dispatched as `fix` found the work is an allocation, not a fix. This note is the artifact; no code moves with it |
| **Status** | Proposed — blocked on the four rulings in §4 |
| **Answers** | issue [#2974](https://github.com/Jinn-Network/mono/issues/2974) |
| **Depends on** | [pluggable integrity providers](../docs/superpowers/specs/2026-08-17-pluggable-integrity-providers-design.md) §7.4, §8, §19.5, §19.7; [`packages/benchmark-product/PUBLIC-BUNDLE.md`](../packages/benchmark-product/PUBLIC-BUNDLE.md) §"Anchored bundle v6" and §"Evidence-native bundle v5 and its two profiles" |
| **Does not do** | Allocate anything. Change any frozen format, identifier, check tuple, or sealed record. Touch the sealed Demo-1 artifacts |

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

So #2974 is that later allocation. It is `design`-shaped and needs the rulings
in §4 before any code is written. The issue is currently typed `fix` with
Effort `Medium`; on the evidence below it is at least `feat` / `High`.

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

## 2. What the allocation costs

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

What does not exist is four frozen public identifiers, none of which can be
changed after publication:

| # | Identifier | Why it is needed |
|---|---|---|
| 1 | a bundle format, next free `benchmark-product-public-bundle/9` | `/5` plus the `anchors/<sha256>.bin` closure and the eighth check |
| 2 | a claim package, next free `benchmark-product.claim-package/7` | `/3` plus an `anchors` section and an eight-name `verification.checks` tuple |
| 3 + 4 | two profile IRIs under `https://spec.jinn.network/profiles/…/9`, full-evidence and metadata-first | `/5` declares its profile in its own bytes; the anchored successor must do the same for both forms |

Plus code across three packages: generalizing `evaluateIntegrityAnchors`
(`packages/benchmark-product/verify/src/anchor/check.ts`) off its hard-wired
`SUBJECT_KINDS` map of `lock`→`RUN_RECORD_KIND` / `matrix`→`MATRIX_RECORD_KIND`
and its `runSha256` / `matrixSha256` input onto a taxonomy parameter; a `/9`
branch in `packages/benchmark-product/verify/src/verify.ts` and
`packages/benchmarking/evidence/src/portable.ts`; anchor sealing and carriage in
`packages/benchmark-product/core/scripts/demo1-export-public-bundle.mjs`; the
`freeze-repo` capability table and `reader-instructions.ts`; and the
PUBLIC-BUNDLE.md format section, whose own rule is that every format carries its
complete recipe pinned at the reader line that understands it. That reader line
does not exist on npm either — the `/9` row would land as "publication pending",
which `/7` and `/8` already do, so it is an accepted in-repo state but it does
mean the *live* bundle cannot be verified by any released reader until a
`@colophon-claims/verify` release ships.

## 3. The blocking conflict: the splice-catch refuses this anchor

Design §8 step 4, implemented at `check.ts` ("4. The splice-catch"), is
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

No available reading is free:

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

## 4. The four rulings needed

1. **Allocate or decline** identifiers 1–4 of §2. Allocating four frozen public
   identifiers — a bundle format, a claim package, and two profile IRIs — is a
   governance act, not an implementation detail.
2. **Resolve §3** — (a), (b), or (c). This decides whether #2974 is achievable
   at all, so it gates the other three rather than following them.
3. **Sanction a producer path for an already-reported run.** Design §19.5 closes
   the anchoring window at `report` and `runAnchor` enforces it; §19.7 lists
   anchoring an already-published bundle as future work. The Demo-1 report is
   reported. Sealing these proofs therefore needs either an explicit,
   narrow republication path or an explicit exception — and either way a ruling
   that re-emitting the published artifact under a new identity digest is
   intended, since the bundle identity is the SHA-256 of `bundle.json` and every
   citation of the current identity changes.
4. **Decide the OTS half** (the issue's second acceptance criterion). The three
   calendar proofs are still `pending`. Options: upgrade them to
   Bitcoin-attested before republication and carry the upgraded bytes; carry
   them pending, which the claim's `anchors` section renders as `pending` and
   which passes; or carry only the RFC 3161 token and document the calendars as
   held-but-uncarried. Note the reader never upgrades a pending proof and never
   contacts a provider, so a pending proof stays pending in every reader forever
   unless the bundle is republished again.

## 5. What was deliberately not done

No identifier was allocated, no format or claim schema was extended, no check
semantics were changed, and the sealed Demo-1 artifacts were not touched. All
four are byte-frozen public surfaces whose wrong first draft is permanent, and
three of the four rulings above have no "nearest existing convention" to follow
— the convention that exists (§3, applied verbatim) refuses the anchor the issue
exists to carry.
