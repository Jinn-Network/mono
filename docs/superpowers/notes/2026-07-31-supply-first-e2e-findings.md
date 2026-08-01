# First end-to-end run of the supply pipeline — results and dispositions

- **Date:** 2026-07-31
- **Branch:** `supply/first-e2e` @ `feee30e88` (composition harness under `scripts/e2e/supply-pipeline/`)
- **Design:** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
- **Status:** Findings recorded with coordinator dispositions. The §11 legacy supersession
  gate is **not** discharged — see §3.

## 1. What ran

The six merged supply packages were composed into a runnable pipeline for the first time
and driven against a real upstream instance. **No merged package was modified — zero code
defects were found.** Every finding below is an integration gap in the tier-4 composition
layer, which is precisely the layer the design deferred.

| Step | Result |
| --- | --- |
| Portal build chain | 14/14 packages install + build first try |
| Suites | 558 tests green (record 129, verification 78, admission 100, derivation 102, posting 76, curation 73) |
| Environment verification | `stable`, K=5 distinct containers, all five per-run observation digests identical, baseline recorded honestly (0 passing / 6 failing) |
| Cheap verification | DSSE signature valid; record-subject binding confirmed |
| Admission | do-nothing 2× → 6 passed / 1 failed; gold 2× → 7 passed / 0 failed; 1 written, 0 refused |
| Sealed outputs | `validateTask`, `EvaluationSpecSchema.parse`, `checkAdmissionReceipt` all conform |
| Posting | plan only — 0.0012 ETH escrow computed, `explicit` approval, **never executed, no key acquired** |

Instance: `0b01001001__spectree-64`, image pinned by digest (1.33 GB compressed).
Gold patch stayed out of the pool (the gold store wrote a `DO-NOT-PUBLISH` marker).

## 2. Findings and dispositions

**F1 — `controls.network: "none"` forecloses the install step import-only v1 depends on
(MAJOR, design-level).** The pre-built upstream image does not contain the extras its own
`install_config.install` names; installing them offline is impossible, so the environment
cannot reach its intended baseline under the profile's own controls.

*Disposition (coordinator).* The attestation was **correct** — it reported a stably-broken
baseline, which is the product working, not failing. Three rulings:
1. **Network stays off. Non-negotiable.** An "install with network on" phase would void
   closure: the fetched bytes are unpinned, so runs would differ and the entire
   `closed-reproducible` claim would become a lie. Never add it.
2. **The real gap is selection, not networking.** The design publishes negative
   attestations (D3) but never says derivation must *skip* those environments. Add a
   normative rule: **an environment whose latest attestation shows an unusable baseline is
   not a task source.** Broken environments are still published — that is the free public
   signal — they are simply not derived from.
3. **Narrowing the declared test scope is the legitimate authoring move** (§4.2 already
   permits it; admission's per-path targeting means a narrow scope does not block
   derivation). The general case — images whose install genuinely needs upstream packages
   — is served by a **pinned local mirror** (the research note's time-travel dependency
   proxy), filed as a named extension. It is not v1.

**F2 — records built from upstream rows are not executable (MAJOR).** `toCommandSpecs`
emits `{bin, args}` only; the image's toolchain lives off the default PATH, and upstream's
own harness `source`s conda in a shell — which `CommandSpec` correctly forbids. A
per-image-family execution profile is required and **no such mechanism is designed**.

*Disposition.* This belongs to the **import strategy**, not the composition: mapping an
upstream row to a working execution profile is upstream-specific knowledge, exactly what
a source strategy owns. Filed to the supply program as an import-strategy amendment. The
run's workaround — putting PATH in the command's `env`, inside the sealed record — is the
right shape and correctly changes the record digest.

**F3 — nothing acquires a parser (MAJOR; hits the product claim directly).** The port
requires implementations to acquire the parser by digest and fail closed, and §4.2 makes
`parser.uri` advisory — but no acquisition infrastructure exists anywhere in the stack.
**Third-party re-verification, the differentiator this whole family is built on, is
therefore not executable by a third party today.**

*Disposition.* This is the most serious finding and it is mine. Parsers must be
**digest-addressed artifacts stored via the evidence repository's `putArtifact`**, exactly
like state artifacts — the machinery already exists and needs no new concept. The design's
"advisory uri, digest authoritative" line was insufficient: a digest with no resolvable
source is a claim, not a capability. Amendment applied to the design §4.2; a
composition-private registry (what the run used) satisfies nobody but its author.

**F4 — a transient failure mints a signed false negative (MODERATE).** `verifyEnvironment`
seals an `image-unresolvable` attestation on the first pull error. The staged-state machine
with its retry discipline exists in a sibling module that nothing forces the caller to
wire. Observed live: anonymous Docker Hub rate limiting returned `denied`/`unauthorized`
for an image that demonstrably exists — indistinguishable from "image gone", and it would
have published a signed, attributable, append-only false negative.

*Disposition.* Retry-then-`error` must be **internal to `verifyEnvironment`**, not
optional wiring — infrastructure classification and bounded retry happen before any
sealing. Filed to the verification unit as a fix with a regression test (a runtime that
fails twice then succeeds must produce one `stable` attestation, never a negative one).
Attestations are permanent and plural; a false negative is not recoverable by a later
positive.

**F5 (MINOR)** — the runs/baseline presence rule is enforced only at runtime, so every
consumer re-narrows by hand; make it a discriminated union at the type level.
**F6 (MINOR)** — upstream `image_name` often lacks a tag/digest and `license_name` is
prose, not SPDX; both mappings are import-strategy-owned (folds into F2). Note: **6 of 10
sampled rows carry no image at all** — image availability, not derivation throughput, is
the binding constraint on supply volume.
**F7 (MINOR/DX)** — three row shapes for one upstream row; the decoupling is deliberate but
the composition must keep `repo`/`base_commit` aligned or rows silently skip.
**F8 (NOTE)** — the design and program documents live only on the session branch; the
merged packages cite a spec their own branch does not carry. Land them with the next merge.

## 3. The supersession gate is not discharged

| §11 clause | Status |
| --- | --- |
| verification + derivation + admission kits green | **Yes** |
| end-to-end reproduction of the rebench import | **Yes, N=1** |
| sealed outputs pass profiles conformance | **Yes** |
| for a **representative upstream sample** | **No** |

The *mechanism* is proven; the *sample* is not — one instance, one repo, one language, one
image family. And F1/F2 mean a representative sample is not yet runnable at all. **The
legacy harvest loop keeps running.** Re-run the gate after the F1 selection rule, the F2
execution-profile mechanism, and the F3 parser acquisition land.

Operational blockers for a larger sample, recorded so the next attempt budgets for them:
authenticated registry pulls (anonymous throttling is indistinguishable from absence),
real disk headroom (one image consumed 5 GB of 19 GB free), and a resolvable-image census
before committing to a sample size.
