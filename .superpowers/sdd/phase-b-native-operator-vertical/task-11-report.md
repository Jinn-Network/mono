# Task 11 — B9 independent public consumer and catalog-tarball acceptance report

## Result

B9 is complete. A separate consumer now cold-syncs and resumes requester, solver, and evaluator
signed sources, retrieves the complete native graph through public exact-record interfaces, verifies
the bytes, source chains, DSSE authorities, effective-time trust, graph joins, stable operation
identities, and canonical finalized chain facts, then emits a deterministic
`native-vertical-verification.json`. Its SQLite/cache root is consumer-owned and the implementation
has no producer-store input.

The release proof derives four executable role closures from checked-in fixture manifests and the
architecture catalog, packs them with their transitive catalog dependencies, installs exact canary
versions into clean prefixes outside the repository, starts every fixture, and records `npm ls`
plus module-resolution provenance. It rejects local dependency specifiers, locks, package
symlinks/source escapes, undeclared public targets, and producer-private paths.

Base: `4580ded63fa18fa0e02fd8bbafdcaf33744c3f3d`

Implementation commits:

- `f82c3146a` — preserve exact signed-discovery DSSE wire bytes
- `5cc64c26b` — persist verified independent source sync state
- `0ce447f83` — publish exact native record media types
- `58d042359` — retrieve the complete exact native record graph
- `ecf20e2b9` — authenticate exact requester Submission bytes
- `aaa6e2540` — verify native trust, graph, operation, and finalized-chain authority
- `3dac62226` — bind evidence documents to exact execution identities
- `51aa9e213` — prove the real public requester/solver/evaluator vertical
- `e4e40cc7d` — verify the catalog-derived packed native role closure

Implementation head before this report: `e4e40cc7db53915d1f77f713847977f696d46bf2`.

No live RPC, wallet, Kubo/IPFS, or Base Sepolia transaction was used. Public endpoints and canonical
chain facts were deterministic local fixtures; B10 owns the capped live run.

## Public consumer and graph proof

The consumer transactionally stores each verified source sequence/head, exact signed entry,
active/inactive fork status, and content-addressed cache entry. A returning pass starts at the
durable high-water and performs zero entry work when unchanged. A rewind retains displaced bytes
as inactive audit history and resumes from the latest signed common entry.

The public-vertical fixture uses the production requester, solution, and evaluator signed
publishers with persistent real Ed25519 test identities. The consumer receives only public source
readers, public digest retrieval, trust roots/policies/revocations, and canonical chain facts. It
retrieves and joins the Task, EvaluationSpec, receipt, Submission/requester envelope, solution
evidence/output/Delivery/envelope, evaluation Task/Submission/evidence/Delivery/envelope, and
verdict. Every advertised digest is checked over retrieved bytes before parsing.

Focused adversarial tests reject missing public locations, digest-mismatched bytes, discontinuous,
stale, or unknown-signer source material, fake DSSE with a known key ID, absent anchors/policies,
effective revocation, graph/execution mismatch, and non-finalized canonical facts. The report is
stable for the same graph and refuses private-path material.

The exact packed consumer emitted:

```json
{"schemaVersion":1,"verified":true,"recordDigest":"sha256:0de6079be559bfb552b010103721b01494ee5fbfc6bc5f8388c713fa4c3ec61f","taskDigest":"sha256:0de6079be559bfb552b010103721b01494ee5fbfc6bc5f8388c713fa4c3ec61f"}
```

## Catalog and packed-product proof

The catalog adds `native-task-supply-canary` and promotes only `task-admission`, `task-derivation`,
and `task-posting` from experimental/disabled to candidate/canary-only. `task-curation`,
`chain-scenarios`, and `environment-record` remain experimental and publication-disabled.
Generated topology is synchronized with the human-authored catalog.

Executable role manifests contain 10 requester, 20 operator, 20 evaluator, and 8 consumer root
imports. Catalog traversal produces closures of 14, 24, 26, and 9 packages respectively. Their
union plus the three promoted task-supply packages is 32 tarballs. The ordinary `platform-v1`
bundle remains 50 tarballs.

Exact-head bundle evidence, produced with Node `22.23.1` and npm `11.19.0`:

| Bundle | Packages | Build time | Manifest path | Manifest SHA-256 |
|---|---:|---:|---|---|
| platform-v1 | 50 | 1m 13.93s | `/tmp/jinn-task11-exact-platform.BWXuXO/manifest.json` | `3915119537343a445ea381fdf4ed8656eee3c01ec6b935fa8d4f0de22f4453a1` |
| native role closure | 32 | 49.57s | `/tmp/jinn-task11-exact-native.MzS0Uz/manifest.json` | `69e0125542938facd84fe9c186e2c920c7b425d46c85c699d6c1fb0c6f2669cd` |

