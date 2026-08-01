# CE4 — Chain State Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Date:** 2026-07-31
- **Component:** CE4 of the chain environment family program
  ([`2026-07-31-chain-environment-program.md`](2026-07-31-chain-environment-program.md))
- **Design (law):** [`../specs/2026-07-31-chain-environment-family-design.md`](../specs/2026-07-31-chain-environment-family-design.md)
  — §7 (the authoring pipeline), §4.2 (the two axes, E13 coverage, E5 anchor bound, the
  boundary rule), §5.1 step 4 + §5.2 (archive-dependent observation), §10 (the Anvil
  dump-fidelity caveat), §11 (non-goals). Approved at `b3faed8b0`.
- **Parent law:** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  (`5b0739832`) and the merged supply implementation on `integration/evidence-v1`.
- **Branch:** `chain/ce4-chain-extraction`, based on `chain/ce3-chain-verification`
  (which bases on `chain/ce1-chain-record`, which bases on `integration/evidence-v1`).
  The PR targets its base branch, never integration.

**Goal:** ship `@jinn-network/chain-state-extraction` — the authoring producer half of
design §7. It forks a public chain at an anchor through **one injected archive port**, runs
the author's reference scripts and probe suite against that connected fork to establish a
baseline observation, harvests the state the run actually touched, assembles a candidate
chain-environment record + state artifact + E13 coverage manifest, and then runs the
**widen-and-re-verify convergence loop**: CE3's closed-state verification under blackhole,
compared against the connected baseline, widening the slice from localized missing state
until the blackholed world reproduces the baseline — or terminating, under a declared
bound, with a typed failure that says what would not close.

**Why the loop is the component.** Anvil's fork backend fetches missing state *lazily*, so
`anvil_dumpState` on a forked instance captures only what was touched, and its fidelity has
real bug history (design §10). A dump therefore proves nothing about closure. Extraction is
not "dump and ship"; it is "dump, then prove offline, then widen until the blackholed run
matches the connected baseline". Every other file in this package exists to make that loop
decidable, bounded, and honest.

**Architecture:** one injected network port, one pure state model, one bounded loop.

- **`ArchiveRpcPort` is the only network dependency**, it is injected, and it is used at
  **authoring time only**. Nothing in this package opens a socket, reads a URL, or knows a
  provider name; provider locators are never identity (design §4.1). The port is wrapped in
  a **budget + journal** decorator before any other module sees it, so (a) an unbounded loop
  against a paid archive is structurally impossible and (b) *every* lazy fetch the connected
  fork performs is recorded — which makes the journal, not the dump, the harvest ground
  truth.
- **The connected fork's state backend is the same injected port.** The materializer is
  handed the port, never an endpoint. This is simultaneously the custody rule and the
  instrument: the set of accounts/slots the run touched is exactly the set of calls the port
  saw. A dump that silently omits an entry the journal recorded is caught at harvest, before
  an artifact is ever assembled — the precise failure this component exists for.
