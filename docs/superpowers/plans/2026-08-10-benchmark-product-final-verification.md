# Standalone Benchmarking Product — Final Verification Evidence (2026-08-10)

This is the BP-52 local verification record for the standalone benchmarking
product. The [program ledger](./2026-08-05-standalone-benchmarking-product-program.md),
[design authority](../specs/2026-08-05-benchmark-product-design.md), and product
charter v0.2 remain authoritative. This document records evidence; it grants no
remote, release, extraction, deployment, or merge authority.

## 1. Verdict and authority boundary

**Local implementation verdict:** the M0–M5 product scope is implemented and the
BP-52 fail-fast verification is green on Node 22.23.1. The product demonstrates
complete and cancelled real-local-venue journeys through the optimized private
web app, a complete real-local-venue public CLI quickstart, and portable bundle
verification after source-workspace deletion.

**Program state:** BP-00–BP-52 are integrated locally and M0–M5 are complete.
The fresh program-wide reviewer issued PASS after two red-first correction rounds.
The branch is implementation-complete but remains subject to the merge-readiness
caveats in §9.

Local implementation only. No base refresh was performed. No branch or tag was
pushed; no PR, Issue, Project, release, package, repository, deployment, or live
infrastructure was created or mutated. Remote effects: none.

## 2. Baseline, resumption, and final local state

- Program lineage fork: `1fb3e78f13b804db7a0583cacacff5c39dc8c51e` from
  `integration/evidence-v1`. The charter-stated earlier baseline remains an
  ancestor; the ledger records the exact orientation.
- First-session interruption: product head `bc0868d62`, with M0/M1 complete,
  M2 at BP-21, 538 tests, BP-22 mid-implementation, and BP-30 awaiting review.
  The committed handoff moved the session branch to `a7758fa7b` without changing
  that product state.
- Resumption mechanics: the successor read the handoff, full ledger, complete
  design including every §12 addendum, and charter before resuming BP-22. It
  continued in hierarchy mode with synchronous child completion, no monitors,
  and a fresh non-author review for every packet. The ledger discloses each
  coordinator takeover or flattened completion where an agent wedged.
- BP-52 exact clean base: `cb9cea5a5ae8807ea1d07d098866683bea1d74a6`
  on `bench/bp52-final`.
- Charter v0.2 SHA-256:
  `ed53a37942db3a6bcccd70a702b2f9c5c3f407002be8bb5bf8bc9d6dfd33eaa8`.
- BP-52 identified two previously unproven cross-packet claims before editing:
  the optimized browser did not prove a real cancelled publish/copy/delete/
  standalone-verify path, and the extraction/issue-plan authorities were not in
  product-CI path filters or structurally pinned. Both now have deterministic
  coverage.
- The first independent BP-52 review then caught two P1 omissions: this final
  evidence record did not itself trigger product CI, and teardown trusted a
  replayable marker at a replaced same-path browser root. Both received valid
  red-first regressions and identity-fenced corrections. The second review passed
  the CI correction but found the filesystem ownership receipt could self-certify
  replacement inodes. Its deterministic probe became a third red-first P1
  correction: setup-controller memory is now the only ownership trust anchor.
- The reviewed BP-52 delta comprised nine files: the product CI path filters, documentation
  consistency tests, optimized production browser journey, Playwright setup/
  configuration, removal of the separate teardown module, browser ownership
  implementation and tests, and this evidence record. It was committed in its
  packet worktree as `52185b1b1` and integrated locally as `c09e89703` only after
  the final independent PASS.

## 3. Product outcome by perspective

| Perspective | Verified outcome | Honest boundary |
|---|---|---|
| Sponsor | Can define two or more pinned configurations, select assurance, preview, quote, lock before outcomes are known, authorize gated actions, and publish a portable comparative claim. | The local venue proves real execution and disciplined accounting, not owner-independent preregistration or party independence. |
| Operator | Can complete the lifecycle through the private responsive GUI, see live dispatch and drain, recover via typed guidance, inspect results/dissent/limitations, and locally publish a bundle. | There is no hosted service or deployment; arbitrary-path standalone verification remains a CLI/library capability. |
| Delegated agent | Can use 27 generated operations through the packed core/CLI surface with stable JSON success/error envelopes, authority checks, attributed audit, and four exit classes. | `bundle verify` is deliberately a standalone CLI/library exclusion from workspace GUI parity, not a hidden 28th operation. |
| Skeptic | Can copy the immutable digest-addressed bundle, delete the source workspace, and independently re-run manifest, evidence-closure, trust, matrix-rederivation, report-verification, and claim-consistency. Raw authenticated records and neutral static assets preserve adverse facts. | Public means locally materialized and distribution-ready, not uploaded, hosted, endorsed, or confidential. |

