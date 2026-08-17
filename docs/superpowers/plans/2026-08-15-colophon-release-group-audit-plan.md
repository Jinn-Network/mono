# Platform Package Organization Audit Plan

| Field | Value |
|---|---|
| Date | 2026-08-15 |
| Shape | `design` — discovery and planning only |
| Baseline | `47ab2f934fec7fd3b49da6e0ad453882f6720575` (`origin/integration/evidence-v1`) |
| Worktree | `docs/colophon-release-group-audit` |
| Delivery | Local planning document only; no publication, Issue creation, npm-org mutation, or `colophon-claims/site` edits |
| Authorities | `docs/superpowers/specs/2026-07-30-stack-design-principles.md` (index); `docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md` (DR-2026-07-30, owns boundary/tiers); catalog `architecture/platform-packages.v1.json`; DR-2026-08-03; handbook Rules 2, 8, and 9. Colophon spec is a **consumer constraint**, not a grouping authority. |

> **For later implementers:** this is an audit plan, not a packaging implementation plan. It produces findings, decision gates, and a later draft release design. Do not publish packages, enable `PLATFORM_CANARY_PUBLISH_ENABLED`, alter trusted-publisher registrations, or change release-group membership while executing it.

> **2026-08-15 framing note:** The filename and worktree keep `colophon` because that product is the first public-shaped consumer that forced the question. The work itself is **how to organize `@jinn-network/*` packages before any of them publish.** Colophon is one consumer of that organization, not the function that defines it. Do not optimize protocol or release-group membership around Colophon, the local backend, or any other single implementation (stack design principles §8).

**Goal:** Establish how Jinn's npm release groups actually work, whether current `platform-v1` membership matches the stack's layering law and concern separation, and what evidence is required before publishing — without preselecting a release model. Consumer closures (Colophon, native-vertical packing, client, a hypothetical third-party implementer) are **tests** of that organization.

**Architecture:** Treat the platform architecture spec as intent for *what belongs together*; the catalog as executable membership authority for *what is currently grouped*; workflows and publisher scripts as operational authority for *what can actually ship*. Recalculate graphs from manifests; confirm publication from the registry and GitHub Actions; then audit concern mixing, kit-vs-implementation sequencing, experimental graduation, and consumer impact before any design choice.

---

## 1. Current-state summary

Nothing in `platform-v1` is on npm. The catalog names a **54-package**, one-version, receipt-bound, dependency-ordered canary group. That atomicity is logical (one catalog set, one version, one receipt), not a transactional npm operation. Canary publication is **catalog-permitted and implemented**, but **not operationally enabled**: the latest green `Stack npm Publish` run on `integration/evidence-v1` skipped `stack-canary`. Stable publication is **catalog-forbidden** (`canary-only`, `stable: false`). The publisher hard-refuses any lane other than `canary`.

That is the platform's publication state. Consumers inherit it.

Colophon is the first public-shaped **product** consumer of unpublished platform packages. Its three packages resolve **29** `@jinn-network/*` runtime packages: **27** in `platform-v1`, **two** (`@jinn-network/task-admission`, `@jinn-network/environment-record`) in experimental groups whose policy is `disabled`. Colophon itself is cataloged under `transitional-or-private` with `publishPolicy: never`. Native-vertical packing is a **second** consumer fixture (30 packages, including those two experimentals); it is not a catalog release group. A third-party implementer who never heard of Colophon is the **design** consumer the stack principles require.

The 29-package Colophon closure is therefore **demand evidence and a coupling test**, not a candidate `platform-v1` membership list. Shrinking the platform to what Colophon installs would violate "do not optimize around one local implementation" and would drop kits that exist so outsiders can verify without running Jinn products.

Do not choose full-platform publication, smaller synchronized groups, extraction, bundling, or independent versioning until the workstreams below close. Organize first; publish last. Public npm remains the last proof, after local tarball and clean-registry proofs.

### 1.1 What the stack principles require of package organization

The principles document **defines nothing**; owning specs win on conflict. For release-group work the load-bearing rules are:

| Principle | Implication for packages / release groups |
|---|---|
| **§2 Layering law** (owned by platform architecture) | Tiers 1–3 never name a product. Products (Colophon, operator app, Autopilot) stay out of `platform-v1`. Protocol records, protocol-extending records, reusable capabilities, and kits may share a *compatibility* group only if they actually share a compatibility promise — not because they live in the same repo. Frozen dependency direction: applications → discovery → TEP + Evidence → trust. |
| **§4 Six concerns kept separate** | A package that mixes sealed-record semantics with persistence, marketplace policy, or product UX is a packaging smell. Membership audit classifies each package by **which concern it owns**, not by which product imports it. |
| **§5 Sealed once** | Sealing is re-implemented per package with cross-package equivalence fixtures. Record packages that share digest/canonicalization rules may need coordinated release **even without a runtime import edge**. |
| **§8 Built for implementers outside this repo** | Do not optimize grouping around Colophon, the local backend, or the operator daemon. The published set must be usable by a third party who never clones this mono. Avoid premature compatibility with unpublished Jinn interfaces — which is exactly the state Colophon is in today. |
| **§9 Conformance kits precede implementations** | The five `*-testing` kits in `platform-v1` are not "weak membership" because Colophon does not install them. Publishing implementations without kits would invert the sequencing rule. Kits may need to publish **with or before** the implementations they test. |
| **§10 Architecture must be executable** | Catalog + import canaries are the map; specs are commentary. Domain is the directory nesting axis; **layer is not a directory axis** — so release groups must not be "the benchmarking folder" either. |
| **§11 Non-goals** | Do not invent a scheduler, marketplace, or hosted service *inside* protocol packages in order to make a consumer installable. |

Platform architecture (DR-2026-07-30) is the owning home for the inclusion test and extraction gate. DR-2026-08-03 is the owning home for "Phase B use does not graduate task-supply or environment packages." Those two DRs constrain membership more tightly than any consumer closure.

---

## 2. Evidence map

### 2.1 Inspected HEAD

- Branch: `docs/colophon-release-group-audit` tracking `origin/integration/evidence-v1`.
- Commit: `47ab2f934` — *Merge pull request #2686 from Jinn-Network/codex/colophon-real-provider-proof*.
- Catalog validator: `.github/scripts/platform-catalog.mjs` (`loadPlatformCatalog` succeeds; 89 catalog entries).

### 2.2 Release groups at this HEAD

| Release group | Packages | Publish policies | `stackPublished` / canary / stable | What it is |
|---|---:|---|---|---|
| `platform-v1` | 54 | `canary-only` | true / true / false | Catalog-selected core candidates; one version `0.1.0`; receipt-gated canary publisher exists |
| `experimental-environment-supply` | 8 | `disabled` | false / false / false | Environment record family and related capabilities; Phase C keeps publication off |
| `experimental-task-supply` | 5 | `disabled` | false / false / false | Admission, derivation, posting, curation, chain-scenarios |
| `experimental-policy` | 2 | `disabled` | false / false / false | Policy identity/outcomes |
| `legacy-product-lines` | 6 | `independent` | false / false / false | Client, sdk, core, plugin, jinn-layer, marketplace-pipeline |
| `transitional-or-private` | 14 | `private`, `never` | false / false / false | Products and tooling including all four Colophon packages |

`platform-v1.allowedDependencyReleaseGroups` is **only** `platform-v1`. A `platform-v1` package cannot depend on an experimental package. That constraint, not directory proximity, is why admission and environment-record are outside the 54.

A packing selection named `native-vertical-runtime-closure` exists in `.github/scripts/build-prepublication-bundle.mjs`. It is **not** a catalog release group. It packs 30 packages for role-fixture verification, including the two experimental packages, using `platform-v1` as version authority. The stack runbook states this is test evidence, not a canary publication promise.

### 2.3 How `platform-v1` was established

| Source | Role |
|---|---|
| DR-2026-07-30 / `docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md` | Intent: platform = tiers 1–3 plus kits/guards; extraction gate needs a stack publish path; follow-up 1 is that path |
| `1e0b81bc6` (2026-08-02) | Canonical catalog created; `platform-v1` started at **50** packages |
| `522725d34` (2026-08-02) | Release membership derived from the catalog rather than hardcoded lists |
| DR-2026-08-03 | Marketplace-pipeline removed from `platform-v1`; **no task-supply or environment package ratified by Phase B use alone**; publication stays disabled until each package's graduation gate passes |
| Later catalog commits | Membership grew with new platform packages. Original **50** at `1e0b81bc6`. HEAD **54**: added `trust-authoring`, `task-execution-oci-grader`, `record-publication`, `benchmarking-publication`, `benchmarking-local`, `evidence-trace`; removed `evidence-trajectory` and `marketplace-pipeline` (DR-2026-08-03). Net +4. |

The group was created to solve a specific problem: nothing platform-dependent could consume **canonical published artifacts**, so the extraction gate, operator recomposition, and external products were blocked. It is a **compatibility-and-receipt set**, not a claim that every member is required by every consumer.

### 2.4 Authority when sources disagree

| Question | Authority | Notes |
|---|---|---|
| Which packages are in which group, with which publish policy | `architecture/platform-packages.v1.json`, validated by `platform-catalog.mjs` | Generated `architecture/generated/platform-topology.md` is a view, not a second source |
| Version, runtime deps, license, `files`, `private` | Each `package.json` | Catalog is forbidden from storing npm metadata |
| Whether a lane may publish | Catalog flags **and** `loadPublishableCatalogPackages` | Canary requires every member in `{canary-and-stable, canary-only}`; stable requires every member `canary-and-stable` |
| What a workflow actually does | `.github/workflows/stack-npm-publish.yml` plus its tests | Tests assert there is **no** stable `npm publish` path |
| What bytes may be published | Same-run verification receipt + `publish-verified-platform.mjs` | Direct `publish-stack.mjs` publication is disabled |
| Intent / graduation / layering | DR-2026-07-30, DR-2026-08-03, platform architecture, stack design principles (index) | Prose that contradicts the catalog or workflow is stale unless it names a policy the catalog cannot express. Principles do not override owning specs. |
| Operator cadence for **client** | Handbook Rules 8–9, `.github/workflows/npm-publish.yml` | Separate train from `platform-v1` |
| Product consumer constraints (Colophon) | `spec/2026-08-13-colophon-self-serve.md` | How one product pins a platform receipt; **not** `platform-v1` membership |

### 2.5 Consumer fixture: Colophon runtime closure

One product graph, recorded because it is the first public-shaped consumer of unpublished platform packages. It is **not** a membership proposal.

Computed from `dependencies` / `optionalDependencies` / `peerDependencies` only. `devDependencies` and `resolutions` do not define the published install graph, though `portal:` resolutions are how the mono currently builds.

| Package | Direct `@jinn-network/*` | Complete `@jinn-network/*` runtime closure | In `platform-v1` | Experimental |
|---|---:|---:|---:|---:|
| `@colophon-claims/verify` | 9 | 10 | 8 | 2 |
| `@colophon-claims/core` | 23 | 29 | 27 | 2 |
| `@colophon-claims/cli` | 0 (only Colophon) | 29 | 27 | 2 |
| Union of the three | — | **29** | **27** | **2** |

The two experimental packages:

- `@jinn-network/task-admission` — **direct** runtime dependency of both `verify` and `core`; group `experimental-task-supply`; stability `candidate`; policy `disabled`; license Apache-2.0.
- `@jinn-network/environment-record` — **not imported by Colophon source**; runtime dependency of `task-admission`; group `experimental-environment-supply`; stability `experimental`; policy `disabled`; license MIT.

`cli` adds Next/React and the two Colophon packages. It does not add further Jinn packages beyond `core`'s closure.

**Starting-observation check:** 29 / 27 / 2 is reproduced exactly. No arithmetic drift.

**Count drift elsewhere:** Colophon spec §3.2 still says the clean CI build constructs **23** platform dependency distributions. Direct `core` Jinn deps are 23; adding the transitive `environment-record` is **24**, matching the 2026-08-09 extraction-readiness note. Benchmark Product CI watch paths include those trees plus `task-admission` and `environment-record`. Treat "23" as stale shorthand for direct `core` deps.

### 2.6 Consumer fixture: what Colophon imports from experimental packages

This is evidence of **concern mixing** in `task-admission` (sealed receipt types vs authoring that pulls `environment-record`), observed through one consumer. Other consumers of the same packages are listed below.

**Verifier (`@colophon-claims/verify`)** — `src/profile/admission-receipts.ts` imports only:

- `ADMISSION_RECEIPT_MEDIA_TYPE`
- `IN_TOTO_STATEMENT_TYPE`
- `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1`
- type `PredictionSnapshotAdmissionReceiptV1`

It parses a sealed DSSE envelope and reads a digest. It does not call `admitCandidate` or `sealEnvironmentRecord`.

**Runner/core** — `src/intake/sample.ts` (and `src/run/admission-receipts.ts`) import authoring/runtime APIs: `admitPredictionSnapshot`, `loadPredictionSnapshotFixture`, `sealPredictionSnapshotAdmissionReceipt`, `verifyPredictionSnapshotFixture`. The bundled sample is constructed from admission's golden prediction-forecast fixture.