- **The convergence classification is rigorous, not heuristic.** Out-of-slice reads under
  blackhole return *empty deterministically* (design §4.2's boundary rule), so missing state
  makes the blackholed world **stably wrong**, never unstable. Therefore: K blackholed runs
  that agree with each other but disagree with the connected baseline ⇒ missing state ⇒
  localize and widen. K blackholed runs that disagree with *each other* ⇒ a determinism
  control is broken, not a slice problem ⇒ terminate `divergence-unexplained`. Divergence
  from baseline with an empty localized miss set ⇒ terminate `divergence-unexplained`.
- **Localization is one connected run per widening.** The candidate's artifact is layered in
  front of the archive port; the layered backend answers from the artifact and journals its
  misses. The miss set *is* the widening delta. Bounded by `maxWidenings` and by the archive
  budget, both declared in the request and both ceilinged in code.
- **This package never says "verified".** `extractEnvironment` produces a *candidate*.
  The only closed-state claim in the returned value is CE3's own sealed attestation, carried
  verbatim. A test enforces that (contract 7).

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:`
resolutions); zod 4.4.3; `@jinn-network/trust-core` (JCS, sha256, RFC 3339, ordering);
`@jinn-network/chain-environment-record` (CE1 — record kinds, sealing, port types);
`@jinn-network/chain-environment-verification` (CE3 — the closure check, invoked as a
library); vitest 4. No chain client library, no RPC transport, no `viem`: the port is the
boundary.

---

## Global constraints

From the program plan §4; these bind every task below.

1. **Designs are law** (contract 1). The design is `b3faed8b0`. A defect found while
   implementing is a Finding with a proposed disposition appended to this plan's §Findings —
   never a silent patch.
2. **Kits and fixtures precede implementations** (contract 2). Within this plan: the fake
   archive and its scenario scripts (T3, T13) are the tests that drive every module; the
   assembled conformance kit is green before this branch is reported complete.
3. **Sealing is re-implemented per package** (contract 3) — that rule owns *record* sealing
   and belongs to CE1. This package does **not** re-implement record sealing; it calls CE1's
   `sealChainEnvironmentRecord`. It *does* own the state-artifact and coverage-manifest
   canonical bytes, which are this package's own products, and pins them with fixtures.
4. **Custody law** (contract 4). No key material; no ambient authority. `process.env`,
   `fetch`, `WebSocket`, `node:http(s)`, `node:net`, `node:dns`, `child_process` never appear
   in `src/`. `node:fs/promises` appears in exactly two production files —
   `src/extraction-state-store.ts` (directory is an argument) and `src/testing.ts` (fixture
   loading). The archive endpoint is never a string this package holds: the caller injects an
   object. Fail closed.
5. **No product names in tiers 1–3** (contract 5). `plugin`, `jinn-plugin`, `operator`,
   `autopilot`, `daemon`, `client` must not appear in source, exports, or dependencies. No
   import of `@jinn-network/core`, `@jinn-network/plugin`, `@jinn-network/jinn-layer`, or
   anything under `client/`.
6. **Digest discipline** (contract 6). Record-body and scalar digests are `sha256:`-prefixed
   lowercase hex; in-toto DigestSet values are **bare** lowercase hex. This package produces
   no in-toto subjects of its own — it hands digests to CE1 (record body, `sha256:`-prefixed)
   and to CE3 (which builds the subjects). The confusion fixture ships in this package's kit
   anyway, because `artifactDigest` crosses both worlds (T5 step 6).
7. **Bounded claims** (contract 7). No API name, doc comment, README line, or returned string
   in this package says "verified", "deterministic", "authenticated", or
   "closed-reproducible" about its own output. The vocabulary is `candidate`, `converged`,
   `baseline`, `matched`. `closed-reproducible` appears only as a value read off CE3's
   attestation. Enforced by a test (T14 step 6).
8. **Fixture keys are freshly generated per record** (contract 8). This package generates no
   keys at all and holds none; fixture *accounts* arrive as addresses in the request. The kit
   uses addresses from a documented non-fundable synthetic range (T14 step 1) — never a
   well-known dev mnemonic address.
9. **Register in the existing tree guards in the same PR** (contract 9): inventory row +
   dependency graph, source-boundary allowances, packed-types entrypoint, and the CI job in
   `.github/workflows/environments-ci.yml`.
10. **TDD per task; verification before completion** (contract 10). Every task ends with
    `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test` in the package, plus the
    tree guards where the task touched them, outputs shown, before the task is reported done.
11. **Stop on missing Consumes** (contract 11). Every symbol consumed from
    `chain/ce1-chain-record` or `chain/ce3-chain-verification` is named exactly in
    §Consumed interfaces. A symbol that is not on the base branch is a **stop-and-report**,
    not an improvisation and not a local re-declaration.
12. **The kit runs on fakes** (contract 12). No Docker, no Anvil, no network in any test in
    this package. The legacy SWE harvest machinery under `client/src/solver-types/` may be
    read for reference and is **never imported**; this staged state machine and failure
    taxonomy are fresh rewrites over this package's own closed vocabulary.
13. Node `>=22`; `"type": "module"`; every relative import carries the `.js` extension. No
    `localeCompare`, no `Intl` in production source — use `compareCodeUnitStrings` from
    `@jinn-network/trust-core`.

**The cost rule, restated because it is the one that bites.** An unbounded widen loop against
a metered archive provider is a cost incident, not a slow test. Three bounds are enforced
*before* any port call: `maxWidenings` (request value, ceilinged at `MAX_WIDENINGS_CEILING`),
`maxCalls`, and `maxBytes`. Exhaustion of any of them is a first-class typed failure
(`policy` disposition), never a retry, and the consumed usage is reported on every return
path including failures.

---

## Consumed interfaces (verify before Task 1)

Both sibling planners supplied their literal signatures on 2026-07-31 (recorded in
§Findings where they amend program §3). Everything below is what CE4 imports; a symbol
whose shape on the base branch differs from this table is a **stop-and-report**, never a
local adaptation (contract 11).

**From `chain/ce1-chain-record` — `@jinn-network/chain-environment-record`:**

| Symbol | Shape / signature | Used by |
| --- | --- | --- |
| `ChainEnvironmentRecord` | blocks: `kind`, `runtime`, `sourceAnchor?`, `stateMaterialization`, `fixtures`, `determinismControls`, `capabilityEnvelope`, `verificationContract`, `supersedes?` | `candidate.ts`, `extract.ts`, `widen.ts` |
| `sealChainEnvironmentRecord(record: unknown): Uint8Array` | throws on a record that breaks the census or closed-state rules | `candidate.ts` |
| `parseChainEnvironmentRecord(bytes): ChainEnvironmentRecord` | rejects non-canonical bytes | `candidate.ts` |
| ``chainEnvironmentRecordDigest(bytes): `sha256:${string}` `` | | `candidate.ts` |
| ``bareHexDigest(digest: `sha256:${string}`): string`` | throws on an already-bare value | `candidate.ts`, `coverage.ts` |
| ``prefixedDigest(bare: string): `sha256:${string}` `` | inverse | `coverage.ts` |
| `anchorAuthenticityBoundOf(anchor \| undefined)` | `"not-anchored" \| "declared" \| "header-proven"` — **E5 in code; CE4 calls it, never re-derives it** | `anchor.ts` |
| `StateEntryCounts` | `{accounts, storageSlots, codeEntries}` — the census type all three manifests use | `artifact.ts`, `coverage.ts` |
| `BLACKHOLE_EGRESS_POLICY_ID` | `"jinn.egress.blackhole/1"` | `candidate.ts` (precondition check) |
| `ChainMaterializer`, `ProbeExecutor<Observation>`, `ScriptReplayer<Observation>` | port **types** (generic over the observation type — CE1 declares **no** canonical observation type) | `ports.ts`, `localize.ts` |
| `ChainStateBackend` | `{getAccount, getCode, getStorageAt, getBlockHeader}`, all `\| undefined`-returning; **injected**, and the shape `asChainStateBackend` adapts CE4's port to (CE1-F10, coordinator ruling CR3) | `ports.ts` |
| `requiresStateBackend(record): boolean` | true iff `closureClass === "archive-dependent"` — the shared predicate; CE4 keys off it instead of re-deriving | `baseline.ts`, `widen.ts` |
| `MaterializationRequest` | `{record, resources, instanceId, networkPolicy, stateBackend?}` — **`instanceId` and `networkPolicy` are the caller's to assign**; `resources` is `ResolvedResources` = `{byDigest}`, not a bare Map | `localize.ts`, `candidate.ts` |
| `ChainInstance` / `VerifiedChainInstance` | `{instanceId, rpcEndpoint, report?, stop}`; the `Verified` alias has `report` non-optional | `candidate.ts`, `localize.ts` |
| `MaterializationReport` | carries `artifactEntries` (`{accounts, codeEntries, storageSlots}` — renamed to match `StateEntryCounts`) and `` postFixtureCommitment: `0x${string}` `` | `candidate.ts` |
| `./fixtures/chain/archive-dependent.json` | the golden CE4 extracts *from*; `closed-anchored-subset.json` is the shape it converges *to* | tests |

**The two record blocks CE4 computes**, with CE1's exact field names:

```ts
sourceAnchor: {
  caip2ChainId, nativeChainId, genesisHash, blockNumber, blockHash /* MANDATORY */,
  stateRoot, timestamp /* unix seconds, integer */,
  finalityPolicy: "finalized" | "safe" | "latest" | `confirmations:${number}`,
  headerProof?: ResourceDescriptor,
}
stateMaterialization: {
  closureClass: "closed-state" | "archive-dependent",
  fidelityClass: "local" | "anchored-subset" | "full-state",
  constructionMethod: "archive-extraction" | "local-construction" | "full-state-export",
  materializer: { id, version, digest },
  stateArtifact?: { descriptor: ResourceDescriptor, format: { id, version }, entryCounts: StateEntryCounts },
  sourceProofManifest?: { proofFormat: "eip-1186", proofs: ResourceDescriptor, coverage: StateEntryCounts },
  fixtureCoverage?: { manifest: ResourceDescriptor, declared: StateEntryCounts, mutatedProofCoveredAccounts: number },
  archive?: { requiredCapabilities: string[], providerLocators?: string[] },
  mutatesSourceProtocolState?: boolean,   // required when fidelityClass !== "local"
  initialStateCommitment,                  // MUST NOT equal sourceAnchor.stateRoot
}
```

**The E13 census CE1 enforces at seal time** — CE4's whole coverage stage exists to satisfy
it: for each of `accounts` / `storageSlots` / `codeEntries`,
`sourceProofManifest.coverage[k] + fixtureCoverage.declared[k] === stateArtifact.entryCounts[k]`,
exact equality, so double-counting fails as loudly as under-counting; and
`mutatedProofCoveredAccounts > 0` forces `mutatesSourceProtocolState: true`. Every entry is
therefore classified **exactly once**: an entry that a fixture mutates counts on the fixture
side and raises `mutatedProofCoveredAccounts`, never on both. The rules are **vacuous when
`stateArtifact` is absent**, which is precisely the archive-dependent draft this pipeline
starts from.

Closed-state preconditions CE1 rejects at seal time, and CE4 therefore checks on the
author's draft *before* spending an archive call (`policy` failure, T10):
`stateArtifact` present, `archive` absent,
`capabilityEnvelope.egressPolicyId === BLACKHOLE_EGRESS_POLICY_ID`,
`verificationContract.closureCheckRequired === true`,
`determinismControls.resetMechanism === "fresh-process"`.

**From `chain/ce3-chain-verification` — `@jinn-network/chain-environment-verification`:**

| Symbol | Shape / signature | Used by |
| --- | --- | --- |
| `observeArchiveEnvironment(deps, record, options?): Promise<SealedAttestation>` | the archive-dependent path; **this is CE4's connected baseline** | `baseline.ts` |
| `verifyChainEnvironment(deps, record, options?): Promise<SealedAttestation>` | the closed-state path; throws `INVALID_INPUT` if `closureClass !== "closed-state"` | `widen.ts` |
| `SealedAttestation` | `{envelopeBytes, payloadBytes, attestationDigest, statement, outcome, instanceIds, observations}` — `outcome` and `observations` are surfaced deliberately for this loop | `baseline.ts`, `widen.ts` |
| `ChainVerificationDeps` | `{runtime: {materializer, probes}, artifactStore, signer, clock, verifier, informationRuntime?}` | `ports.ts` |
| `ChainRuntime` | `{materializer: ChainMaterializer, probes: ProbeExecutor}` | `ports.ts` |
| `ArtifactStore` | `{getArtifact(descriptor, opts?), putArtifact(bytes, opts?)}` | `ports.ts`, `candidate.ts` |
| `Clock`, `VerifierIdentity`, `NetworkPolicy`, `DEFAULT_BLACKHOLE_POLICY` | | `ports.ts`, `widen.ts` |
| `CanonicalChainObservation`, `chainObservationDigest(o)`, `chainObservationsEqual(a, b)` | every quantity is a **string**; uppercase hex rejected | `baseline.ts`, `widen.ts` |
| `CHAIN_VERIFICATION_OUTCOMES` (14), `ChainVerificationOutcome`, `RUN_BEARING_OUTCOMES` | closed vocabulary | `widen.ts` |
| `CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`, `MINIMUM_RUN_COUNT` (5) | constants — imported, never re-declared | `widen.ts` |
| `SourceProofManifest`, `FixtureMutationDeclaration`, `CoverageAssessmentInput`, `CoverageAssessment`, `assessArtifactCoverage(input)` | **CE3 owns the coverage computation**; CE4 produces the manifest and calls the assessor before paying for a K-run | `coverage.ts`, `widen.ts` |
| `assessClosure(input): ClosureAssessment` | pure, no I/O | `widen.ts` (cheap pre-check) |
| `ChainVerificationError` | thrown only for caller error / port contract breach | `baseline.ts`, `widen.ts` |
| `VerifiedChainMaterializer` (`ChainMaterializer & {materialize(...): Promise<VerifiedChainInstance>}`) | what `createAnvilMaterializer` returns, so no `report`-undefined branch exists for CE4 to write | `ports.ts`, `candidate.ts` |
| `createAnvilMaterializer` / `createProbeExecutor` / `createScriptReplayer` | **not imported by `src/`** — the *host* composes them into `deps`; the kit uses fakes (contract 12) | — |

Two CE3 behaviours the whole design leans on: environment facts come back as a **signed
attestation with an `outcome`**, never as a thrown error, so CE4 branches on `.outcome`; and
`observations` carries the full canonical observation per run, so CE4 diffs the connected
baseline against the blackholed runs without re-running anything.

**Both cross-plan gaps are now closed** (CE1, 2026-07-31, coordinator ruling CR3 and finding
CE1-F10). The fork backend is injected on the materialize request, so every lazy fetch is
journaled and budgeted, and a materializer handed an archive-dependent record without one
fails closed rather than reading `providerLocators`. The instance handle is settled as
`ChainInstance {instanceId, rpcEndpoint, report?, stop}` with
`VerifiedChainInstance = ChainInstance & {report}`, and CE4's one stake in it survives:
`report.postFixtureCommitment`, typed `` `0x${string}` `` to match what
`stateMaterialization.initialStateCommitment` spells. CE4 types every materialization it
performs against `VerifiedChainInstance` and narrows nothing itself. One residual cost is
filed as F-CE4-10.

**From `integration/evidence-v1` — `@jinn-network/trust-core`** (verified present on
`origin/integration/evidence-v1` at `9f4925037`, `packages/trust/core/src/`):

| Symbol | Source file | Used by |
| --- | --- | --- |
| `canonicalJsonBytes(value): Uint8Array` | `canonical-json.ts` | artifact, key sets, coverage, staged state |
| `recordDigest(bytes): Sha256Digest` | `hashing.ts` | artifact digest, key-set digest |
| `sha256Hex(bytes): string` | `hashing.ts` | bare-hex crossing in `coverage.ts` |
| `Sha256Digest` | `types.ts` | everywhere |
| `compareCodeUnitStrings(left, right)` | `order.ts` | every sort in this package |
| `isCalendarStrictRfc3339(value)` | `rfc3339.ts` | staged state timestamps |
| `DsseSigner` | `dsse.ts` | `ports.ts` (passed through to CE3; never held) |

**From `@jinn-network/trust-testing`** (devDependency, tests only):
`createEoaTestSigner(seed)` — the kit drives CE3's real sealing with real deterministic
signatures rather than a stub signer.

**Verification step, run before Task 1** (contract 11):

```bash
git rev-parse --abbrev-ref HEAD
ls packages/environments/chain-record/package.json \
   packages/environments/chain-verification/package.json
grep -n "^export" packages/environments/chain-record/src/index.ts
grep -n "^export" packages/environments/chain-verification/src/index.ts
```

Expected: branch is `chain/ce4-chain-extraction`; both packages exist; every symbol in the
two tables above appears in the two export lists. Any miss → stop and report, naming the
symbol and the table row.

---

## What this package must never claim

One paragraph, because contract 7 is the contract most easily violated by a helpful variable
name. `extractEnvironment` returns a **candidate**: bytes an author *proposes*.
`widenAndReverify` returns `converged` when the blackholed runs CE3 performed reproduced the
connected baseline observation — a statement about two digests being equal, nothing more. It
does not mean the world is faithful to mainnet (that is the E5 declaration plus the E13
coverage manifest, and both are recorded as what they are), it does not mean the task is
solvable, and it does not mean the archive provider told the truth. `closed-reproducible` is
CE3's word, appears in this package only as a value read off CE3's attestation, and is never
assigned to a CE4-owned field.

---

## File structure

All paths relative to `packages/environments/chain-extraction/`.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`, `README.md` | package scaffold |
| `scripts/pack-smoke.mjs` | tarball shape + packed-import smoke |
| `scripts/generate-fixtures.mjs` | writes and `--check`s the fixture corpus |
| `src/identifiers.ts` | protocol URI, run counts, widening ceiling, default budget, schema versions |
| `src/errors.ts` | `ChainExtractionError`, `invalidInput`, `conformanceFailure` |
| `src/failures.ts` | stages, closed reason vocabulary, five-way disposition mapping |
| `src/hex.ts` | address / 32-byte / quantity schemas and normalization (lowercase, no shortcuts) |
| `src/key-set.ts` | `StateKeySet` — canonical sorted account/code/storage keys, union, difference, digest |
| `src/ports.ts` | `ArchiveRpcPort`, header/account/proof shapes, `ForkBackendBinding`, `StateDumpPort`, `ExtractionDeps` |
| `src/rlp.ts` | minimal RLP decode (proof nodes only) |
| `src/proof.ts` | offline EIP-1186 verification against the declared root |
| `src/budget.ts` | `createBudgetedArchivePort` — call/byte ceilings + the access journal |
| `src/artifact.ts` | `StateArtifact` model: schema, canonical bytes, digest, key set, merge |
| `src/anchor.ts` | `captureAnchor` — number/hash/root/timestamp/finality + the E5 bound + self-disagreement re-check |
| `src/coverage.ts` | proof bundle + fixture-coverage document, CE1's census counts, `mutatesSourceProtocolState` |
| `src/baseline.ts` | `establishBaseline` — connected fork, fixtures, probes + reference scripts, repeat-stability |
| `src/harvest.ts` | `harvestTouchedState` — journal-authoritative artifact, dump cross-check |
| `src/candidate.ts` | assemble + seal the candidate record (via CE1) around the artifact and coverage manifest |
| `src/extract.ts` | `extractEnvironment` — the staged producer |
| `src/layered-backend.ts` | `createLayeredStateBackend` — artifact-first, archive-on-miss, miss journal |
| `src/widen.ts` | `widenAndReverify` + `localizeMissingState` — the bounded convergence loop |
| `src/extraction-state.ts` | pure staged-job algebra + `ExtractionStateStore` port |
| `src/extraction-state-store.ts` | `createFileExtractionStateStore` — atomic write, resumable, budget carried |
| `src/index.ts` | public surface |
| `src/testing.ts` | fake archive + fake runtime + scenarios + `describeChainExtractionConformance` |
| `src/bounded-claims.test.ts` | contract 7 enforcement over this package's own source and exports |
| `fixtures/artifacts-v1/*.json` | golden state artifacts the kit pins byte-for-byte |
| `fixtures/coverage-v1/*.json` | golden proof bundle + fixture-coverage document |
| `fixtures/adversarial-v1/*.json` | uppercase-hex artifact, unsorted slots, uncovered entry, bare-hex/prefixed confusion |

Repo files this plan also edits (created by CE1, extended by CE3, on the base branch):
`.github/scripts/environments-package-inventory.test.mjs`,
`.github/scripts/environments-source-boundaries.test.mjs`,
`.github/scripts/environments-packed-types.test.mjs`,
`.github/workflows/environments-ci.yml`.

---

### Task 1: Scaffold the package and register it with the tree guards

**Files:**
- Create: `packages/environments/chain-extraction/package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`, `README.md`,
  `src/index.ts`, `scripts/pack-smoke.mjs`
- Modify: `.github/scripts/environments-package-inventory.test.mjs`,
  `.github/scripts/environments-source-boundaries.test.mjs`,
  `.github/scripts/environments-packed-types.test.mjs`,
  `.github/workflows/environments-ci.yml`

**Interfaces:**
- Consumes: the `packages/environments/` tree and its guard trio (from
  `integration/evidence-v1` via CE1/CE3), plus the two chain packages named in
  §Consumed interfaces. Absent → stop and report.
- Produces: the package directory publishing `@jinn-network/chain-state-extraction` with
  exports `.`, `./testing`, `./fixtures/*`.

- [ ] **Step 1: Run the §Consumed interfaces verification block**

Run the four commands in §Consumed interfaces. Expected: branch
`chain/ce4-chain-extraction`; both chain packages present; every consumed symbol listed.
Record any miss and stop.

- [ ] **Step 2: Register the package in the inventory guard so it fails**

Read `.github/scripts/environments-package-inventory.test.mjs` first — CE1 and CE3 have
already added their rows. Append to `ENVIRONMENT_PACKAGES`:

```js
  ['chain-extraction', '@jinn-network/chain-state-extraction'],
```

Append to `JINN_DEPENDENCY_GRAPH`:

```js
  // `chain-extraction` is tier 3. Design §3: it invokes chain-verification's closure check
  // as a library and depends on the record kind it drafts; its only network dependency is
  // the injected `ArchiveRpcPort`, which is a type, not a package.
  ['chain-extraction', {
    dependencies: [
      '@jinn-network/chain-environment-record',
      '@jinn-network/chain-environment-verification',
      '@jinn-network/trust-core',
    ],
    // `trust-resolve` is install-graph only (a portal's own resolutions do not apply, so
    // `trust-testing`'s Jinn dependency is resolved here). Importing it is banned below.
    devDependencies: ['@jinn-network/trust-resolve', '@jinn-network/trust-testing'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

Add the export-map row in the same file's third test:

```js
    ['chain-extraction', ['.', './fixtures/*', './testing']],
```

- [ ] **Step 3: Run the guard to verify it fails**

Run: `node --test .github/scripts/environments-package-inventory.test.mjs`
Expected: FAIL — `ENOENT ... packages/environments/chain-extraction/package.json`.

- [ ] **Step 4: Create the package scaffold**

`package.json`:

```json
{
  "name": "@jinn-network/chain-state-extraction",
  "version": "0.1.0",
  "description": "Archive-fork state extraction and the widen-and-re-verify convergence loop for chain environment candidates.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/environments/chain-extraction"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    },
    "./fixtures/*": "./fixtures/*"
  },
  "files": [
    "dist/",
    "fixtures/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/chain-environment-record": "0.1.0",
    "@jinn-network/chain-environment-verification": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "zod": "4.4.3"
  },
  "peerDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  },
  "devDependencies": {
    "@jinn-network/trust-resolve": "0.1.0",
    "@jinn-network/trust-testing": "0.1.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/chain-environment-record": "portal:../chain-record",
    "@jinn-network/chain-environment-verification": "portal:../chain-verification",
    "@jinn-network/trust-core": "portal:../../trust/core",
    "@jinn-network/trust-resolve": "portal:../../trust/resolve",
    "@jinn-network/trust-testing": "portal:../../trust/testing"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

`.gitignore`:

```
dist/
node_modules/
.yarn/
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The conformance kit reads `describe`/`it`/`expect` off `globalThis` at call
    // time so the module stays importable outside a test run (see src/testing.ts).
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
```

`src/index.ts` (grows task by task; starts as the package's identity only):

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  BASELINE_RUN_COUNT,
  CHAIN_EXTRACTION_PROTOCOL_URI,
  DEFAULT_ARCHIVE_BUDGET,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "./identifiers.js";
```

`README.md`:

```markdown
# @jinn-network/chain-state-extraction

Drafts chain environment **candidates** and drives them to convergence.

## What this package produces, exactly

`extractEnvironment` returns a **candidate**: a chain environment record body, a state
artifact, and an E13 coverage manifest, together with the connected-fork baseline
observation they were derived from. A candidate is a proposal. It is not verified, and this
package never says it is.

`widenAndReverify` runs the design §7 loop: it asks
`@jinn-network/chain-environment-verification` to run the closed-state protocol against the
candidate under blackhole, compares the resulting observation with the connected baseline,
and — when they differ because the committed slice is too narrow — localizes the missing
accounts and slots, widens the artifact, re-seals, and repeats. It terminates either with a
converged candidate carrying **CE3's** attestation, or with a typed failure naming what
would not close.

`converged` means exactly: *the blackholed runs CE3 performed produced the same canonical
observation digest as the connected baseline.* Any stronger reading — fidelity to the
public chain, task solvability, provider honesty — belongs to the coverage manifest, the
E5 anchor bound, or nobody.

## Why the loop exists

A fork backend fetches missing state lazily, so a state dump taken from a forked instance
contains only what execution happened to touch, and dump fidelity has a real bug history
(family design §10). Closure is therefore earned by reproducing the baseline offline, not
asserted by taking a dump. Out-of-slice reads in a sealed instance return *empty,
deterministically*, so a too-narrow slice makes the world **stably wrong** — which is what
makes the divergence signal decidable rather than flaky.

## The one network dependency

`ArchiveRpcPort` is injected, is used at authoring time only, and is wrapped in a budget
before any module sees it: `maxCalls`, `maxBytes`, and `maxWidenings`, all ceilinged. No
file in `src/` opens a socket, holds a URL, or names a provider.
```

`scripts/pack-smoke.mjs`: copy
`packages/environments/verification/scripts/pack-smoke.mjs` and change the three roots to
`../chain-record`, `../chain-verification`, `../../trust/core`; the expected packed entries
are `package/dist/index.js`, `package/dist/testing.js`, `package/fixtures/`, `package/README.md`.

- [ ] **Step 5: Extend the source-boundary guard**

In `.github/scripts/environments-source-boundaries.test.mjs`, add the chain-extraction
allowances beside CE1's and CE3's:

```js
// `packages/environments/chain-extraction` is tier 3. Design §3 gives it exactly two Jinn
// package edges plus trust/core. Its only network dependency is an *injected port*, so the
// ambient-network ban applies to it in full — a `fetch` identifier anywhere in this
// package's source is the exact violation the design's custody law forbids.
const CHAIN_EXTRACTION_ALLOWED_EXTERNALS = [
  '@jinn-network/chain-environment-record',
  '@jinn-network/chain-environment-verification',
  '@jinn-network/trust-core',
  'zod',
];
const CHAIN_EXTRACTION_ALLOWED_DEPENDENCIES = [...CHAIN_EXTRACTION_ALLOWED_EXTERNALS];
const CHAIN_EXTRACTION_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
  '@types/node',
  'typescript',
  'vitest',
];
const CHAIN_EXTRACTION_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
```

and append to `FILESYSTEM_ALLOWED_SOURCES`:

```js
  // The extraction pipeline is crash-safe: its state file is the resume point, and its
  // directory is an argument, not ambient authority. Named one file at a time so a second
  // filesystem user still needs a deliberate edit here.
  'chain-extraction/src/extraction-state-store.ts',
  'chain-extraction/src/testing.ts',
  'chain-extraction/src/extraction-state-store.test.ts',
  'chain-extraction/src/testing.test.ts',
  'chain-extraction/src/bounded-claims.test.ts',
  // Reads this package's own source to assert no hand-rolled digest-prefix stripping
  // (T5 step 6). Named individually, like the rest.
  'chain-extraction/src/artifact.test.ts',
```

Then add the package's assertion block, modeled exactly on the existing `verification` one:
dependencies/devDependencies/peerDependencies deep-equal the lists above; externals imported
anywhere in `src/` are a subset of `CHAIN_EXTRACTION_ALLOWED_EXTERNALS`; the foreign-package
list is `ENVIRONMENTS_FOREIGN_PACKAGES` minus `@jinn-network/trust-*` plus
`@jinn-network/trust-resolve`; every module in `NODE_IO_MODULES` is banned outside the
filesystem carve-out.

- [ ] **Step 6: Extend the packed-types guard**

In `.github/scripts/environments-packed-types.test.mjs`, add `'chain-extraction'` to
`environmentDirectories` and a consumer snippet that compiles against the packed tarball:

```ts
import {
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
  extractEnvironment,
  widenAndReverify,
  type ArchiveRpcPort,
  type ChainEnvironmentCandidate,
  type ConvergenceResult,
  type ExtractionResult,
} from "@jinn-network/chain-state-extraction";

const ceiling: number = MAX_WIDENINGS_CEILING;
const widenings: number = DEFAULT_MAX_WIDENINGS;
export type Port = ArchiveRpcPort;
export type Candidate = ChainEnvironmentCandidate;
export type Extract = typeof extractEnvironment extends
  (...args: never) => Promise<ExtractionResult> ? true : never;
export type Widen = typeof widenAndReverify extends
  (...args: never) => Promise<ConvergenceResult> ? true : never;
export const bounds = { ceiling, widenings };
```

- [ ] **Step 7: Add the CI job**

In `.github/workflows/environments-ci.yml`, add
`packages/environments/chain-extraction/**` coverage (already covered by the existing
`packages/environments/**` path filter) plus this plan's path to `paths:`, and add the job:

```yaml
  chain-extraction:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Build the packages this capability depends on
        run: |
          (cd packages/trust/core && yarn install --immutable && yarn build)
          (cd packages/trust/testing && yarn install --immutable && yarn build)
          (cd packages/environments/chain-record && yarn install --immutable && yarn build)
          (cd packages/environments/chain-verification && yarn install --immutable && yarn build)
      - name: Verify Chain State Extraction
        working-directory: packages/environments/chain-extraction
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Chain State Extraction distribution
        uses: actions/upload-artifact@v4
        with:
          name: environments-chain-extraction-dist
          path: packages/environments/chain-extraction/dist
          if-no-files-found: error
          retention-days: 1
```

Add `chain-extraction` to the `verify` job's `needs:` list, its result to the
`for result in ...` loop, and its dist placement to the "Place package distributions" step.

- [ ] **Step 8: Install and prove the scaffold is green**

Run:
```bash
cd packages/environments/chain-extraction && corepack yarn@4.13.0 install
```
Expected: resolves; the four `portal:` targets link.

Run:
```bash
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs
```
Expected: PASS (packed-types is exercised after the first build, in T13).

- [ ] **Step 9: Commit**

```bash
git add packages/environments/chain-extraction .github
git commit -m "feat(chain-extraction): scaffold the package and register the tree guards"
```

---

### Task 2: Identifiers, errors, and the five-way failure taxonomy

Design §7 (the loop must be bounded), §5.2 (provider disagreement is a recorded fact), §10
(dump fidelity). The taxonomy is where "what would not close" becomes a value a caller can
branch on instead of a string it has to read.

**Files:**
- Create: `src/identifiers.ts`, `src/errors.ts`, `src/failures.ts`, `src/failures.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: nothing (leaf modules).
- Produces: `CHAIN_EXTRACTION_PROTOCOL_URI`, `BASELINE_RUN_COUNT`,
  `DEFAULT_MAX_WIDENINGS`, `MAX_WIDENINGS_CEILING`, `DEFAULT_ARCHIVE_BUDGET`,
  `ChainExtractionError`, `EXTRACTION_STAGES`, `EXTRACTION_FAILURE_REASONS`,
  `EXTRACTION_FAILURE_DISPOSITIONS`, `classifyExtractionFailure`,
  `stageForExtractionFailure`.

- [ ] **Step 1: Write the failing taxonomy test**

`src/failures.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  EXTRACTION_FAILURE_DISPOSITIONS,
  EXTRACTION_FAILURE_REASONS,
  EXTRACTION_STAGES,
  classifyExtractionFailure,
  stageForExtractionFailure,
} from "./failures.js";

describe("the extraction failure taxonomy", () => {
  it("classifies every reason, exactly once, into the five dispositions", () => {
    for (const reason of EXTRACTION_FAILURE_REASONS) {
      expect(EXTRACTION_FAILURE_DISPOSITIONS).toContain(classifyExtractionFailure(reason));
      expect(EXTRACTION_STAGES).toContain(stageForExtractionFailure(reason));
    }
    expect(new Set(EXTRACTION_FAILURE_REASONS).size).toBe(EXTRACTION_FAILURE_REASONS.length);
  });

  it("retries only infrastructure; archive-unavailable is not an infrastructure retry", () => {
    // A provider that cannot serve the anchor will not serve it on the next attempt
    // either; that is a fact about the archive, and the loop must surface it rather
    // than burn the budget rediscovering it.
    expect(classifyExtractionFailure("archive-unreachable")).toBe("archive-unavailable");
    expect(classifyExtractionFailure("archive-anchor-pruned")).toBe("archive-unavailable");
    expect(classifyExtractionFailure("runtime-failure")).toBe("infrastructure");
    expect(classifyExtractionFailure("artifact-store-failure")).toBe("infrastructure");
  });

  it("keeps the two non-convergence shapes distinct", () => {
    // Exhausting the bound and diverging with nothing to widen on are different
    // findings: the first says "the bound was too small", the second says "the
    // divergence is not a slice problem". Collapsing them would send the author
    // to raise a bound that cannot help.
    expect(classifyExtractionFailure("widen-bound-exhausted")).toBe("non-convergent");
    expect(classifyExtractionFailure("divergence-unexplained")).toBe("non-convergent");
    expect(classifyExtractionFailure("baseline-unstable")).toBe("non-convergent");
    expect(stageForExtractionFailure("baseline-unstable")).toBe("baseline");
    expect(stageForExtractionFailure("widen-bound-exhausted")).toBe("reverify");
  });

  it("puts budget exhaustion and coverage gaps under policy, never retry", () => {
    expect(classifyExtractionFailure("archive-budget-exhausted")).toBe("policy");
    expect(classifyExtractionFailure("coverage-incomplete")).toBe("policy");
    expect(classifyExtractionFailure("harvest-empty")).toBe("policy");
    expect(classifyExtractionFailure("archive-self-disagreement")).toBe("provider-disagreement");
    expect(classifyExtractionFailure("archive-root-mismatch")).toBe("provider-disagreement");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/failures.test.ts`
Expected: FAIL — `Failed to resolve import "./failures.js"`.

- [ ] **Step 3: Implement identifiers, errors, and failures**

`src/identifiers.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** Names the pipeline this package implements (design §7). Not a claim. */
export const CHAIN_EXTRACTION_PROTOCOL_URI =
  "https://jinn.network/protocols/chain-state-extraction/v1" as const;

/**
 * The connected baseline is established twice on independent fork instances. Two is
 * enough: the baseline is a *reference*, not the durable claim -- K >= 5 belongs to the
 * blackholed protocol CE3 runs (design E4). Its only job here is to refuse to extract
 * from a world that does not even agree with itself while connected.
 */
export const BASELINE_RUN_COUNT = 2;

/** Widenings attempted before the loop gives up, when the request does not say. */
export const DEFAULT_MAX_WIDENINGS = 3;

/**
 * The ceiling a request may not exceed. An unbounded widen loop against a metered
 * archive is a cost incident; the bound is therefore in code, not in a caller's good
 * intentions.
 */
export const MAX_WIDENINGS_CEILING = 8;

export interface ArchiveBudgetLimits {
  readonly maxCalls: number;
  readonly maxBytes: number;
}

/** Sized for one anchored-subset world: thousands of slots, not a full-state image. */
export const DEFAULT_ARCHIVE_BUDGET: ArchiveBudgetLimits = Object.freeze({
  maxCalls: 20_000,
  maxBytes: 256 * 1024 * 1024,
});

export const STATE_ARTIFACT_SCHEMA_VERSION = "chain-state-artifact.v1" as const;
export const COVERAGE_MANIFEST_SCHEMA_VERSION = "chain-source-coverage.v1" as const;
export const EXTRACTION_STATE_SCHEMA_VERSION = "chain-extraction-staged-state.v1" as const;
```

`src/errors.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export const CHAIN_EXTRACTION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type ChainExtractionErrorCode = (typeof CHAIN_EXTRACTION_ERROR_CODES)[number];

export class ChainExtractionError extends Error {
  override readonly name = "ChainExtractionError";

  constructor(
    readonly code: ChainExtractionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Caller error: malformed input, or a bound the caller broke. */
export function invalidInput(message: string, cause?: unknown): never {
  throw new ChainExtractionError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * An injected port broke its documented contract. Never an extraction fact --
 * extraction facts are returned as typed failures, not thrown.
 */
export function conformanceFailure(message: string, cause?: unknown): never {
  throw new ChainExtractionError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
```

`src/failures.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/** The pipeline stages of design §7, in execution order. */
export const EXTRACTION_STAGES = [
  "anchor",
  "baseline",
  "harvest",
  "assemble",
  "reverify",
] as const;
export type ExtractionStage = (typeof EXTRACTION_STAGES)[number];

/**
 * The closed reason vocabulary. Free-form detail rides in `detail`; the code is what a
 * caller matches on and what the staged state file stores.
 */
export const EXTRACTION_FAILURE_REASONS = [
  // The archive could not supply the anchored world at all.
  "archive-unreachable",
  "archive-anchor-pruned",
  "archive-proof-unsupported",
  // The archive contradicted itself or the anchor it was asked about.
  "archive-self-disagreement",
  "archive-root-mismatch",
  // The world would not close.
  "baseline-unstable",
  "divergence-unexplained",
  "widen-bound-exhausted",
  // A rule this package refuses to break, whatever the caller wants.
  "archive-budget-exhausted",
  "coverage-incomplete",
  "harvest-empty",
  "widen-bound-above-ceiling",
  // CE3 refused the record for a reason widening cannot address (runtime identity,
  // capability, proof validity). The record must change, not the slice.
  "verification-refused",
  // The host's own machinery failed.
  "runtime-failure",
  "artifact-store-failure",
] as const;
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

/**
 * Five dispositions, each answering a different operator question:
 * `archive-unavailable` -- get different archive access; `provider-disagreement` -- the
 * archive is lying or racing, do not trust this extraction; `non-convergent` -- the world
 * cannot be closed as specified; `policy` -- a declared bound or rule stopped this,
 * raising it is a decision, not a retry; `infrastructure` -- the host broke, retry is
 * meaningful.
 */
export const EXTRACTION_FAILURE_DISPOSITIONS = [
  "archive-unavailable",
  "provider-disagreement",
  "non-convergent",
  "policy",
  "infrastructure",
] as const;
export type ExtractionFailureDisposition =
  (typeof EXTRACTION_FAILURE_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<ExtractionFailureReason, ExtractionFailureDisposition>
> = Object.freeze({
  "archive-unreachable": "archive-unavailable",
  "archive-anchor-pruned": "archive-unavailable",
  "archive-proof-unsupported": "archive-unavailable",
  "archive-self-disagreement": "provider-disagreement",
  "archive-root-mismatch": "provider-disagreement",
  "baseline-unstable": "non-convergent",
  "divergence-unexplained": "non-convergent",
  "widen-bound-exhausted": "non-convergent",
  "archive-budget-exhausted": "policy",
  "coverage-incomplete": "policy",
  "harvest-empty": "policy",
  "widen-bound-above-ceiling": "policy",
  "verification-refused": "policy",
  "runtime-failure": "infrastructure",
  "artifact-store-failure": "infrastructure",
});

const STAGE_BY_REASON: Readonly<Record<ExtractionFailureReason, ExtractionStage>> =
  Object.freeze({
    "archive-unreachable": "anchor",
    "archive-anchor-pruned": "anchor",
    "archive-proof-unsupported": "assemble",
    "archive-self-disagreement": "anchor",
    "archive-root-mismatch": "assemble",
    "baseline-unstable": "baseline",
    "divergence-unexplained": "reverify",
    "widen-bound-exhausted": "reverify",
    "archive-budget-exhausted": "reverify",
    "coverage-incomplete": "assemble",
    "harvest-empty": "harvest",
    "widen-bound-above-ceiling": "anchor",
    "verification-refused": "reverify",
    "runtime-failure": "baseline",
    "artifact-store-failure": "assemble",
  });

export function classifyExtractionFailure(
  reason: ExtractionFailureReason,
): ExtractionFailureDisposition {
  return DISPOSITION_BY_REASON[reason];
}

export function stageForExtractionFailure(
  reason: ExtractionFailureReason,
): ExtractionStage {
  return STAGE_BY_REASON[reason];
}

/**
 * Only `infrastructure` is worth another attempt with the same inputs. Every other
 * disposition needs a human decision: different archive access, a different anchor, a
 * wider bound, or a different world.
 */
export function isRetryableExtractionFailure(reason: ExtractionFailureReason): boolean {
  return classifyExtractionFailure(reason) === "infrastructure";
}
```

Note the deliberate divergence from CE3's SWE taxonomy, which retries
`image-unresolvable`: an archive that cannot serve block N is not a bad day, it is a
retention policy, and a retry spends budget to learn the same thing. Stated here so a
reviewer reading both taxonomies sees the divergence is intentional.

- [ ] **Step 4: Run the test and the typecheck**

Run: `corepack yarn@4.13.0 vitest run src/failures.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 4 tests pass; zero type errors.

- [ ] **Step 5: Export from `src/index.ts` and commit**

Add the `./failures.js` and `./errors.js` export blocks alongside the identifiers block.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): identifiers, errors, and the five-way failure taxonomy"
```

---

### Task 3: Hex normalization and the canonical `StateKeySet`

Every later module compares, unions, and digests *sets of state keys* — the accounts and
slots a run touched, the ones an artifact carries, the ones a blackholed run was missing.
That comparison has to be exact and order-free, so it gets its own canonical model with its
own tests before anything uses it.

**Files:**
- Create: `src/hex.ts`, `src/hex.test.ts`, `src/key-set.ts`, `src/key-set.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `recordDigest`, `compareCodeUnitStrings`,
  `Sha256Digest` from `@jinn-network/trust-core`.
- Produces: `HexAddress`, `Hex32`, `HexQuantity`, `HexBytes` + their schemas and
  `normalizeAddress` / `normalizeSlot` / `normalizeQuantity`; `StateKeySet`,
  `emptyKeySet`, `keySetWithAccount`, `keySetWithCode`, `keySetWithSlot`,
  `unionKeySets`, `differenceKeySets`, `keySetSize`, `keySetIsEmpty`, `keySetDigest`.

- [ ] **Step 1: Write the failing tests**

`src/hex.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainExtractionError } from "./errors.js";
import { normalizeAddress, normalizeQuantity, normalizeSlot } from "./hex.js";

describe("hex normalization", () => {
  it("lowercases addresses and refuses anything that is not 20 bytes", () => {
    expect(normalizeAddress("0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"))
      .toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(() => normalizeAddress("0xa0b8")).toThrow(ChainExtractionError);
    expect(() => normalizeAddress("a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))
      .toThrow(ChainExtractionError);
  });

  it("left-pads storage slots to 32 bytes so 0x1 and 0x01 are one key", () => {
    expect(normalizeSlot("0x1")).toBe(`0x${"0".repeat(63)}1`);
    expect(normalizeSlot(`0x${"0".repeat(63)}1`)).toBe(`0x${"0".repeat(63)}1`);
  });

  it("normalizes quantities to minimal form, so 0x0 and 0x00 are one value", () => {
    expect(normalizeQuantity("0x00")).toBe("0x0");
    expect(normalizeQuantity("0x0de0b6b3a7640000")).toBe("0xde0b6b3a7640000");
    expect(() => normalizeQuantity("0x")).toThrow(ChainExtractionError);
  });
});
```

`src/key-set.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  differenceKeySets,
  emptyKeySet,
  keySetDigest,
  keySetIsEmpty,
  keySetSize,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  unionKeySets,
} from "./key-set.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

describe("StateKeySet", () => {
  it("is order-free: insertion order never changes the digest", () => {
    const left = keySetWithSlot(keySetWithSlot(keySetWithAccount(emptyKeySet(), B), A, SLOT_2), A, SLOT_1);
    const right = keySetWithAccount(keySetWithSlot(keySetWithSlot(emptyKeySet(), A, SLOT_1), A, SLOT_2), B);
    expect(keySetDigest(left)).toBe(keySetDigest(right));
    expect(left.accounts).toEqual([A, B]);
    expect(left.storage[0]?.slots).toEqual([SLOT_1, SLOT_2]);
  });

  it("normalizes on the way in, so 0x1 and its padded form are one slot", () => {
    const set = keySetWithSlot(keySetWithSlot(emptyKeySet(), A, "0x1"), A, SLOT_1);
    expect(set.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
    // One key: a slot read is a slot key. Recording a slot does NOT imply the account
    // fields were read -- the two are separate reads and separate artifact entries.
    expect(keySetSize(set)).toBe(1);
  });

  it("unions and differences by key, not by object identity", () => {
    const touched = keySetWithCode(keySetWithSlot(keySetWithAccount(emptyKeySet(), A), A, SLOT_1), A);
    const committed = keySetWithAccount(emptyKeySet(), A);
    const missing = differenceKeySets(touched, committed);
    expect(missing.accounts).toEqual([]);
    expect(missing.code).toEqual([A]);
    expect(missing.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
    expect(keySetIsEmpty(differenceKeySets(touched, unionKeySets(committed, missing)))).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `corepack yarn@4.13.0 vitest run src/hex.test.ts src/key-set.test.ts`
Expected: FAIL — unresolved imports `./hex.js`, `./key-set.js`.

- [ ] **Step 3: Implement `src/hex.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { invalidInput } from "./errors.js";

/** 20-byte account address, lowercase, always 0x-prefixed. */
export type HexAddress = string;
/** 32-byte value: storage slot key, storage value, hash, state root. */
export type Hex32 = string;
/** A quantity in minimal hex form (`0x0`, `0xde0b6b3a7640000`) -- never padded. */
export type HexQuantity = string;
/** Arbitrary-length byte string (contract code, a proof node). */
export type HexBytes = string;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const HEX32_PATTERN = /^0x[0-9a-f]{64}$/u;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const BYTES_PATTERN = /^0x(?:[0-9a-f]{2})*$/u;

export const HexAddressSchema = z.string().regex(ADDRESS_PATTERN);
export const Hex32Schema = z.string().regex(HEX32_PATTERN);
export const HexQuantitySchema = z.string().regex(QUANTITY_PATTERN);
export const HexBytesSchema = z.string().regex(BYTES_PATTERN);

function body(value: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    invalidInput(`${label} must be a 0x-prefixed hex string; received "${String(value)}".`);
  }
  const rest = value.slice(2);
  if (!/^[0-9a-fA-F]*$/u.test(rest)) {
    invalidInput(`${label} contains a non-hex character: "${value}".`);
  }
  return rest.toLowerCase();
}

export function normalizeAddress(value: string): HexAddress {
  const hex = body(value, "An address");
  if (hex.length !== 40) invalidInput(`An address must be 20 bytes; received "${value}".`);
  return `0x${hex}`;
}

/**
 * Storage keys are left-padded to 32 bytes. Providers are inconsistent about this
 * (`eth_getProof` echoes what it was given, `anvil_dumpState` pads), and one unpadded
 * key silently splits a slot into two keys -- which reads as "missing state" forever.
 */
export function normalizeSlot(value: string): Hex32 {
  const hex = body(value, "A storage key");
  if (hex.length > 64) invalidInput(`A storage key must be at most 32 bytes; received "${value}".`);
  return `0x${hex.padStart(64, "0")}`;
}

/** 32-byte values (hashes, roots, storage values) keep their full width. */
export function normalizeHex32(value: string): Hex32 {
  const hex = body(value, "A 32-byte value");
  if (hex.length > 64) invalidInput(`A 32-byte value is too wide; received "${value}".`);
  return `0x${hex.padStart(64, "0")}`;
}

/** Quantities are minimal: no leading zeros, `0x0` for zero. */
export function normalizeQuantity(value: string): HexQuantity {
  const hex = body(value, "A quantity");
  if (hex.length === 0) invalidInput(`A quantity must have at least one digit; received "${value}".`);
  const trimmed = hex.replace(/^0+/u, "");
  return `0x${trimmed === "" ? "0" : trimmed}`;
}

export function normalizeBytes(value: string): HexBytes {
  const hex = body(value, "A byte string");
  if (hex.length % 2 !== 0) invalidInput(`A byte string must have whole bytes; received "${value}".`);
  return `0x${hex}`;
}

export function isEmptyBytes(value: HexBytes): boolean {
  return value === "0x";
}
```

- [ ] **Step 4: Implement `src/key-set.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { normalizeAddress, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";

/**
 * The set of state keys a run touched, an artifact carries, or a widening must add.
 * Canonical by construction: sorted, deduplicated, normalized. Two sets are equal iff
 * their digests are equal, which is what makes "what is this blackholed run missing?"
 * a subtraction instead of a judgement call.
 */
export interface StateKeySet {
  /** Accounts whose balance/nonce were read. */
  readonly accounts: readonly HexAddress[];
  /** Accounts whose code was read. A superset relationship with `accounts` is not
   * assumed: code can be read without the account fields and vice versa. */
  readonly code: readonly HexAddress[];
  readonly storage: readonly { readonly address: HexAddress; readonly slots: readonly Hex32[] }[];
}

export function emptyKeySet(): StateKeySet {
  return { accounts: [], code: [], storage: [] };
}

function withSortedInsert(values: readonly string[], value: string): readonly string[] {
  if (values.includes(value)) return values;
  return [...values, value].sort(compareCodeUnitStrings);
}

export function keySetWithAccount(set: StateKeySet, address: string): StateKeySet {
  return { ...set, accounts: withSortedInsert(set.accounts, normalizeAddress(address)) };
}

export function keySetWithCode(set: StateKeySet, address: string): StateKeySet {
  return { ...set, code: withSortedInsert(set.code, normalizeAddress(address)) };
}

export function keySetWithSlot(set: StateKeySet, address: string, slot: string): StateKeySet {
  const account = normalizeAddress(address);
  const key = normalizeSlot(slot);
  const existing = set.storage.find((entry) => entry.address === account);
  const storage = existing === undefined
    ? [...set.storage, { address: account, slots: [key] }]
    : set.storage.map((entry) => entry.address === account
      ? { address: account, slots: withSortedInsert(entry.slots, key) }
      : entry);
  return {
    ...set,
    storage: storage
      .map((entry) => ({ address: entry.address, slots: entry.slots }))
      .sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
  };
}

export function unionKeySets(left: StateKeySet, right: StateKeySet): StateKeySet {
  let merged: StateKeySet = left;
  for (const address of right.accounts) merged = keySetWithAccount(merged, address);
  for (const address of right.code) merged = keySetWithCode(merged, address);
  for (const entry of right.storage) {
    for (const slot of entry.slots) merged = keySetWithSlot(merged, entry.address, slot);
  }
  return merged;
}

/** Everything in `left` that `right` does not carry. The widening delta. */
export function differenceKeySets(left: StateKeySet, right: StateKeySet): StateKeySet {
  const rightSlots = new Map(right.storage.map((entry) => [entry.address, new Set(entry.slots)]));
  return {
    accounts: left.accounts.filter((address) => !right.accounts.includes(address)),
    code: left.code.filter((address) => !right.code.includes(address)),
    storage: left.storage
      .map((entry) => ({
        address: entry.address,
        slots: entry.slots.filter((slot) => !(rightSlots.get(entry.address)?.has(slot) ?? false)),
      }))
      .filter((entry) => entry.slots.length > 0),
  };
}

export function keySetSize(set: StateKeySet): number {
  return set.accounts.length
    + set.code.length
    + set.storage.reduce((total, entry) => total + entry.slots.length, 0);
}

export function keySetIsEmpty(set: StateKeySet): boolean {
  return keySetSize(set) === 0;
}

export function keySetDigest(set: StateKeySet): Sha256Digest {
  return recordDigest(canonicalJsonBytes(set));
}
```

- [ ] **Step 5: Run the tests, the typecheck, and commit**

Run: `corepack yarn@4.13.0 vitest run src/hex.test.ts src/key-set.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 6 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): hex normalization and the canonical state key set"
```

---

### Task 4: `ArchiveRpcPort`, the injected dependency set, and the budgeted journal

The custody contract and the harvest instrument are the same object. This task builds both.

**Files:**
- Create: `src/ports.ts`, `src/budget.ts`, `src/budget.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `ChainRuntime`, `ArtifactStore`, `Clock`, `VerifierIdentity` from
  `@jinn-network/chain-environment-verification` (whose `ChainRuntime` bundles CE1's
  `ChainMaterializer` / `ProbeExecutor` / `ScriptReplayer`); `DsseSigner` from
  `@jinn-network/trust-core`.
- Produces: `ArchiveRpcPort`, `BlockSelector`, `ArchiveBlockHeader`, `ArchiveAccountState`,
  `ArchiveAccountProof`, `ForkBackendBinding`, `ExtractionDeps`, `ArchiveUsage`,
  `createBudgetedArchivePort(port, limits)`, `BudgetedArchivePort`,
  `asChainStateBackend(archive)`. (`StateDumpPort` and `ChainStateDump` are added to the
  same file by T10, which is where they are used.)

- [ ] **Step 1: Write the failing budget test**

`src/budget.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChainStateBackend } from "@jinn-network/chain-environment-record";

import { createBudgetedArchivePort } from "./budget.js";
import { ChainExtractionError } from "./errors.js";
import { asChainStateBackend, type ArchiveRpcPort } from "./ports.js";

const ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc";

function countingPort(): ArchiveRpcPort {
  return {
    async getBlockHeader() {
      return {
        number: 21_000_000,
        hash: `0x${"1".repeat(64)}`,
        parentHash: `0x${"2".repeat(64)}`,
        stateRoot: `0x${"3".repeat(64)}`,
        timestamp: 1_760_000_000,
      };
    },
    async getAccount() {
      return { nonce: "0x0", balanceWei: "0x0", codeHash: `0x${"4".repeat(64)}` };
    },
    async getCode() {
      return "0x6001";
    },
    async getStorageAt() {
      return `0x${"0".repeat(64)}`;
    },
    async getProof() {
      return {
        address: ADDRESS,
        balance: "0x0",
        nonce: "0x0",
        codeHash: `0x${"4".repeat(64)}`,
        storageHash: `0x${"5".repeat(64)}`,
        accountProof: ["0xaabb"],
        storageProof: [],
      };
    },
  };
}

describe("the budgeted archive port", () => {
  it("journals every read as a state key, which is the harvest ground truth", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1_000_000 });
    await budgeted.getAccount(ADDRESS, 21_000_000);
    await budgeted.getCode(ADDRESS, 21_000_000);
    await budgeted.getStorageAt(ADDRESS, "0x1", 21_000_000);

    expect(budgeted.journal().accounts).toEqual([ADDRESS]);
    expect(budgeted.journal().code).toEqual([ADDRESS]);
    expect(budgeted.journal().storage).toEqual([
      { address: ADDRESS, slots: [`0x${"0".repeat(63)}1`] },
    ]);
    expect(budgeted.usage().calls).toBe(3);
    expect(budgeted.usage().bytes).toBeGreaterThan(0);
  });

  it("does not journal header or proof reads: they are not agent-visible state", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1_000_000 });
    await budgeted.getBlockHeader(21_000_000);
    await budgeted.getProof(ADDRESS, ["0x1"], 21_000_000);
    expect(budgeted.journal().accounts).toEqual([]);
    expect(budgeted.usage().calls).toBe(2);
  });

  it("refuses the call that would exceed the ceiling, before it reaches the port", async () => {
    let reached = 0;
    const port = countingPort();
    const counted: ArchiveRpcPort = {
      ...port,
      async getAccount(address, block) {
        reached += 1;
        return port.getAccount(address, block);
      },
    };
    const budgeted = createBudgetedArchivePort(counted, { maxCalls: 1, maxBytes: 1_000_000 });
    await budgeted.getAccount(ADDRESS, 21_000_000);
    await expect(budgeted.getAccount(ADDRESS, 21_000_000)).rejects.toThrow(ChainExtractionError);
    expect(reached).toBe(1);
    expect(budgeted.usage().exhausted).toBe("calls");
  });

  it("presents as CE1's ChainStateBackend, and carries account absence faithfully", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 50, maxBytes: 1_000_000 });
    // The annotation is the point: if CE1 changes the backend contract, this stops
    // compiling, which is the earliest possible warning.
    const backend: ChainStateBackend = asChainStateBackend(budgeted);
    const account = await backend.getAccount(ADDRESS, 21_000_000);
    expect(account?.balanceWei).toBe("0x0");
    // One call, not two: `storageRoot` is optional (CE1-F12), so a plain account read
    // never drags an eth_getProof behind it.
    expect(account?.storageRoot).toBeUndefined();
    expect(budgeted.usage().calls).toBe(1);

    const empty = createBudgetedArchivePort(
      { ...countingPort(), async getAccount() { return undefined; } },
      { maxCalls: 50, maxBytes: 1_000_000 },
    );
    const absent: ChainStateBackend = asChainStateBackend(empty);
    expect(await absent.getAccount(ADDRESS, 21_000_000)).toBeUndefined();
  });

  it("stays exhausted once exhausted, and reports usage on the way out", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1 });
    await expect(budgeted.getAccount(ADDRESS, 21_000_000)).rejects.toThrow(/maxBytes/u);
    expect(budgeted.usage().exhausted).toBe("bytes");
    await expect(budgeted.getCode(ADDRESS, 21_000_000)).rejects.toThrow(/maxBytes/u);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/budget.test.ts`
Expected: FAIL — unresolved imports `./budget.js`, `./ports.js`.

- [ ] **Step 3: Implement `src/ports.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type {
  ChainStateBackend,
  ScriptReplayer,
  VerifiedChainMaterializer,
} from "@jinn-network/chain-environment-record";
import type {
  ArtifactStore,
  ChainRuntime,
  Clock,
  VerifierIdentity,
} from "@jinn-network/chain-environment-verification";
import type { DsseSigner } from "@jinn-network/trust-core";

import type { ArchiveBudgetLimits } from "./identifiers.js";
import type { Hex32, HexAddress, HexBytes, HexQuantity } from "./hex.js";

export type {
  ArtifactStore, ChainRuntime, ChainStateBackend, Clock, ScriptReplayer,
  VerifiedChainMaterializer, VerifierIdentity,
};

/** `"finalized"` is how the anchor's finality is *observed*, never how it is chosen. */
export type BlockSelector = number | "latest" | "finalized";

export interface ArchiveBlockHeader {
  readonly number: number;
  readonly hash: Hex32;
  readonly parentHash: Hex32;
  readonly stateRoot: Hex32;
  /** Unix seconds. */
  readonly timestamp: number;
}

/**
 * Field names and optionality follow CE1's `ChainStateBackend` exactly (`balanceWei`, not
 * `balance`; `storageRoot` optional), so `asChainStateBackend` is a pass-through rather
 * than a translation layer. `storageRoot` is present only when the archive supplied a
 * proof anyway -- no plain JSON-RPC method carries it (CE1-F12 / F-CE4-10).
 */
export interface ArchiveAccountState {
  readonly nonce: HexQuantity;
  readonly balanceWei: HexQuantity;
  readonly codeHash: Hex32;
  readonly storageRoot?: Hex32;
}

/** EIP-1186. The proof binds this account to the state root of the block it was taken
 * at; that root's correspondence to canonical history is a separate step (design E5). */
export interface ArchiveAccountProof {
  readonly address: HexAddress;
  readonly balance: HexQuantity;
  readonly nonce: HexQuantity;
  readonly codeHash: Hex32;
  readonly storageHash: Hex32;
  readonly accountProof: readonly HexBytes[];
  readonly storageProof: readonly {
    readonly key: Hex32;
    readonly value: HexQuantity;
    readonly proof: readonly HexBytes[];
  }[];
}

/**
 * The only network dependency in this package, and it is injected.
 *
 * Authoring-time only: nothing at verification or run time may hold one. The host
 * implements it over whatever archive access it has; this package never learns the
 * provider's name, URL, or credentials -- a provider is a locator, never identity
 * (design §4.1). Implementations MUST be free of hidden retry-with-different-provider
 * behavior: a differing answer for the same (method, arguments, block) is a fact this
 * package needs to see, not smooth over (design §5.2).
 */
export interface ArchiveRpcPort {
  getBlockHeader(selector: BlockSelector, signal?: AbortSignal): Promise<ArchiveBlockHeader>;
  /** `undefined` means the account does not exist at that block -- a fact worth carrying:
   * execution that reads an empty account must be reproducible too, and T7 covers it with
   * an absence proof. */
  getAccount(address: HexAddress, block: number, signal?: AbortSignal): Promise<ArchiveAccountState | undefined>;
  getCode(address: HexAddress, block: number, signal?: AbortSignal): Promise<HexBytes>;
  getStorageAt(address: HexAddress, slot: Hex32, block: number, signal?: AbortSignal): Promise<Hex32>;
  getProof(
    address: HexAddress,
    slots: readonly Hex32[],
    block: number,
    signal?: AbortSignal,
  ): Promise<ArchiveAccountProof>;
}

export interface ArchiveUsage {
  readonly calls: number;
  readonly bytes: number;
  readonly limits: ArchiveBudgetLimits;
  /** Which ceiling stopped the pipeline, if one did. */
  readonly exhausted?: "calls" | "bytes";
}

/**
 * How the connected fork reaches the archive. Finding F-CE4-1: a fork backend must never
 * be a URL this package holds -- that is ambient authority, and it would route the
 * runtime's lazy fetches around the budget and the journal, which is where this
 * pipeline's harvest ground truth comes from.
 */
export type ForkBackendBinding =
  /** CE1/CE3 accept an injected state backend on the materialize request (disposition A). */
  | { readonly kind: "injected-port" }
  /**
   * The host serves a runner-local JSON-RPC endpoint from the SAME injected port and gives
   * CE4 its locator to write into `stateMaterialization.archive.providerLocators`
   * (disposition B -- needs no upstream change; locators are record data, and this package
   * still dials nothing).
   */
  | { readonly kind: "locator"; readonly locator: string };

/**
 * Everything this package touches the world through. Six of the seven members are what
 * CE3's two protocol entry points need, because this pipeline invokes them as a library;
 * `archive` and `forkBackend` are what CE4 adds, and both are authoring-time only.
 */
export interface ExtractionDeps {
  readonly archive: ArchiveRpcPort;
  readonly forkBackend: ForkBackendBinding;
  /**
   * CE3's `ChainRuntime` (`{materializer, probes}`), narrowed so the materializer is the
   * **reporting** one. CE4 cannot write `initialStateCommitment` without
   * `report.postFixtureCommitment`, so a host that composes a non-reporting materializer
   * should fail at composition, in its own types, rather than at extraction time -- and
   * `deps.runtime` still satisfies `ChainVerificationDeps["runtime"]` when it is handed
   * straight to CE3.
   */
  readonly runtime: ChainRuntime & { readonly materializer: VerifiedChainMaterializer };
  /** CE1's `ScriptReplayer`, used to replay the author's reference scripts during
   * localization. CE3's `ChainRuntime` does not carry it, so it is injected beside. */
  readonly replayer: ScriptReplayer;
  /** Optional (F-CE4-2): a cross-check only. The journal, not a dump, is the closure set. */
  readonly stateDump?: StateDumpPort;
  readonly artifactStore: ArtifactStore;
  /** A signing function. This package never holds, reads, or derives key material; it
   * forwards it to CE3, which seals the attestation. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain; forwarded to CE3 unchanged. */
  readonly verifier: VerifierIdentity;
}

/**
 * Presents the budgeted port as CE1's `ChainStateBackend`, which is what a `fork`
 * materialization takes (`requiresStateBackend(record) === true`). Nothing is translated:
 * the field names match, `storageRoot` is optional on both sides (CE1-F12), and account
 * absence is `undefined` on both sides -- which matters more than it looks. A backend that
 * reported zero-values for an absent account would disagree with the sealed world it is
 * about to produce, where an out-of-slice read is empty by the boundary rule (design §4.2);
 * the disagreement would then surface as probe noise instead of as the coverage fact it is.
 *
 * The adapter still exists for two small jobs: normalizing the address and slot spellings
 * before they reach the journal, and narrowing the header to the three fields CE1 declares.
 */
export function asChainStateBackend(archive: BudgetedArchivePort): ChainStateBackend {
  return {
    async getAccount(address, blockNumber) {
      return archive.getAccount(normalizeAddress(address), blockNumber);
    },
    async getCode(address, blockNumber) {
      return archive.getCode(normalizeAddress(address), blockNumber);
    },
    async getStorageAt(address, slot, blockNumber) {
      return archive.getStorageAt(normalizeAddress(address), normalizeSlot(slot), blockNumber);
    },
    async getBlockHeader(blockNumber) {
      const header = await archive.getBlockHeader(blockNumber);
      return { hash: header.hash, stateRoot: header.stateRoot, timestamp: header.timestamp };
    },
  };
}

```

- [ ] **Step 4: Implement `src/budget.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { invalidInput } from "./errors.js";
import { normalizeAddress, normalizeHex32, normalizeSlot } from "./hex.js";
import type { ArchiveBudgetLimits } from "./identifiers.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";
import type {
  ArchiveAccountProof,
  ArchiveAccountState,
  ArchiveBlockHeader,
  ArchiveRpcPort,
  ArchiveUsage,
  BlockSelector,
} from "./ports.js";
import type { Hex32, HexAddress, HexBytes } from "./hex.js";

export interface BudgetedArchivePort extends ArchiveRpcPort {
  /** The state keys read through this port so far. The harvest ground truth: a forked
   * instance fetches lazily, so what it fetched *is* what execution touched. */
  journal(): StateKeySet;
  usage(): ArchiveUsage;
}

/** Cost proxy: the serialized size of what came back. Exact enough to bound spend, and
 * it needs no cooperation from the host's transport. */
function measure(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Wraps the injected port with the two ceilings and the access journal. Every module
 * downstream takes the *budgeted* port, so there is no code path in this package that
 * can call an archive without spending against a declared bound.
 */
export function createBudgetedArchivePort(
  port: ArchiveRpcPort,
  limits: ArchiveBudgetLimits,
): BudgetedArchivePort {
  if (!Number.isInteger(limits.maxCalls) || limits.maxCalls <= 0) {
    invalidInput(`maxCalls must be a positive integer; received ${String(limits.maxCalls)}.`);
  }
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    invalidInput(`maxBytes must be a positive integer; received ${String(limits.maxBytes)}.`);
  }

  let calls = 0;
  let bytes = 0;
  let exhausted: "calls" | "bytes" | undefined;
  let journal = emptyKeySet();

  function refuse(kind: "calls" | "bytes"): never {
    exhausted = kind;
    invalidInput(
      kind === "calls"
        ? `Archive budget exhausted: maxCalls=${limits.maxCalls} reached after ${calls} calls.`
        : `Archive budget exhausted: maxBytes=${limits.maxBytes} reached after ${bytes} bytes.`,
    );
  }

  async function spend<T>(operation: () => Promise<T>): Promise<T> {
    if (exhausted !== undefined) refuse(exhausted);
    if (calls + 1 > limits.maxCalls) refuse("calls");
    calls += 1;
    const result = await operation();
    bytes += measure(result);
    if (bytes > limits.maxBytes) refuse("bytes");
    return result;
  }

  return {
    journal: () => journal,
    usage: (): ArchiveUsage => ({
      calls,
      bytes,
      limits,
      ...(exhausted === undefined ? {} : { exhausted }),
    }),

    async getBlockHeader(selector: BlockSelector, signal?: AbortSignal): Promise<ArchiveBlockHeader> {
      // Headers are chain metadata, not agent-visible state: journaling them would
      // widen slices with entries no execution ever read.
      return spend(() => port.getBlockHeader(selector, signal));
    },

    async getAccount(address: HexAddress, block: number, signal?: AbortSignal): Promise<ArchiveAccountState | undefined> {
      const account = normalizeAddress(address);
      const state = await spend(() => port.getAccount(account, block, signal));
      // Journaled whether or not the account exists: execution READ it, so the sealed
      // world must answer the same way, and "absent" is an answer.
      journal = keySetWithAccount(journal, account);
      return state;
    },

    async getCode(address: HexAddress, block: number, signal?: AbortSignal): Promise<HexBytes> {
      const account = normalizeAddress(address);
      const code = await spend(() => port.getCode(account, block, signal));
      journal = keySetWithCode(journal, account);
      return code;
    },

    async getStorageAt(address: HexAddress, slot: Hex32, block: number, signal?: AbortSignal): Promise<Hex32> {
      const account = normalizeAddress(address);
      const key = normalizeSlot(slot);
      const value = await spend(() => port.getStorageAt(account, key, block, signal));
      journal = keySetWithSlot(journal, account, key);
      return normalizeHex32(value);
    },

    async getProof(
      address: HexAddress,
      slots: readonly Hex32[],
      block: number,
      signal?: AbortSignal,
    ): Promise<ArchiveAccountProof> {
      // Proofs are evidence about state already decided upon, not a discovery read.
      return spend(() => port.getProof(
        normalizeAddress(address),
        slots.map((slot) => normalizeSlot(slot)),
        block,
        signal,
      ));
    },
  };
}
```

Note the shape of the budget refusal: it throws `ChainExtractionError` at the port, and the
pipeline stages catch it and convert it to the typed `archive-budget-exhausted` failure with
the usage attached (T9, T11). Throwing at the port is what makes "no code path can spend
without a bound" true by construction rather than by discipline.

- [ ] **Step 5: Run the tests, typecheck, export, commit**

Run: `corepack yarn@4.13.0 vitest run src/budget.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 4 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): the injected archive port, its budget, and its access journal"
```

---

### Task 5: The state artifact model

The artifact is this package's own product (design §10: bespoke format, producer pinned by
digest), so its canonical bytes and its digest are owned and fixture-pinned here.

**Files:**
- Create: `src/artifact.ts`, `src/artifact.test.ts`,
  `fixtures/artifacts-v1/minimal.json`, `fixtures/adversarial-v1/uppercase-hex.json`,
  `fixtures/adversarial-v1/unsorted-slots.json`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `recordDigest`, `compareCodeUnitStrings` from trust-core;
  `StateEntryCounts` from CE1; T3's hex and key-set modules.
- Produces: `STATE_ARTIFACT_FORMAT`, `StateArtifact`, `StateArtifactAccountSchema`,
  `StateArtifactSchema`, `serializeStateArtifact`, `parseStateArtifact`,
  `stateArtifactDigest`, `stateArtifactKeySet`, `mergeIntoStateArtifact`,
  `stateArtifactEntryCount` (and, in T8, `stateArtifactEntryCounts`).

**CE4 owns the format identifier.** CE1 confirmed the state-artifact format is *record
data*, not a CE1 constant: `stateMaterialization.stateArtifact.format = {id, version}`. The
producer therefore pins it, and this package is the producer:

```ts
/** Runtime-neutral by design: a third party re-verifying an anchored-subset record
 * (design §5.4) must be able to read the slice without any runtime's internals. CE3's
 * materializer translates it into the runtime's own load mechanism. */
export const STATE_ARTIFACT_FORMAT = Object.freeze({ id: "jinn.chain-state-slice", version: "1" });
```

- [ ] **Step 1: Write the failing test**

`src/artifact.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  mergeIntoStateArtifact,
  parseStateArtifact,
  serializeStateArtifact,
  stateArtifactDigest,
  stateArtifactKeySet,
  type StateArtifact,
} from "./artifact.js";
import { ChainExtractionError } from "./errors.js";
import { keySetWithAccount, keySetWithSlot } from "./key-set.js";

const ANCHOR = {
  blockNumber: 21_000_000,
  blockHash: `0x${"1".repeat(64)}`,
  stateRoot: `0x${"3".repeat(64)}`,
  timestamp: 1_760_000_000,
};
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

const MINIMAL: StateArtifact = {
  schemaVersion: "chain-state-artifact.v1",
  anchor: ANCHOR,
  accounts: [
    { address: A, balance: "0xde0b6b3a7640000", nonce: "0x1", code: "0x6001", storage: [{ slot: SLOT_1, value: `0x${"0".repeat(63)}7` }] },
  ],
};

describe("the state artifact", () => {
  it("round-trips through canonical bytes with a stable digest", () => {
    const bytes = serializeStateArtifact(MINIMAL);
    expect(parseStateArtifact(bytes)).toEqual(MINIMAL);
    expect(stateArtifactDigest(bytes)).toBe(stateArtifactDigest(serializeStateArtifact(MINIMAL)));
    expect(stateArtifactDigest(bytes).startsWith("sha256:")).toBe(true);
  });

  it("refuses non-canonical hex rather than silently accepting two spellings of one key", () => {
    const uppercased = JSON.parse(new TextDecoder().decode(serializeStateArtifact(MINIMAL))) as
      { accounts: { address: string }[] };
    uppercased.accounts[0]!.address = A.toUpperCase().replace("0X", "0x");
    expect(() => parseStateArtifact(new TextEncoder().encode(JSON.stringify(uppercased))))
      .toThrow(ChainExtractionError);
  });

  it("reports its own key set, which is what the widen loop subtracts from", () => {
    const keys = stateArtifactKeySet(MINIMAL);
    expect(keys.accounts).toEqual([A]);
    expect(keys.code).toEqual([A]);
    expect(keys.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
  });

  it("merges widening entries in address order and keeps existing values", () => {
    const widened = mergeIntoStateArtifact(MINIMAL, [
      { address: B, balance: "0x0", nonce: "0x0", storage: [{ slot: SLOT_2, value: `0x${"0".repeat(63)}9` }] },
      { address: A, balance: "0xde0b6b3a7640000", nonce: "0x1", code: "0x6001", storage: [{ slot: SLOT_2, value: `0x${"0".repeat(64)}` }] },
    ]);
    expect(widened.accounts.map((account) => account.address)).toEqual([A, B]);
    expect(widened.accounts[0]?.storage.map((entry) => entry.slot)).toEqual([SLOT_1, SLOT_2]);
    // The widened artifact's key set is exactly the old one plus the two added slots
    // plus the new account -- the property the loop's termination test depends on.
    const expected = keySetWithAccount(
      keySetWithSlot(keySetWithSlot(stateArtifactKeySet(MINIMAL), A, SLOT_2), B, SLOT_2),
      B,
    );
    expect(stateArtifactKeySet(widened)).toEqual(expected);
  });

  it("refuses a merge that would change a committed value", () => {
    expect(() => mergeIntoStateArtifact(MINIMAL, [
      { address: A, balance: "0x1", nonce: "0x1", code: "0x6001", storage: [] },
    ])).toThrow(/committed/u);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/artifact.test.ts`
Expected: FAIL — unresolved import `./artifact.js`.

- [ ] **Step 3: Implement `src/artifact.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";
import {
  Hex32Schema,
  HexAddressSchema,
  HexBytesSchema,
  HexQuantitySchema,
  isEmptyBytes,
  type Hex32,
  type HexAddress,
} from "./hex.js";
import { STATE_ARTIFACT_SCHEMA_VERSION } from "./identifiers.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  type StateKeySet,
} from "./key-set.js";

const StorageEntrySchema = z.strictObject({
  slot: Hex32Schema,
  value: Hex32Schema,
});

export const StateArtifactAccountSchema = z.strictObject({
  address: HexAddressSchema,
  balance: HexQuantitySchema,
  nonce: HexQuantitySchema,
  /** Present iff the account carries code. Absent and `"0x"` are the same world; the
   * schema admits only one spelling so two artifacts of one world cannot differ. */
  code: HexBytesSchema.optional(),
  storage: z.array(StorageEntrySchema),
});
export type StateArtifactAccount = z.infer<typeof StateArtifactAccountSchema>;

export const StateArtifactSchema = z.strictObject({
  schemaVersion: z.literal(STATE_ARTIFACT_SCHEMA_VERSION),
  anchor: z.strictObject({
    blockNumber: z.number().int().nonnegative(),
    blockHash: Hex32Schema,
    stateRoot: Hex32Schema,
    timestamp: z.number().int().nonnegative(),
  }),
  accounts: z.array(StateArtifactAccountSchema),
});
export type StateArtifact = z.infer<typeof StateArtifactSchema>;

function assertOrdered(artifact: StateArtifact): void {
  const addresses = artifact.accounts.map((account) => account.address);
  const sorted = [...addresses].sort(compareCodeUnitStrings);
  if (JSON.stringify(addresses) !== JSON.stringify(sorted)) {
    invalidInput("State artifact accounts must be sorted by address.");
  }
  if (new Set(addresses).size !== addresses.length) {
    invalidInput("State artifact carries a duplicate account address.");
  }
  for (const account of artifact.accounts) {
    const slots = account.storage.map((entry) => entry.slot);
    const sortedSlots = [...slots].sort(compareCodeUnitStrings);
    if (JSON.stringify(slots) !== JSON.stringify(sortedSlots)) {
      invalidInput(`Storage slots for ${account.address} must be sorted.`);
    }
    if (new Set(slots).size !== slots.length) {
      invalidInput(`Storage for ${account.address} carries a duplicate slot.`);
    }
    if (account.code !== undefined && isEmptyBytes(account.code)) {
      invalidInput(`${account.address} declares empty code; omit the field instead.`);
    }
  }
}

export function serializeStateArtifact(artifact: StateArtifact): Uint8Array {
  const parsed = StateArtifactSchema.safeParse(artifact);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalidInput(first
      ? `Invalid state artifact at /${first.path.join("/")}: ${first.message}`
      : "Invalid state artifact.");
  }
  assertOrdered(parsed.data);
  return canonicalJsonBytes(parsed.data);
}

export function parseStateArtifact(bytes: Uint8Array): StateArtifact {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("State artifact is not valid UTF-8 JSON.", cause);
  }
  const parsed = StateArtifactSchema.safeParse(decoded);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalidInput(first
      ? `Invalid state artifact at /${first.path.join("/")}: ${first.message}`
      : "Invalid state artifact.");
  }
  assertOrdered(parsed.data);
  return parsed.data;
}

export function stateArtifactDigest(bytes: Uint8Array): Sha256Digest {
  return recordDigest(bytes);
}

/** Every key the artifact commits. The widen loop subtracts this from what a run read. */
export function stateArtifactKeySet(artifact: StateArtifact): StateKeySet {
  let keys = emptyKeySet();
  for (const account of artifact.accounts) {
    keys = keySetWithAccount(keys, account.address);
    if (account.code !== undefined) keys = keySetWithCode(keys, account.address);
    for (const entry of account.storage) keys = keySetWithSlot(keys, account.address, entry.slot);
  }
  return keys;
}

export function stateArtifactEntryCount(artifact: StateArtifact): number {
  return artifact.accounts.reduce(
    (total, account) => total + 1 + (account.code === undefined ? 0 : 1) + account.storage.length,
    0,
  );
}

/**
 * Widening is additive. A merge that would *change* an already-committed value is
 * refused: the anchor is frozen, so a differing value means the archive disagreed with
 * itself between calls (design §5.2), and quietly taking the newer one would erase the
 * evidence of that.
 */
export function mergeIntoStateArtifact(
  artifact: StateArtifact,
  additions: readonly StateArtifactAccount[],
): StateArtifact {
  const byAddress = new Map<HexAddress, StateArtifactAccount>(
    artifact.accounts.map((account) => [account.address, account]),
  );

  for (const addition of additions) {
    const existing = byAddress.get(addition.address);
    if (existing === undefined) {
      byAddress.set(addition.address, {
        ...addition,
        storage: [...addition.storage].sort((left, right) =>
          compareCodeUnitStrings(left.slot, right.slot)),
      });
      continue;
    }
    if (existing.balance !== addition.balance || existing.nonce !== addition.nonce) {
      invalidInput(
        `Widening would change committed account fields for ${addition.address}: `
        + `balance ${existing.balance} -> ${addition.balance}, nonce ${existing.nonce} -> ${addition.nonce}.`,
      );
    }
    if (existing.code !== undefined && addition.code !== undefined && existing.code !== addition.code) {
      invalidInput(`Widening would change committed code for ${addition.address}.`);
    }
    const slots = new Map<Hex32, string>(existing.storage.map((entry) => [entry.slot, entry.value]));
    for (const entry of addition.storage) {
      const committed = slots.get(entry.slot);
      if (committed !== undefined && committed !== entry.value) {
        invalidInput(
          `Widening would change committed storage ${addition.address}/${entry.slot}: `
          + `${committed} -> ${entry.value}.`,
        );
      }
      slots.set(entry.slot, entry.value);
    }
    const code = existing.code ?? addition.code;
    const storage = [...slots.entries()]
      .map(([slot, value]) => ({ slot, value }))
      .sort((left, right) => compareCodeUnitStrings(left.slot, right.slot));
    byAddress.set(addition.address, code === undefined
      ? { address: existing.address, balance: existing.balance, nonce: existing.nonce, storage }
      : { address: existing.address, balance: existing.balance, nonce: existing.nonce, code, storage });
  }

  return {
    schemaVersion: artifact.schemaVersion,
    anchor: artifact.anchor,
    accounts: [...byAddress.values()].sort((left, right) =>
      compareCodeUnitStrings(left.address, right.address)),
  };
}
```

- [ ] **Step 4: Generate the fixtures**

Write `scripts/generate-fixtures.mjs` that imports the built `dist/artifact.js`, constructs
`MINIMAL` exactly as the test does, and writes:
- `fixtures/artifacts-v1/minimal.json` — the canonical bytes, plus a sibling
  `minimal.sha256` holding `stateArtifactDigest` output,
- `fixtures/adversarial-v1/uppercase-hex.json` — `minimal` with the address uppercased,
- `fixtures/adversarial-v1/unsorted-slots.json` — `minimal` with two slots in descending
  order.

Add `"check:fixtures": "node scripts/generate-fixtures.mjs --check"` to `package.json`
scripts, following `packages/environments/record`'s existing generator (read it first).

Run: `corepack yarn@4.13.0 build && node scripts/generate-fixtures.mjs && corepack yarn@4.13.0 check:fixtures`
Expected: three fixtures written; `--check` reports no drift.

- [ ] **Step 5: Add the fixture-corpus test**

Append to `src/artifact.test.ts` a block that reads the two adversarial fixtures and asserts
`parseStateArtifact` throws `ChainExtractionError` for each, with the message naming the
field. This is what stops a "helpful" future normalization from being added to the parser.

- [ ] **Step 6: The digest-confusion fixture (contract 6)**

Add one test asserting `stateArtifactDigest(bytes)` is `sha256:`-prefixed and that the
bare-hex form (what an in-toto DigestSet carries when CE3 names this artifact as a subject)
is produced only by CE1's `bareHexDigest`, never by string slicing in this package:

```ts
it("hands CE3 a prefixed digest and never mints a bare-hex one itself", async () => {
  const { bareHexDigest } = await import("@jinn-network/chain-environment-record");
  const digest = stateArtifactDigest(serializeStateArtifact(MINIMAL));
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(bareHexDigest(digest)).toMatch(/^[0-9a-f]{64}$/u);
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("./artifact.ts", import.meta.url), "utf8"));
  expect(source).not.toMatch(/slice\(7\)|replace\("sha256:"/u);
});
```

- [ ] **Step 7: Run everything, export, commit**

Run: `corepack yarn@4.13.0 test && corepack yarn@4.13.0 typecheck`
Expected: all artifact tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): the state artifact model, its canonical bytes, and its fixtures"
```

---

### Task 6: Anchor capture, the finality observation, and the E5 bound

Design §4.3 (source anchor block), §4.2 E5 (the anchor-authenticity bound), §5.2 (provider
disagreement is recorded, not smoothed over).

**Files:**
- Create: `src/anchor.ts`, `src/anchor.test.ts`
- Modify: `src/failures.ts` (adds the `StageOutcome` helpers used by every stage), `src/index.ts`

**Interfaces:**
- Consumes: `BudgetedArchivePort` (T4), hex normalization (T3), `isCalendarStrictRfc3339`
  and `Clock`.
- Produces: `AnchorCapture`, `HeaderProofDescriptor`, `captureAnchor(archive, request, clock)`,
  `confirmAnchorUnchanged(archive, capture)`, and in `failures.ts`:
  `StageOutcome<T>`, `stageOk`, `stageFail`.

- [ ] **Step 1: Write the failing test**

`src/anchor.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { captureAnchor, confirmAnchorUnchanged } from "./anchor.js";
import { createBudgetedArchivePort } from "./budget.js";
import type { ArchiveBlockHeader, ArchiveRpcPort, BlockSelector } from "./ports.js";

const CLOCK = { now: () => new Date("2026-07-31T09:00:00.000Z") };

function header(number: number, marker: string): ArchiveBlockHeader {
  return {
    number,
    hash: `0x${marker.repeat(64)}`,
    parentHash: `0x${"0".repeat(64)}`,
    stateRoot: `0x${marker.repeat(64)}`,
    timestamp: 1_760_000_000 + number,
  };
}

function archiveWith(headers: (selector: BlockSelector, call: number) => ArchiveBlockHeader): ArchiveRpcPort {
  let call = 0;
  return {
    async getBlockHeader(selector) {
      call += 1;
      return headers(selector, call);
    },
    async getAccount() { throw new Error("unused"); },
    async getCode() { throw new Error("unused"); },
    async getStorageAt() { throw new Error("unused"); },
    async getProof() { throw new Error("unused"); },
  };
}

describe("anchor capture", () => {
  it("captures number, hash, root, timestamp and the observed finality depth", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(21_000_064, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockNumber).toBe(21_000_000);
    expect(outcome.value.stateRoot).toBe(`0x${"1".repeat(64)}`);
    expect(outcome.value.finality).toEqual({
      observedAt: "2026-07-31T09:00:00.000Z",
      finalizedBlockNumber: 21_000_064,
      depthBelowFinalized: 64,
      finalizedAtObservation: true,
    });
  });

  it("carries the author's header proof and lets CE1's function classify the E5 bound", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(21_000_064, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!outcome.ok) throw new Error("expected a capture");
    expect(outcome.value.headerProof).toBeUndefined();

    const proven = await captureAnchor(
      archive,
      {
        blockNumber: 21_000_000,
        headerProof: { name: "header-proof", digest: { sha256: "a".repeat(64) } },
      },
      CLOCK,
    );
    if (!proven.ok) throw new Error("expected a capture");
    expect(proven.value.headerProof?.name).toBe("header-proof");
    // The classification itself is CE1's: T11 asserts
    // `anchorAuthenticityBoundOf(record.sourceAnchor)` is "header-proven" for this case.
  });

  it("reports an anchor above the finalized head honestly instead of failing", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(20_999_990, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!outcome.ok) throw new Error("expected a capture");
    expect(outcome.value.finality.finalizedAtObservation).toBe(false);
    expect(outcome.value.finality.depthBelowFinalized).toBe(-10);
  });

  it("fails archive-self-disagreement when the same block answers differently later", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector, call) => selector === "finalized"
        ? header(21_000_064, "9")
        : header(21_000_000, call > 2 ? "7" : "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const captured = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!captured.ok) throw new Error("expected a capture");
    const confirmed = await confirmAnchorUnchanged(archive, captured.value);
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.reason).toBe("archive-self-disagreement");
    expect(confirmed.detail).toMatch(/stateRoot/u);
  });

  it("fails archive-anchor-pruned when the archive cannot serve the block", async () => {
    const archive = createBudgetedArchivePort({
      async getBlockHeader() { throw new Error("missing trie node 0xabc (path ) state 0xdef"); },
      async getAccount() { throw new Error("unused"); },
      async getCode() { throw new Error("unused"); },
      async getStorageAt() { throw new Error("unused"); },
      async getProof() { throw new Error("unused"); },
    }, { maxCalls: 10, maxBytes: 1_000_000 });
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("archive-anchor-pruned");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/anchor.test.ts`
Expected: FAIL — unresolved import `./anchor.js`.

- [ ] **Step 3: Add the stage helpers to `src/failures.ts`**

```ts
/**
 * Every pipeline stage returns one of these. Extraction *facts* -- the archive could not
 * serve the anchor, the world would not close -- are values, not exceptions; exceptions
 * are reserved for caller error and port contract violations (see errors.ts).
 */
export type StageOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly reason: ExtractionFailureReason;
    readonly detail: string;
  };

export function stageOk<T>(value: T): StageOutcome<T> {
  return { ok: true, value };
}

export function stageFail<T>(
  reason: ExtractionFailureReason,
  detail: string,
): StageOutcome<T> {
  return { ok: false, reason, detail };
}
```

- [ ] **Step 4: Implement `src/anchor.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { normalizeHex32 } from "./hex.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import type { BudgetedArchivePort } from "./budget.js";
import type { Clock } from "./ports.js";
import type { Hex32 } from "./hex.js";

/** A ResourceDescriptor as the record carries it; CE1 owns the schema, CE4 only passes
 * it through, so the shape here is the minimum this module reads. */
export interface HeaderProofDescriptor {
  readonly name: string;
  readonly digest: { readonly sha256: string };
}

/**
 * Design E5 lives in CE1's `anchorAuthenticityBoundOf(anchor)`, which returns
 * `"not-anchored" | "declared" | "header-proven"`. CE4 **calls that function** and never
 * re-derives the bound; this module only carries the header-proof descriptor the author
 * supplied, so the assembled record can name it and CE1 can classify it.
 */
export type HeaderProofCarrier = HeaderProofDescriptor | undefined;

export interface AnchorFinalityObservation {
  /** RFC 3339 UTC, from the injected clock. Part of the claim: an old observation
   * re-presented later is not a fresh one. */
  readonly observedAt: string;
  readonly finalizedBlockNumber: number;
  /** Positive when the anchor is at or below the finalized head; negative when the
   * author anchored above it, which is legal and recorded rather than refused. */
  readonly depthBelowFinalized: number;
  readonly finalizedAtObservation: boolean;
}

export interface AnchorCapture {
  readonly blockNumber: number;
  readonly blockHash: Hex32;
  readonly stateRoot: Hex32;
  /** Unix seconds, as the chain reports it. */
  readonly timestamp: number;
  readonly finality: AnchorFinalityObservation;
  readonly headerProof: HeaderProofCarrier;
}

export interface AnchorRequest {
  readonly blockNumber: number;
  readonly headerProof?: HeaderProofDescriptor;
}

/** Archives fail two distinguishable ways, and the difference tells the author what to
 * do: get a *different* archive, or get archive access at all. */
function classifyHeaderError(cause: unknown): { reason: "archive-anchor-pruned" | "archive-unreachable"; detail: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const pruned = /missing trie node|state.*not available|pruned|header not found|block not found/iu.test(message);
  return {
    reason: pruned ? "archive-anchor-pruned" : "archive-unreachable",
    detail: message,
  };
}

export async function captureAnchor(
  archive: BudgetedArchivePort,
  request: AnchorRequest,
  clock: Clock,
): Promise<StageOutcome<AnchorCapture>> {
  if (!Number.isInteger(request.blockNumber) || request.blockNumber < 0) {
    return stageFail("archive-unreachable", `Anchor block must be a non-negative integer; received ${String(request.blockNumber)}.`);
  }

  let anchor;
  try {
    anchor = await archive.getBlockHeader(request.blockNumber);
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, detail);
  }
  if (anchor.number !== request.blockNumber) {
    return stageFail(
      "archive-self-disagreement",
      `Asked for block ${request.blockNumber}; the archive answered with block ${anchor.number}.`,
    );
  }

  let finalized;
  try {
    finalized = await archive.getBlockHeader("finalized");
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, `Finality observation failed: ${detail}`);
  }

  const observedAt = clock.now().toISOString();
  const depthBelowFinalized = finalized.number - anchor.number;

  return stageOk({
    blockNumber: anchor.number,
    blockHash: normalizeHex32(anchor.hash),
    stateRoot: normalizeHex32(anchor.stateRoot),
    timestamp: anchor.timestamp,
    finality: {
      observedAt,
      finalizedBlockNumber: finalized.number,
      depthBelowFinalized,
      finalizedAtObservation: depthBelowFinalized >= 0,
    },
    headerProof: request.headerProof,
  });
}