## 4. Milestone and acceptance evidence

| Milestone | State | Machine-backed outcome |
|---|---|---|
| M0 | complete | Product design, Tier-4 catalog member, package skeleton, product CI, package/source guards, and `publishPolicy: never`. |
| M1 | complete | One core state machine, packed CLI, real two-arm/six-cell local run, sealed Matrix/Report/claim, and tamper-refusing verification. |
| M2 | complete | Pure disclosed previews, honest quotes, all four assurance presets, retained dissent/conflict, durable cancellation, and complete terminal accounting. |
| M3 | complete | Private Next.js app is a server-side client of the core public entry only; setup through publish is wired without GUI-owned benchmark semantics. |
| M4 | complete | Frozen `public-bundle/1` with five deterministic assets, authenticated raw-record closure, public trust material, and copied-bundle standalone verification. |
| M5 | complete | Accessibility/security contracts, operator/agent/bundle/security docs, public quickstart, extraction dry run, issue drafts, BP-52 cross-cutting battery, and fresh program-wide PASS. |

BP-52 acceptance matrix:

| Acceptance | Evidence | Result |
|---|---|---|
| Audit integrated M0–M5 before editing | Gap inventory in §2; edits limited to the two proof gaps and this record | PASS |
| Clean Node 22 core/web/backend battery | §7 exact package commands and counts | PASS |
| Real built-CLI public flow | `yarn public-quickstart`, 17 steps, six cells, copied bundle after source deletion | PASS |
| Optimized real browser complete flow | Production Playwright, real local venue, Report/publish/copy/delete/six checks | PASS |
| Optimized real browser cancelled flow | Active generation and dispatch observed; requested → draining → cancelled; all six cells terminal; cancellation marker; publish/copy/delete/six checks | PASS |
| Honest static presentations | Deterministic complete/partial/cancelled fixtures plus conflicted/adverse mirrors and neutral no-winner assets | PASS |
| Adversarial portability | Focused 8-file/79-test matrix in §8 | PASS |
| GUI/CLI/library parity and boundaries | 27 generated operations; standalone exclusion; family/type/pack guards | PASS |
| Documentation and issue coverage | Seven documentation consistency tests; required BP-20–BP-52 drafts and all three product-plan CI paths pinned twice | PASS |
| No remote or canonical-generation effects | Generated check, diff/status sweep, local-only execution | PASS |

## 5. Packet and review record

The detailed correction evidence is append-only in the
[program ledger](./2026-08-05-standalone-benchmarking-product-program.md).

| Packet | Outcome | Independent non-author review |
|---|---|---|
| BP-00 | product design | PASS after one blocking correction, two rounds |
| BP-01 | core skeleton/guards/CI | PASS; non-blocking notes dispositioned |
| BP-10 | workspace/lifecycle/authority | PASS; non-blocking notes dispositioned |
| BP-11 | intake/sample/import | PASS + confirmed PASS after one should-fix |
| BP-12 | real official run path | NEEDS CHANGES → PASS; flattened completion disclosed |
| BP-13 | Report/claim/verify | FAIL-with-fixes → PASS |
| BP-14 | CLI real-venue evidence | NEEDS CHANGES → PASS; flattened packet disclosed |
| BP-20 | preview/quote | PASS after three non-blocking corrections |
| BP-21 | assurance/dissent | PASS-WITH-FIXES → PASS |
| BP-22 | cancellation/accounting | repeated NEEDS CHANGES → PASS after 11 material fixes plus lock audit |
| BP-30 | web skeleton | NEEDS CHANGES → PASS plus staged-integration re-review |
| BP-31 | setup/preview/quote/lock GUI | PASS |
| BP-32 | live run/cancel/collect GUI | NEEDS CHANGES on five blockers → PASS |
| BP-33 | results/Report/verify GUI | NEEDS CHANGES on four blockers → PASS |
| BP-40 | portable public bundle | three correction rounds → PASS on fourth review |
| BP-41 | static claim assets | NEEDS CHANGES twice → PASS |
| BP-50 | accessibility/security | NEEDS CHANGES twice → PASS |
| BP-51 | docs/quickstart/extraction | NEEDS CHANGES → PASS |
| BP-52 | final cross-cutting verification | NEEDS CHANGES on two P1 blockers, then one receipt-trust P1 on re-review; all corrected red-first; final independent re-review PASS; integrated locally |