**`environment-record` in Colophon:** no `from "@jinn-network/environment-record"` in product source. It appears in Colophon `resolutions` and yarn.lock because `task-admission` declares it. Prediction-snapshot admission itself does not import `environment-record`; SWE/chain `admit.ts` does. Installing `@jinn-network/task-admission` still installs `environment-record`, because npm resolves the package's dependency list, not the importer's used exports.

**Other runtime consumers of `task-admission`:** `@jinn-network/client` (legacy product), `@jinn-network/task-derivation`, `@jinn-network/chain-scenarios`. **Other runtime consumers of `environment-record`:** client, `task-admission`, `task-derivation`, `environment-verification`, `record-discovery-facts-environments`. Colophon is a second product consumer of admission, which is exactly the kind of evidence Phase C said graduation requires — but it is not itself ratification.

Graduation text already on the package READMEs: approved authority, a second independent consumer, frozen conformance, packed external installation, and load-bearing live use. DR-2026-08-03 decision 6 is the policy hold: do not ratify task-supply or environment packages on Phase B evidence alone.

### 2.7 `platform-v1` coupling (static, this HEAD)

The intra-group runtime graph is a **DAG** (no strongly connected component larger than one package). Publication uses seven topological waves. That DAG is necessary for lockstep publication; it is **not** sufficient proof that all 54 share one concern or one compatibility promise.

| Role in the group | Packages | Evidence |
|---|---|---|
| Roots (depend on no other `platform-v1` package) | `evidence-protocol`, `task-execution-protocol`, `trust-core` | Wave 0; high in-degree |
| High fan-in bridges | `task-execution-protocol` (in 17), `evidence-repository` (14), `record-discovery-protocol` (12), `task-execution-profiles` (11), `evidence-protocol` (11), `trust-core` (11), `benchmarking-records` (8) | Shared wire/record contracts |
| High fan-out assemblies | `task-execution-backend-local` (out 9), `marketplace-testing` (out 7), `task-execution-evaluation-harness` (out 6) | Composition, not protocol |
| Platform-support kits in the 54 | `benchmarking-testing`, `record-discovery-testing`, `marketplace-testing`, `task-execution-testing`, `trust-testing` | Conformance, optional `vitest` peers; no Colophon runtime import |
| Intra-group leaves (nothing else in `platform-v1` depends on them) | 22 packages | Includes both Colophon-facing capabilities (`benchmarking-aggregate`, `record-discovery-transport-http`, `task-execution-oci-grader`, …) and packages Colophon never installs |

**27 `platform-v1` packages are absent from the Colophon runtime closure**, including marketplace venue/binding/projector/testing, most evidence storage backends (sqlite/ipfs/oci), evidence trace/decode/contribution/retrieval/local-runtime, discovery facts projections, evidence-journal source, trust-authoring, trust-resolve, and all five `*-testing` kits.

That absence is a **consumer-graph fact**, not a membership verdict. Native-vertical role packing still uses marketplace, several evidence packages, and `trust-resolve`. Kits exist so third parties can verify without running a Jinn product (principles §8–§9). Leaf-in-group often means "capability or binding," not "accidentally included." Workstream D classifies those 27 by **tier and concern first**; Colophon-absence is one column, not the sort key.

Membership evidence that **is** currently mechanical:

- Runtime dependency edges (catalog-validated).
- Shared gates (`benchmarking-ci`, `evidence-ci`, `marketplace-ci`, `record-discovery-ci`, `task-execution-ci`, `trust-ci`).
- One version and one trusted-publisher workflow.
- Public-surface declarations (schemas/fixtures/conformance).

Membership evidence that is **not** currently mechanical and must be collected per package in Workstream D:

- Shared wire formats that change together.
- Coordinated behavior changes across commits.
- Common public support promises versus historical proximity.
- Build-only or test-only relationships (devDependencies are ignored by publish order; they can still couple CI).

Do not infer release coupling from `packages/<domain>/` layout.

### 2.8 What the tooling actually enforces