/**
 * Re-reads the anchor header after the extraction has consumed the archive, and refuses
 * to proceed if it changed. A frozen historical block cannot legitimately change; a
 * provider that answers differently is either racing across a pool of nodes or serving
 * a reorged view, and either way every byte harvested in between is suspect.
 */
export async function confirmAnchorUnchanged(
  archive: BudgetedArchivePort,
  capture: AnchorCapture,
): Promise<StageOutcome<AnchorCapture>> {
  let again;
  try {
    again = await archive.getBlockHeader(capture.blockNumber);
  } catch (cause) {
    const { reason, detail } = classifyHeaderError(cause);
    return stageFail(reason, `Anchor re-read failed: ${detail}`);
  }
  const differences: string[] = [];
  if (normalizeHex32(again.hash) !== capture.blockHash) {
    differences.push(`blockHash ${capture.blockHash} -> ${normalizeHex32(again.hash)}`);
  }
  if (normalizeHex32(again.stateRoot) !== capture.stateRoot) {
    differences.push(`stateRoot ${capture.stateRoot} -> ${normalizeHex32(again.stateRoot)}`);
  }
  if (again.timestamp !== capture.timestamp) {
    differences.push(`timestamp ${capture.timestamp} -> ${again.timestamp}`);
  }
  if (differences.length > 0) {
    return stageFail(
      "archive-self-disagreement",
      `The archive answered differently for block ${capture.blockNumber}: ${differences.join("; ")}.`,
    );
  }
  return stageOk(capture);
}
```

- [ ] **Step 5: Run the tests, typecheck, export, commit**

Run: `corepack yarn@4.13.0 vitest run src/anchor.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 5 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): anchor capture, finality observation, and the E5 bound"
```

---

### Task 7: EIP-1186 proof verification, offline

CE3 pinned the contract: `SourceProofManifest` carries a per-entry `verified` flag **as
data**, an unverified entry covers nothing, and the producer sets it — *"if you want it to
live in CE4 that is fine, just set `verified` honestly."* The manifest is sealed into the
record before CE3 ever runs, so the producer is the only party who can set it. CE4 therefore
verifies the proofs itself, offline and purely, and an entry is `verified: true` only when
the trie walk actually reached its value under the declared anchor root.

This is also the only defense against an archive that hands back a fabricated slot: without
it, `verified` would be a synonym for "we asked for it."

**Files:**
- Create: `src/rlp.ts`, `src/rlp.test.ts`, `src/proof.ts`, `src/proof.test.ts`
- Modify: `package.json` (adds `@noble/hashes`), the T1 guard lists, `src/index.ts`

**Interfaces:**
- Consumes: `keccak_256` from `@noble/hashes/sha3.js`; T3's hex helpers.
- Produces: `decodeRlp`, `RlpItem`, `verifyAccountProof(proof, stateRoot): ProofVerdict`,
  `ProofVerdict`.

- [ ] **Step 1: Add the dependency and widen the guards**

`package.json` gains `"@noble/hashes": "^1.7.1"` (the version CE1 already pins — read
`packages/environments/chain-record/package.json` and match it exactly). Add
`'@noble/hashes'` to `CHAIN_EXTRACTION_ALLOWED_EXTERNALS` and
`CHAIN_EXTRACTION_ALLOWED_DEPENDENCIES` in
`.github/scripts/environments-source-boundaries.test.mjs`, and to the inventory guard's
dependency graph if it lists non-Jinn dependencies (it does not — check before editing).

Run: `node --test .github/scripts/environments-source-boundaries.test.mjs`
Expected: PASS.

- [ ] **Step 2: Write the failing RLP test**

`src/rlp.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeRlp } from "./rlp.js";