No packet change was integrated without a PASS. Reviews found material defects
from BP-12 onward, validating the independent-review gate. The coordinator took
over final assembly only after documented idle/wedge handling and always returned
the corrected delta to an independent reviewer before integration.

## 6. Architecture, dependency, and interface parity

```text
private web (server actions) ─┐
                             ├─> @jinn-network/benchmark-product-core
built CLI -------------------┘             │
                                           ├─ public platform package seams
                                           ├─ mutable private workspace + sealed CAS
                                           └─ immutable public-bundle/1 + portable verifier
```

- The Tier-4 core operations library is the sole product state-machine,
  validation, authority, audit, accounting, Report, claim, and verification
  implementation. Web and CLI are peer clients; the web has one direct Jinn edge,
  to the core package root on the server.
- Core composes public benchmarking, task-admission, task-execution, and trust
  packages. Package/source guards prohibit deep imports, browser-side core use,
  API-route bypasses, other-product coupling, copied platform predicates, and any
  Tier-1–3 inward reference to the product.
- Mutable drafts and journals remain private. Locks seal Run bytes before results;
  collection seals Matrix bytes; reporting seals Report and Claim; publication
  emits an allowlisted immutable closure. A portable verifier consumes the frozen
  bundle bytes and public keys without the source workspace.
- The generated capability matrix contains 27 generated operations with GUI and
  CLI dispositions. All 27 are current. Standalone `bundle verify` is the one
  explicit non-workspace capability exclusion.
- The five public assets are projections of stored authenticated facts only:
  semantic HTML report, badge SVG, social-card SVG, README, and share text. They
  do not choose a winner or recompute product conclusions.

## 7. Verification evidence

All commands below ran fail-fast with
`/Users/adrianobradley/.nvm/versions/node/v22.23.1/bin` first on `PATH`.
Runtime: Node `22.23.1`; package manager: Yarn `4.13.0`.

| Surface | Exact command family | Final result |
|---|---|---|
| Portal dependency chain | build protocol → trust/core → environments/record → task-execution profiles/backend/supervisor/workspace/launchers/admission/interop → evidence chain → evaluation harness/adapters → backend-local assembly → benchmarking run/local | GREEN in required build order |
| Core | `yarn install --immutable`; `yarn typecheck`; `yarn test`; `yarn build`; `yarn check:parity`; `yarn pack:smoke` | Final rerun: 68 files / 680 tests; typecheck/build green; 27 parity entries current; installed-package platform/branding/dependency smoke green |
| Web | `yarn install --immutable`; `yarn lint`; `yarn typecheck`; `yarn test`; sentinel `yarn build`; sentinel `yarn test:browser` | 13 files / 72 tests; optimized seven-route build; Playwright 3/3 |
| Local backend assembly | immutable install; typecheck; test; build; pack smoke | 15 files / 116 pass, one platform skip; pack boundary green |
| Family guards | package inventory + source boundaries | 13/13 |
| Packed public types | `.github/scripts/benchmark-product-packed-types.test.mjs` | 1/1; one public code entry across one product package |
| Architecture generator tests | `.github/scripts/generate-architecture.test.mjs` | 15/15 |
| Catalog/control/workflows | platform catalog, architecture control/workflow, platform verification, evidence/layer/npm/stack publish workflow tests | 203/203 |
| Generated authorities | `node .github/scripts/generate-architecture.mjs --check` | GREEN; two canonical generated files current and byte-clean |
| Focused adversarial | eight core files listed in §8 | 8 files / 79 tests |
| Documentation | `yarn vitest run src/docs-consistency.test.ts` | 7/7 after this record was added |
| Repository diff | `git diff --check` plus generated/status sweeps | GREEN |

