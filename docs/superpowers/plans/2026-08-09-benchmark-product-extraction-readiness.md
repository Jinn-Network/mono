# Benchmark Product — Extraction-Readiness Dry Run

| | |
|---|---|
| **Date** | 2026-08-09 |
| **Packet** | BP-51 |
| **Shape** | `docs` |
| **Evaluated tree** | `packages/benchmark-product` |
| **Base** | `b235db6f5883adf1486ea460b5a10f48735b97d0` |
| **Gate authority** | [Jinn platform architecture §6](../specs/2026-07-30-jinn-platform-architecture.md#6-the-extraction-gate-mechanical) |
| **Overall verdict** | **NOT EXTRACTION-READY** |

This is a dry run of all eight mechanical extraction-gate items. It records
the current evidence and the work that would be required to turn each red item
green. It does not authorize a move, repository creation, package release,
deployment, or remote action. Platform architecture requires a dedicated
decision record even after every gate is green; no such decision record exists.

The product remains a private, unpublished Tier 4 incubating tree in the
monorepo. Its current location is not a defect: extraction is a consequence of
readiness, never a goal.

## Gate summary

| # | Gate | Verdict |
|---:|---|---|
| 1 | Platform dependencies resolve from the stable published registry | **BLOCKED** |
| 2 | CI passes from a clean clone of the component tree alone | **BLOCKED** |
| 3 | Deploy artifacts/configuration point at the new home | **NOT GREEN** |
| 4 | No tier-1–3 kit, guard, or fixture references the product | **PASS** |
| 5 | No remaining repo-global workflow reference; departing tree owns equivalent CI and conformance | **BLOCKED** |
| 6 | Independent release/tag/trusted-publisher pipeline | **BLOCKED / N/A during private incubation** |
| 7 | Review protection and CODEOWNERS migrate | **BLOCKED** |
| 8 | No vendored platform record/capability code | **PASS, with disclosed generic filesystem-helper provenance** |

## 1. Published platform dependencies — BLOCKED

Both package manifests resolve their Jinn dependency closures through
monorepo-local `portal:` overrides:

- `packages/benchmark-product/core/package.json` → `resolutions`
- `packages/benchmark-product/web/package.json` → `resolutions`

The catalog's `platform-v1` release group is canary-capable but stable
publication remains disabled. The gate authority states directly that stable
npm consumption cannot satisfy item 1 until the live hosting blocker closes.
The product therefore cannot consume the same stable canonical artifacts an
external repository would consume.

**Closure condition:** every Jinn dependency resolves from stable published
artifacts with no `portal:` or in-repository `resolutions` override, including a
fresh lockfile proof against those artifacts.

## 2. Component-only clean-clone CI — BLOCKED

[Benchmark Product CI](../../../.github/workflows/benchmark-product-ci.yml)
builds the portal dependency graph from 24 sibling package directories before
building core. It then uploads `packages/**/dist` and restores those repository-
wide distributions in the web and packed-consumer jobs. A clone containing only
the product tree cannot reproduce this sequence.

**Closure condition:** an isolated fixture or future repository checks out only
the component, installs registry dependencies, and passes the same core, web,
real-venue, browser, pack, types, and conformance battery without sibling source
or transferred sibling `dist/` directories.

## 3. Deploy artifacts and platform configuration — NOT GREEN

[The product threat model](../../../packages/benchmark-product/SECURITY.md#deployment-status-none)
records deployment status `none`: no hosted service, public web deployment,
remote account boundary, or deploy operation exists. There is consequently no
deploy artifact, watch pattern, build context, ignore file, or new-home platform
configuration to verify.

This is not a request to invent deployment. Under current product authority,
the honest gate verdict is not green rather than pass-by-vacuity.

**Closure condition:** only after a separately authorized deployment design,
prove that every artifact builds without sibling-tree copies and that every
deploy-platform path targets the extracted home.

## 4. No tier-1–3 product references — PASS

The product package-inventory guard independently rejects runtime dependencies
from tiers 1–3 to either benchmark-product package. A fresh repository sweep of
`packages`, `client`, `apps`, `plugin`, and `scripts`, excluding the product
tree, found no `@jinn-network/benchmark-product-*` import and no
`packages/benchmark-product` reference in a tier-1–3 kit, guard, or fixture.
The remaining repository references are the product-owned workflow, catalog,
and family guards; none makes product behavior normative for the platform.

Evidence authorities:

- `.github/scripts/benchmark-product-package-inventory.test.mjs`
- `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` §2 and §11

**Recheck condition:** rerun the same dependency and source sweep at any future
extraction decision head.

## 5. Departing-tree CI and conformance independence — BLOCKED

The product workflow and all three family guards live under repository-global
`.github/`, outside the departing tree:

- `.github/workflows/benchmark-product-ci.yml`
- `.github/scripts/benchmark-product-package-inventory.test.mjs`
- `.github/scripts/benchmark-product-source-boundaries.test.mjs`
- `.github/scripts/benchmark-product-packed-types.test.mjs`

The workflow also has the sibling-build and cross-job `dist/` transfer described
under item 2. Both product catalog entries currently have empty
`publicSurface.conformance` arrays. There is no extracted-tree workflow that
proves equivalent architecture, real-venue, packed-consumer, browser, and
conformance coverage.

**Closure condition:** the remaining repository no longer references the
departing tree, while the departing tree owns and passes an equivalent complete
gate—including an explicit conformance run, not lint-only CI.

## 6. Release, tag, and trusted publisher — BLOCKED / N/A

Both manifests are `private: true`. Both catalog entries use
`releaseGroup: "transitional-or-private"` and `publishPolicy: "never"`; the
inventory guard enforces that the product never publishes. No monorepo release
currently produces these artifacts, so migration is not applicable during
private incubation. However, the extraction gate requires the departing
component to own a release/tag pipeline and any rebound npm trusted-publisher
registration, so the item is not green.

**Closure condition:** only after a separately authorized release posture,
prove an independent tag and artifact pipeline, correct package visibility, and
trusted-publisher binding to the new repository/workflow. Do not weaken
`publishPolicy: never` merely to satisfy this dry run.

## 7. Review protection migration — BLOCKED

Current protection comes from monorepo-wide CODEOWNERS rules for `/packages/`,
`/docs/`, workflows, scripts, and architecture controls. There is no dedicated
`/packages/benchmark-product/` ownership rule or proposed new-home CODEOWNERS
file to migrate. Catalog ownership is `architecture-control`, but a catalog
label is not extracted-repository branch protection.

Evidence authority: `.github/CODEOWNERS` and the two product catalog records in
`architecture/platform-packages.v1.json`.

**Closure condition:** a future extraction plan carries equivalent human review
protection for code, human surfaces, security policy, workflows, public bundle
format, and authority documents, with branch protection verified before cutover.

## 8. No vendored platform code — PASS with disclosure

The source-boundary guard rejects deep package imports, sibling source escapes,
browser-side core imports, and unapproved Jinn dependencies. Product record,
aggregation, orchestration, trust, and verification behavior enters through
declared public package entries. `core/src/platform.ts` is a public-entry seam,
not copied behavior.

One provenance note is intentionally explicit: `core/src/fs/atomic.ts` says its
generic atomic-write/fsync pattern was reproduced from policy-optimization,
which derived it from local-backend practice. The file imports only Node built-
ins and implements generic filesystem durability. It is not copied platform
record-kind, verifier, orchestration, or capability source, so it does not fail
the narrower item-8 prohibition. A future extraction review should either keep
this attribution or replace the helper with a separately owned generic utility;
it must not conceal the reuse.

Evidence authorities:

- `.github/scripts/benchmark-product-source-boundaries.test.mjs`
- `packages/benchmark-product/core/src/platform.ts`
- `packages/benchmark-product/core/src/fs/atomic.ts`
- `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` §3 and §11

## Conclusion

Gate items 4 and 8 pass. Items 1, 2, 5, and 7 are concretely blocked; item 6 is
intentionally inapplicable to the current private posture but remains unfulfilled;
item 3 has no authorized deployment surface and is not green. The tree is
therefore **not extraction-ready**.

No extraction is authorized. Even if all eight results later become PASS, a
future decision record must separately establish audience, ownership,
maintenance, release cadence, security posture, migration mechanics, and the
authority to create or move repositories.