const bytes = (hex: string) => Uint8Array.from(
  (hex.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
);

describe("RLP decoding", () => {
  it("decodes single bytes, short strings, and short lists", () => {
    expect(decodeRlp(bytes("00"))).toEqual(bytes("00"));
    expect(decodeRlp(bytes("83646f67"))).toEqual(bytes("646f67")); // "dog"
    const list = decodeRlp(bytes("c88363617483646f67")); // ["cat", "dog"]
    expect(Array.isArray(list)).toBe(true);
    expect((list as Uint8Array[])[0]).toEqual(bytes("636174"));
  });

  it("decodes long strings and long lists through their length prefixes", () => {
    const payload = "61".repeat(56);
    expect(decodeRlp(bytes(`b838${payload}`))).toEqual(bytes(payload));
  });

  it("refuses trailing bytes and truncated input rather than guessing", () => {
    expect(() => decodeRlp(bytes("83646f6700"))).toThrow(/trailing/u);
    expect(() => decodeRlp(bytes("83646f"))).toThrow(/truncated/u);
  });
});
```

- [ ] **Step 3: Implement `src/rlp.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { invalidInput } from "./errors.js";

export type RlpItem = Uint8Array | RlpItem[];

function readLength(input: Uint8Array, offset: number, lengthOfLength: number): number {
  let value = 0;
  for (let index = 0; index < lengthOfLength; index += 1) {
    const byte = input[offset + index];
    if (byte === undefined) invalidInput("RLP input is truncated inside a length prefix.");
    value = value * 256 + byte;
  }
  return value;
}

function decodeItem(input: Uint8Array, offset: number): { item: RlpItem; next: number } {
  const prefix = input[offset];
  if (prefix === undefined) invalidInput("RLP input is truncated.");

  const slice = (start: number, length: number): Uint8Array => {
    if (start + length > input.length) invalidInput("RLP input is truncated.");
    return input.slice(start, start + length);
  };

  if (prefix < 0x80) return { item: input.slice(offset, offset + 1), next: offset + 1 };
  if (prefix < 0xb8) {
    const length = prefix - 0x80;
    return { item: slice(offset + 1, length), next: offset + 1 + length };
  }
  if (prefix < 0xc0) {
    const lengthOfLength = prefix - 0xb7;
    const length = readLength(input, offset + 1, lengthOfLength);
    return {
      item: slice(offset + 1 + lengthOfLength, length),
      next: offset + 1 + lengthOfLength + length,
    };
  }

  const [payloadStart, payloadLength] = prefix < 0xf8
    ? [offset + 1, prefix - 0xc0]
    : (() => {
      const lengthOfLength = prefix - 0xf7;
      return [offset + 1 + lengthOfLength, readLength(input, offset + 1, lengthOfLength)] as const;
    })();

  const end = payloadStart + payloadLength;
  if (end > input.length) invalidInput("RLP input is truncated inside a list.");
  const items: RlpItem[] = [];
  let cursor = payloadStart;
  while (cursor < end) {
    const decoded = decodeItem(input, cursor);
    items.push(decoded.item);
    cursor = decoded.next;
  }
  if (cursor !== end) invalidInput("RLP list payload overruns its declared length.");
  return { item: items, next: end };
}

/** Decodes exactly one item and refuses trailing bytes: a proof node with slack in it is
 * not a node this package will walk. */
export function decodeRlp(input: Uint8Array): RlpItem {
  const { item, next } = decodeItem(input, 0);
  if (next !== input.length) invalidInput("RLP input carries trailing bytes.");
  return item;
}
```

- [ ] **Step 4: Write the failing proof test**

`src/proof.test.ts` drives `verifyAccountProof` against the kit's fake archive, which builds
**real** tries (T14 step 2 builds them with the same primitives, so the test is not circular
only because the trie construction and the trie walk are independent code paths — the fake
builds nodes bottom-up, the verifier walks top-down):

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { verifyAccountProof } from "./proof.js";
import { buildFakeTrieWorld, FAKE_POOL, FAKE_SLOT_1 } from "./testing.js";

describe("EIP-1186 verification", () => {
  it("verifies an account and its storage against the declared root", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.proofFor(FAKE_POOL, [FAKE_SLOT_1]), world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(true);
  });

  it("refuses a proof presented against a different root", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.proofFor(FAKE_POOL, [FAKE_SLOT_1]), `0x${"e".repeat(64)}`);
    expect(verdict.account).toBe(false);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(false);
  });

  it("refuses a tampered storage value while the account still verifies", () => {
    // The forged-slice case from design §16: real protocol code and most storage proven
    // against the true root, one slot quietly changed.
    const world = buildFakeTrieWorld();
    const proof = world.proofFor(FAKE_POOL, [FAKE_SLOT_1]);
    const tampered = {
      ...proof,
      storageProof: proof.storageProof.map((entry) => ({ ...entry, value: "0xdead" })),
    };
    const verdict = verifyAccountProof(tampered, world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(false);
  });

  it("verifies a proven-absent account, because reading empty state is legal", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.absenceProofFor(`0x${"9".repeat(40)}`), world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.absent).toBe(true);
  });
});
```

- [ ] **Step 5: Implement `src/proof.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";

import { normalizeHex32, normalizeSlot, type Hex32 } from "./hex.js";
import type { ArchiveAccountProof } from "./ports.js";
import { decodeRlp, type RlpItem } from "./rlp.js";

export interface ProofVerdict {
  /** True when the walk terminated consistently with the claimed account state -- either
   * at the claimed value, or at a proven absence. */
  readonly account: boolean;
  readonly absent: boolean;
  readonly storage: Readonly<Record<Hex32, boolean>>;
}

function fromHex(value: string): Uint8Array {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const padded = body.length % 2 === 0 ? body : `0${body}`;
  return Uint8Array.from((padded.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nibbles(bytes: Uint8Array): number[] {
  return [...bytes].flatMap((byte) => [byte >> 4, byte & 0x0f]);
}

/** Strips a quantity to its minimal big-endian form, which is how the trie stores it. */
function minimal(value: string): Uint8Array {
  const bytes = fromHex(value);
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.slice(start);
}

type WalkResult =
  | { readonly kind: "value"; readonly value: Uint8Array }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

/**
 * Walks a Merkle-Patricia proof from `root` along `path`, using only the supplied nodes.
 * Every reference is resolved by hash against the node list, so a proof that omits a node
 * -- or supplies one that does not hash to the reference -- is invalid rather than
 * "probably fine".
 */
function walk(root: Uint8Array, path: number[], nodes: readonly Uint8Array[]): WalkResult {
  const byHash = new Map(nodes.map((node) => [toHex(keccak_256(node)), node]));
  let expected = root;
  let cursor = 0;
  let current: Uint8Array | undefined = byHash.get(toHex(expected));

  for (let guard = 0; guard <= nodes.length; guard += 1) {
    if (current === undefined) return { kind: "absent" };
    if (!equalBytes(keccak_256(current), expected)) return { kind: "invalid" };

    let decoded: RlpItem;
    try {
      decoded = decodeRlp(current);
    } catch {
      return { kind: "invalid" };
    }
    if (!Array.isArray(decoded)) return { kind: "invalid" };

    if (decoded.length === 17) {
      if (cursor === path.length) {
        const value = decoded[16];
        if (!(value instanceof Uint8Array)) return { kind: "invalid" };
        return value.length === 0 ? { kind: "absent" } : { kind: "value", value };
      }
      const branch = decoded[path[cursor]!];
      if (!(branch instanceof Uint8Array)) return { kind: "invalid" };
      cursor += 1;
      if (branch.length === 0) return { kind: "absent" };
      expected = branch;
      current = byHash.get(toHex(branch));
      continue;
    }

    if (decoded.length !== 2) return { kind: "invalid" };
    const [encodedPath, payload] = decoded;
    if (!(encodedPath instanceof Uint8Array) || !(payload instanceof Uint8Array)) {
      return { kind: "invalid" };
    }
    const pathNibbles = nibbles(encodedPath);
    const flag = pathNibbles[0] ?? 0;
    const odd = (flag & 1) === 1;
    const leaf = (flag & 2) === 2;
    const partial = pathNibbles.slice(odd ? 1 : 2);
    const remaining = path.slice(cursor);
    if (partial.length > remaining.length) return { kind: "absent" };
    if (!partial.every((nibble, index) => nibble === remaining[index])) return { kind: "absent" };
    cursor += partial.length;

    if (leaf) {
      return cursor === path.length
        ? { kind: "value", value: payload }
        : { kind: "absent" };
    }
    expected = payload;
    current = byHash.get(toHex(payload));
  }
  return { kind: "invalid" };
}

/**
 * Verifies one EIP-1186 response against a declared state root, offline.
 *
 * The bound is design E5's and is not widened by this function: it proves the entries
 * belong to the trie under *that root*. Whether that root is the canonical chain's root at
 * block N is a separate, declared step (`anchorAuthenticityBoundOf`).
 */
export function verifyAccountProof(proof: ArchiveAccountProof, stateRoot: string): ProofVerdict {
  const root = fromHex(normalizeHex32(stateRoot));
  const accountPath = nibbles(keccak_256(fromHex(proof.address)));
  const walked = walk(root, accountPath, proof.accountProof.map(fromHex));

  let accountOk = false;
  let absent = false;

  if (walked.kind === "absent") {
    // A proven-absent account is legitimate coverage: execution that reads an empty
    // account must be reproducible too, and "empty" is exactly what the sealed world
    // returns for it.
    absent = true;
    accountOk = minimal(proof.balance).length === 0
      && minimal(proof.nonce).length === 0;
  } else if (walked.kind === "value") {
    const decoded = decodeRlp(walked.value);
    if (Array.isArray(decoded) && decoded.length === 4) {
      const [nonce, balance, storageHash, codeHash] = decoded as Uint8Array[];
      accountOk = equalBytes(nonce!, minimal(proof.nonce))
        && equalBytes(balance!, minimal(proof.balance))
        && equalBytes(storageHash!, fromHex(normalizeHex32(proof.storageHash)))
        && equalBytes(codeHash!, fromHex(normalizeHex32(proof.codeHash)));
    }
  }

  const storage: Record<string, boolean> = {};
  for (const entry of proof.storageProof) {
    const slot = normalizeSlot(entry.key);
    if (!accountOk) {
      storage[slot] = false;
      continue;
    }
    if (absent) {
      // Every slot of an absent account is zero; a non-zero claim is a contradiction.
      storage[slot] = minimal(entry.value).length === 0;
      continue;
    }
    const slotWalk = walk(
      fromHex(normalizeHex32(proof.storageHash)),
      nibbles(keccak_256(fromHex(slot))),
      entry.proof.map(fromHex),
    );
    const claimed = minimal(entry.value);
    if (slotWalk.kind === "absent") storage[slot] = claimed.length === 0;
    else if (slotWalk.kind === "value") {
      const decoded = decodeRlp(slotWalk.value);
      storage[slot] = decoded instanceof Uint8Array && equalBytes(decoded, claimed);
    } else storage[slot] = false;
  }

  return { account: accountOk, absent, storage };
}
```

- [ ] **Step 6: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/rlp.test.ts src/proof.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 3 + 4 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction .github
git commit -m "feat(chain-extraction): offline EIP-1186 proof verification"
```

---

### Task 8: The coverage stage — CE3's manifest types, CE1's census, CE4's artifact formats

Design §4.2 E13. CE3 owns the *assessment* (`assessArtifactCoverage`) and is the only place
`source-coverage-incomplete` is decided; CE1 enforces the *census arithmetic* at seal time.
CE4 produces the two byte-artifacts those point at — and **CE1 explicitly delegated their
internal format to this plan**, so this task pins it.

**Files:**
- Create: `src/coverage.ts`, `src/coverage.test.ts`,
  `fixtures/coverage-v1/proof-bundle.json`, `fixtures/coverage-v1/fixture-coverage.json`,
  `fixtures/adversarial-v1/uncovered-entry.json`
- Modify: `src/artifact.ts` (adds `stateArtifactEntryCounts`), `src/index.ts`

**Interfaces:**
- Consumes: `SourceProofManifest`, `FixtureMutationDeclaration`, `CoverageAssessmentInput`,
  `CoverageAssessment`, `assessArtifactCoverage` from **CE3**; `StateEntryCounts`,
  `bareHexDigest` from **CE1**; T7's `verifyAccountProof`.
- Produces: `PROOF_BUNDLE_FORMAT`, `FIXTURE_COVERAGE_FORMAT`, `ProofBundle`,
  `FixtureCoverageDocument`, `collectSourceProofs`, `buildCoverageArtifacts`,
  `CoverageArtifacts`, and in `artifact.ts` `stateArtifactEntryCounts(artifact): StateEntryCounts`.

**The two formats CE4 pins (F-CE4-5).** Both are I-JSON, JCS-canonicalized, digest-addressed,
and deliberately runtime-neutral — a third party re-verifying an anchored-subset record
(design §5.4) must be able to check the proofs without any Jinn code:

```ts
export const PROOF_BUNDLE_FORMAT = Object.freeze({ id: "jinn.chain-source-proofs", version: "1" });
export const FIXTURE_COVERAGE_FORMAT = Object.freeze({ id: "jinn.chain-fixture-coverage", version: "1" });

export interface ProofBundle {
  readonly format: typeof PROOF_BUNDLE_FORMAT;
  readonly proofFormat: "eip-1186";
  readonly anchor: { readonly blockNumber: number; readonly blockHash: Hex32; readonly stateRoot: Hex32 };
  /** Sorted by address; storage proofs sorted by slot. Raw EIP-1186 responses, unmodified
   * except for hex normalization -- so anyone can re-run the same walk this package ran. */
  readonly accounts: readonly ArchiveAccountProof[];
}

export interface FixtureCoverageDocument {
  readonly format: typeof FIXTURE_COVERAGE_FORMAT;
  /** CE3's `FixtureMutationDeclaration` shape verbatim: {address, kind, slot?}. Sorted. */
  readonly declarations: readonly FixtureMutationDeclaration[];
}
```

- [ ] **Step 1: Write the failing test**

`src/coverage.test.ts` — five cases:

```ts
// SPDX-License-Identifier: Apache-2.0

import { assessArtifactCoverage } from "@jinn-network/chain-environment-verification";
import { describe, expect, it } from "vitest";

import { stateArtifactEntryCounts } from "./artifact.js";
import { buildCoverageArtifacts, collectSourceProofs } from "./coverage.js";
import { createBudgetedArchivePort } from "./budget.js";
import { buildFakeTrieWorld, fakeStateArtifact, FAKE_ACTOR, FAKE_POOL, FAKE_SLOT_1 } from "./testing.js";

describe("the coverage stage", () => {
  it("counts every artifact entry exactly once, so CE1's census balances", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [{ address: FAKE_ACTOR, kind: "account" }],
    });
    if (!built.ok) throw new Error(built.detail);

    const counts = stateArtifactEntryCounts(artifact);
    for (const key of ["accounts", "storageSlots", "codeEntries"] as const) {
      expect(built.value.proofCoverage[key] + built.value.fixtureDeclared[key]).toBe(counts[key]);
    }
  });

  it("agrees with CE3's assessor, which is the only party that decides incompleteness", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [{ address: FAKE_ACTOR, kind: "account" }],
    });
    if (!built.ok) throw new Error(built.detail);
    const assessment = assessArtifactCoverage({
      fidelityClass: "anchored-subset",
      entries: built.value.entries,
      manifest: built.value.manifest,
      fixtureMutations: built.value.declarations,
      mutatesSourceProtocolState: built.value.mutatesSourceProtocolState,
    });
    expect(assessment.complete).toBe(true);
    expect(assessment.uncovered).toBe(0);
  });

  it("fails coverage-incomplete when an entry is neither proven nor declared", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact, fidelityClass: "anchored-subset", bundle: proofs.value, declarations: [],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("coverage-incomplete");
    expect(built.detail).toContain(FAKE_ACTOR);
  });

  it("marks a tampered entry unverified, and therefore uncovered", async () => {
    const world = buildFakeTrieWorld({ tamperSlot: { address: FAKE_POOL, slot: FAKE_SLOT_1 } });
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const proofs = await collectSourceProofs(archive, fakeStateArtifact(), { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    expect(proofs.ok).toBe(false);
    if (proofs.ok) return;
    expect(proofs.reason).toBe("archive-root-mismatch");
  });

  it("raises mutatesSourceProtocolState when a fixture writes a proven account", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
    const artifact = fakeStateArtifact();
    const proofs = await collectSourceProofs(archive, artifact, { addresses: [FAKE_POOL], stateRoot: world.stateRoot });
    if (!proofs.ok) throw new Error(proofs.detail);
    const built = buildCoverageArtifacts({
      artifact,
      fidelityClass: "anchored-subset",
      bundle: proofs.value,
      declarations: [
        { address: FAKE_ACTOR, kind: "account" },
        { address: FAKE_POOL, kind: "storage", slot: FAKE_SLOT_1 },
      ],
    });
    if (!built.ok) throw new Error(built.detail);
    expect(built.value.mutatesSourceProtocolState).toBe(true);
    expect(built.value.mutatedProofCoveredAccounts).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail; then implement**

`src/artifact.ts` gains:

```ts
/** CE1's census type. One entry per account, per code blob, per slot -- the denominator
 * the record's E13 arithmetic balances against. */
export function stateArtifactEntryCounts(artifact: StateArtifact): StateEntryCounts {
  return {
    accounts: artifact.accounts.length,
    codeEntries: artifact.accounts.filter((account) => account.code !== undefined).length,
    storageSlots: artifact.accounts.reduce((total, account) => total + account.storage.length, 0),
  };
}
```

`src/coverage.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { StateEntryCounts } from "@jinn-network/chain-environment-record";
import type {
  FixtureMutationDeclaration,
  SourceProofManifest,
} from "@jinn-network/chain-environment-verification";
import { canonicalJsonBytes, compareCodeUnitStrings, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";

import { stateArtifactEntryCounts, type StateArtifact } from "./artifact.js";
import type { BudgetedArchivePort } from "./budget.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import { normalizeAddress, normalizeHex32, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";
import type { ArchiveAccountProof } from "./ports.js";
import { verifyAccountProof } from "./proof.js";

export const PROOF_BUNDLE_FORMAT = Object.freeze({ id: "jinn.chain-source-proofs", version: "1" });
export const FIXTURE_COVERAGE_FORMAT = Object.freeze({ id: "jinn.chain-fixture-coverage", version: "1" });

export interface ProofBundle {
  readonly format: typeof PROOF_BUNDLE_FORMAT;
  readonly proofFormat: "eip-1186";
  readonly anchor: {
    readonly blockNumber: number;
    readonly blockHash: Hex32;
    readonly stateRoot: Hex32;
  };
  readonly accounts: readonly ArchiveAccountProof[];
}

export interface FixtureCoverageDocument {
  readonly format: typeof FIXTURE_COVERAGE_FORMAT;
  readonly declarations: readonly FixtureMutationDeclaration[];
}

/**
 * Fetches EIP-1186 proofs for the addresses the author claims come from the source chain
 * and **verifies each one offline** before it is allowed into the bundle. A proof that
 * does not walk to its claimed value under the declared root is `archive-root-mismatch`:
 * either the provider served a different world, or someone tampered with the slice --
 * and CE4 cannot tell which, so it refuses either way.
 */
export async function collectSourceProofs(
  archive: BudgetedArchivePort,
  artifact: StateArtifact,
  options: { readonly addresses: readonly HexAddress[]; readonly stateRoot: string },
): Promise<StageOutcome<ProofBundle>> {
  const root = normalizeHex32(options.stateRoot);
  const accounts: ArchiveAccountProof[] = [];

  for (const raw of [...new Set(options.addresses)].sort(compareCodeUnitStrings)) {
    const address = normalizeAddress(raw);
    const entry = artifact.accounts.find((account) => account.address === address);
    if (entry === undefined) {
      return stageFail("coverage-incomplete", `Proof requested for ${address}, which the artifact does not carry.`);
    }
    let proof: ArchiveAccountProof;
    try {
      proof = await archive.getProof(address, entry.storage.map((slot) => slot.slot), artifact.anchor.blockNumber);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/Archive budget exhausted/u.test(message)) return stageFail("archive-budget-exhausted", message);
      if (/method .*not (?:supported|found)|unsupported method|eth_getProof/iu.test(message)) {
        return stageFail("archive-proof-unsupported", message);
      }
      return stageFail("archive-unreachable", message);
    }

    const verdict = verifyAccountProof(proof, root);
    if (!verdict.account) {
      return stageFail("archive-root-mismatch", `The account proof for ${address} does not verify against ${root}.`);
    }
    for (const slot of entry.storage) {
      if (verdict.storage[slot.slot] !== true) {
        return stageFail(
          "archive-root-mismatch",
          `The storage proof for ${address}/${slot.slot} does not verify against ${root}.`,
        );
      }
    }
    accounts.push({
      ...proof,
      address,
      storageProof: [...proof.storageProof]
        .map((slot) => ({ ...slot, key: normalizeSlot(slot.key) }))
        .sort((left, right) => compareCodeUnitStrings(left.key, right.key)),
    });
  }

  return stageOk({
    format: PROOF_BUNDLE_FORMAT,
    proofFormat: "eip-1186",
    anchor: {
      blockNumber: artifact.anchor.blockNumber,
      blockHash: artifact.anchor.blockHash,
      stateRoot: root,
    },
    accounts: accounts.sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
  });
}

export interface CoverageArtifacts {
  readonly bundleBytes: Uint8Array;
  readonly bundleDigest: Sha256Digest;
  readonly fixtureBytes: Uint8Array;
  readonly fixtureDigest: Sha256Digest;
  /** CE3's manifest, built from the verified bundle: `verified` is set from the actual
   * walk, never from "we asked for it". */
  readonly manifest: SourceProofManifest;
  readonly declarations: readonly FixtureMutationDeclaration[];
  /** Handed straight to `assessArtifactCoverage`. */
  /** Shaped for `CoverageAssessmentInput.entries`, in the same vocabulary. */
  readonly entries: {
    readonly accounts: readonly string[];
    readonly codeEntries: readonly string[];
    readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
  };
  readonly proofCoverage: StateEntryCounts;
  readonly fixtureDeclared: StateEntryCounts;
  readonly mutatedProofCoveredAccounts: number;
  readonly mutatesSourceProtocolState: boolean;
}

export interface CoverageInput {
  readonly artifact: StateArtifact;
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  readonly bundle: ProofBundle;
  readonly declarations: readonly FixtureMutationDeclaration[];
}

/**
 * Classifies every artifact entry **exactly once** -- fixture declarations win over proofs,
 * and the overlap is counted in `mutatedProofCoveredAccounts` -- because CE1's census is
 * exact equality, so a double-counted entry fails to seal just as loudly as a missing one.
 */
export function buildCoverageArtifacts(input: CoverageInput): StageOutcome<CoverageArtifacts> {
  const proven = new Map(input.bundle.accounts.map((proof) => [proof.address, proof]));
  const declaredAccounts = new Set<string>();
  const declaredCode = new Set<string>();
  const declaredStorage = new Set<string>();
  for (const declaration of input.declarations) {
    const address = normalizeAddress(declaration.address);
    if (declaration.kind === "account") declaredAccounts.add(address);
    else if (declaration.kind === "code") declaredCode.add(address);
    else if (declaration.slot !== undefined) declaredStorage.add(`${address}/${normalizeSlot(declaration.slot)}`);
    else return stageFail("coverage-incomplete", `A storage declaration for ${address} names no slot.`);
  }

  const entries = {
    accounts: input.artifact.accounts.map((account) => account.address),
    codeEntries: input.artifact.accounts
      .filter((account) => account.code !== undefined).map((account) => account.address),
    storageSlots: input.artifact.accounts.flatMap((account) =>
      account.storage.map((slot) => ({ address: account.address, slot: slot.slot }))),
  };

  const proofCoverage = { accounts: 0, codeEntries: 0, storageSlots: 0 };
  const fixtureDeclared = { accounts: 0, codeEntries: 0, storageSlots: 0 };
  const uncovered: string[] = [];
  const mutatedProofCovered = new Set<string>();

  const classify = (
    key: keyof StateEntryCounts,
    address: string,
    declared: boolean,
    provenHere: boolean,
    label: string,
  ): void => {
    if (declared) {
      fixtureDeclared[key] += 1;
      if (provenHere) mutatedProofCovered.add(address);
      return;
    }
    if (provenHere) {
      proofCoverage[key] += 1;
      return;
    }
    uncovered.push(label);
  };

  for (const account of input.artifact.accounts) {
    const proof = proven.get(account.address);
    classify("accounts", account.address, declaredAccounts.has(account.address), proof !== undefined, account.address);
    if (account.code !== undefined) {
      classify("codeEntries", account.address, declaredCode.has(account.address), proof !== undefined,
        `${account.address}#code`);
    }
    for (const slot of account.storage) {
      classify("storageSlots", account.address, declaredStorage.has(`${account.address}/${slot.slot}`),
        proof !== undefined, `${account.address}/${slot.slot}`);
    }
  }

  if (uncovered.length > 0) {
    return stageFail(
      "coverage-incomplete",
      `${uncovered.length} artifact entr${uncovered.length === 1 ? "y is" : "ies are"} neither proof-covered `
      + `nor fixture-declared: ${uncovered.slice(0, 10).join(", ")}${uncovered.length > 10 ? ", ..." : ""}.`,
    );
  }

  // Member names are CE1's `StateEntryCounts` vocabulary end to end -- `accounts` /
  // `codeEntries` / `storageSlots` -- so the manifest, the assessment input, the census,
  // and the report's entry index all read the same way and nothing needs a translation
  // table between them.
  const manifest: SourceProofManifest = {
    anchorStateRoot: input.bundle.anchor.stateRoot,
    accounts: input.bundle.accounts.map((proof) => ({ address: proof.address, verified: true })),
    codeEntries: input.bundle.accounts
      .filter((proof) => input.artifact.accounts.find((account) =>
        account.address === proof.address)?.code !== undefined)
      .map((proof) => ({ address: proof.address, codeHash: proof.codeHash, verified: true })),
    storageSlots: input.bundle.accounts.flatMap((proof) =>
      proof.storageProof.map((slot) => ({ address: proof.address, slot: slot.key, verified: true }))),
  };

  const declarations = [...input.declarations]
    .map((declaration) => ({
      ...declaration,
      address: normalizeAddress(declaration.address),
      ...(declaration.slot === undefined ? {} : { slot: normalizeSlot(declaration.slot) }),
    }))
    .sort((left, right) => compareCodeUnitStrings(
      `${left.address}/${left.kind}/${left.slot ?? ""}`,
      `${right.address}/${right.kind}/${right.slot ?? ""}`,
    ));

  const bundleBytes = canonicalJsonBytes(input.bundle);
  const fixtureBytes = canonicalJsonBytes({ format: FIXTURE_COVERAGE_FORMAT, declarations });

  return stageOk({
    bundleBytes,
    bundleDigest: recordDigest(bundleBytes),
    fixtureBytes,
    fixtureDigest: recordDigest(fixtureBytes),
    manifest,
    declarations,
    entries,
    proofCoverage,
    fixtureDeclared,
    mutatedProofCoveredAccounts: mutatedProofCovered.size,
    mutatesSourceProtocolState: mutatedProofCovered.size > 0,
  });
}
```

Note what is deliberately absent: this module never decides
`source-coverage-incomplete` *for the record* — CE3's `assessArtifactCoverage` does, and the
second test asserts the two agree. CE4 fails first only so that no artifact it cannot
classify is ever sealed; the authority stays in one place.

For `fidelityClass: "local"` the bundle is empty, every entry must be fixture-declared, and
`mutatesSourceProtocolState` is false — pinned by a sixth test.

- [ ] **Step 3: Generate the coverage fixtures and run everything**

Extend `scripts/generate-fixtures.mjs` to emit `fixtures/coverage-v1/{proof-bundle,fixture-coverage}.json`
plus their `.sha256` siblings, and `fixtures/adversarial-v1/uncovered-entry.json` (an
artifact with one account neither proven nor declared, asserted to fail).

Run: `corepack yarn@4.13.0 vitest run src/coverage.test.ts && corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 check:fixtures`
Expected: 6 tests pass; zero type errors; no fixture drift.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): the E13 coverage stage and its two pinned artifact formats"
```