`yarn public-quickstart` clean-built and invoked `dist/cli/bin.js` through 17
successful steps: init, draft/sample/two arms, quote, lock, launch, status,
resume, status, collect, results, report, workspace verify, publish, and copied-
bundle standalone verify. It used the real local venue, forwarded no ambient
credentials or network configuration, completed six expected cells, deleted the
source workspace, passed the six portable checks, and removed its owned temporary
root. Evidence identities:

- Run: `41670341f40dab3457b956bfea1bdbaaf66b027d9180957f13a7395bcea15f84`
- Matrix: `227dbb7329c09dfe178ec2c96980c97afeeada6b3968ac5e82e5eef0c3346d8a`
- Report: `9621850be78be3f44ce4d170ee5bf9e251dd54e79666168c824f1f192ee1921b`
- Bundle: `e0ad39ad69c84304a63f12905c4d51683cf38320182e54e158f16c822ffb34d4`

The optimized browser test used a uniquely owned workspace and the real local
backend for both paths. The complete draft reached six judged cells. The second
draft observed an active driver and a dispatched cell, persisted cancel intent,
rendered requested/draining, reached closed/cancelled, and rendered all six
terminal rows. Both drafts then sealed Report/Claim, published, copied their
bundles outside the source, deleted the source workspace, and passed the shipped
standalone CLI with the exact six checks; the cancelled copy retained
`verification/cancel-requested.json`.

## 8. Adversarial, accessibility, and security evidence

The focused adversarial rerun comprised:
`bundle/assets.test.ts`, `bundle/manifest.test.ts`,
`operations/report.test.ts`, `operations/verify.test.ts`,
`report/claim.test.ts`, `report/trust.test.ts`,
`run/cancel-marker.test.ts`, and `operations/run-results.test.ts`.
Its 79/79 cases, also included in the full core battery, prove:

- complete, partial, conflicted, adverse, and cancelled presentations retain
  exact Matrix/Report/Claim mirrors, attrition, dissent, configuration, scope,
  limitations, neutral/no-winner framing, and terminal accounting;
- duplicate/missing/extra/tampered manifest entries, Matrix bytes, Report payload
  or envelope, Claim bytes/unknown fields, public-key identity, evidence assembly,
  cancellation-marker bytes, and every one of the five asset bytes fail closed;
- missing, substituted, multiply consumed, out-of-domain, or unreachable graph
  records fail evidence closure, including solve/evaluation Submission, Delivery,
  output, verdict, receipt, Task, and EvaluationSpec relationships;
- unsafe paths, symlinks, hardlinks, special files, inode changes, and external
  links fail without a second semantic reopen; the cancellation marker separately
  rejects malformed, noncanonical, symlink, and bad-schema states;
- expired, task failure, infrastructure failure, cancellation, unscorable, and
  disagreement remain distinct and do not enter score denominators incorrectly.

Production Playwright additionally swept every route and material state at desktop
and 390px, with keyboard-only traversal, visible focus/skip targets, responsive
containment, and zero axe violations without waivers. Exact response headers were
pinned: `no-store`, CSP with `base-uri 'none'`, frame denial, nosniff, no-referrer,
and an 81-feature empty Permissions Policy whose runtime-recognized set matched
exactly and whose allowed set was empty.

Unique build/runtime/workspace/credential sentinels, generated private-key bytes,
absolute paths, secrets, unexpected diagnostics, HTML/Flight payloads, static
chunks, browser console at every level, requested URLs, external requests, and
both copied bundles were swept. No prohibited value, browser warning/error,
external request, symlink, or multi-link regular file was observed. Browser-owned
workspaces and listeners were removed by exact-owner teardown. Playwright global
setup returns its teardown closure, so the original root/marker BigInt device and
inode identities, token, and exact marker bytes stay only in controller memory;
filesystem content cannot self-assert cleanup authority and no JSON transport is
needed. Teardown snapshots the sole-link marker through an `O_NOFOLLOW` descriptor,
atomically quarantines the exact run-root path, validates the moved root/marker/
child allowlist twice, and only then removes recursively. Replay, a fully self-
consistent fake receipt, same-path root or marker replacement, symlink, hardlink,
unexpected child, original-path occupant race, and quarantine ABA retain evidence
or preserve the later occupant without overwrite.