| Concern | Intended | Tested | Operationally enabled at this HEAD |
|---|---|---|---|
| Version alignment | Every `platform-v1` manifest version identical (`0.1.0`) | `publish-stack.mjs` throws on skew; stable tag must match | Yes for packing; no public versions exist |
| Complete set selection | Catalog `expectedPackageCount` 54; plan set must equal catalog set | Catalog validator; prepublication bundle tests | Yes for verification artifacts |
| Build and publication order | Runtime-only topological waves | `stack-package-graph.mjs`; seven waves at this HEAD | Used when packing; not used for npm today |
| Manifest rewriting | Set version, `gitHead`; rewrite in-set deps to that version; strip `portal:` resolutions | `stack-publish-manifest.mjs` | During `npm pack` only; restored after pack |
| Dependency range rewriting | Exact same version for in-set names; out-of-set specifiers unchanged | Same | Same |
| Local specifier refusal | Packed manifests must not retain `portal:`/`workspace:`/`link:`/`file:` | `publish-stack-run.mjs` | Pack-time |
| Same-commit verification | Checkout SHA bound into receipt; publisher reconstructs receipt | Workflow + `publish-verified-platform.mjs` | Yes on every push (verification half) |
| Receipt and provenance | Attest tarballs, profile, trusted-publisher list, verification receipt; publisher verifies `gh attestation` against `platform-verification.yml` | Tests and workflow | Verification attested; publication receipt only if canary job runs |
| Trusted-publisher identity | GitHub Actions / `Jinn-Network` / `mono` / `stack-npm-publish.yml` / environment `npm-publish` / action `npm publish` | `stack-trusted-publishers.mjs` | Registrations generated; **not verified on npmjs in this kickoff** |
| Partial-publication recovery | Preflight registry; skip exact integrity+tag matches; publish missing names in wave order; refuse integrity mismatch | `publish-verified-platform.test.mjs` | Code exists; unused while canary is skipped |
| Registry verification | Post-publish version, `dist.integrity`, dist-tag with retries | Same | Unused |
| Canary | Catalog `canary: true`; workflow job `stack-canary` gated by `vars.PLATFORM_CANARY_PUBLISH_ENABLED == 'true'` | Workflow tests require that predicate | **Skipped** on run [31845984888](https://github.com/Jinn-Network/mono/actions/runs/31845984888); npm has no `platform-v1` packages |
| Stable | Catalog `stable: false`; publisher `lane` must be `canary`; no stable publish job | Workflow tests: "shares verification without any publication path" | Verification/live-host jobs exist; **no npm publish**; `https://spec.jinn.network/` fetched as 404 at kickoff |
| Colophon publication | Spec: demand-gated product workflow over a stable Jinn set | Product CI packs local tarballs | Catalog `never`; no Colophon publish workflow; public-shaped manifests (`publishConfig.access: public`) |

Handbook Rules 8–9 still describe the **client** train (`npm-publish.yml` → `@jinn-network/client` canary on `next`, `latest` on Monday). `platform-v1` is a second train with `stack-v*` tags and `canary`/`latest` dist-tags **in code**, not in current registry state.

### 2.9 Consumer impact (install graph versus publication set)

Consumers do not define groups. They expose whether a proposed group is honest: a third-party protocol implementer should be able to take sealed-record packages and kits without a product; a capability host should be able to take applications without marketplace settlement; Colophon should be able to pin one coherent receipt without becoming schema authority.

| Consumer | What membership means today | What they would install |
|---|---|---|
| Third-party protocol implementer (design consumer, principles §8) | Should take sealed-record packages + kits without a Jinn product or marketplace binding | Today: nothing on npm; in-repo they already have kit packages in `platform-v1` |
| Native-vertical packing | 30-package packing selection including two experimentals; version authority is `platform-v1` | Test evidence, not a publication promise |
| Colophon installer (`npx @colophon-claims/cli`) | Cannot resolve from npm; would need the 27 `platform-v1` packages **plus** the two experimental packages at one exact set | Not the other 27 `platform-v1` packages |
| Standalone Colophon verifier | Smaller: 8 `platform-v1` + 2 experimental if `task-admission` remains a runtime dependency | Must not pull backend/launcher/supervisor/workspace; product tests already assert that locally |
| Other external consumers | No `platform-v1` registry artifacts exist; legacy `@jinn-network/{client,sdk,core,plugin,jinn-layer}` remain the only published Jinn packages | Independent versions, not `0.1.0` stack versions |
| Jinn contributors | Mono still builds through `portal:` | Unchanged until publication |
| Monday cuts / canary cadence | Client canary/`latest` continue; stack canary does not fire; no `stack-v*` tags on origin | Two cadences already, only one live |
| Security fix in one package | Today: change in-repo, rebuild dependents from source. After lockstep canary: a one-package fix still republishes the **entire 54** at one new version (logical atomicity). Independent versioning would allow a single bump | Publication-set size ≠ download size |
| Compatibility / rollback | Receipt binds source SHA, catalog digest, wave order, tarball integrity | Rollback is "install the previous receipt set," not "unpublish" |
| Download size vs publication-set size | npm installs the **resolved consumer closure**, not the 54 | Publishing 54 does not make a verifier download 54 |

Licenses in the 29-package Colophon Jinn closure: **12 Apache-2.0**, **17 MIT**. Colophon packages are MIT. A public Colophon tarball must ship an accurate notice inventory for Apache-2.0 dependencies (spec §6.2). That is a publication prerequisite, not a reason to choose a model yet.

### 2.10 Registry snapshot (2026-08-15)

Published under `@jinn-network` (search + `npm view`): `client` 0.2.2, `sdk` 0.1.1, `core`/`plugin`/`jinn-layer` 0.1.2, plus historical `mech-client-ts`. Dist-tags exist for those legacy lines.

`npm view` returned no package for: `trust-core`, `task-execution-protocol`, `benchmarking-records`, `evidence-protocol`, `task-admission`, `environment-record`, or `@colophon-claims/{verify,core,cli}`.

No `stack-v*` tags on `origin`.

### 2.11 Industry comparison (evaluation criteria, not a template)

Primary docs, used only to name dimensions:

- **Lerna fixed/locked** — one version line; a breaking bump in one package can version the whole set; unchanged packages need not always publish except on breaking bumps. [Lerna version and publish](https://lerna.js.org/docs/features/version-and-publish).
- **Lerna independent** — per-package bumps; better when components evolve at different rates; more coordination cost for a coherent consumer set.
- **Changesets `fixed`** — named groups that bump and publish together; highest-impact change in the group wins. [Changesets fixed packages](https://github.com/changesets/changesets/blob/main/docs/fixed-packages.md). Changesets `linked` shares a version *strategy* without forcing identical versions.
- **Nx release groups** — `projectsRelationship: 'fixed' | 'independent'` per group. [Nx release configuration](https://github.com/nrwl/nx/blob/master/packages/nx/src/config/nx-json.ts).

Jinn already mixes these: `platform-v1` is fixed/lockstep; `legacy-product-lines` is independent; experimental groups are unpublished; products (Colophon, client) are intended as separately versioned compositions that **pin** platform receipts. The interesting design space is whether **one** lockstep group should cover protocol records, kits, backends, and marketplace bindings, or whether concern/tier boundaries deserve distinct synchronized groups — with consumers pinning one or more receipts. A consumer's install closure must not be mistaken for the platform kernel.

---

## 3. Confirmed facts, interpretations, unresolved questions

### 3.1 Confirmed facts

1. Catalog has 89 entries; `platform-v1` has 54 packages, all `candidate`, all `canary-only`, all version `0.1.0`.
2. Colophon's complete first-party runtime Jinn closure is 29 packages: 27 in `platform-v1`, 2 experimental.
3. The `platform-v1` runtime graph is acyclic; publish order is seven waves.
4. `platform-v1` may not depend on experimental groups.
5. Direct `publish-stack.mjs` publication is disabled; only `publish-verified-platform.mjs` contains executable `npm publish`.
6. That publisher accepts only `releaseGroup=platform-v1` and `lane=canary`.
7. Latest green stack workflow verified and attested artifacts, then **skipped** `stack-canary`.
8. No `platform-v1` or Colophon packages are on npm. No `stack-v*` tags exist.
9. Colophon catalog policy is `never`; manifests are public-shaped; there is no Colophon publish workflow.
10. Colophon spec forbids canary, workspace, portal, and local tarballs in the **release proof**. Local tarball/ephemeral-registry proofs are allowed for pre-publication implementation.
11. Verifier and runner share `task-admission`, but not the same imported surface.
12. `environment-record` is a transitive install, not a Colophon import.
13. DR-2026-08-03 still disables publication of task-supply and environment packages pending graduation gates.
14. `https://spec.jinn.network/` returned 404 at kickoff. Live-host verification cannot currently be assumed green.
15. Colophon's product spec still says packaging-follows-demand and "public npm last." Those are **product** rules. Platform package organization follows the layering law, concern separation, and outside-implementer rule — not Colophon demand.

### 3.2 Interpretations (not yet decisions)

1. `platform-v1` membership looks like **one compatibility-and-receipt set** (shared version + shared receipt + domain CI gates + acyclic runtime graph), assembled around "tiers 1–3 plus kits." That is a **publication convenience**. It is not yet proven that every member shares one concern, one change cadence, or one public support promise.
2. The 27 packages Colophon does not install are not automatically removable; kits and marketplace/evidence leaves may be required by the layering law and by non-Colophon consumers. Conversely, lockstep with marketplace bindings may be **too large** a compatibility promise if those packages change on a different cadence than sealed records.
3. Canary is one operator action (`PLATFORM_CANARY_PUBLISH_ENABLED=true` after trusted-publisher and environment protection checklists) away from attempting publication of **all 54**. That would still omit experimental packages that some consumers (Colophon, native-vertical packing) actually import. Enabling canary does not organize the graph; it publishes the current organization.
4. Publishing only a single product's closure would be a **different release group**, and would optimize the platform around one implementation — forbidden by principles §8 unless the operator explicitly accepts that as a product-private bundle, not as `platform-v1`.
5. Splitting prediction-snapshot receipt types out of `task-admission` would be a **package-boundary** change (concern separation: sealed receipt vs authoring/runtime), not a release-policy tweak. It is the kind of organization question this audit exists to surface. It would not by itself graduate SWE admission (DR-2026-08-03).
6. Bundling a product's deps remains a documented **product** contingency; it is not a substitute for organizing `@jinn-network/*`.
7. Handbook Rules 8–9 do not currently describe `platform-v1`. A stable stack cut is a **new** cadence object (`stack-v*`), not the Monday client cut, unless an operator decision binds them.

### 3.3 Unresolved questions (policy unless marked engineering)

**Policy (operator):**

1. Is `platform-v1` the public compatibility promise for **all** of tiers 1–3 plus kits, or may protocol records, kits, backends, and marketplace bindings occupy distinct synchronized groups? **Decided 2026-08-15:** distinct synchronized groups (see §16). Not the current 54 as one kernel; not product closures; not per-package independent versioning.
2. May experimental packages be published at all, and under which group/policy, without claiming Phase C graduation (DR-2026-08-03)? **Decided 2026-08-15:** remove the publication caste; classify with Decision 1; [DR-2026-08-15](../../../log/decisions/2026-08-15-withdraw-task-supply-environment-publication-caste.md) amends DR-2026-08-03 decision 6. Not graduation. Catalog unchanged until a later PR.
3. Who completes npm trusted-publisher registrations and GitHub `npm-publish` environment protection for whatever set is eventually published? **Decided 2026-08-15:** same custody as packages already on npm (`@jinn-network/client` and the other independent trains). Same npm org, same GitHub environment `npm-publish`, same operator. Environment is shared, not split.
4. May any **product** (Colophon included) ever ship against `canary`, or is stable-only the platform's public promise? **Decided 2026-08-15:** products' public releases pin **stable only**. Platform canary may still exist as an opt-in train. This forces a real stable stack cut rather than living on canary forever.
5. Who owns `@jinn-network` publisher identity versus product scopes (`@colophon-claims`, others)? **Decided 2026-08-15:** **A.** Platform = `@jinn-network` (Jinn-Network, Decision 3). Products = their own orgs. Colophon = `@colophon-claims`, Colophon-controlled. No product package under `@jinn-network`. Org reservation is still a human gate.
6. May product-only releases use a demand-gated lane between Monday **client** cuts and/or between `stack-v*` cuts? **Decided 2026-08-15:** **A.** Yes. Products are independent consumers. A product-only release (Jinn pin unchanged) may publish on demand from this mono. Not auto on every `next` push. Not gated by Monday client or by the next `stack-v*` unless the product needs a new platform API (then Decision 4: wait and upgrade the pin as a set).

**Engineering (answerable with spikes, still not a model choice):**

7. For each of the 54: which of the six concerns (§4) and which tier (§2) does the package own? Where does a package mix concerns? **A:** §12. Catalog: 5 tier-1, 3 tier-2, 41 tier-3, 5 kits (`tier: null`, `platform-support`). Audit flags **20** mixed-concern packages (kits pulling implementations, persistence/bindings lockstep with protocol, `task-execution-profiles` carrying admission-receipt checks, `trust-authoring` as serialization in a tier-2 slot).
8. Do the five `*-testing` kits need to publish with, before, or independently of the implementations they test (§9)? **A:** Today they cannot publish as a protocol-only set. Union of the five kits' **runtime** closures is **24** `platform-v1` packages because `task-execution-testing` depends on backend-local implementations and `marketplace-testing` depends on those kits plus venue/binding/projector. `benchmarking-testing` and `record-discovery-testing` are closer to protocol-only. Independent kit publication would require a package-boundary change, not a release-policy tweak.
9. Does a packed Colophon verifier tarball actually require `task-admission`'s full dependency list, or only the four imported sealed-receipt symbols? **A:** npm always installs `environment-record` because it is a runtime dep of `task-admission`. The four symbols live in `identifiers.ts` + `prediction-snapshot.ts`, which do not import `environment-record`. There is no subpath export; the package root barrels `admit.ts`. Installing the verifier Jinn closure from tarballs yielded **10** names, matching the static graph.
10. Does `admitPredictionSnapshot` pull `environment-record` into the module graph, or only SWE `admit.ts`? **A:** Only SWE `admit.ts` (and `inline-match.ts`, `testing.ts`, `test-paths.ts`) import `environment-record`. `admitPredictionSnapshot` does not. Evaluating the **package root** still loads `admit.js` via `export *`.
11. Which packages share sealed-record / canonicalization fixtures across package boundaries without a runtime import (§5)? **A:** Sealing is re-implemented per package; catalog `publicSurface` and on-disk `fixtures/` exist on protocol roots, kits, and several adapters. This audit did not prove which pairs are digest-equivalent. Record packages may still need coordinated release without a runtime import edge (§12.5).
12. Has any trusted-publisher row already been registered on npmjs? **A:** not publicly observable; sample packages 404; Aug 1–2 `stack-canary` failed `ENEEDAUTH`. Treat as not registered until an npm org owner confirms.
13. Can `spec.jinn.network` serve the attested profile artifact for this SHA, or is live-host still undeployed? **A:** undeployed. DNS is Vercel; every path is `DEPLOYMENT_NOT_FOUND`. Public-key vars and signing secrets are also unset.
14. What is the packed byte size of a protocol+kits subset versus native-vertical packing versus Colophon verifier/runner versus the full 54? **A (unpacked `node_modules` after clean install from same-SHA tarballs):** protocol+kits 24 pkgs ~136 MB (includes `viem`); native-vertical 30 pkgs ~133 MB; Colophon verifier Jinn 10 pkgs ~16 MB; Colophon runner Jinn 29 pkgs ~20 MB. Publication-set size ≠ download size.

Do not convert items 1–6 into "implement X" tasks.

---

## 4. Audit workstreams and sequence

Early workstreams exist to **eliminate** later ones. If Workstream A shows that no public Jinn package can be published (custody, trusted-publisher, or live-host blockers), Workstreams D–F still run as coupling research, but publication-path design waits.

### Work required before a draft release design

#### Workstream A — Operational publication reality

**Purpose:** Separate "the code can publish" from "the org can publish."

**Evidence to collect:**

- [x] Repository variable `PLATFORM_CANARY_PUBLISH_ENABLED` value (read-only; do not set it).
- [x] GitHub environment `npm-publish`: required reviewers, allowed branches.
- [x] Whether npmjs trusted-publisher rows exist for a sample of the 54 (at least `trust-core`, `task-execution-protocol`, `benchmarking-records`) and for none of the experimental packages.
- [x] Re-fetch `https://spec.jinn.network/` profile paths used by `verify-live-profile-host.mjs`; record exact status and body digest.
- [x] Confirm still no `stack-v*` tags and still no `platform-v1` npm documents.
- [x] Read `docs/runbooks/stack-npm-publishing.md` checklist against those facts; mark each item done/not done without performing it.

**Findings:** §9 (observed 2026-08-15). Public registry proof is **blocked independently of membership.**

**Safe local spike:** none required. Registry and GitHub reads only.

**Exit:** A one-page "publication enablement ledger" with three columns: implemented, tested, enabled. No flags flipped.

**If this workstream finds trusted-publisher or live-host missing:** the draft design must treat public registry proof as blocked independently of membership.

#### Workstream B — Installed versus declared closures (multiple consumers)

**Purpose:** Static manifest closure can overstate what a packed consumer installs. Use several consumers as **tests** of organization, not as membership lists.

**Evidence to collect:**

- [x] Pack a **protocol+kits** subset locally (the five `*-testing` kits plus the protocol packages they declare) and install in a clean directory. Record `npm ls --all` for `@jinn-network/*`. *(Used same-SHA CI tarballs from run 31845984888, not a local rebuild.)*
- [x] Pack native-vertical role fixtures with the existing prepublication bundle path. Record installed names vs the 30 packing selection.
- [x] Colophon `verify` / `core` **Jinn** closures installed from those tarballs. Colophon packages themselves were not packed (worktree has no `node_modules`/`dist`).
- [x] Record `npm ls --all` for `@jinn-network/*`.
- [x] Diff installed names against the static 10 / 29 figures — **exact match**.
- [x] Confirm the reader install still excludes backend, launcher, supervisor, workspace, and `@colophon-claims/core`.
- [x] Measure unpacked sizes for protocol+kits, native-vertical, Colophon verifier, Colophon runner.

**Findings:** §10.

**Safe local spike:** reuse existing product pack-smoke and `prepublication-external-consumer.mjs` patterns. Do not publish.

**Exit:** Installed-closure tables for protocol+kits, native-vertical, Colophon verifier, Colophon runner. Later design uses installed tables, not static guesses.

**Eliminates:** speculative "the verifier only needs three protocol packages" and "Colophon's 29 is the platform" claims that do not survive `npm ls`.

#### Workstream C — Experimental packages: concern, contract, graduation

**Purpose:** Describe what `task-admission` and `environment-record` **are** (tier, concern, sealed vs authoring) before asking whether any consumer needs them published. Colophon and native-vertical are two consumers of that contract, not the definition of it.

**Evidence to collect:**

- [x] Classify each experimental package by tier (§2) and concern (§4). Note concern mixing (e.g. sealed receipt types living in an authoring package that also imports environment records).
- [x] Module-level import graph: which `task-admission` files load `environment-record`.
- [x] Whether `prediction-snapshot` APIs can be imported without evaluating `admit.ts`.
- [x] Whether receipt media types / policy URIs / Zod types already exist (or should exist) in a tier-1/2 package **any** verifier could depend on.
- [x] Fixture ownership: golden prediction-snapshot fixture location; whether protocol kits already own the sealed-receipt contract.
- [x] List all runtime consumers from the installed graph, not just manifests (client, derivation, chain-scenarios, Colophon, …).
- [x] Map README graduation gates to observable evidence (second consumer, packed install, live use) and mark each met/unmet **without** recommending graduation.

**Spike:** packed `@jinn-network/task-admission` from native-role tarball; importing the four verifier symbols from the package root succeeds and **evaluates the barrel**, including `admit.js`.

**Findings:** §11.

**Safe local spike:** a throwaway Node script in `/tmp` that imports only the four sealed-receipt symbols from a packed `task-admission` tarball and prints `require.cache` / resolved modules. Delete after capturing output. No repo package split.

**Exit:** A contract sheet: stable sealed data vs authoring/runtime vs transitive accident, per package, per consumer. If sealed receipt types do not belong in `task-admission`, that is an **organization finding**, not a Colophon special case.

**Eliminates:** treating "publish the experimental groups" and "remove the dependency" as the only options before knowing which symbols are load-bearing and which concern they belong to.

#### Workstream D — Per-package membership evidence for `platform-v1`

**Purpose:** Classify why each of the 54 is in the group, using stack principles as the primary axes. Consumer columns are tests, not the grouping function.

For every package, fill:

| Field | Allowed values |
|---|---|
| Tier (§2) | protocol / protocol-extending record / application / kit-or-guard / mixed / unclear |
| Primary concern (§4) | semantic protocol / serialization / carrier / backend API / persistence / application policy / mixed |
| Runtime coupling to another member | none / depends / depended-on / both |
| Shared sealed record or schema (§5) | yes (path) / no |
| Shared conformance kit (§9) | yes (kit name) / no / this package *is* the kit |
| Coordinated behavior (90-day `git log -S` or PR list) | yes / no / unknown |
| Public support promise | candidate canary set / kit-only / binding / unclear |
| Consumer tests (not membership) | Colophon installed? native-vertical packed? third-party kit user would need it? |
| Weak-membership hypothesis | keep / investigate concern mix / likely historical proximity |

**Sequence inside D:**

1. [x] Classify by **tier and concern** across all 54 (the principles pass). Flag mixed-concern packages.
2. [x] Classify the five `*-testing` kits against §9 (must they publish with implementations?).
3. [x] Classify marketplace bindings and evidence persistence backends (likely different cadence than sealed records).
4. [x] Classify protocol roots (`trust-core`, `evidence-protocol`, `task-execution-protocol`, record packages).
5. [x] Only then fill consumer-test columns (Colophon, native-vertical). Do not sort or drop rows by those columns.

**Findings:** §12.

**Safe local spike:** `git log --follow -- package.json` for a sample of five mixed-concern or marketplace/persistence leaves. Stop if the sample shows they landed with their domain's first platform PR rather than as leftovers.

**Exit:** The 54-row table. Do **not** edit the catalog.

**Eliminates:** arguing about "the 54 is bloated because Colophon does not import marketplace" or "the 54 is sacred" without per-package tier/concern evidence.

#### Workstream E — Cadence, compatibility, and consumer stories

**Purpose:** Map membership to people and trains, still without choosing a model.

**Evidence to collect:**

- [x] Write consumer stories for: third-party protocol implementer, kit user, native-vertical host, Colophon installer, Colophon verifier, contributor, security-fix, rollback — using **installed** closures from B.
- [x] Contrast client Rules 8–9 with `stack-v*` / `canary` / `latest` as implemented for `platform-v1`.
- [x] Note what a one-package Apache-2.0 security fix would force under lockstep versus independent versus concern-sliced groups.
- [x] License/notice inventory for protocol+kits and for each consumer graph from B.

**Findings:** §13.

**Exit:** Impact matrix. Operator-facing language must stay spec-compliant (no "paid," no emoji, no helper-text cruft if any UI copy is quoted).

#### Workstream F — Alternative models against criteria (no selection)

Evaluate each model with **conditions under which it would be appropriate**, using A–E evidence. Do not rank a winner in this workstream.

| Model | Appropriate when | Inappropriate when |
|---|---|---|
| Full current `platform-v1` (54) plus a separate policy for experimental groups | Tier/concern audit shows the 54 really share one compatibility promise; unused-by-a-given-consumer packages are cheap; one public kernel matters more than cadence isolation | Mixed-concern packages cannot be supported as one set; or experimental publication is forbidden while consumers still import those packages |
| Multiple smaller synchronized groups (by tier/concern, not by product) | Protocol records, kits, backends, and bindings change on different cadences **and** consumers can pin several receipts | The public story cannot name more than one platform receipt |
| Receipt-bound **product** closures (Colophon 29, native-vertical 30, …) | Used as product-private bundles or packing selections, never as the definition of `platform-v1` | The product closure is published *as* the platform kernel (principles §8 fail) |
| Independent package versioning | Most packages are truly leaf contracts with stable APIs | Exact-set coherence is the platform's public invariant |
| Hybrid: sealed contracts independently versioned; implementations lockstep | Record packages change rarely; adapters/backends change often; §5 equivalence fixtures still hold across versions | Sealing/canonicalization bugs require simultaneous verifier+author updates |
| Bundled **product** distributions | A product has demand and cannot wait for platform publication | It would hide `@jinn-network` identity, fork schemas, or become the de facto platform |
| Extraction or published mirror | Extraction gates are green **and** dual governance has demand (existing spec) | Used as a shortcut around unpublished Jinn deps (already rejected) |

Dimensions to score separately: source-repo identity, npm scope identity, release cadence, provenance, licensing, maintenance burden.

**Exit:** A criteria table filled with evidence citations. **No recommended model.**

### Work required only before actual npm publication

These wait until a **draft release design exists and is operator-approved**. They are listed so they are not mistaken for audit work.

- [ ] Operator decisions on §3.3 items 1–6.
- [ ] Catalog/workflow changes implied by that design (membership, `publishPolicy`, maybe a new release group).
- [ ] Trusted-publisher registration and `npm-publish` environment protection.
- [ ] `PLATFORM_CANARY_PUBLISH_ENABLED` only after the runbook checklist.
- [ ] Stable lane: catalog `canary-and-stable`, publisher lane support, `stack-v*` tag, live-host green against a real origin.
- [ ] Colophon product workflow, `@colophon-claims` custody, NOTICE files.
- [ ] Local tarball proof, then ephemeral/clean registry proof, then public npm as final proof.

### Suggested calendar order

```text
A (ops reality) ──┬── B (installed closures: protocol+kits, native-vertical, Colophon)
                  └── C (experimental concern/contract/graduation)
                         │
                         D (membership table: tier/concern first, consumer columns last)
                         │
                         E (consumer/cadence/license)
                         │
                         F (models vs criteria, no choice)
                         │
                         Gate G0: audit complete
                         │
                         [operator] draft release design
                         │
                         Gate G1: design approved
                         │
                         publication engineering (out of this plan)
```

A can kill "just publish the 54 tomorrow." C can kill "ignore experimental packages" and can surface a concern-split inside `task-admission`. B can kill both "the verifier is already small enough" and "Colophon's 29 is the platform." D can kill "delete marketplace from the group because Colophon does not import it" **and** "keep marketplace lockstep with sealed records because they share a folder."

---

## 5. Decision criteria (no predetermined outcome)

A future draft release design is acceptable only if it can answer **yes** to every applicable question:

1. **Layering.** Tiers 1–3 never name a product. Products pin platform receipts; they do not define platform membership.
2. **Concern separation.** Packages mixed across the six concerns are named and either split (later design) or explicitly accepted as a documented exception.
3. **Outside implementer.** A third party who never heard of Colophon can install sealed-record packages and kits and verify without running Jinn product code.
4. **Kits before or with implementations.** No published implementation lacks a published kit the design claims it conforms to.
5. **Executable architecture.** Membership remains catalog-backed; directory layout is not used as a release-group axis.
6. **Legibility.** A third party can say which exact tarball bytes, source SHA, and catalog digest they installed, without cloning the mono.
7. **Coherence.** Every `@jinn-network/*` package in a given receipt comes from one named set with one compatibility story. Mixed canary/stable/experimental/unspecified is a fail **within that receipt**.
8. **Consumer honesty.** Install size is the resolved closure, not the publication set. A product may pin one receipt; it must not require the visitor to version the platform.
9. **Graduation honesty.** If an experimental package is published, the design states whether that **is** or **is not** Phase C graduation, and cites DR-2026-08-03.
10. **Cadence honesty.** Client Monday cuts, stack `stack-v*` cuts, and product versions are named separately; coupling is explicit.
11. **Security/rollback.** A one-package fix and a bad cut have described operators (republish set vs bump one vs yank dist-tag — npm versions stay immutable).
12. **Provenance.** Trusted publisher, no long-lived npm token, same-run receipt, no install lifecycle scripts.
13. **Licensing.** Apache-2.0 and MIT packages in each published set have a notice inventory.
14. **Non-goals preserved.** No site edits, no second repo as a shortcut around unpublished deps, no Windows expansion, no telemetry.

Failing any criterion returns the design to discovery, not to a different default model.

---

## 6. Risks

| Risk | Why it matters now | Control during the audit |
|---|---|---|
| Optimizing around one consumer | Colophon's 29 would make a convenient but illegal `platform-v1` | Principles §8; Workstream D sorts by tier/concern |
| Compatibility | Lockstep 54 means a marketplace bugfix republishes sealed records every consumer pins | Record cadence coupling; do not shrink the group in-code during the audit |
| Provenance | Canary publisher is the only trusted-publisher workflow; a second workflow or token would split identity | Do not register new publishers during the audit |
| Licensing | Mixed Apache-2.0 / MIT across platform packages | Inventory in E; no relicensing |
| Partial publication | Publisher can leave a hole if interrupted; recovery is integrity-sensitive | Do not run the publisher |
| Release cadence | Two trains already; enabling stack canary on every `evidence-v1` push is a support load | Flag stays off |
| Experimental dependencies | Publishing them without graduation overclaims; omitting them leaves some consumers uninstallable | Workstream C |
| Canary mistaken for stable | Products that require stable must not treat canary as the public promise | Keep that gate explicit |
| Live-host prose drift | Specs still say "blocked on hosting" while the workflow has a live-host job that would likely fail (404) | Treat hosting as unverified, not as solved |
| Catalog/manifest disagreement | Product `publishConfig.access: public` vs catalog `never` | Catalog wins for whether platform CI will publish them |
| Extraction temptation | Moving a product to another repo does not publish Jinn deps | Extraction-readiness remains NOT READY |

---

## 7. Audit completion criteria

The audit is complete when all of the following exist in-tree or as an addendum to this plan, and **none** of them is a disguised implementation:

1. Updated enablement ledger (Workstream A).
2. Installed-closure tables for protocol+kits, native-vertical, Colophon verifier, Colophon runner (B).
3. Experimental concern/contract/graduation sheet (C).
4. 54-row membership evidence table with tier/concern as primary axes (D).
5. Consumer/cadence/license matrix (E).
6. Model-criteria table with no selected winner (F).
7. §3.3 policy questions still listed as policy, with any new facts attached.
8. A one-paragraph statement of what would still be required **after** operator model choice, before public npm.

The audit is **not** complete if it ships catalog edits, workflow edits, enabled flags, Issues, or a recommended release model.

---

## 8. Operator summary

**Workstream A result (2026-08-15):** the org **cannot publish** `platform-v1` yet. Verification is implemented and green; canary is skipped because `PLATFORM_CANARY_PUBLISH_ENABLED` is unset; `npm-publish` is unprotected; trusted-publisher rows are not observable and have never succeeded (Aug 1–2 `stack-canary` died with `ENEEDAUTH`); `spec.jinn.network` is a Vercel `DEPLOYMENT_NOT_FOUND`. Membership design does not unblock public npm.

**Workstream B:** same-SHA CI tarballs install cleanly. Protocol+kits runtime union is **24** packages (~136 MB, includes `viem`), not “kits + sealed records.” Native-vertical packing is **30**. Colophon verify Jinn closure is **10** (~16 MB, no backends). Colophon core is **29** (~20 MB). Static graphs matched installed names.

**Workstream C:** `task-admission` mixes sealed prediction-snapshot receipt types with SWE environment-record authoring in one barrel. Organization finding, not a Colophon special case. The five README graduation gates are no longer a unique publication caste (Decision 2 / DR-2026-08-15).

**Workstream D:** `platform-v1` is **5** protocol + **3** protocol-extending + **41** applications + **5** kits. **20** packages are mixed-concern; **22** warrant cadence/concern investigation; **1** looks like historical proximity (`execution-recorder-bridge`). Kits cannot publish as a protocol-only set today.

**Operator Decision 1:** two synchronized groups (sealed platform vs implementations), not the 54 as one kernel.

**Operator Decision 2:** withdraw the task-supply/environment publication caste; classify those 13 packages with Decision 1 ([DR-2026-08-15](../../../log/decisions/2026-08-15-withdraw-task-supply-environment-publication-caste.md)).

**Operator Decision 3:** stack packages use the same npm org, GitHub environment `npm-publish`, and operator as currently published `@jinn-network/*` packages. Shared environment; not split.

**Operator Decision 4:** products pin stable platform receipts only. Platform canary may exist as opt-in. Forces a real stable stack cut; Colophon waits on that cut.

**Operator Decision 5:** platform = `@jinn-network`; products = own orgs; Colophon = `@colophon-claims`. Org not reserved in this session.

**Operator Decision 6:** product-only releases on demand (Jinn pin unchanged). Not auto on `next`. Not waiting for Monday or the next `stack-v*` unless a new platform API is required.

---

## 9. Workstream A — publication enablement ledger

Observed **2026-08-15** from worktree `docs/colophon-release-group-audit` at `47ab2f934`. Reads only. No flags set, no publishers registered, no host deployed.

**Verdict:** public registry proof is blocked independently of package organization. Verification is real; publication is not enabled.

### 9.1 Implemented / tested / enabled

| Capability | Implemented | Tested | Enabled now |
|---|---|---|---|
| Catalog `platform-v1` membership + wave order | yes (54 packages, 7 waves) | catalog validator; verification workflow | yes, for packing only |
| Same-run platform verification + receipt attestation | yes (`platform-verification.yml`) | green on `integration/evidence-v1` and `next` | yes — runs on every push |
| Receipt-gated canary publisher (`publish-verified-platform.mjs`) | yes; lane must be `canary`; group must be `platform-v1` | workflow tests; publisher unit tests | **no** — `stack-canary` skipped |
| Canary enable flag | workflow predicate `vars.PLATFORM_CANARY_PUBLISH_ENABLED == 'true'` | tests require that predicate | **unset** (repo variables `total_count: 0`; GET 404) |
| GitHub environment `npm-publish` | exists (created 2026-04-15); used by **both** client `npm-publish.yml` and stack `stack-canary` | client deploys to it | **unprotected** — `protection_rules: []`, `deployment_branch_policy: null`. Contrast: `npm-stable-publish` has required reviewer `ritsuKai2000` and allowed branch `next` |
| Trusted-publisher registrations (54 rows, workflow `stack-npm-publish.yml`, env `npm-publish`) | list generator exists; CI writes the list as an artifact | generator tested | **not observable / never succeeded.** Sample packages 404 on npmjs. No npm org session. Last time `stack-canary` ran (2026-08-01/02) it failed with `npm error code ENEEDAUTH` |
| No long-lived `NODE_AUTH_TOKEN` | runbook forbids it; client workflow unsets it | secret list has no npm token | yes (absence) |
| Stable npm publish | **no job**; publisher refuses non-canary | workflow tests assert no stable publish path | no |
| Live `spec.jinn.network` host | DNS points at Vercel (`216.198.79.1`, `216.198.79.65`) | `stable-live-host-verification` job exists; skipped on push | **no deployment.** Every fetched path is HTTP 404 `text/plain`, body `DEPLOYMENT_NOT_FOUND` |
| Profile-manifest signing | script no-ops if key absent | — | **not provisioned.** `JINN_PROFILE_MANIFEST_SIGNING_KEY` / `KEY_ID` are not in repo, org, or `npm-publish` secret lists. Public-key URL/SHA256 repo vars are unset. Live-host would fail even after a host exists |
| `stack-v*` tags | workflow_dispatch / release path | — | **none** on origin |
| `platform-v1` npm documents | — | `npm view` + registry GET | **none.** `@jinn-network/client` remains on the independent train (`0.2.2` / canary SHA tag) |

### 9.2 Live host fetches (canonical origin)

`https://spec.jinn.network` is the only origin `verify-live-profile-host.mjs` may use under `--lane stable`. Apex `https://jinn.network/` is a different Vercel site (HTTP 200 HTML) and is not the protocol host.

| URL | Status | Content-Type | Bytes | SHA-256 | Body |
|---|---:|---|---:|---|---|
| `/` | 404 | `text/plain; charset=utf-8` | 107 | `80026277b5009d1a95aa6a64657066d9b752efc9fb56bc670dc918aad9d8a2e0` | Vercel `DEPLOYMENT_NOT_FOUND` |
| `/manifest.json` | 404 | same | 107 | `71872eb55ec7143fc9c418912b8911377bb43ebc797a40dcbb794553f606d763` | same class |
| `/manifest.dsse.json` | 404 | same | 107 | `2d71485adff2fbf1326ef4a67fb5aadfccac25087808ffb0d4422fb3bbed0088` | same class |
| `/profiles/task-execution/v1` | 404 | same | 107 | `0226b3b174ea9be484e40414517888bf2f9469f674f279d4532ed4daede2dbbc` | same class |
| `/profiles/task-profile/v1` | 404 | same | 107 | `3fb852bd2a9aa0bfaffe82b3a0f2285452e167c1a9fa2cbbcb53acda26800655` | same class |
| `/profiles/trace-vocabulary/v1` | 404 | same | 107 | `dd4b776beed0b45f115cdd7f90a3ff531d3624ccf779e02be7bd7885b7a0ee8c` | same class |
| `/profiles/execution-evidence/v1` (prefix; must not 200) | 404 | same | 107 | `86e0e7bb96f652d4f53cdd58d083bf9c9fb87c7a942e7a624cbc144f04679630` | same class — 404 here is **not** a live-host pass; the gate still needs 200 at the prefix entry point |
| `/profiles/execution-evidence/v1/ro-crate-metadata.json` | 404 | same | 107 | `28038b0c8853ac21744040e759b6ad743ee705aacec4a49d86db3b44cce8e627` | same class |
| `/profiles/evidence-repository-oci/v1` | 404 | same | 107 | `6a1c759c251a978edaba33e0f65653cf825eed879ada99bd0bfa6ef2ce2e8fb1` | same class |
| `/00000000-0000-4000-8000-000000000000` (anti-fallback) | 404 | same | 107 | `e66059f4590898f9fa4130d598a4c97526afc161fcd5990d10b0c143da5af19f` | 404 is the *desired* anti-fallback answer, but the host is missing entirely |

Digests differ per request because Vercel embeds a request id in the 107-byte body. The stable fact is **status 404 + `DEPLOYMENT_NOT_FOUND`**, not a particular digest.

### 9.3 npm sample

| Package | Registry | Notes |
|---|---|---|
| `@jinn-network/trust-core` | 404 | `platform-v1` sample |
| `@jinn-network/task-execution-protocol` | 404 | `platform-v1` sample |
| `@jinn-network/benchmarking-records` | 404 | `platform-v1` sample |
| `@jinn-network/evidence-protocol` | 404 | `platform-v1` sample |
| `@jinn-network/task-admission` | 404 | experimental; also unpublished |
| `@jinn-network/environment-record` | 404 | experimental; also unpublished |
| `@jinn-network/client` | 200 | `latest` 0.2.2; `canary` `0.2.2-canary.sha.9b01706bc82437536b11f33efaeb013fb7fa2a2a`; provenance attestations present |

Generated registration list at this HEAD: **54** `platform-v1` names, including the three samples, **excluding** the two experimental packages.

### 9.4 Workflow reality

| Run | Branch | SHA | Verification | `stack-canary` |
|---|---|---|---|---|
| [31845984888](https://github.com/Jinn-Network/mono/actions/runs/31845984888) | `integration/evidence-v1` | `47ab2f934` (this worktree) | success | skipped |
| [31882428616](https://github.com/Jinn-Network/mono/actions/runs/31882428616) | `next` | promote #2688 | success | skipped |
| [31885772962](https://github.com/Jinn-Network/mono/actions/runs/31885772962) | `next` | in flight at observe time | verification running | not started |
| [30737814957](https://github.com/Jinn-Network/mono/actions/runs/30737814957) (2026-08-02) | `integration/evidence-v1` | `16b32ff80` | older workflow shape | **ran and failed** (`ENEEDAUTH` — npm required login). Sibling job named "Trusted-publisher registration list" failed a local surface test, not an npmjs probe |
| [30705249124](https://github.com/Jinn-Network/mono/actions/runs/30705249124) (2026-08-01) | `integration/evidence-v1` | `985f8cf16` | older workflow | **ran and failed** |

So the flag was effectively on around 2026-08-01/02, publication was attempted, OIDC/auth was not accepted by npm, and today the flag is **gone** (not `false` — the variable does not exist). Do not re-set it during this audit.

`git ls-remote --tags origin 'stack-v*'` returned empty.

### 9.5 Runbook checklist (mark only; do not perform)

From `docs/runbooks/stack-npm-publishing.md` trusted-publisher section:

| Item | Status |
|---|---|
| Operator on a team in the `@jinn-network` npm org | **unknown** (this session is `npm whoami` 401) |
| Regenerate list and compare with generated release view | **can** — `stack-trusted-publishers.mjs` wrote 54 rows; not compared to npmjs because packages 404 |
| Add every registration (GitHub Actions / `Jinn-Network` / `mono` / `stack-npm-publish.yml` / env `npm-publish` / action `npm publish`) | **not done** as far as public npm and the Aug 1–2 `ENEEDAUTH` failure can see |
| Protect `npm-publish` with required reviewers and allowed branches | **not done.** Protecting it would also gate the **client** publish job, which shares this environment |
| Add no `NODE_AUTH_TOKEN` | **holds** |
| Run the full hosted verifier and record exact successful source SHA | verification **green**; that is not the hosted live-origin gate. Live-origin gate has never had a host |
| Set `PLATFORM_CANARY_PUBLISH_ENABLED=true` only after every preceding item | **correctly unset** |
| Record operator and completion date in the operational change record | **not done** |

Hosting checklist (`docs/runbooks/jinn-network-profile-hosting.md`): signing key, key id, published public key URL, static host for `spec.jinn.network` — **all not done.** Domain exists on Vercel without a matching deployment. Gate rows remain un-fireable.

### 9.6 What this does and does not kill

- **Kills:** "publish the 54 tomorrow"; any draft that treats public npm as the next engineering step; any claim that live-host verification is green against a real origin; treating canary as a one-click leftover.
- **Does not kill:** Workstreams B–F were still required as organization research after A. They are now recorded in §10–§14.
- **Does not decide:** membership of `platform-v1`. An empty registry is not evidence that 54 is the right set.

§3.3 engineering items 12–13: trusted-publisher rows are **not publicly observable and have never produced a package**; `spec.jinn.network` **cannot** serve the attested profile for this SHA (or any SHA).


---

## 10. Workstream B — installed closures

Observed **2026-08-15**. Used same-SHA CI artifacts from GitHub Actions run [31845984888](https://github.com/Jinn-Network/mono/actions/runs/31845984888) (`47ab2f934`), not a local rebuild. Clean `npm install --ignore-scripts` from `file:` tarballs (no `portal:`). Third-party packages resolved from the public registry.

Colophon packages themselves were **not** packed (this worktree has no `node_modules` / `dist/`). The numbers below are the **Jinn** closures a Colophon install would pull. `@colophon-claims/cli` adds only `@colophon-claims/{core,verify}` plus Next/React — no extra `@jinn-network/*` names.

### 10.1 Installed `@jinn-network/*` counts

| Consumer | Requested roots | Installed `@jinn-network/*` | Unpacked `node_modules` (approx.) | Notes |
|---|---:|---:|---:|---|
| Five `*-testing` kits + their **runtime** closures | 5 kits | **24** | ~136 MB | Dominated by `viem` via `trust-resolve` / marketplace |
| Native-vertical packing selection | role fixtures | **30** | ~133 MB | Includes experimental `task-admission` + `environment-record` |
| Colophon **verify** Jinn closure | 9 declared | **10** | ~16 MB | + transitive `environment-record` |
| Colophon **core** Jinn closure | 23 declared | **29** | ~20 MB | + `task-admission` + `environment-record`; no kits |
| Full `platform-v1` packed set | 54 | 54 tarballs exist | not installed as one tree in this spike | version `0.1.0-canary.sha.47ab2f934fec7fd3b49da6e0ad453882f6720575` |

Installed names **matched** the static dependency walks. Publication-set size ≠ download size.

### 10.2 Protocol+kits 24 (load-bearing organization finding)

Installing the five kits does **not** yield “kits + sealed records only.” Runtime dependency of each kit:

| Kit | Runtime `@jinn-network/*` (direct) | What that pulls |
|---|---|---|
| `benchmarking-testing` | records, profiles, protocol | + `trust-core` via records |
| `record-discovery-testing` | discovery protocol | + `trust-core` |
| `trust-testing` | `trust-core`, **`trust-resolve`** | `viem` |
| `task-execution-testing` | protocol, **backend, backend-local, launchers, supervisor, workspace** | evidence discovery/repository + execution-recorder |
| `marketplace-testing` | evidence-protocol, **binding, projector, venue-base**, discovery-testing, TEP-testing, trust-testing | the union above + Base venue (`better-sqlite3`, `viem`) |

**Protocol-kit-only union** (`benchmarking-testing` ∪ `record-discovery-testing`): **7** packages — `benchmarking-{records,testing}`, `record-discovery-{protocol,testing}`, `task-execution-{profiles,protocol}`, `trust-core`.

That 7-set is the closest current approximation of “kits precede implementations” at the *package.json* layer. The other three kits invert §9 at the manifest layer: a kit user who installs `task-execution-testing` or `marketplace-testing` also installs local backends and the Base venue adapter.

Independent kit publication is therefore a **package-boundary change**, not a release-policy tweak.

### 10.3 Colophon closures (consumer tests)

**Verify (10):** `benchmarking-{aggregate,interop,local,records,run}`, `task-admission`, `task-execution-{profiles,protocol}`, `trust-core`, plus transitive `environment-record`.

Does **not** install backend, launchers, supervisor, workspace, marketplace, discovery HTTP, kits, or `@colophon-claims/core`.

**Core (29):** the verify 10 plus attestation-issuer, benchmarking-publication, evidence-{discovery,protocol,repository}, execution-recorder, record-discovery-{client,protocol,serve,transport-http}, record-publication, task-execution-{backend,backend-local,evaluation-harness,evaluator-adapters,launchers,oci-grader,supervisor,workspace}.

Still no kits, no marketplace packages, no SQLite/IPFS/OCI repository bindings.

### 10.4 Native-vertical (30)

Packing selection, not a catalog release group. Union of requester / operator / evaluator / consumer role fixtures, including the two experimentals. Contains marketplace + venue-base + sqlite catalog + trust-resolve. Does **not** contain Colophon’s benchmarking application stack or `task-execution-oci-grader`.

---

## 11. Workstream C — experimental concern / contract / graduation

Catalog facts (HEAD `47ab2f934`):

| Package | Path | Catalog tier | Role | Group | Stability | Policy | License | Runtime `@jinn-network/*` |
|---|---|---:|---|---|---|---|---|---|
| `task-admission` | `packages/task-supply/admission` | 3 | task admission capability | `experimental-task-supply` | candidate | disabled | Apache-2.0 | `environment-record`, `task-execution-profiles`, `task-execution-protocol`, `trust-core` |
| `environment-record` | `packages/environments/record` | 2 | environment record family | `experimental-environment-supply` | experimental | disabled | MIT | none |

`platform-v1.allowedDependencyReleaseGroups` is only itself, so these two **cannot** join the 54 without a catalog policy change. That is why they sit outside, not because they failed an inclusion test.

### 11.1 Concern mix inside `task-admission`

- `src/index.ts` barrels everything, including `admit.js`.
- `src/admit.ts` (SWE differential) **imports** `environment-record`. So do `inline-match.ts`, `testing.ts`, `test-paths.ts`.
- `src/prediction-snapshot.ts` does **not** import `environment-record`. It imports `task-execution-profiles`, `trust-core`, local identifiers/refusals. Defines `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1` and `PredictionSnapshotAdmissionReceiptV1`.
- `src/identifiers.ts`: `ADMISSION_RECEIPT_MEDIA_TYPE = "application/vnd.in-toto+json"` — the same string as `trust-core` `DSSE_PAYLOAD_TYPE`. `IN_TOTO_STATEMENT_TYPE` is duplicated (comment: mirrored structurally, never imported across trees). Prediction-snapshot policy URIs live only here.
- Exports: `.` and `./testing` only. **No** `./prediction-snapshot` subpath.

Packed spike: importing the four verifier symbols from the package root **succeeds**. `environment-record` is installed (manifest dep). Evaluating the root still loads `admit.js` via `export *`. Organization finding: sealed receipt parse types and SWE environment authoring share one package and one barrel.

### 11.2 What already exists in tier-1/2 for a verifier

| Symbol | Where it already lives | Enough for Colophon verify? |
|---|---|---|
| DSSE `payloadType` `application/vnd.in-toto+json` | `trust-core` `DSSE_PAYLOAD_TYPE` | yes, for media-type check |
| in-toto Statement `_type` | `trust-core` `IN_TOTO_STATEMENT_TYPE` | yes, for `_type` check |
| Structural DSSE admission-receipt checks | `task-execution-profiles` `checkAdmissionReceipt` / `AdmissionReceiptStatementSchema` | **no** — does not export prediction-snapshot policy URI or `PredictionSnapshotAdmissionReceiptV1` |
| `PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1` + receipt type | **only** `task-admission` | this is the load-bearing sealed-contract gap |

Colophon verify (`packages/benchmark-product/verify/src/profile/admission-receipts.ts`) parses a sealed envelope; it does not call `admitCandidate`. Colophon core uses authoring APIs (`admitPredictionSnapshot`, fixtures, seal) in `packages/benchmark-product/core/src/intake/sample.ts`.

Golden fixture: `packages/task-supply/admission/fixtures/prediction-snapshot-v1/`. Protocol kits do **not** own this sealed-receipt contract today.

### 11.3 Runtime consumers (source imports, not only manifests)

**`task-admission`:** client `native-requester`; `task-derivation`; `chain-scenarios`; Colophon verify + core; own pack-smoke. Native-role requester fixture also lists it.

**`environment-record`:** admission (SWE path); derivation; `environment-verification`; `record-discovery-facts-environments`; chain-record equivalence tests; plus any install of `task-admission`.

### 11.4 Graduation gates (READMEs + DR-2026-08-03)

DR-2026-08-03: “Ratify no task-supply or environment package on Phase B evidence alone; keep speculative publication disabled.”

| Gate (admission README / env-record README) | Met? |
|---|---|
| Approved authority (record-family / admission decision beyond Phase B use) | **unmet** (publication stays disabled in catalog) |
| Second independent consumer | **unmet** as ratification — Colophon + native-requester + derivation are first-party. No external implementer. |
| Frozen conformance | **partial** — in-tree fixtures and kits exist; not published as registry artifacts |
| Packed external install | **partial** — CI packs native-role tarballs; public npm 404 |
| Load-bearing live use | **unmet** |
| Independent producers and consumers (env-record) | **unmet** |

Native-role packing and Colophon use are **not** ratification. This sheet does **not** recommend graduation.

---

## 12. Workstream D — `platform-v1` membership evidence

Catalog at HEAD: **54** members. Original catalog (`1e0b81bc6`, 2026-08-02) had **50**. Net +4: added `benchmarking-local`, `benchmarking-publication`, `evidence-trace`, `record-publication`, `task-execution-oci-grader`, `trust-authoring`; removed `evidence-trajectory`, `marketplace-pipeline` (DR-2026-08-03). Lockstep is younger than the packages.

**Safe local spike (five mixed-concern / persistence / binding leaves):** `git log --follow` on `package.json` for `marketplace-venue-base`, `evidence-catalog-sqlite`, `task-execution-testing`, `trust-resolve`, `evidence-repository-ipfs`. All landed with their domain’s first platform scaffold (2026-07-24 … 2026-07-31), not as leftovers glued on later. Coordinated *release* behavior is the Aug 2 catalog, not a shared commit history. Remaining 49 rows: **unknown** (not sampled).

Hypothesis column is **not** a keep/drop decision. `keep` = belongs in *some* platform compatibility story as currently designed. `investigate concern mix` = same group as sealed records is the question. `likely historical proximity` = weak independent inclusion story.

Counts: **31** keep / **22** investigate concern mix / **1** likely historical proximity (`execution-recorder-bridge`). Audit §2 tiers: **5** protocol / **3** protocol-extending / **41** application / **5** kit-or-guard. §4: **20** mixed, **15** application policy, **9** semantic protocol, **4** backend API, **3** persistence, **2** carrier, **1** serialization.

### 12.1 Principles pass (tier / concern first)

All names are `@jinn-network/<package>`.

| Package (`@jinn-network/…`) | Catalog tier | §2 tier (audit) | §4 concern | Coupling | §5 sealed | §9 kit | Coord (90d sample) | Support promise | Hypothesis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `record-discovery-protocol` | 1 | protocol | semantic protocol | both | yes (fixtures/) | record-discovery-testing | unknown | candidate canary set | keep |
| `evidence-protocol` | 1 | protocol | semantic protocol | depended-on | yes (fixtures/ + schema) | no dedicated *-testing kit; ./testing on siblings | unknown | candidate canary set | keep |
| `task-execution-profiles` | 1 | protocol | mixed | both | yes (fixtures/ + profiles/) | ./testing + benchmarking-testing | unknown | candidate canary set | investigate concern mix |
| `task-execution-protocol` | 1 | protocol | semantic protocol | depended-on | yes (schemas/ + fixtures/) | task-execution-testing | unknown | candidate canary set | keep |
| `trust-core` | 1 | protocol | semantic protocol | depended-on | yes (fixtures/) | trust-testing | unknown | candidate canary set | keep |
| `benchmarking-records` | 2 | protocol-extending record | semantic protocol | both | yes (schemas/ + fixtures/) | benchmarking-testing | unknown | candidate canary set | keep |
| `evidence-trace` | 2 | protocol-extending record | semantic protocol | both | yes (fixtures/) | no | unknown | candidate canary set | keep |
| `trust-authoring` | 2 | protocol-extending record | serialization | depends | no (authoring, not a record family kit) | no | unknown | unclear | investigate concern mix |
| `benchmarking-aggregate` | 3 | application | application policy | depends | no | no | unknown | candidate canary set | keep |
| `benchmarking-interop` | 3 | application | application policy | depends | yes (fixtures/) | no | unknown | candidate canary set | keep |
| `benchmarking-local` | 3 | application | mixed | depends | no | no | unknown | binding | investigate concern mix |
| `benchmarking-marketplace` | 3 | application | mixed | depends | yes (fixtures/) | no | unknown | binding | investigate concern mix |
| `benchmarking-publication` | 3 | application | application policy | depends | no | no | unknown | candidate canary set | keep |
| `benchmarking-run` | 3 | application | application policy | both | no | no | unknown | candidate canary set | keep |
| `record-discovery-client` | 3 | application | carrier | both | no | no | unknown | candidate canary set | keep |
| `record-discovery-facts-benchmarking` | 3 | application | mixed | depends | yes (fixtures/) | no | unknown | candidate canary set | keep |
| `record-discovery-facts-evidence` | 3 | application | mixed | depends | no | no | unknown | candidate canary set | keep |
| `record-discovery-facts-task-execution` | 3 | application | mixed | depends | no | no | unknown | candidate canary set | keep |
| `record-discovery-facts-trust` | 3 | application | mixed | depends | no | no | unknown | candidate canary set | keep |
| `record-discovery-serve` | 3 | application | backend API | both | no | no | unknown | candidate canary set | keep |
| `record-discovery-source-evidence-journal` | 3 | application | mixed | depends | yes (fixtures/) | no | unknown | binding | investigate concern mix |
| `record-discovery-transport-http` | 3 | application | carrier | depends | no | no | unknown | candidate canary set | keep |
| `record-publication` | 3 | application | application policy | both | no | no | unknown | candidate canary set | keep |
| `attestation-issuer` | 3 | application | application policy | both | yes (fixtures/) | ./testing | unknown | candidate canary set | keep |
| `evidence-catalog-sqlite` | 3 | application | persistence | both | no | no | yes (domain scaffold Jul 2026) | binding | investigate concern mix |
| `evidence-contribution` | 3 | application | application policy | depends | no | ./testing | unknown | unclear | keep |
| `evidence-derivation` | 3 | application | mixed | both | no | ./testing | unknown | unclear | investigate concern mix |
| `evidence-discovery` | 3 | application | backend API | both | no | no | unknown | candidate canary set | keep |
| `evidence-local-runtime` | 3 | application | mixed | depends | no | no | unknown | unclear | investigate concern mix |
| `evidence-publication` | 3 | application | application policy | both | no | no | unknown | candidate canary set | keep |
| `evidence-repository` | 3 | application | backend API | both | no | no | unknown | candidate canary set | keep |
| `evidence-repository-ipfs` | 3 | application | persistence | depends | no | no | yes (domain scaffold Jul 2026) | binding | investigate concern mix |
| `evidence-repository-oci` | 3 | application | persistence | depends | no | no | unknown | binding | investigate concern mix |
| `evidence-retrieval` | 3 | application | application policy | depends | no | no | unknown | unclear | keep |
| `evidence-trace-decode` | 3 | application | semantic protocol | depends | yes (decode fixtures) | no | unknown | unclear | keep |
| `execution-recorder` | 3 | application | application policy | both | yes (fixtures/) | no | unknown | candidate canary set | keep |
| `execution-recorder-bridge` | 3 | application | mixed | depends | no | no | unknown | unclear | likely historical proximity |
| `marketplace-binding` | 3 | application | mixed | both | yes (fixtures/) | marketplace-testing | unknown | binding | investigate concern mix |
| `marketplace-projector` | 3 | application | mixed | both | no | marketplace-testing | unknown | binding | investigate concern mix |
| `marketplace-venue-base` | 3 | application | mixed | both | no | marketplace-testing (runtime dep) | yes (domain scaffold Jul 2026) | binding | investigate concern mix |
| `task-execution-backend` | 3 | application | backend API | both | no | task-execution-testing | unknown | candidate canary set | keep |
| `task-execution-backend-local` | 3 | application | mixed | both | no | task-execution-testing (runtime dep) | unknown | unclear | investigate concern mix |
| `task-execution-evaluation-harness` | 3 | application | application policy | both | no | no | unknown | unclear | keep |
| `task-execution-evaluator-adapters` | 3 | application | application policy | both | yes (fixtures/) | no | unknown | unclear | keep |
| `task-execution-launchers` | 3 | application | application policy | both | no | task-execution-testing (runtime dep) | unknown | unclear | investigate concern mix |
| `task-execution-oci-grader` | 3 | application | mixed | depends | no | no | unknown | unclear | investigate concern mix |
| `task-execution-supervisor` | 3 | application | application policy | both | no | task-execution-testing (runtime dep) | unknown | unclear | investigate concern mix |
| `task-execution-workspace` | 3 | application | application policy | both | no | task-execution-testing (runtime dep) | unknown | unclear | investigate concern mix |
| `trust-resolve` | 3 | application | mixed | both | no | trust-testing | yes (domain scaffold Jul 2026) | binding | investigate concern mix |
| `benchmarking-testing` | null (support) | kit-or-guard | semantic protocol | depends | yes (kit fixtures) | this package is the kit | unknown | kit-only | keep |
| `record-discovery-testing` | null (support) | kit-or-guard | semantic protocol | both | yes (kit fixtures) | this package is the kit | unknown | kit-only | keep |
| `marketplace-testing` | null (support) | kit-or-guard | mixed | depends | yes (kit fixtures) | this package is the kit | unknown | kit-only | investigate concern mix |
| `task-execution-testing` | null (support) | kit-or-guard | mixed | both | yes (kit fixtures) | this package is the kit | yes (domain scaffold Jul 2026) | kit-only | investigate concern mix |
| `trust-testing` | null (support) | kit-or-guard | mixed | both | yes (kit fixtures) | this package is the kit | unknown | kit-only | investigate concern mix |

### 12.2 Consumer-test columns (filled last; do not sort membership by these)

Y = present in that **installed** `@jinn-network/*` closure from Workstream B (platform-v1 names only). Experimental `task-admission` / `environment-record` are omitted here because they are not in the 54.

| Package | License | Colophon verify | Colophon core | Native-vertical | Full kit union | Protocol-kit union |
| --- | --- | --- | --- | --- | --- | --- |
| `record-discovery-protocol` | MIT | — | Y | Y | Y | Y |
| `evidence-protocol` | MIT | — | Y | Y | Y | — |
| `task-execution-profiles` | Apache-2.0 | Y | Y | Y | Y | Y |
| `task-execution-protocol` | MIT | Y | Y | Y | Y | Y |
| `trust-core` | Apache-2.0 | Y | Y | Y | Y | Y |
| `benchmarking-records` | MIT | Y | Y | — | Y | Y |
| `evidence-trace` | Apache-2.0 | — | — | — | — | — |
| `trust-authoring` | Apache-2.0 | — | — | — | — | — |
| `benchmarking-aggregate` | MIT | Y | Y | — | — | — |
| `benchmarking-interop` | MIT | Y | Y | — | — | — |
| `benchmarking-local` | MIT | Y | Y | — | — | — |
| `benchmarking-marketplace` | MIT | — | — | — | — | — |
| `benchmarking-publication` | MIT | — | Y | — | — | — |
| `benchmarking-run` | MIT | Y | Y | — | — | — |
| `record-discovery-client` | MIT | — | Y | Y | — | — |
| `record-discovery-facts-benchmarking` | MIT | — | — | — | — | — |
| `record-discovery-facts-evidence` | MIT | — | — | — | — | — |
| `record-discovery-facts-task-execution` | MIT | — | — | Y | — | — |
| `record-discovery-facts-trust` | MIT | — | — | — | — | — |
| `record-discovery-serve` | MIT | — | Y | Y | Y | — |
| `record-discovery-source-evidence-journal` | MIT | — | — | — | — | — |
| `record-discovery-transport-http` | MIT | — | Y | Y | — | — |
| `record-publication` | MIT | — | Y | Y | — | — |
| `attestation-issuer` | Apache-2.0 | — | Y | Y | — | — |
| `evidence-catalog-sqlite` | MIT | — | — | Y | — | — |
| `evidence-contribution` | Apache-2.0 | — | — | — | — | — |
| `evidence-derivation` | Apache-2.0 | — | — | — | — | — |
| `evidence-discovery` | MIT | — | Y | Y | Y | — |
| `evidence-local-runtime` | MIT | — | — | Y | — | — |
| `evidence-publication` | Apache-2.0 | — | — | Y | — | — |
| `evidence-repository` | MIT | — | Y | Y | Y | — |
| `evidence-repository-ipfs` | Apache-2.0 | — | — | — | — | — |
| `evidence-repository-oci` | MIT | — | — | — | — | — |
| `evidence-retrieval` | MIT | — | — | — | — | — |
| `evidence-trace-decode` | Apache-2.0 | — | — | — | — | — |
| `execution-recorder` | Apache-2.0 | — | Y | Y | Y | — |
| `execution-recorder-bridge` | Apache-2.0 | — | — | — | — | — |
| `marketplace-binding` | MIT | — | — | Y | Y | — |
| `marketplace-projector` | MIT | — | — | Y | Y | — |
| `marketplace-venue-base` | MIT | — | — | Y | Y | — |
| `task-execution-backend` | MIT | — | Y | Y | Y | — |
| `task-execution-backend-local` | Apache-2.0 | — | Y | Y | Y | — |
| `task-execution-evaluation-harness` | Apache-2.0 | — | Y | Y | — | — |
| `task-execution-evaluator-adapters` | Apache-2.0 | — | Y | Y | — | — |
| `task-execution-launchers` | Apache-2.0 | — | Y | Y | Y | — |
| `task-execution-oci-grader` | Apache-2.0 | — | Y | — | — | — |
| `task-execution-supervisor` | Apache-2.0 | — | Y | Y | Y | — |
| `task-execution-workspace` | Apache-2.0 | — | Y | Y | Y | — |
| `trust-resolve` | Apache-2.0 | — | — | Y | Y | — |
| `benchmarking-testing` | MIT | — | — | — | Y | Y |
| `record-discovery-testing` | MIT | — | — | — | Y | Y |
| `marketplace-testing` | MIT | — | — | — | Y | — |
| `task-execution-testing` | MIT | — | — | — | Y | — |
| `trust-testing` | Apache-2.0 | — | — | — | Y | — |

A third-party **protocol-kit** user (benchmarking-testing ∪ record-discovery-testing) needs **7** of the 54. A **full kit** user needs **24**. Colophon verify needs **8** of the 54 plus two experimentals. Native-vertical packing needs **28** of the 54 plus two experimentals. **Unused by every B consumer** is not a drop criterion (principles §8; facts leaves are the designed discovery↔record join).

### 12.3 Kits versus §9

- `benchmarking-testing` and `record-discovery-testing` are protocol-shaped kits (runtime deps are record/protocol packages).
- `trust-testing` runtime-depends on `trust-resolve` (`viem`) — kit pulls a chain binding.
- `task-execution-testing` runtime-depends on local backend assembly, launchers, supervisor, workspace.
- `marketplace-testing` runtime-depends on those kits **and** `marketplace-{binding,projector,venue-base}`.
- Evidence has **no** `evidence-testing` kit in the five; conformance is `./testing` exports on individual evidence packages.

§9 (“kits precede implementations”) holds as a design rule and **fails** as a package.json fact for three of five kits.

### 12.4 Marketplace bindings and persistence backends

These share `platform-v1`’s one version and one receipt with sealed protocol roots:

- Persistence: `evidence-catalog-sqlite` (`better-sqlite3`), `evidence-repository-ipfs` (`kubo-rpc-client`), `evidence-repository-oci`.
- Bindings: `marketplace-binding`, `marketplace-projector`, `marketplace-venue-base` (Base + sqlite + viem), `trust-resolve` (viem), `benchmarking-local`, `benchmarking-marketplace`.
- Local composition: `evidence-local-runtime`, `task-execution-backend-local`.

Nothing in the catalog currently allows these to version independently of `trust-core`. That is the lockstep cost.

### 12.5 Protocol roots

True Jinn-dep-free roots: `task-execution-protocol`, `evidence-protocol`, `trust-core`.

`record-discovery-protocol` depends on `trust-core`. `task-execution-profiles` depends on `task-execution-protocol` and also exports `./testing` plus structural `checkAdmissionReceipt` (concern mix with admission). `benchmarking-records` and `evidence-trace` are tier-2 record families with kits/fixtures. `trust-authoring` is catalog tier 2 but is serialization/authoring, not a sealed record family with a kit.

Cross-package sealed equivalence (§5, engineering Q11): sealing is re-implemented per package (JCS-once, sha256). Catalog `publicSurface.fixtures` / on-disk `fixtures/` exist on protocol roots, kits, and several adapters. This audit did **not** exhaustively prove which fixture pairs are cross-package digest-equivalent; it records that the mechanism exists and is the reason record packages may need coordinated release **even without** a runtime import edge.

---

## 13. Workstream E — cadence, compatibility, consumer stories

### 13.1 Consumer stories (installed closures)

| Actor | What they install today | What breaks if `platform-v1` stays 54-lockstep | What breaks if groups split by concern without a product receipt story |
|---|---|---|---|
| Third-party **protocol implementer** | Wants the 7-set (or similar) + published schemas/kits | Must take backends, Base venue, sqlite, viem, or wait forever because nothing is on npm (A) | Can pin protocol receipt; must not be told Colophon’s 29 is the platform |
| **Kit user** (full marketplace kit) | 24 packages, including local backend + venue-base | Same receipt as sealed records; a venue bugfix republishes `trust-core` | Must pin several receipts (protocol + TEP impl + marketplace) |
| **Native-vertical host** | 30 packed names (incl. two experimentals) | Experimentals are not in the 54; packing uses `platform-v1` as version authority anyway | Host still needs admission+env-record published or bundled |
| **Colophon installer** (core) | 29 Jinn names | 27/54 + 2 experimental; cannot `npm install` any of them (A) | Must pin platform receipt(s) plus a policy for experimentals without calling that graduation |
| **Colophon verifier** | 10 Jinn names, ~16 MB, no backends | Smallest product graph; still pulled into any lockstep bump of the 54 if it pins `platform-v1` | Happiest under a sealed-record + admission-types group, if that group exists |
| **Contributor** | portal: workspaces | Catalog forbids `platform-v1` → experimental deps; they already violate that in products via resolutions | Splitting groups increases catalog/wave complexity |
| **Security-fix** (one Apache-2.0 package, e.g. `trust-core`) | — | Lockstep republishes all 54 at one new canary version (sqlite, venue, oci-grader included) | Independent: bump one. Concern-sliced: bump the protocol group; implementations that import it follow semver of that group |
| **Rollback** | npm versions immutable | Move dist-tag; there is **no** stack `latest` today. Bad canary remains a version forever | Same immutability; more tags to move if multiple groups |

### 13.2 Client Rules 8–9 versus stack cadence

Handbook Rules 8–9 describe the **client** train: every push to `next` that touches `client/**` publishes `@jinn-network/client` canary; Monday named cut is `latest`; `main` fast-forwards on release publish.

`platform-v1` is a **different object**:

- Catalog `canary-only`, `stable: false`.
- Publisher hard-refuses non-canary.
- Workflow `stack-canary` is flag-gated and currently **skipped**.
- No `stack-v*` tags exist.
- Dist-tag `canary` on 54 packages would collide in *name* with client canary but not in package identity (`@jinn-network/client` vs the 54).
- There is no stack `latest`. A stable stack cut would be a **new** cadence object, not the Monday client cut, unless an operator decision binds them (§3.2).

Demand-gated product releases are **allowed** (Decision 6): product cadence is independent of Monday client and of the next `stack-v*`, as long as the public Jinn pin is a stable receipt (Decision 4). Auto-canary of a product on every `next` push is still forbidden.

### 13.3 License / notice inventory (no relicensing)

`platform-v1`: **33 MIT / 21 Apache-2.0**. Mixed inside every interesting closure.

| Closure | MIT / Apache-2.0 (approx.) | Heavy third-party runtime |
|---|---|---|
| Protocol-kit 7 | mostly MIT + Apache `trust-core` + Apache `task-execution-profiles` | `@noble/hashes`, `zod`, `ajv` |
| Full kit 24 | mixed | **`viem`**, `better-sqlite3` (venue-base), `@noble/*`, `zod` |
| Colophon verify 10 | mixed + experimental Apache admission + MIT env-record | `@noble/hashes`, `zod` — **no viem** |
| Colophon core 29 | mixed | still no viem; adds TEP implementation tree |
| Native-vertical 30 | mixed | `viem`, `better-sqlite3` |
| Persistence leaves (not in Colophon) | sqlite MIT; ipfs Apache (`kubo-rpc-client`); oci MIT | native addons / Kubo |

NOTICE files for a published set must list both licenses plus third-party notices for whatever that set actually installs. Verifier-sized sets avoid `viem` / sqlite; kit and native-vertical sets do not.

Experimental pair: admission Apache-2.0, environment-record MIT — same mix a verifier already has via `trust-core` + `benchmarking-records`.

---

## 14. Workstream F — models versus criteria (no selection)

Evaluate with A–E evidence. **No recommended model.** Conditions are when a later operator design *could* honestly pick the row, not a ranking.

| Model | Appropriate when | Inappropriate when | Evidence already in hand |
|---|---|---|---|
| Full current `platform-v1` (54) plus a **separate** policy for experimental groups | Operator accepts one public kernel for tiers 1–3 + kits; unused-by-a-given-consumer packages are cheap; one receipt matters more than cadence isolation; §9 inversion in three kits is an accepted exception | Mixed-concern packages cannot be supported as one set; or a venue/sqlite/viem advisory must not republish sealed records; or experimental publication is forbidden while Colophon/native still import those packages | D: 41/54 are applications; 22 investigate concern mix. B: no consumer needs all 54. A: cannot publish anyway |
| Multiple smaller synchronized groups (by **tier/concern**, not by product) | Protocol records, kits, backends, and bindings change on different cadences **and** consumers can pin several receipts; kit package.json is split or kits move with implementations on purpose | The public story cannot name more than one platform receipt; or catalog/wave tooling cannot express multiple `stackPublished` groups yet (engineering follows design, not vice versa) | B protocol-kit 7 vs kit 24 vs native 30 vs Colophon 29 are distinct. D persistence/bindings identified |
| Receipt-bound **product** closures (Colophon 29, native-vertical 30, …) | Used as product-private bundles or packing selections | The product closure is published *as* the platform kernel (principles §8 fail; kits dropped; marketplace dropped because Colophon does not import it) | B: Colophon omits kits and marketplace; native omits benchmarking application and oci-grader; both include experimentals the 54 forbid |
| Independent package versioning | Most packages are truly leaf contracts with stable APIs; §5 cross-package fixtures still hold across independently chosen versions | Exact-set coherence is the platform’s public invariant (catalog today: one version `0.1.0` for all 54) | Catalog `allowedDependencyReleaseGroups` and one-version publisher encode lockstep. Protocol roots have no Jinn deps and *could* version independently; kits that import implementations could not |
| Hybrid: sealed contracts independently versioned; implementations lockstep | Record packages change rarely; adapters/backends change often; §5 equivalence fixtures still hold; prediction-snapshot types live in a sealed package (C) | Sealing/canonicalization bugs require simultaneous verifier+author updates every time; or kits still runtime-depend on implementations so “independent sealed” is a fiction at install time | C: sealed receipt types trapped in experimental authoring package. B: three kits install implementations |
| Bundled **product** distributions | A product has demand and cannot wait for platform publication; bundle is labeled as the product, not as `@jinn-network` | It would hide `@jinn-network` identity, fork schemas, or become the de facto platform | A: public npm blocked. Colophon spec already forbids pretending unpublished Jinn deps are a product-only problem |
| Extraction or published mirror | Extraction gates are green **and** dual governance has demand (existing spec) | Used as a shortcut around unpublished Jinn deps (already rejected) | Architecture follow-up 1 is the publish path; A shows that path is not enabled. Extraction-readiness remains NOT READY |

Dimensions (not scored as a winner): source-repo identity stays `Jinn-Network/mono` today; npm scope identity is `@jinn-network` vs product scopes; release cadence is client Rules 8–9 vs nonexistent `stack-v*`; provenance is trusted-publisher + receipt (A: not live); licensing is mixed MIT/Apache (E); maintenance burden scales with lockstep width (54) versus number of receipts (sliced groups).

### 14.1 Criteria check (informs a future design; still not a choice)

| Criterion (§5) | What A–E showed |
|---|---|
| Layering | Products are already out of `platform-v1`. Experimentals are out because of `allowedDependencyReleaseGroups`, not because they are products |
| Concern separation | Named: 20 mixed-concern packages; three kits invert §9; admission barrels sealed types with env-record authoring |
| Outside implementer | Closest honest set today is protocol-kit 7, unpublished |
| Kits before implementations | Design yes; manifests no for TEP/marketplace/trust kits |
| Executable architecture | Catalog remains the map; D did not edit it |
| Legibility | Receipts exist in CI; public registry and `spec.jinn.network` do not serve them |
| Coherence | One named set exists (`platform-v1`); consumers already mix it with disabled experimentals |
| Consumer honesty | Install size ≠ 54; recorded in B |
| Graduation honesty | C: gates unmet; do not treat packing/Colophon as ratification |
| Cadence honesty | Client ≠ stack; stack has no `latest` |
| Security/rollback | Lockstep republishes 54; versions immutable |
| Provenance | Trusted publisher never succeeded; no npm token |
| Licensing | Mixed; NOTICE required per published set |
| Non-goals | This audit did not publish, enable flags, file Issues, or edit Colophon site |

Failing any criterion still returns a **future** draft to discovery. This workstream does not produce that draft.

---

## 15. Gate G0 — audit complete

This plan now contains A–F findings. **G0 is the audit gate, not a publication gate.**

Still required **after** an operator picks a draft release design, before public npm (unchanged from §4 “work required only before actual npm publication”):

1. Operator decisions on §3.3 items 1–6 — **closed 2026-08-15** (see §16). Draft release design from those votes: §17. Not applied to catalog/workflows yet.
2. Catalog/workflow changes implied by that design — **not** done in this audit.
3. Trusted-publisher registration and a decision about protecting `npm-publish` without accidentally gating client publishes (shared environment).
4. Hosting: signing key, public key URL, `spec.jinn.network` serving real artifacts.
5. `PLATFORM_CANARY_PUBLISH_ENABLED` only after the runbook checklist.
6. Local tarball proof (B already did clean `file:` installs for closures), then ephemeral/clean registry proof, then public npm as last proof.

Do not enable the flag, register publishers, or change `platform-v1` membership from this document alone.

---

## 16. Operator decisions (closed 2026-08-15)

Recorded from the operator session after Gate G0. These are policy. They do not publish packages, edit the catalog, or enable flags.

### Decision 1 — What `platform-v1` is promising (2026-08-15)

**Choice:** two synchronized groups, sliced by concern, not by product.

| Group | Compatibility promise | Travels together |
|---|---|---|
| **Sealed platform** | Produce and verify sealed records without running a Jinn product | Tier-1 and tier-2 record packages, plus the two kits whose manifests already stop at protocol (`benchmarking-testing`, `record-discovery-testing`). One version, one receipt. |
| **Implementations** | Run, bind, persist, and grade | Backends, launchers, persistence (SQLite / IPFS / OCI), marketplace bindings, Base venue, `trust-resolve`, local runtimes, graders, and the three kits that already install those things. Separate version, separate receipt. |

Products pin **both** receipts. They do not define Group 1. Colophon’s 29 and native-vertical’s 30 stay consumer tests, not membership lists.

**Rejected for this decision:** one kernel of the current 54; per-package independent versioning; a 20-package purity refactor as a gate; naming groups after a product.

**Follow-ups, not gates:** split the three kit manifests if a later design wants “kits without backends”; split `task-admission` if a later design wants receipt types without `environment-record`.

Exact package lists for the former experimental groups are in Decision 2. Decisions 3–6 are closed; catalog/workflow changes still wait for an approved draft (§17). The current catalog group `platform-v1` (54, one version) remains the *implemented* grouping until that draft is applied.

### Decision 2 — Experimental caste (2026-08-15)

**Choice:** withdraw the publication-disabled-until-graduation caste. Classify the 13 task-supply and environment packages with Decision 1. Record: [DR-2026-08-15](../../../log/decisions/2026-08-15-withdraw-task-supply-environment-publication-caste.md).

First-party use still does not ratify. Candidate canary is the same bar as the 54. This is **not** a stable cut and **not** an independent external consumer.

| Group | Former experimental packages (`@jinn-network/…`) |
|---|---|
| **Sealed platform** | `environment-record`, `chain-environment-record` |
| **Implementations** | `task-admission`, `task-derivation`, `task-posting`, `task-curation`, `chain-scenarios`, `environment-verification`, `chain-environment-verification`, `chain-state-extraction`, `information-world` (record + replay mixed; implementations until split), `record-discovery-facts-environments`, `record-discovery-facts-chain-environments` |

**Retained from DR-2026-08-03 decision 6:** do not extract `task-curation` into Record Discovery facts until two real consumers prove that join. That is a seam, not a caste.

**Out of this decision:** `experimental-policy` (`policy-identity`, `policy-outcomes`) was never under decision 6. Still draft-spec; not reclassified here.

**Not done by this decision:** catalog `publishPolicy` / group membership; README banners; enabling canary; trusted-publisher registration.

### Decision 3 — Publish custody (2026-08-15)

**Choice:** same as currently published `@jinn-network/*` packages. Reuse the npm org, GitHub environment `npm-publish`, OIDC trusted-publisher pattern, and the operator who already registers those rows (client / sdk / layer trains). Do not invent a second publisher identity or a second GitHub environment for the stack groups.

**Accepted consequence:** later protection of `npm-publish` (reviewers, allowed branches) also gates client canary, because the environment is shared. `npm-stable-publish` remains the existing protected path for client `latest`.

**Not done by this decision:** adding trusted-publisher rows; changing environment protection rules; enabling `PLATFORM_CANARY_PUBLISH_ENABLED`.

### Decision 4 — Product pins vs platform canary (2026-08-15)

**Choice:** **A.** A product's public release pins `@jinn-network/*` from a **stable** platform receipt only. Workspace, portals, local tarballs, and canary versions remain forbidden in that proof (same rule Colophon's spec already wrote).

Platform canary may still publish as an opt-in integrator/CI train, like `@jinn-network/client@canary`. It is not what a visitor-facing product may depend on.

**Reason recorded:** this forces actually publishing what is needed (a named stable stack cut / `latest`) rather than living on canaries forever.

**Consequence:** Colophon (and any later product) cannot npm-publish until sealed-platform and implementations have a stable lane. Catalog today is `canary-only` / `stable: false`; a later catalog PR must allow stable for those two groups. Client's own `@canary` / `@latest` is unchanged.

**Not done by this decision:** inventing `stack-v*` tags, flipping catalog `stable: true`, or enabling any publish flag.

**Amendment (2026-08-17, [DR-2026-08-17-c](../../../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md)):** Colophon's **first** public npm cut may pin exact `0.1.0-canary.sha.<fullSha>` versions from one stack-canary receipt. Floating `@canary` remains forbidden. Living on canary forever remains forbidden. The Jinn stable / `spec.jinn.network` hold is unchanged. Subsequent pin changes wait for the first green live-host stable receipt.

### Decision 5 — Publisher identity (2026-08-15)

**Choice:** **A.** Platform packages publish as `@jinn-network` under Jinn-Network (Decision 3). Products publish under their own npm organizations. Colophon is `@colophon-claims` (Colophon-controlled): public `core`, `cli`, `verify`; `web` stays private. No Colophon package under `@jinn-network`. Not `@colophon` (taken). Not a personal scope.

Source of record stays in this mono. Public product face `ritsukai` / `colophon.claims`. Attribution: “Built on Jinn, by Jinn contributors.”

**Not done by this decision:** creating the npm org, reserving names, or adding a Colophon publish workflow. Reservation remains a human publication gate.

### Decision 6 — Product cadence (2026-08-15)

**Choice:** **A.** Products are independent consumers of published Jinn. After the first stable platform receipt exists, a **product-only** release (Jinn pin unchanged) may publish on demand from this mono — not tied to the Monday client cut, and not tied to waiting for the next `stack-v*`.

If the product needs a **new** platform API, Decision 4 still applies: wait for a compatible stable stack cut and upgrade the complete pin as a set.

**Still forbidden:** auto-publish of a product on every push to `next` (that would ship against unpinned HEAD). Handbook Rules 8–9 continue to describe **client** only; they do not gate `@colophon-claims`. A separate npm org (Decision 5) does not by itself grant this exception — this vote does.

**Not done by this decision:** adding a Colophon publish workflow, reserving `@colophon-claims`, or amending the handbook text.

---

## 17. Draft release design (policy closed 2026-08-15)

This is the design implied by Decisions 1–6. Catalog split and trusted-publisher registration have since landed. [DR-2026-08-17-c](../../../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md) applies a named first-cut exception to Decision 4. [DR-2026-08-17-d](../../../log/decisions/2026-08-17-platform-canary-publish-enabled.md) set the canary flag. `@colophon-claims` is reserved. Product workflow and live spec host are still not applied.

### Three public objects

| Object | npm identity | Promise | Cadence |
|---|---|---|---|
| **Sealed platform** | `@jinn-network/*` (record packages + `benchmarking-testing` + `record-discovery-testing`) | Produce/verify sealed records without running a Jinn product. One version, one receipt. | Canary opt-in; **stable** required before any *subsequent* product pin (Decision 4 as amended by DR-2026-08-17-c). Named cut (`stack-v*` / `latest`) is a new object, not the Monday client cut. |
| **Implementations** | `@jinn-network/*` (backends, launchers, persistence, marketplace/venue, `trust-resolve`, local runtimes, graders, the three kits that already install those, plus Decision 2’s implementation-class former experimentals) | Run, bind, persist, grade. Separate version, separate receipt. | Same custody and lanes as sealed platform (Decision 3). Products pin **both** receipts. |
| **Product** (Colophon first) | `@colophon-claims` (`core`, `cli`, `verify` public; `web` private) | Independent consumer. | Demand-gated, manual. Several product versions against one stable Jinn pin. Upgrade the pin as a set when a new platform API is needed. Never auto on `next`. |

Client (`@jinn-network/client` and the other `legacy-product-lines` trains) is unchanged: canary on `next`, `latest` on Monday.

### What stays a test, not a group

Colophon’s 29 and native-vertical’s 30 remain coupling tests. `experimental-policy` stays draft, unpublished. `task-curation` stays a seam (do not extract into Record Discovery facts until two consumers prove the join).

### Human gates still in front of public npm

1. Catalog PR: replace one 54-row `platform-v1` / `canary-only` with the two groups; allow stable (`canary-and-stable` or equivalent); move the 13 former experimentals per Decision 2; leave Colophon `never` until a product workflow exists.
2. Trusted-publisher rows for every `@jinn-network` name that will publish; later protect `npm-publish` knowing it also gates **client** canary.
3. Hosting: signing key, public key URL, `spec.jinn.network` serving real artifacts.
4. `PLATFORM_CANARY_PUBLISH_ENABLED` only after the runbook checklist. DR-2026-08-17-c then allows Colophon's **first** public cut to pin that exact receipt.
5. First **stable** stack cut (`stack-v*` / `latest`) — still required before the next Colophon pin change, and still held on live `spec.jinn.network`.
6. Reserve `@colophon-claims` (human); then a demand-gated product publish workflow in this mono, distinct from client Rules 8–9.
7. README banners that still recite the withdrawn graduation caste.
8. Follow-ups, not gates: split three kit manifests; split `task-admission` barrel.

Local tarball proof already exists (Workstream B). Next proofs: ephemeral/clean registry, then public npm last.