---

### Task 9: The connected baseline, through CE3's archive path

Design §7's first two steps. CE3 pinned `observeArchiveEnvironment(deps, record, options?)`
as the archive-dependent protocol, returning the same `SealedAttestation` shape with
`outcome: "archive-observed"` and **full canonical observations per run**. So CE4 does not
drive the runtime itself for the baseline: it hands CE3 the author's archive-dependent draft
record and reads the observation back. One protocol implementation, one observation
canonicalization, one place where K-run mechanics live.

**Files:**
- Create: `src/baseline.ts`, `src/baseline.test.ts`
- Modify: `src/ports.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `observeArchiveEnvironment`, `SealedAttestation`, `chainObservationDigest`,
  `ChainVerificationError` from CE3; `ChainEnvironmentRecord` from CE1; T4, T6.
- Produces: `ExtractionRequest`, `ChainEnvironmentRecordDraft`, `ConnectedBaseline`,
  `establishBaseline(deps, request, archive, anchor)`.

- [ ] **Step 1: Define the request and the draft**

```ts
/**
 * What the author supplies. The draft is a complete, valid **archive-dependent** record --
 * CE1's `fixtures/chain/archive-dependent.json` is exactly this shape, and its E13 rules
 * are vacuous while `stateArtifact` is absent, which is why the pipeline can start here.
 * CE4 rewrites exactly two blocks on the way to `closed-state`.
 */