Invalid runs excluded from evidence:

- The first two new cancelled-browser attempts traversed the product correctly
  but used overly broad/nonexistent test selectors (four baseline rows globally,
  then a non-ARIA labelled container). Exact table scoping fixed the test; no
  product change was required. The final focused and full Playwright runs passed.
- The first documentation-test edit contained an invalid regular expression and
  was corrected before the authoritative red. The valid red then failed because
  both new CI path filters were absent; the filter correction produced 6/6 before
  this document's deliberate missing-file red and 7/7 green. Independent review
  then found this new record missing from the trigger: a valid 6/7 red measured
  expected two occurrences and received zero; both entries restored 7/7.
- The first browser-cleanup reviewer regression passed three cases and failed one:
  current cleanup accepted a replayed marker at a replaced root and deleted the
  replacement. The expanded red passed three and failed five across root replay,
  same-byte marker inode replacement, marker symlink/hardlink, and unexpected
  child. The identity-receipt/quarantine correction passed all 8/8, the full web
  suite 69/69, and optimized Playwright 3/3 with no residue. Second review then
  supplied a canonical replacement receipt carrying current replacement inodes:
  the valid focused red passed 8/9 while cleanup again deleted replacement evidence.
  Removing filesystem authority and adding original-path/ABA probes produced
  ownership 11/11, full web 72/72, and optimized Playwright 3/3 with no residue.
- Historical ambient-Node and unbuilt-sibling-dist failures are excluded in the
  ledger. Every final command above used Node 22.23.1 and the required clean build
  order.

## 9. Extraction, drift, hygiene, and merge-readiness caveats

The [extraction-readiness dry run](./2026-08-09-benchmark-product-extraction-readiness.md)
remains **NOT EXTRACTION-READY**:

| Gate | Verdict |
|---|---|
| Published platform dependencies | BLOCKED |
| Component-only clean-clone CI | BLOCKED |
| Deploy artifacts/platform configuration | NOT GREEN |
| No Tier-1–3 product references | PASS |
| Departing-tree CI/conformance independence | BLOCKED |
| Release/tag/trusted publisher | BLOCKED / not applicable under private `publishPolicy: never` |
| Review-protection migration | BLOCKED |
| No vendored platform code | PASS with disclosed generic filesystem-helper/private structural-type provenance |

Even eight future PASS results would require a separate decision record. This
dry run authorizes no move, repository creation, package release, deployment, or
remote action.

Drift at BP-52: local `origin/integration/evidence-v1` is
`1980c7e067cd74e601d640df334169dbc6e65605`; the completed session lineage is 43
commits ahead and 54 behind after BP-52 integration and ledger closure. The merge
base remains `1fb3e78f1`. A merge-base-to-origin
path diff found no upstream change to `packages/benchmark-product`, the product
design/ledger, product CI, or product guard paths. Upstream-only drift remains in
repository workflows/control selection and the two generated architecture views.
The proposed base refresh was never approved and was not performed.

Hygiene and outstanding local actions:

- BP-52 uses unique owner-marked roots; its quickstart, browser workspaces,
  copied bundles, production server, and browser artifacts/listeners are removed.
- The session permission deny rules remain present and were not weakened.
- The issue-draft authority contains BP-20/21/22/30/31/32/33/40/41/50/51/52;
  no GitHub Issue or other remote object was created.
- Completed packet worktrees BP-00/01/10/11/12/13/20/21 and BP-52 were each
  checked clean, removed through Git's worktree mechanism, and pruned. Unrelated
  active worktrees were not touched.

Merge-readiness caveats:

1. Owning Issues do not exist and cannot be created under this session's local-
   only authority. Human CODEOWNERS review is required for protected paths.
2. The 54-commit upstream divergence needs an explicit human decision and normal
   compatibility review; this program did not refresh or merge the moved base.
3. Extraction, release, hosting, deployment, package publication, live-market
   validation, owner-independent preregistration, and party-independence remain
   unproven or explicitly out of scope. No claim should imply otherwise.