Both manifests name source `e4e40cc7db53915d1f77f713847977f696d46bf2`, version
`0.1.0-canary.sha.e4e40cc7db53915d1f77f713847977f696d46bf2`, every package, relative
tarball filename, and its SHA-512 SRI. Those manifests are the authoritative 82-tarball digest
inventories; the tarballs remain beside them.

The exact-head clean install/start took 1m 03.30s. Retained prefixes and public-target resolution
counts are:

| Fixture | Packages | Resolved public targets | Prefix |
|---|---:|---:|---|
| platform | 50 | 631 | `/var/folders/2y/y3bmqdw55kx2jhq804chv76m0000gn/T/jinn-platform-prepublication-consumer-TyomDl` |
| requester | 14 | 240 | `/var/folders/2y/y3bmqdw55kx2jhq804chv76m0000gn/T/jinn-native-requester-prepublication-consumer-uy58eM` |
| operator | 24 | 298 | `/var/folders/2y/y3bmqdw55kx2jhq804chv76m0000gn/T/jinn-native-operator-prepublication-consumer-iltMyD` |
| evaluator | 26 | 312 | `/var/folders/2y/y3bmqdw55kx2jhq804chv76m0000gn/T/jinn-native-evaluator-prepublication-consumer-UGNn1j` |
| consumer | 9 | 265 | `/var/folders/2y/y3bmqdw55kx2jhq804chv76m0000gn/T/jinn-native-consumer-prepublication-consumer-u3cKmP` |

Each prefix retains `dependency-provenance.json` and `module-resolution-provenance.json`; the
consumer also retains `native-vertical-verification.json`. Inspection found zero package locks,
zero symlinks, and zero `file:`, `portal:`, `workspace:`, or `link:` manifest specifiers. Every
resolved module path stays under its clean prefix.

## API, workflow, and changed-path summary

- Added consumer-only state, sync, exact graph retrieval, verification, and report modules under
  `client/test/fixtures/native-vertical-consumer`, with integration coverage under
  `client/test/native-consumer`.
- Hardened discovery DSSE/source verification and exact requester/solution publication so public
  retrieval preserves authoritative bytes and media types.
- Added catalog-derived native role fixture/closure planning in
  `.github/scripts/native-vertical-role-packages.mjs` and generalized the existing prepublication
  builder/consumer rather than creating a second pack protocol.
- Updated the platform verification workflow to build, attest, download, and consume both exact
  bundles under the pinned toolchain.
- Fixed the real task-supply packed dependency closures and admission pack smoke exposed by the
  external install. No Task Execution Protocol schema or marketplace contract changed.

## Verification

Fresh green evidence:

- consumer/requester/CLI integration: 7 files, 32/32 tests;
- client TypeScript typecheck: exit 0;
- catalog, bundle, external-consumer, workflow, inventory, and source-boundary checks: 128/128;
- task-admission: 158/158 plus typecheck, build, and pack smoke;
- task-derivation: 107/107 plus typecheck, build, and pack smoke;
- task-posting: 76/76 plus typecheck, build, and pack smoke;
- generated architecture check and `git diff --check`: clean;
- exact-head 50-package and 32-package builds plus all five clean installs/starts: exit 0.

Representative commands:

```text
node --test .github/scripts/{build-prepublication-bundle,prepublication-external-consumer,platform-catalog,platform-verification-workflow,task-supply-package-inventory,task-supply-source-boundaries}.test.mjs
yarn --cwd client vitest run test/native-consumer test/native-requester/requester.test.ts test/cli/native-requester.test.ts --maxWorkers=1 --fileParallelism=false
yarn --cwd client typecheck
node .github/scripts/build-prepublication-bundle.mjs ... --release-group platform-v1 --lane canary
node .github/scripts/build-prepublication-bundle.mjs ... --release-group native-task-supply-canary --lane canary --native-vertical-roles
node .github/scripts/prepublication-external-consumer.mjs --manifest <platform>/manifest.json --native-manifest <native>/manifest.json --keep
node .github/scripts/generate-architecture.mjs --check
```

## Residual risk and B10 handoff

`environment-record` is a real runtime dependency of the requester closure but intentionally
remains experimental and publication-disabled. The accepted local Phase B bundle therefore packs
it as a catalog-derived closure-only dependency. Publishing only the promoted three task-supply
packages to a registry would not create a standalone registry-installable closure until release
governance separately graduates or externalizes `environment-record`; B9 does not silently broaden
that promotion.

The independent proof uses public local/fork adapters, not public internet availability or live
Base Sepolia finality. B10 must run the consolidated reviews/hosted exact-head gates and capped live
closure before changing the Base Sepolia default.