export type ChainEnvironmentRecordDraft = ChainEnvironmentRecord;

export interface ExtractionRequest {
  readonly draft: ChainEnvironmentRecordDraft;
  readonly anchorBlockNumber: number;
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  /** Addresses whose artifact entries the author claims come from the source chain. */
  readonly sourceAddresses: readonly string[];
  /** CE3's declaration shape, verbatim: `{address, kind, slot?}`. */
  readonly fixtureDeclarations: readonly FixtureMutationDeclaration[];
  /** Declared and then checked against what the archive reports (design §4.3). */
  readonly finalityPolicy: "finalized" | "safe" | "latest" | `confirmations:${number}`;
  readonly headerProof?: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly budget?: Partial<ArchiveBudgetLimits>;
  readonly maxWidenings?: number;
}

export interface ConnectedBaseline {
  /** The digest every blackholed run must reproduce, computed with CE3's own function. */
  readonly observationDigest: Sha256Digest;
  readonly observation: CanonicalChainObservation;
  readonly runObservationDigests: readonly Sha256Digest[];
  /** Every state key the connected runs read through the injected archive port. */
  readonly touched: StateKeySet;
  /** CE3's archive-observation attestation, carried verbatim. */
  readonly attestation: SealedAttestation;
}
```

- [ ] **Step 2: Write the failing test**

Four cases, driven by the kit's fakes (T14): the baseline agrees with itself and returns two
identical run digests; the journal is non-empty and contains the pool account and its slots;
an outcome other than `archive-observed` becomes the matching typed failure
(`provider-disagreement` for CE3's `provider-disagreement`, `baseline-unstable` for
`probe-divergence`); a budget refusal surfaces as `archive-budget-exhausted` rather than a
crash.

- [ ] **Step 3: Implement `src/baseline.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  ChainVerificationError,
  chainObservationDigest,
  observeArchiveEnvironment,
  type CanonicalChainObservation,
  type SealedAttestation,
} from "@jinn-network/chain-environment-verification";
import type { Sha256Digest } from "@jinn-network/trust-core";

import type { AnchorCapture } from "./anchor.js";
import type { BudgetedArchivePort } from "./budget.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import { BASELINE_RUN_COUNT } from "./identifiers.js";
import type { StateKeySet } from "./key-set.js";
import type { ExtractionDeps } from "./ports.js";

/**
 * Runs the author's archive-dependent draft through CE3's archive-observation protocol,
 * with the fork's state backend bound to CE4's injected, budgeted, journaling port
 * (see `ExtractionDeps.forkBackend` and Finding F-CE4-1). The observation it returns is
 * the reference the whole widen loop converges to; the journal it leaves behind is the
 * harvest ground truth.
 */
export async function establishBaseline(
  deps: ExtractionDeps,
  request: ExtractionRequest,
  archive: BudgetedArchivePort,
  anchor: AnchorCapture,
): Promise<StageOutcome<ConnectedBaseline>> {
  const record = withAnchoredDraft(request, anchor, deps.forkBackend);

  let attestation: SealedAttestation;
  try {
    attestation = await observeArchiveEnvironment(
      {
        runtime: deps.runtime,
        artifactStore: deps.artifactStore,
        signer: deps.signer,
        clock: deps.clock,
        verifier: deps.verifier,
      },
      record,
      { runCount: BASELINE_RUN_COUNT },
    );
  } catch (cause) {
    if (cause instanceof ChainVerificationError) {
      return stageFail("runtime-failure", `The archive-observation protocol refused the draft: ${cause.message}`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Archive budget exhausted/u.test(message)) return stageFail("archive-budget-exhausted", message);
    return stageFail("runtime-failure", message);
  }

  if (attestation.outcome !== "archive-observed") {
    // CE3's vocabulary maps onto CE4's without inventing a third: a provider that
    // disagreed is a provider-disagreement; runs that disagreed are an unstable baseline;
    // anything else is the host's problem, not the slice's.
    const reason = attestation.outcome === "provider-disagreement"
      ? "archive-self-disagreement"
      : attestation.outcome === "probe-divergence" || attestation.outcome === "reset-divergence"
        ? "baseline-unstable"
        : attestation.outcome === "artifact-unavailable"
          ? "artifact-store-failure"
          : "runtime-failure";
    return stageFail(
      reason,
      `The connected baseline came back "${attestation.outcome}". A world that is not `
      + "repeat-stable while connected cannot be closed by widening its slice.",
    );
  }

  const observations = attestation.observations;
  const first = observations[0];
  if (first === undefined) return stageFail("runtime-failure", "The baseline produced no observation.");
  const digests = observations.map((observation) => chainObservationDigest(observation));
  const divergent = digests.findIndex((digest) => digest !== digests[0]);
  if (divergent > 0) {
    return stageFail(
      "baseline-unstable",
      `The connected world disagreed with itself: run 1 observed ${digests[0]}, `
      + `run ${divergent + 1} observed ${digests[divergent]}.`,
    );
  }

  return stageOk({
    observationDigest: digests[0]!,
    observation: first,
    runObservationDigests: digests,
    touched: archive.journal(),
    attestation,
  });
}
```

`withAnchoredDraft` (same file) fills the draft's `sourceAnchor` from the capture and sets
`stateMaterialization.closureClass = "archive-dependent"`, so
`requiresStateBackend(record)` — CE1's shared predicate, which CE4 calls rather than
re-deriving — is true and the backend is mandatory. The binding follows `deps.forkBackend`:
for `{kind: "injected-port"}` (the shape CE1 landed) the materialize request carries
`stateBackend: asChainStateBackend(archive)`; for `{kind: "locator", locator}` the record
carries `archive = {requiredCapabilities: ["archive-state"], providerLocators: [locator]}`
pointing at a **runner-local** endpoint the host serves from the same injected port. Either
way every fetch is journaled and budgeted, and no module in this package dials anything.
CE4 also assigns `instanceId` and `networkPolicy` on every materialize request it makes
directly (localization), because CE1 made both the caller's to assign — a runtime that named
its own instances would be vouching for its own freshness.

- [ ] **Step 4: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/baseline.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 4 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): the connected baseline via CE3's archive-observation path"
```

---

### Task 10: Harvest — the journal is the closure set, the dump is never trusted

Design §10's caveat, taken to its conclusion. A forked instance fetches state lazily
**through the backend**, so the set of keys the injected port was asked for *is* exactly the
set the sealed world must carry: anything execution read came through the port, and anything
it did not read the sealed world does not need. A state dump is therefore not an input this
pipeline depends on — which is the only posture consistent with a dump format that has a
real bug history.

When the host supplies the optional dump port, its output is used **only** as a cross-check,
and both directions are reported: keys the journal saw and the dump missed
(`dumpOmissions` — the §10 bug) and keys the dump carried that nothing read
(`dumpOnlyEntries` — harmless, but evidence about the runtime).

**Files:**
- Create: `src/harvest.ts`, `src/harvest.test.ts`
- Modify: `src/ports.ts` (the optional `StateDumpPort`), `src/index.ts`

**Interfaces:**
- Consumes: T3 key sets, T5 artifact, T4 budgeted port.
- Produces: `StateDumpPort`, `ChainStateDump`, `HarvestResult`,
  `harvestTouchedState(archive, options)`.

```ts
/**
 * Optional. CE1 and CE3 disagree about the instance handle's shape and neither pins a
 * dump method (F-CE4-2), and this pipeline does not need one: the journal is the closure
 * set. A host that can dump supplies this port and gets a cross-check; a host that cannot
 * loses nothing but the cross-check.
 */
export interface ChainStateDump {
  readonly accounts: Readonly<Record<string, {
    readonly balance: string;
    readonly nonce: string;
    readonly code?: string;
    readonly storage?: Readonly<Record<string, string>>;
  }>>;
}

export interface StateDumpPort {
  dump(instanceId: string, signal?: AbortSignal): Promise<ChainStateDump>;
}
```

- [ ] **Step 1: Write the failing test**

Four cases: the artifact is built from the journal alone and carries exactly the journaled
keys; a dump that omits a journaled key changes **nothing** about the artifact and is
reported in `dumpOmissions`; a dump carrying an unread account is reported in
`dumpOnlyEntries` and is **not** admitted to the artifact (an artifact entry nothing reads
would need coverage it cannot get); an empty journal is `harvest-empty`.

- [ ] **Step 2: Implement `src/harvest.ts`**

`harvestTouchedState(archive, {journal, anchor, dump?})`:

1. Fail `harvest-empty` when the journal is empty — a probe suite that reads nothing yields
   a vacuous world, and no amount of widening fixes it.
2. For every journaled account: `getAccount` at the anchor; `getCode` when the code key was
   journaled; `getStorageAt` for each journaled slot. Values come from the **archive at the
   anchor**, which is the pre-fixture source state the record's fixtures are then applied
   on top of (design §5.1 step 5) — so the artifact is a source-state slice, not a
   post-fixture snapshot.
3. Assemble through `mergeIntoStateArtifact`, whose refusal to change a committed value is
   what turns an archive that answers differently on the second read into
   `archive-self-disagreement` instead of a silent overwrite.
4. When `dump` is present, compute `dumpOmissions = journal − dumpKeys` and
   `dumpOnlyEntries = dumpKeys − journal`, report both, and change nothing.
5. Budget refusals become `archive-budget-exhausted`; anything else from the port becomes
   `archive-unreachable`.

The returned `HarvestResult` is `{artifact, entryCounts, dumpOmissions, dumpOnlyEntries}`.

- [ ] **Step 3: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/harvest.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 4 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): journal-authoritative harvest with dump cross-check"
```

---

### Task 11: The candidate, and `extractEnvironment`

The pinned entry point (program §3). It rewrites exactly two blocks of the author's draft,
satisfies CE1's census and closed-state preconditions, and returns a **candidate**.

**Files:**
- Create: `src/candidate.ts`, `src/candidate.test.ts`, `src/extract.ts`, `src/extract.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `sealChainEnvironmentRecord`, `parseChainEnvironmentRecord`,
  `chainEnvironmentRecordDigest`, `bareHexDigest`, `BLACKHOLE_EGRESS_POLICY_ID`,
  `anchorAuthenticityBoundOf` from CE1; T6–T10.
- Produces: `ChainEnvironmentCandidate`, `assertClosedStatePreconditions`,
  `computeSealedInitialCommitment`, `assembleCandidate`, `ExtractionResult`,
  `extractEnvironment(deps, request): Promise<ExtractionResult>`.

- [ ] **Step 1: Precondition check, before any archive call**

```ts
/**
 * CE1 rejects these at seal time; CE4 rejects them before spending money. Each one is a
 * property of the author's draft that no amount of extraction can fix.
 */
export function assertClosedStatePreconditions(
  draft: ChainEnvironmentRecord,
): StageOutcome<void> {
  const problems: string[] = [];
  if (draft.capabilityEnvelope.egressPolicyId !== BLACKHOLE_EGRESS_POLICY_ID) {
    problems.push(`capabilityEnvelope.egressPolicyId must be ${BLACKHOLE_EGRESS_POLICY_ID}`);
  }
  if (draft.verificationContract.closureCheckRequired !== true) {
    problems.push("verificationContract.closureCheckRequired must be true");
  }
  if (draft.determinismControls.resetMechanism !== "fresh-process") {
    problems.push('determinismControls.resetMechanism must be "fresh-process"');
  }
  return problems.length === 0
    ? stageOk(undefined)
    : stageFail("verification-refused",
      `The draft cannot become a closed-state record: ${problems.join("; ")}.`);
}
```

- [ ] **Step 2: The sealed initial-state commitment, and its provisional record**

CE1 rejects a record whose `initialStateCommitment` equals `sourceAnchor.stateRoot`, and
design §4.3 defines the value as the **post-fixture, agent-visible** commitment — a property
of the *sealed* world, not of the connected fork whose post-fixture state is a
lazily-populated overlay. `ChainMaterializer.materialize` takes a record, so the value is
read from a materialization of a **provisional** record: identical to the final one except
for a sentinel commitment, never sealed, never stored, never returned.

CE1 settled where the value lives (CR3): `instance.report.postFixtureCommitment`, typed
`` `0x${string}` `` — the same spelling the record uses, so it is compared and written
without conversion. Type the materialization against `VerifiedChainInstance` and `report`
is non-optional with no narrowing here.

```ts
/** Never sealed. A test asserts it appears in no sealed record this package produces. */
export const PROVISIONAL_COMMITMENT = `0x${"f".repeat(64)}` as const;

export async function computeSealedInitialCommitment(
  deps: Pick<ExtractionDeps, "runtime">,
  provisional: ChainEnvironmentRecord,
  resources: ResolvedResources,
  artifact: StateArtifact,
): Promise<StageOutcome<`0x${string}`>> {
  // A sealed world takes NO state backend -- `requiresStateBackend(provisional)` is false
  // for a closed-state record, and passing one anyway would be the confusion the whole
  // design forbids. The kit's fake asserts it never arrives.
  // No cast: CE3's `createAnvilMaterializer` returns a `VerifiedChainMaterializer`, whose
  // `materialize` is typed `Promise<VerifiedChainInstance>`, so `report` is non-optional
  // here. A materializer that returns no report is CE3's `materialization-report-absent`
  // -> `verification-infrastructure-failure`, which the widen loop already maps to
  // `runtime-failure`; there is no undefined-report branch for CE4 to invent.
  const instance = await deps.runtime.materializer.materialize({
    record: provisional,
    resources,                                    // CE1's `ResolvedResources`: `{ byDigest }`
    instanceId: "chain-extraction/initial-commitment",
    networkPolicy: DEFAULT_BLACKHOLE_POLICY,
  });
  try {
    // Free cross-check, now that CE1 renamed the report's buckets to match
    // `StateEntryCounts` member-for-member: what the instance says it loaded must equal
    // what the artifact says it carries. A mismatch means the loader and the producer
    // disagree about the slice, and no census computed over the artifact would be true of
    // the world that actually booted.
    //
    // This rests on a contract, not on hope: CE1's `ArtifactEntryObservation` JSDoc makes
    // it normative that the block is read back from the materialized world and never
    // copied from the artifact the materializer was handed -- a report derived from its
    // own input cannot validate that input, which would make this check vacuous.
    const loaded = instance.report.artifactEntries;
    const declared = stateArtifactEntryCounts(artifact);
    for (const key of ["accounts", "codeEntries", "storageSlots"] as const) {
      if (loaded[key].length !== declared[key]) {
        return stageFail(
          "runtime-failure",
          `The materializer loaded ${loaded[key].length} ${key} from an artifact declaring ${declared[key]}.`,
        );
      }
    }
    return stageOk(instance.report.postFixtureCommitment);
  } finally {
    await instance.stop().catch(() => undefined);
  }
}
```

- [ ] **Step 3: Assemble**

`assembleCandidate` puts the three artifacts (state artifact, proof bundle, fixture-coverage
document) through `artifactStore.putArtifact`, refuses a store that returns a different
digest (`artifact-store-failure`), and writes:

```ts
sourceAnchor: {
  caip2ChainId: request.draft.sourceAnchor?.caip2ChainId ?? request.caip2ChainId,
  nativeChainId, genesisHash,
  blockNumber: anchor.blockNumber,
  blockHash: anchor.blockHash,
  stateRoot: anchor.stateRoot,
  timestamp: anchor.timestamp,
  finalityPolicy: request.finalityPolicy,
  ...(request.headerProof === undefined ? {} : { headerProof: request.headerProof }),
},
stateMaterialization: {
  closureClass: "closed-state",
  fidelityClass: request.fidelityClass,
  constructionMethod: "archive-extraction",
  materializer: request.draft.stateMaterialization.materializer,
  stateArtifact: {
    descriptor: { name: "state-artifact", digest: { sha256: bareHexDigest(artifactDigest) }, size },
    format: STATE_ARTIFACT_FORMAT,
    entryCounts,
  },
  sourceProofManifest: {
    proofFormat: "eip-1186",
    proofs: { name: "source-proofs", digest: { sha256: bareHexDigest(coverage.bundleDigest) }, size },
    coverage: coverage.proofCoverage,
  },
  fixtureCoverage: {
    manifest: { name: "fixture-coverage", digest: { sha256: bareHexDigest(coverage.fixtureDigest) }, size },
    declared: coverage.fixtureDeclared,
    mutatedProofCoveredAccounts: coverage.mutatedProofCoveredAccounts,
  },
  mutatesSourceProtocolState: coverage.mutatesSourceProtocolState,
  initialStateCommitment,
  // `archive` is deliberately absent: CE1 rejects a closed-state record that carries it.
},
```

then seals through CE1 and re-parses the sealed bytes. Four tests: the census balances and
the record seals; the artifact descriptors are bare-hex and the stored bytes match; the
sentinel never appears in a sealed record; `anchorAuthenticityBoundOf(record.sourceAnchor)`
is `"declared"` without a header proof and `"header-proven"` with one — E5 read from CE1's
own function rather than re-derived.

- [ ] **Step 4: `extractEnvironment`**

Stage order, each returning `ExtractionResult` on failure with `archiveUsage` attached:
bound check (`widen-bound-above-ceiling`, zero archive calls) → closed-state preconditions →
`captureAnchor` → finality-policy check (a draft declaring `"finalized"` for an anchor above
the finalized head is `verification-refused`; the observation is recorded either way) →
`establishBaseline` → `harvestTouchedState` → `collectSourceProofs` (skipped for `local`) →
`buildCoverageArtifacts` → `confirmAnchorUnchanged` → `computeSealedInitialCommitment` →
`assembleCandidate`. The result carries `{status: "candidate", candidate, archiveUsage,
dumpOmissions, dumpOnlyEntries, maxWidenings}`.

Five tests: a candidate whose artifact covers the journal; nothing in the returned value
matches `/closed-reproducible|"verified"/`; a bound above the ceiling refused with zero
archive calls; `archive-anchor-pruned` surfaced with disposition `archive-unavailable`; an
anchor that drifts under the extraction surfaced as `provider-disagreement`.

- [ ] **Step 5: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/candidate.test.ts src/extract.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 9 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): assemble the candidate and ship extractEnvironment"
```

---

### Task 12: `widenAndReverify` — the bounded convergence loop

The component. Design §7: *closed-state verification loop (blackholed K-runs; observation
divergence vs the connected baseline reveals missing state → widen slice → re-extract)*.

**Files:**
- Create: `src/layered-backend.ts`, `src/layered-backend.test.ts`, `src/widen.ts`,
  `src/widen.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `verifyChainEnvironment`, `SealedAttestation`, `ChainVerificationOutcome`,
  `chainObservationDigest`, `chainObservationsEqual`, `assessArtifactCoverage`,
  `assessClosure`, `CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE` from CE3; T8–T11.
- Produces: `LayeredStateBackend`, `createLayeredStateBackend`, `WideningRound`,
  `ConvergenceResult`, `WidenOptions`, `localizeMissingState`,
  `widenAndReverify(deps, {candidate, request}, options?)`.

**The classification, stated before the code, because it is the whole design:**

| CE3's `attestation.outcome` | What it means here | What the loop does |
| --- | --- | --- |
| `closed-reproducible`, observation **=** baseline | The sealed world reproduces the connected one | **converged** |
| `closed-reproducible`, observation **≠** baseline | K runs agreed with each other and disagreed with the baseline — the signature of missing state, because out-of-slice reads are *empty deterministically* (design §4.2) | localize → widen → re-verify |
| `initial-state-mismatch` | The sealed post-fixture commitment differs — the same signature, one step earlier | localize → widen → re-verify |
| `probe-divergence` / `reset-divergence` | The blackholed runs disagreed with **each other**. Missing state cannot cause this: empty is empty on every run | terminate `divergence-unexplained` |
| divergence with an **empty** localized miss set | Nothing to widen with | terminate `divergence-unexplained` |
| bound reached | Legal, bounded, reported with what each round added | terminate `widen-bound-exhausted` |
| `source-coverage-incomplete` | CE4 sealed an artifact it could not classify — a CE4 bug, surfaced | terminate `coverage-incomplete` |
| `artifact-unavailable` / `verification-infrastructure-failure` | The host broke | terminate `artifact-store-failure` / `runtime-failure` |
| any other of CE3's 14 | Widening cannot address it; the record must change | terminate `verification-refused` |

- [ ] **Step 1: The layered backend**

Unchanged in purpose from the localization instrument: artifact first, archive on miss,
every miss journaled; the miss set *is* the widening delta. Three tests: a committed account
and slot cost zero archive calls; an uncommitted account is journaled and falls through; a
slot the artifact does not carry is a miss **even when its account is committed** — a
backend that answered zero there would hide the exact gap the loop exists to find, because
an unset slot and an uncommitted slot are indistinguishable to the EVM and must not be to
us. (Implementation as written in the previous revision of this plan: `misses()`,
artifact-first `getAccount` / `getCode` / `getStorageAt`, pass-through `getBlockHeader` /
`getProof`.)

- [ ] **Step 2: `localizeMissingState`**

Runs the author's probe suite and reference scripts **connected**, through a fork whose
backend is the layered one, and returns
`differenceKeySets(backend.misses(), stateArtifactKeySet(candidate.artifact))`. It reuses
the same `deps.forkBackend` binding as the baseline (T9 step 3), so localization spends
against the same budget and journals through the same port.

- [ ] **Step 3: The loop**

```ts
export interface WideningRound {
  readonly index: number;
  readonly recordDigest: Sha256Digest;
  readonly outcome: ChainVerificationOutcome;
  readonly blackholedObservationDigest?: Sha256Digest;
  readonly matchedBaseline: boolean;
  readonly widenedBy?: StateKeySet;
  readonly archiveCalls: number;
}

export type ConvergenceResult =
  | {
    readonly status: "converged";
    readonly candidate: ChainEnvironmentCandidate;
    /** CE3's sealed attestation, verbatim. The only closed-state claim in this value,
     * and it is not this package's to make. */
    readonly attestation: SealedAttestation;
    readonly rounds: readonly WideningRound[];
    readonly archiveUsage: ArchiveUsage;
  }
  | {
    readonly status: "failed";
    readonly reason: ExtractionFailureReason;
    readonly disposition: ExtractionFailureDisposition;
    readonly stage: ExtractionStage;
    readonly detail: string;
    readonly rounds: readonly WideningRound[];
    readonly archiveUsage: ArchiveUsage;
    readonly attestation?: SealedAttestation;
  };

export async function widenAndReverify(
  deps: ExtractionDeps,
  input: { readonly candidate: ChainEnvironmentCandidate; readonly request: ExtractionRequest },
  options: WidenOptions = {},
): Promise<ConvergenceResult>;
```

Body, per round `index` from 0 to `maxWidenings` inclusive:

1. **Cheap pre-check before paying for K runs.** Call CE3's `assessArtifactCoverage` on the
   candidate's own entries and manifest; a `complete: false` here means CE4 would be asking
   CE3 to run five instantiations only to be told what a pure function already knows, so
   terminate `coverage-incomplete` immediately. CE3 offered this seam precisely for the
   widen loop; using it is the difference between a bounded cost and a wasteful one.
2. `verifyChainEnvironment(ce3Deps, candidate.record, {runCount: options.runCount ?? MINIMUM_RUN_COUNT})`.
   A thrown `ChainVerificationError` is caller error or a port breach — `runtime-failure`;
   every *environment* fact arrives as `attestation.outcome`.
3. Assert `attestation.statement.predicateType === CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
   (a host that wired the wrong verifier must not be mistaken for a converged world).
4. `matched = attestation.outcome === "closed-reproducible" &&
   chainObservationsEqual(attestation.observations[0]!, candidate.baseline.observation)` →
   **converged**, carrying CE3's attestation.
5. Not widenable → push the round and terminate with the table's mapping.
6. `index === maxWidenings` → `widen-bound-exhausted`, reporting how many keys each round
   added.
7. `localizeMissingState`; empty → `divergence-unexplained` with the detail that names the
   real suspects (determinism controls, runtime identity), because *nothing was missing*.
8. Widen: `harvestTouchedState(archive, {journal: missing, anchor, dump: undefined})` merged
   into the artifact; widening additions came from the archive at the anchor, so they are
   source state and must be proof-covered unless a fixture declaration names them —
   `collectSourceProofs` over the new address set, then `buildCoverageArtifacts`, then
   `computeSealedInitialCommitment` (the artifact changed, so the commitment changed), then
   `assembleCandidate`. Each round therefore produces a **new sealed record**; only the
   converged one is ever meant to be announced, and intermediate candidates are never
   published.

Six tests, matching the classification table: converges on the first pass; converges after
two widenings (three rounds, the first two with non-empty `widenedBy`, and a different
record digest at the end); terminates at the bound with archive usage strictly under the
ceiling; `probe-divergence` terminates `divergence-unexplained` **without spending a single
archive call**; divergence with no out-of-slice read terminates with the "no out-of-slice
read" detail; and the converged value carries CE3's attestation while containing no
`closed-reproducible` string of its own.

- [ ] **Step 4: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/layered-backend.test.ts src/widen.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 3 + 6 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): the bounded widen-and-re-verify convergence loop"
```

---

### Task 13: The staged, crash-safe pipeline state

An extraction spends real archive budget. A crash between the baseline and the widen loop
must resume without re-spending it, and a job that failed must not be silently retried into
a second bill. The state file is what makes both true. It is a **fresh rewrite** over this
package's vocabulary; the legacy SWE-rebench harvest state machine in the operator tree was
read for its four-way disposition idea and is never imported (contract 12).

**Files:**
- Create: `src/extraction-state.ts`, `src/extraction-state.test.ts`,
  `src/extraction-state-store.ts`, `src/extraction-state-store.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `recordDigest`, `isCalendarStrictRfc3339`,
  `compareCodeUnitStrings` from trust-core; T2's taxonomy; T4's `ArchiveUsage`.
- Produces: `EXTRACTION_JOB_DISPOSITIONS`, `ExtractionJob`, `ExtractionStateFile`,
  `extractionJobKey`, `createExtractionStateFile`, `upsertExtractionJobs`,
  `advanceExtractionJob`, `recordExtractionSpend`, `recordExtractionConverged`,
  `recordExtractionFailure`, `remainingBudget`, `dueExtractionJobs`,
  `serializeExtractionStateFile`, `parseExtractionStateFile`, `ExtractionStateStore`,
  `createFileExtractionStateStore`.

- [ ] **Step 1: Write the failing algebra test**

`src/extraction-state.test.ts` — six cases, each one a rule:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  advanceExtractionJob,
  createExtractionStateFile,
  dueExtractionJobs,
  extractionJobKey,
  parseExtractionStateFile,
  recordExtractionConverged,
  recordExtractionFailure,
  recordExtractionSpend,
  remainingBudget,
  serializeExtractionStateFile,
  upsertExtractionJobs,
} from "./extraction-state.js";
import { fakeExtractionRequest } from "./testing.js";

const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:05:00.000Z";
const KEY = extractionJobKey(fakeExtractionRequest());

describe("the extraction state file", () => {
  it("keys a job by the request identity, so a resume addresses the same job", () => {
    expect(extractionJobKey(fakeExtractionRequest())).toBe(KEY);
    expect(extractionJobKey({ ...fakeExtractionRequest(), anchorBlockNumber: 1 })).not.toBe(KEY);
  });

  it("is idempotent on upsert and resumable at its stage", () => {
    const created = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    const advanced = advanceExtractionJob(created, KEY, "harvest", T1);
    const again = upsertExtractionJobs(advanced, [KEY], T1);
    expect(again.jobs[KEY]?.stage).toBe("harvest");
    expect(again.jobs[KEY]?.createdAt).toBe(T0);
  });

  it("carries spend across a crash, so a resume cannot re-spend the budget", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionSpend(file, KEY, { calls: 900, bytes: 4_000, limits: { maxCalls: 1_000, maxBytes: 10_000 } }, T1);
    const round = parseExtractionStateFile(serializeExtractionStateFile(file));
    expect(remainingBudget(round.jobs[KEY]!, { maxCalls: 1_000, maxBytes: 10_000 }))
      .toEqual({ maxCalls: 100, maxBytes: 6_000 });
  });

  it("retries infrastructure failures behind a fence, up to the attempt cap", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T0, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("retrying");
    expect(dueExtractionJobs(file, T0)).toEqual([]);
    expect(dueExtractionJobs(file, T1).map((job) => job.key)).toEqual([KEY]);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T1, 60_000);
    file = recordExtractionFailure(file, KEY, "runtime-failure", T1, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("infrastructure");
    expect(dueExtractionJobs(file, "2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("never retries a non-convergent, policy, archive, or disagreement failure", () => {
    let file = upsertExtractionJobs(createExtractionStateFile(T0), [KEY], T0);
    file = recordExtractionFailure(file, KEY, "widen-bound-exhausted", T0, 60_000);
    expect(file.jobs[KEY]?.disposition).toBe("non-convergent");
    expect(dueExtractionJobs(file, "2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("fails loud on a corrupt file rather than resetting it", () => {
    expect(() => parseExtractionStateFile(new TextEncoder().encode("{"))).toThrow(/UTF-8 JSON/u);
  });
});
```

- [ ] **Step 2: Run and watch it fail; then implement `src/extraction-state.ts`**

Model it exactly on `packages/environments/verification/src/staged-state.ts` (read it
first — same author-facing shape, different vocabulary), with these differences, each of
which is a decision this component needs:

1. `EXTRACTION_JOB_DISPOSITIONS` is `["pending", "retrying", "converged",
   ...EXTRACTION_FAILURE_DISPOSITIONS]`, so a stored job's disposition *is* the taxonomy
   value a caller branches on — no second mapping to drift.
2. Only `infrastructure` retries (`isRetryableExtractionFailure`), capped at
   `MAX_INFRASTRUCTURE_ATTEMPTS = 3`, fenced by `nextAttemptAt`.
3. `spentCalls` / `spentBytes` accumulate across attempts, and `remainingBudget(job,
   limits)` returns the *unspent* remainder — clamped at zero — which the caller passes as
   `request.budget` on resume. This is the rule that makes a crash-loop cost bounded rather
   than multiplied.
4. `extractionJobKey(request)` is `recordDigest(canonicalJsonBytes({...}))` over the
   request's identity fields — `caip2ChainId`, `nativeChainId`, `anchorBlockNumber`,
   `fidelity`, sorted `sourceAddresses`, the fixture declarations, and the digest of the
   draft — so two requests that would produce the same world share a job, and any change
   to what is being extracted starts a new one.
5. The job records `candidateRecordDigest`, `artifactDigest`, `attestationDigest`, and
   `widenings` as they become known, so a resumed run reports what the crashed one had
   already produced.

- [ ] **Step 3: Implement `src/extraction-state-store.ts`**

Copy the shape of `packages/environments/verification/src/staged-state-store.ts`:
`createFileExtractionStateStore(directory)` — `read()` returns `null` when the file is
absent, `write(file)` writes to `<file>.tmp` and renames. The directory is an **argument**;
this file is the package's only production filesystem surface besides the fixture loader,
and both are named in the guard carve-out (T1 step 5). Its test drives it against a real
temporary directory, asserts the atomic-rename path, and asserts a corrupt file throws
rather than silently resetting.

- [ ] **Step 4: Run, typecheck, commit**

Run: `corepack yarn@4.13.0 vitest run src/extraction-state.test.ts src/extraction-state-store.test.ts && corepack yarn@4.13.0 typecheck`
Expected: 6 + 3 tests pass; zero type errors.

```bash
git add packages/environments/chain-extraction
git commit -m "feat(chain-extraction): crash-safe staged pipeline state with budget carry"
```

---

### Task 14: The conformance kit — a fake archive, a fake chain runtime, five scenarios

Program §4 contract 12 and the family design's kit discipline: **the kit runs on fakes.**
No Anvil, no Docker, no network. The fake runtime is behaviorally faithful for the one
property under test: its observation is a function of the state its probes read, so missing
state changes the observation deterministically — exactly like the real thing, and exactly
what makes the loop's classification testable.

**Files:**
- Create: `src/testing.ts` (grown from T8's minimal version), `src/testing.test.ts`,
  `src/bounded-claims.test.ts`, `fixtures/artifacts-v1/converged.json`
- Modify: `README.md`, `src/index.ts`

**Interfaces:**
- Consumes: `createEoaTestSigner` from `@jinn-network/trust-testing` (devDependency, test
  files only); every T2–T13 export; CE3's `verifyChainEnvironment` (driven through the
  fakes).
- Produces: `buildFakeTrieWorld`, `createFakeArchive`, `FakeArchiveOptions`,
  `createFakeChainRuntime`, `FakeRuntimeOptions`, `createFakeStateDumpPort`,
  `createInMemoryArtifactStore`, `createFixedClock`, `createFakeExtractionDeps`,
  `fakeExtractionRequest`, `fakeStateArtifact`, `fakeBaseline`, the `FAKE_*` constants,
  and `describeChainExtractionConformance(options)`.

**`buildFakeTrieWorld` is the load-bearing fake** (used by T7 and T8): it builds a **real**
Merkle-Patricia trie over the fake accounts bottom-up with `keccak_256`, exposes
`stateRoot`, `proofFor(address, slots)`, `absenceProofFor(address)`, `archive()`, and a
`tamperSlot` option that returns a proof whose claimed value no longer matches the trie.
Construction (bottom-up) and verification (top-down walk) are independent code paths, which
is what keeps T7's tests from being circular.

- [ ] **Step 1: Fix the fake world's addresses (contract 8)**

```ts
// Synthetic addresses with no private key in existence: each is a fixed byte pattern,
// not a key derivation, so none of them can be funded by anyone who "recognizes" it.
// Design §8's bait hazard is about FUNDING a fixture address; these are not derived
// from any mnemonic, and this package generates no keys at all.
export const FAKE_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_ORACLE = "0xcccccccccccccccccccccccccccccccccccccccc";
export const FAKE_TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";
export const FAKE_ACTOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const FAKE_SLOT_1 = `0x${"0".repeat(63)}1`;
export const FAKE_SLOT_2 = `0x${"0".repeat(63)}2`;
export const FAKE_SEALED_COMMITMENT = `0x${"5".repeat(64)}`;
```

- [ ] **Step 2: Implement the fake archive**

```ts
export interface FakeArchiveOptions {
  /** The anchor cannot be served at all. */
  readonly anchorPruned?: boolean;
  /** After N calls, the archive starts answering the anchor header differently -- the
   * provider-disagreement scenario (design §5.2). */
  readonly anchorDriftsAfterCall?: number;
  /** `eth_getProof` is not offered. */
  readonly proofUnsupported?: boolean;
}

/** A tiny in-memory world: four accounts, code on two, a handful of slots. */
export function createFakeArchive(options: FakeArchiveOptions = {}): ArchiveRpcPort {
  const world = new Map<string, { balance: string; nonce: string; code?: string; storage: Map<string, string> }>([
    [FAKE_POOL, { balance: "0x0", nonce: "0x1", code: "0x60016002", storage: new Map([[FAKE_SLOT_1, `0x${"0".repeat(63)}7`], [FAKE_SLOT_2, `0x${"0".repeat(63)}3`]]) }],
    [FAKE_ORACLE, { balance: "0x0", nonce: "0x1", code: "0x60ff", storage: new Map([[FAKE_SLOT_1, `0x${"0".repeat(62)}2a`]]) }],
    [FAKE_TOKEN, { balance: "0x0", nonce: "0x1", code: "0x6042", storage: new Map([[FAKE_SLOT_1, `0x${"0".repeat(63)}5`]]) }],
    [FAKE_ACTOR, { balance: "0xde0b6b3a7640000", nonce: "0x0", storage: new Map() }],
  ]);
  let calls = 0;
  // ... getBlockHeader honors anchorPruned / anchorDriftsAfterCall; getAccount/getCode/
  // getStorageAt read `world` and return zeros for unknown keys; getProof returns a
  // structurally valid proof whose first node embeds the declared root, or throws
  // "the method eth_getProof does not exist" when `proofUnsupported`.
}
```

Write the elided bodies exactly as the T4, T6, T7 and T9 tests already require them —
those tests were written against this fake's behavior, so "done" is when they pass
unchanged.

- [ ] **Step 3: Implement the fake chain runtime**

```ts
export interface FakeRuntimeOptions {
  /** Baseline instability: run N observes something different (T9). */
  readonly observationDriftOnRun?: number;
  /**
   * The number of *additional* reads the sealed world performs that the connected
   * baseline's dump did not capture -- the design §10 dump-fidelity bug, and the reason
   * this package exists. Each widening exposes the next one.
   */
  readonly hiddenReads?: number;
  /** The blackholed runs disagree with each other: a determinism-control break, which
   * the loop must NOT try to widen (T12). */
  readonly blackholeUnstable?: boolean;
  /** The observation differs from the baseline while the run performs no out-of-slice
   * read: the unexplained-divergence case (T12). */
  readonly divergeWithoutReads?: boolean;
  /** The dump silently omits an entry the run demonstrably read (T9, and the kit's
   * fifth scenario). */
  readonly dumpOmits?: readonly string[];
}
```

The fake instance keeps a read log and computes its observation as
`{ reads: [...sorted key/value pairs] }` — so the observation is *by construction* a
function of the state that was read. Out-of-slice reads in a sealed instance return the
zero value, which is what makes a too-narrow slice **stably wrong**, matching the real
boundary rule (design §4.2). `dumpState()` returns the touched entries minus `dumpOmits`.

Two invariants the fake asserts about its callers, because they are contract violations
this package must never commit:

```ts
// 1. A sealed instance is handed NO backend. If one arrives, the caller has confused
//    verification with authoring, and that is the bug the design forbids most loudly.
if (request.stateSource.kind === "artifact" && "backend" in request.stateSource) {
  throw new Error("a sealed materialization must have no state backend");
}
// 2. The layered backend's `codeHash` is never consulted on the committed path.
```

- [ ] **Step 4: Assemble `describeChainExtractionConformance`**

The five scenarios the program requires, each asserting the *whole* returned value, not a
field:

```ts
export interface ChainExtractionConformanceOptions {
  /** The host's signer -- the kit holds no key material of its own. */
  readonly signer: DsseSigner;
}

export function describeChainExtractionConformance(
  options: ChainExtractionConformanceOptions,
): void {
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");

  describe("chain extraction conformance", () => {
    it("converges on the first pass", async () => { /* status converged, 1 round, matchedBaseline */ });

    it("converges after two widenings", async () => {
      // hiddenReads: 2 -- rounds 0 and 1 diverge and widen, round 2 matches. Asserts the
      // widened keys, the growing artifact, and a NEW record digest per round.
    });

    it("never converges, and terminates under the bound", async () => {
      // hiddenReads: Infinity, maxWidenings: 2 -> widen-bound-exhausted / non-convergent,
      // and archive usage strictly under the ceiling: the loop stopped because of the
      // bound, not because it ran out of money.
    });

    it("refuses an archive that disagrees with itself between calls", async () => {
      // anchorDriftsAfterCall -> provider-disagreement, and NO candidate is returned.
    });

    it("is not fooled by a dump that silently omits state the run touched", async () => {
      // The scenario this component exists for (design §10). `dumpOmits:
      // [FAKE_POOL/SLOT_2]` makes the runtime's dump lie. Three assertions:
      //   1. `dumpOmissions` is non-empty -- the lie is DETECTED and reported, not hidden;
      //   2. the sealed artifact carries the omitted slot anyway, because the artifact is
      //      built from the archive journal and never from the dump;
      //   3. the loop still converges -- a broken artifact was never shipped.
      // Then the same scenario with the dump port absent entirely, asserting an identical
      // sealed artifact digest: the pipeline does not depend on a dump at all.
    });
  });
}
```

- [ ] **Step 5: Drive the kit from `src/testing.test.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { dssePreAuthEncoding, type DsseSigner } from "@jinn-network/trust-core";
import { createEoaTestSigner } from "@jinn-network/trust-testing";

import { describeChainExtractionConformance } from "./testing.js";

// Real deterministic secp256k1/EIP-191 signatures: the loop's converged result carries
// CE3's real sealed attestation, not a stub.
const eoa = createEoaTestSigner("chain-extraction-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(
    request.preAuthEncoding ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes),
  ),
}];

describeChainExtractionConformance({ signer });
```

- [ ] **Step 6: The bounded-claims test (contract 7)**

`src/bounded-claims.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import * as surface from "./index.js";

const SRC = new URL("./", import.meta.url);
// `closed-reproducible` is CE3's word. It may appear in this package only where the code
// reads CE3's outcome -- never as a value this package assigns, and never in a name.
const CE3_OUTCOME_ALLOWED = new Set(["widen.ts", "bounded-claims.test.ts", "testing.ts"]);
const FORBIDDEN = [/\bverified\b/iu, /\bdeterministic\b/iu, /\bauthenticated\b/iu, /\bguarantee/iu];

describe("bounded claims", () => {
  it("names nothing in the public surface 'verified' or 'deterministic'", () => {
    for (const name of Object.keys(surface)) {
      expect(name).not.toMatch(/verified|deterministic|guaranteed/iu);
    }
  });

  it("makes no unqualified claim in production source or the README", async () => {
    const files = (await readdir(SRC)).filter((name) => name.endsWith(".ts"));
    for (const name of files) {
      const text = await readFile(new URL(name, SRC), "utf8");
      for (const pattern of FORBIDDEN) {
        const offending = text.split("\n").filter((line) => pattern.test(line)
          // A line that explicitly bounds the claim is what the design asks for.
          && !/never|not |cannot|does not|is not|forbid|refuse/iu.test(line));
        expect(offending, `${name}: ${offending.join(" | ")}`).toEqual([]);
      }
      if (!CE3_OUTCOME_ALLOWED.has(name)) {
        expect(text, name).not.toContain("closed-reproducible");
      }
    }
  });
});
```

- [ ] **Step 7: Finish the README, run everything, commit**

Run:
```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test && corepack yarn@4.13.0 build && corepack yarn@4.13.0 pack:smoke
cd ../../.. && node --test .github/scripts/environments-packed-types.test.mjs
```
Expected: full suite green; the packed consumer compiles against the tarball.

```bash
git add packages/environments/chain-extraction .github
git commit -m "feat(chain-extraction): the conformance kit on fakes and the bounded-claims gate"
```

---

## Verification before completion (branch gate)

Before this branch is reported complete, run and show the output of all of:

```bash
cd packages/environments/chain-extraction
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test \
  && corepack yarn@4.13.0 build && corepack yarn@4.13.0 pack:smoke \
  && corepack yarn@4.13.0 check:fixtures
cd ../../..
node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs \
  .github/scripts/custody-boundaries.test.mjs
# Custody: the injected port is the ONLY network dependency.
grep -rn "process\.env\|node:child_process\|node:http\|node:net\|node:dns\|fetch(\|WebSocket" \
  packages/environments/chain-extraction/src \
  && echo "CUSTODY VIOLATION" || echo "clean"
# No endpoint or provider name may be spelled anywhere in this package.
grep -rniE "https?://|alchemy|infura|tenderly|quicknode|drpc|ankr" \
  packages/environments/chain-extraction/src \
  | grep -v "jinn.network" && echo "PROVIDER LOCATOR IN SOURCE" || echo "clean"
grep -rln "@jinn-network/core\|@jinn-network/plugin\|jinn-layer\|client/src" \
  packages/environments/chain-extraction/src && echo "FROZEN-TRIO IMPORT" || echo "clean"
grep -rn "localeCompare\|Intl\." packages/environments/chain-extraction/src \
  && echo "ORDERING VIOLATION" || echo "clean"
```

Then request one independent high-effort review against the design (§7, §4.2, §10) per
program §5, before anything builds on this branch.

---

## Findings (2026-07-31)

Design defects and cross-plan tensions found while planning, after reconciling with the CE1
and CE3 planners' literal signatures (both supplied 2026-07-31). Contract 1: these are
proposals with dispositions, not applied patches; each is restated in-package as a comment
at the site it affects.

**F-CE4-1 (RESOLVED 2026-07-31 — disposition A landed in CE1).** An archive fork must reach
the archive through an injected port, not a locator the runtime dials: custody forbids a
tier-3 runtime holding an endpoint, and — the argument that settled it — **the injected
port's access journal is this pipeline's harvest ground truth**. A lazily-fetching fork
hides behind its own cache what execution actually reached for, and an extractor left
guessing is back to trusting a dump, which the §7 loop exists to avoid. CE1 landed
`MaterializationRequest.stateBackend?: ChainStateBackend`, exported
`requiresStateBackend(record)` as the shared predicate, and made fail-closed normative (a
materializer handed an archive-dependent record without a backend never reads
`providerLocators`). Recorded there as CE1-F10. CE4 keeps `ForkBackendBinding` so the
host-run loopback variant remains available, but the injected shape is the default and the
one the kit exercises.

**F-CE4-2 (RESOLVED 2026-07-31 — coordinator ruling CR3).** CE1 and CE3 described different
instance handles. Settled as `ChainInstance {instanceId, rpcEndpoint, report?, stop}` with
`VerifiedChainInstance = ChainInstance & {report: MaterializationReport}`; `ChainMaterializer`
gains `reset`. CE4's one stake survives: `report.postFixtureCommitment`, typed
`` `0x${string}` `` (CE1 corrected CE3's proposed `` `sha256:${string}` ``, because it is
compared against `stateMaterialization.initialStateCommitment`, which the record spells as
`0x` + 64 lowercase hex). Nothing is fabricated. CE1 also renamed the report's entry index to
`accounts` / `codeEntries` / `storageSlots`, matching `StateEntryCounts` member-for-member,
which CE4 exploits as a free loader-vs-producer cross-check (T11 step 2).

**F-CE4-10 (RESOLVED 2026-07-31 — CE1 relaxed the field) — `ChainStateBackend.getAccount`
mandated `storageRoot`, which no plain JSON-RPC method returns.** `eth_getBalance` / `eth_getTransactionCount` /
`eth_getCode` do not carry an account's storage root; the only way to obtain it is
`eth_getProof`. Mandating the field therefore turns **every distinct account read during a
fork into an extra proof call** — proof-sized responses against the byte budget, and an
outright failure on archives that do not implement `eth_getProof` (CE4 has a
`archive-proof-unsupported` reason precisely for those, and it would now fire for what
should be a plain balance read). The consuming side does not appear to want it either: a
revm/Anvil fork backend resolves accounts as `{balance, nonce, code_hash}` and has no field
to put a storage root in. *Resolution:* CE1 made `storageRoot` optional and kept `codeHash` mandatory (recorded there
as CE1-F12), and pinned the relaxed shape with a plain-JSON-RPC fake that omits the field, so
a future re-tightening fails typecheck in CE1 rather than surfacing here. CE4's interim
proof-per-account branch is deleted; `asChainStateBackend` is now a pass-through, and the
budget test asserts a plain account read costs exactly one archive call.

**F-CE4-3 — `widenAndReverify`'s argument list is settled here.**
Program §3 pins the name with an ellipsis. Every widening re-derives coverage and re-seals a
record, so the loop needs the request as well as the candidate. *Disposition proposed:*
`widenAndReverify(deps, {candidate, request}, options?)`, mirroring
`extractEnvironment(deps, request)`. Program §3's CE4 bullet to read accordingly.

**F-CE4-4 — proof verification lives in CE4, and that is a change from the design's default
reading.** Design §5.1 step 4 gives CE3 "subset proofs against the declared root", which
reads as CE3 owning verification. But CE3's `SourceProofManifest` carries per-entry
`verified` **as data**, that manifest is sealed into the record *before* CE3 ever runs, and
CE3's planner stated the producer should "set `verified` honestly". The producer is the only
party that can. *Disposition:* CE4 implements offline EIP-1186 verification (T7) and sets
`verified` from the actual trie walk; CE3 re-checks whatever it wishes at step 4 and remains
the sole decider of `source-coverage-incomplete` via `assessArtifactCoverage`. This is
strictly additive honesty — without it, `verified` would mean "we asked for it", and the
design §16 forged-slice finding would be reopened. It also costs `@noble/hashes` as this
package's one non-Jinn runtime dependency beyond zod.

**F-CE4-5 (RESOLVED 2026-07-31 — CE1 adopted the id) — the coverage-artifact formats.**
CE1 pins the *digests* of `sourceProofManifest.proofs` and `fixtureCoverage.manifest` and
the census arithmetic over them, and explicitly delegated their internal format to this
plan. *Disposition proposed:* `jinn.chain-source-proofs/1` (raw, hex-normalized EIP-1186
responses, sorted) and `jinn.chain-fixture-coverage/1` (CE3's `FixtureMutationDeclaration`
list, sorted), both I-JSON/JCS and digest-addressed, plus `jinn.chain-state-slice/1` for the
state artifact itself. All three are deliberately runtime-neutral so a third party can
re-verify an anchored-subset record (design §5.4) without any Jinn or Anvil internals. **CE1
changed its goldens from `{id: "anvil-state"}` to `{id: "jinn.chain-state-slice", version:
"1"}`** (recorded there as CE1-F11), so the corpus and the producer now emit the same format
and no translation sits between the goldens and their consumers; `materializer.id` stays
`anvil-state-loader`, which is correctly runtime-specific. The other two ids sit behind
digest-pinned descriptors CE1 pins but does not interpret, so they stay CE4's. CE3's loader
translates the slice into the runtime's own load mechanism.

**F-CE4-6 — `initialStateCommitment` must be read from the sealed world, via a provisional
record.** Design §4.3 defines it as the post-fixture, agent-visible commitment; CE1 hard-
rejects a record whose value equals `sourceAnchor.stateRoot`. A connected fork's post-fixture
state is a lazily-populated overlay, so its commitment is not the sealed world's. Since
`materialize` takes a record, the value is read from a materialization of a **provisional**
record carrying a sentinel commitment — never sealed, never stored, never returned, and
asserted absent from every sealed record (T11). Recorded as a non-obvious ordering
constraint a reader of §7's pipeline would not infer.

**F-CE4-7 — the dump is never trusted; the journal is the closure set (interpretation).**
Design §10 names the dump-fidelity bug but not what a producer should do about it. Because a
forked instance fetches lazily *through the backend*, the journal of the injected port is
exactly the set of keys the sealed world must carry: what execution read came through the
port, and what it did not read the sealed world does not need. *Disposition:* the artifact
is built from the journal; a dump, when the host offers one, is a cross-check whose
disagreements are reported (`dumpOmissions`, `dumpOnlyEntries`) and never change the
artifact. This is a stronger reading of §10 than "repair the dump", and it is what makes the
pipeline independent of a format with known bugs. No spec amendment proposed.

**F-CE4-8 — archive failures are not retried, diverging from CE2's SWE taxonomy.**
CE2 retries `image-unresolvable` as infrastructure. An archive that will not serve block N
will not serve it on the next attempt either, and each attempt costs money.
*Disposition:* `archive-unavailable` is its own terminal disposition; only `infrastructure`
retries. Recorded so a reviewer comparing the two taxonomies sees the divergence is
deliberate.

**F-CE4-9 (resolved, recorded) — the canonical observation type.** CE1 confirmed it declares
none and makes `ProbeExecutor` generic; CE2 owns `CanonicalChainObservationSchema`; CE3
ships `CanonicalChainObservation` plus `chainObservationDigest` / `chainObservationsEqual`.
CE4 uses CE3's, and never re-canonicalizes an observation of its own — a second
canonicalization would make the baseline↔blackhole comparison meaningless. No action; noted
because CE2 and CE3 now both describe the same bytes, and the cross-package equivalence
fixture for that pair belongs to CE5, which is the first component to hold both.

---

## Self-review

**Design §7 pipeline coverage, stage by stage.**
*Archive fork at anchor* — T6 captures number/hash/root/timestamp and the finality
observation, and carries the header proof so CE1's `anchorAuthenticityBoundOf` classifies
E5's bound rather than CE4 re-deriving it; T4 binds the fork's backend to the injected,
budgeted, journaling port. *Run reference scripts + probes* — T9 hands the author's
archive-dependent draft to CE3's `observeArchiveEnvironment` and reads the canonical
observation back, so K-run mechanics and observation canonicalization exist once, in CE3.
*Harvest touched state* — T10 builds the artifact from the journal, and treats a dump as a
cross-check that can never corrupt it (design §10). *Build candidate record + artifact* —
T5 (slice format), T7 (offline EIP-1186 verification), T8 (the census CE1 seals against and
the two artifact formats CE4 pins), T11 (the two discovered blocks, the closed-state
preconditions, the sealed-world commitment). *Closed-state verification loop* — T12 invokes
`verifyChainEnvironment` under blackhole and branches on `attestation.outcome`.
*Widen slice on divergence* — T12's layered backend localizes; the miss set is the delta.
*Re-extract* — every round re-proves, re-covers, re-commits, and re-seals a **new** record.
*Sealed record + attestation* — the converged result carries CE3's attestation verbatim.

**§4.2 coverage.** Both axes are represented: closure is earned by the loop, never asserted
by the record; fidelity is the author's declaration, and E13 is satisfied twice over — CE4
classifies every entry exactly once so CE1's exact-equality census seals, and CE3's
`assessArtifactCoverage` remains the sole decider of `source-coverage-incomplete`, with a
test asserting the two agree. The boundary rule is load-bearing rather than decorative: it
is why missing state is **stably wrong** and never unstable, which is the loop's core
classification and the reason `probe-divergence` is refused a widening.

**§10 caveat coverage.** The dump-fidelity bug is answered structurally (the journal is the
closure set) and demonstrated (kit scenario 5 asserts the omission is detected, the artifact
is complete anyway, and the digest is identical with the dump port absent entirely). The
`prevrandao` caveat belongs to CE3's determinism controls (program §6) and is not duplicated.

**Pinned-name check against program §3 "CE4 produces".**
`extractEnvironment(deps, request): Promise<ExtractionResult>` — T11, returning candidate +
artifact + coverage manifests. `widenAndReverify(...)` implementing §7's loop — T12, argument
list settled in F-CE4-3. `ArchiveRpcPort` (injected) — T4, the only network dependency,
authoring-time only. All three present, spelled exactly.

**Cross-plan state at filing.** F-CE4-1 (injected fork backend) and F-CE4-2 (the instance
handle) are **resolved** — CE1 landed `MaterializationRequest.stateBackend`,
`requiresStateBackend`, and `VerifiedChainInstance` with
`report.postFixtureCommitment: \`0x${string}\``, and adopted CE4's
`jinn.chain-state-slice/1` format id. F-CE4-10 is resolved too: CE1 relaxed
`ChainStateBackend.getAccount`'s `storageRoot` to optional, so a plain account read no longer
drags an `eth_getProof` behind it and `asChainStateBackend` is a pass-through. **No cross-plan
item against CE1 or CE3 remains open.**

**Consumed-signature consistency (checked against both sibling planners' replies).** CE1:
record blocks and field names, `sealChainEnvironmentRecord(record: unknown)`,
`chainEnvironmentRecordDigest`, `bareHexDigest`/`prefixedDigest`, `StateEntryCounts`,
`BLACKHOLE_EGRESS_POLICY_ID`, `anchorAuthenticityBoundOf`, the census rule, the closed-state
preconditions, and the `archive-dependent.json` golden as the pipeline's input. CE3:
`observeArchiveEnvironment` for the baseline and `verifyChainEnvironment` for the blackholed
leg, `SealedAttestation.{outcome, observations}` (which removed CE4's need for predicate
readers — the earlier draft's F-CE4-6 request is obsolete and was dropped),
`chainObservationDigest`/`chainObservationsEqual`, `assessArtifactCoverage`, `assessClosure`,
`MINIMUM_RUN_COUNT`, and the 14-member outcome vocabulary mapped explicitly in T12's table.
Both previously contested shapes (the instance handle, and where a fork backend is injected)
are now settled in CE1 and consumed here by their landed names.

**Contracts that bite this component.** *Custody* — the port is injected, wrapped before any
module sees it, the fork backend is a binding rather than a URL, and the branch gate greps
for endpoints and provider names as well as ambient APIs. *Contract 7* — enforced by a test
over this package's own source and public surface; `closed-reproducible` appears only where
CE3's value is read. *Contract 12* — every test runs on the fake archive, the fake trie
world, and the fake runtime. *Bounded loop* — three ceilings (`maxWidenings` with a code
ceiling, `maxCalls`, `maxBytes`), checked before the first call, reported on every return
path, carried across crashes by T13, and pre-empted by CE3's pure `assessArtifactCoverage`
so a doomed candidate never buys five instantiations.

**Placeholder scan.** No `TODO`, `FIXME`, `<name>`, or "implement this" appears in any code
block. Three blocks are deliberately specified rather than transcribed — the fake archive's
method bodies, the fake trie world's construction, and T10/T11/T12's step bodies whose
behavior is fixed by the tests written beside them — each with an explicit completion
criterion ("done" is those tests passing unchanged). Generated fixtures name their
generator, their command, and their check mode.

**What a reviewer should attack first.** Now that F-CE4-1 has landed, the sharpest remaining
question is T10's premise: *is the archive journal really the closure set?* The plan argues
it is — a forked instance fetches lazily through the injected backend, so what execution read
came through the port, and what it did not read the sealed world does not need — and the
whole pipeline's independence from a dump rests on that. If it is wrong, the widen loop still
catches the gap (that is what it is for), but the first pass would widen more often than it
should. T14's fifth scenario is where that premise is tested, and it is worth reading before
the code.
