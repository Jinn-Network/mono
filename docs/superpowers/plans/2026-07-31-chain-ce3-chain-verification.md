# CE3 — Chain Environment Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Date:** 2026-07-31
- **Component:** CE3 of the chain environment family
  ([`2026-07-31-chain-environment-program.md`](2026-07-31-chain-environment-program.md))
- **Design (law):** [`../specs/2026-07-31-chain-environment-family-design.md`](../specs/2026-07-31-chain-environment-family-design.md)
  §5 in full (closed-state protocol, archive observation, the attestation, cost), §4.2–§4.4
  (the two-axis model, E13 coverage, the boundary rule, the composite), §8 (fixture-key law),
  §10 (the Anvil caveats), §11 (non-goals). Commit `b3faed8b0`.
- **Parent stack (law):** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  and the merged supply packages on `integration/evidence-v1` (`db22e8416`).
- **House precedent:** `packages/environments/verification` — the merged SWE verification
  package and its plan [`2026-07-31-supply-c2-environment-verification.md`](2026-07-31-supply-c2-environment-verification.md).
  This package is its **sibling**, not its extension: it shares the house shapes (ports,
  closed vocabularies, staged state, fake-runtime kit, golden attestations) and shares no
  code with it.
- **Branch:** `chain/ce3-chain-verification`, based on `chain/ce1-chain-record` (which bases
  on `integration/evidence-v1`). PRs target the base branch, never integration.

**Goal:** ship `@jinn-network/chain-environment-verification` — the tier-3 capability that
executes design §5.1's nine-step closed-state protocol and §5.2's archive-dependent
observation against a sealed chain environment record, verifies a `crypto-environment`
composite as a whole, and seals a DSSE in-toto attestation stating exactly one bounded fact:
*K fresh materializations under blackhole produced identical canonical observations.* The
same package exports the **public runtime surface** — materializer, probe executor, script
replayer — because four consumers (the verifier, the admission observation port, the
evaluation replayer, and a solver's own local runner) need materialize/replay without any
verification protocol (design §3).

**Architecture:** one pure core, two thin drivers, ports for everything that touches the world.

- **Canonical observation, not backend JSON.** `src/observation.ts` owns the observation
  shape, its RFC 8785 bytes, and its digest. Every chain quantity is a decimal or
  lowercase-hex **string**; no JSON number carries a wei value or a gas figure, because a
  quantity past 2^53 would silently change an observation digest between two honest runs.
- **The predicate is a closed Zod schema** whose cross-field rules make design §5.3's honesty
  rules mechanically unforgeable: `runs`/`baseline` present iff the outcome is run-bearing;
  `closed-reproducible` requires every per-run observation digest to equal the canonical one;
  `probe-divergence` requires populated divergence evidence; `window` is always present;
  `archive-observed` requires providers and forbids a closure claim; in-toto DigestSet values
  are bare hex while scalar predicate digests are `sha256:`-prefixed, and each form rejects
  the other.
- **Closure is assessed in two modes, never one.** §5.1 step 2 gives *fork-backend-present*
  (a fetch attempt must be a loud refusal) and *sealed, no fork backend* (closure is evidenced
  by §4.2's boundary rule plus cross-run equality, never by absence of errors). `assessClosure`
  takes the mode as a discriminator and the kit exercises both.
- **Coverage is computed, not trusted.** E13's rule — every artifact entry proof-covered or
  fixture-declared — is a set computation over the artifact entry index, the source-proof
  manifest, and the fixture declarations, producing `source-coverage-incomplete`.
- **Composite ≠ component.** `verifyCryptoEnvironment` checks only what exists in combination
  (origin routing collisions, whole-world offline boot, K-run observation across both planes)
  and emits a `scope: "composite"` attestation whose subject tuple cannot satisfy a component
  match. A composite attestation never substitutes for its components' attestations.
- **The runtime surface is public and I/O-free.** `createAnvilMaterializer` speaks the Anvil
  wire protocol over an **injected** process host, RPC transport, workspace, and artifact
  source. The package spawns nothing, opens no socket, and reads no ambient file.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:`
resolutions); zod 4.4.3; `@jinn-network/trust-core` (DSSE, JCS, hashing, RFC 3339, code-unit
ordering); `@jinn-network/chain-environment-record` (CE1); vitest 4.

---

## Global constraints

From the program plan §4; these bind every task below.

1. **Designs are law** (contract 1). The spec is `b3faed8b0`. A defect discovered while
   implementing is a Finding with a proposed disposition appended to this plan's §Findings —
   never a silent patch.
2. **Kits and fixtures precede implementations** (contract 2). Within this plan: the
   observation module, the outcome vocabulary, the predicate schema and its fixture corpus
   (T3–T7) are green before either driver (T10–T14) is written; the assembled conformance kit
   (T16) is green before this branch is reported complete.
3. **Sealing is re-implemented per package** (contract 3). That rule owns *record* sealing and
   belongs to CE1. This package does not re-implement record sealing; it calls CE1's
   `sealChainEnvironmentRecord` / `sealCryptoEnvironmentRecord`. DSSE attestation sealing
   reuses `trust/core` unchanged (design §3 kernel-sharing ruling). The **observation**
   canonicalization is this package's own and ships its own equivalence fixture.
4. **Custody law** (contract 4). No key material, no ambient authority. `process.env` never
   appears in `src/**` production source. `fetch` / `WebSocket` / `node:http` / `node:net` /
   `node:child_process` / `node:dns` never appear anywhere in `src/` except the one opt-in
   Anvil test named in T17. `node:fs/promises` appears in exactly two production-region files
   (`src/staged-state-store.ts`, which takes its directory as an argument, and `src/testing.ts`,
   which loads this package's own fixtures) plus the three test files named in T1. **There is
   no ambient Docker**: the Anvil materializer receives a `ProcessHost`. Signer is a
   `DsseSigner` function; the package never sees bytes of a private key. Fail closed.
5. **No product names in tiers 1–3** (contract 5). The identifiers `plugin`, `jinn-plugin`,
   `operator`, `autopilot`, `daemon`, `client` must not appear in source, exports, or
   dependencies. No import of `@jinn-network/core`, `@jinn-network/plugin`,
   `@jinn-network/jinn-layer`, or anything under `client/`.
6. **Digest discipline** (contract 6). Record-body and scalar predicate digests are
   `sha256:`-prefixed lowercase hex; in-toto DigestSet values (subjects and
   ResourceDescriptors) are **bare** lowercase hex. `toDigestSet` / `fromDigestSet` are the
   only sanctioned crossings, and the confusion fixture ships in this package's kit (T16).
7. **Bounded claims** (contract 7). No API name, doc comment, README line, log string, or
   fixture in this package says "deterministic", "guaranteed", "trustless", or "authenticated
   against mainnet"; "verified" and "proven" appear only on lines that bound the claim.
   `closed-reproducible` means exactly what §5.3 says and nothing more. A test enforces this
   over source, scripts, fixtures, and the README (T16 step 6) — it is not a promise.
8. **Fixture keys are freshly generated per record and never reused** (contract 8, design §8).
   No fixture address in this package may be a well-known development address that someone
   might fund. A deny-list test over the ten Anvil defaults enforces it (T16 step 6).
9. **Register in the existing tree guards in the same PR** (contract 9): inventory row +
   dependency graph, boundary sweep, packed-types entrypoints, CI job.
10. **TDD per task; verification before completion** (contract 10). Every task ends with
    `yarn typecheck && yarn test` in the package plus the tree guards, outputs shown, before
    the task is reported done.
11. **Stop on missing Consumes** (contract 11). Every symbol consumed from
    `chain/ce1-chain-record` or from `integration/evidence-v1` is named exactly below. A symbol
    not on the base branch is a stop-and-report, not an improvisation. **One narrow
    adaptation is permitted:** where CE1's port types differ from this plan's expected shapes
    by *name only* (same fields, same meaning), rename the call sites — that is mechanical.
    Where they differ by *content* (a field the protocol reads is absent), stop and report.
12. **Docker-dependent tests are opt-in and skip cleanly** (contract 12). The kit runs against
    fakes only. The one suite that needs a real Anvil binary lives in `*.anvil.test.ts`,
    is excluded from the default `yarn test` project, and `skipIf`s itself when the binary is
    absent.
13. **The §10 Anvil caveats are verified, not assumed.** `prevrandao` control at the Anvil
    (not cheatcode) level and dump-state fidelity on forked instances are measured against the
    pinned version in T17, and the result decides which determinism controls this package will
    let a record honestly declare.
14. Node `>=22`; `"type": "module"`; every relative import carries the `.js` extension. No
    `localeCompare`, no `Intl` in production source — use `compareCodeUnitStrings` from
    `@jinn-network/trust-core`.

---

## Consumed interfaces (verify before Task 1)

### From `chain/ce1-chain-record` — `@jinn-network/chain-environment-record`

Pinned by program §3 ("CE1 produces"). Every one of these is a stop-and-report if absent:

| Symbol | Used by |
| --- | --- |
| `ChainEnvironmentRecord` (parsed type) | ports, verify, archive, runtime surface, conformance records |
| `CryptoEnvironmentRecord` (parsed type) | composite |
| `sealChainEnvironmentRecord(record): Uint8Array` | verify (subject digest) |
| `sealCryptoEnvironmentRecord(record): Uint8Array` | composite (subject digest) |
| `parseChainEnvironmentRecord(bytes)` / `parseCryptoEnvironmentRecord(bytes)` | conformance records (round-trip validation) |
| `chainEnvironmentRecordDigest(bytes): \`sha256:${string}\`` | verify |
| `cryptoEnvironmentRecordDigest(bytes): \`sha256:${string}\`` | composite |
| `bareHexDigest(digest): string` | digest-discipline equivalence test (T2 step 5) |
| `CHAIN_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_KIND` + their media types | conformance records, statement media typing |
| `ChainMaterializer`, `ProbeExecutor`, `ScriptReplayer` (**port type declarations**) | ports, runtime surface |
| `@jinn-network/chain-environment-record/testing` kit + fixtures | conformance records, T16 |

**CE1's port types, as adopted (READ THIS BEFORE TASK 1).** CE3's F-CE3-12 was raised against
CE1's first draft and **accepted in full** (coordinator ruling CR3); CE1's plan is amended in
place. These are the declarations this plan writes against — types only, no runtime value:

```ts
export interface NetworkPolicy {
  readonly egress: "denied";
  readonly dns: "absent";
  readonly archiveRpc: "unreachable";
  readonly forkBackend: "absent" | "present";
}

export interface ResolvedResources {
  readonly byDigest: ReadonlyMap<`sha256:${string}`, Uint8Array>;
}

/** Caller-owned archive access for an archive-dependent record (CE1-F10, from CE4). */
export interface ChainStateBackend {
  getAccount(address: string, block: string): Promise<unknown>;
  getCode(address: string, block: string): Promise<string>;
  getStorageAt(address: string, slot: string, block: string): Promise<string>;
  getBlockHeader(block: string): Promise<unknown>;
}
export function requiresStateBackend(record: ChainEnvironmentRecord): boolean;

export interface MaterializationRequest {
  readonly record: ChainEnvironmentRecord;
  readonly resources: ResolvedResources;
  /** Caller-assigned, so K distinct ids are the VERIFIER's claim, not the runtime's. */
  readonly instanceId: string;
  /** The blackhole travels WITH the request (§5.1 step 2). */
  readonly networkPolicy: NetworkPolicy;
  /** Required iff `requiresStateBackend(record)`; see the normative rule below. */
  readonly stateBackend?: ChainStateBackend;
  readonly signal?: AbortSignal;
}

export interface RuntimeIdentityObservation {
  readonly imageManifestDigest: `sha256:${string}`;
  readonly platform: string;
  readonly reportedVersion: string;
  readonly binaryDigest: `sha256:${string}`;
  readonly evmConfigurationDigest: `sha256:${string}`;
  readonly chainId: number;
  readonly appliedControls: Readonly<Record<string, string>>;
  /** Controls the record declared that this runtime cannot apply (design §10). */
  readonly unsupportedControls: readonly string[];
}

/** Member names match `stateArtifact.entryCounts` exactly: one vocabulary for one partition. */
export interface ArtifactEntryObservation {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

export interface IsolationObservation {
  readonly networkPolicy: NetworkPolicy;
  readonly egressAttempts: readonly {
    readonly target: string;
    readonly outcome: "refused" | "succeeded";
    readonly detail?: string;
  }[];
  readonly forbiddenProbes: readonly {
    readonly method: string;
    readonly expectedClass: string;
    readonly observedClass: string;
  }[];
  readonly exposedSignerAccounts: readonly string[];
  readonly ceilingChecks: readonly { readonly name: string; readonly enforced: boolean }[];
}

export interface MaterializationCost {
  readonly wallSeconds: number;
  readonly cpuSeconds?: number;
  readonly maxMemoryBytes?: number;
  readonly diskBytes?: number;
  readonly rpcCalls?: number;
  readonly rpcBytes?: number;
}

export interface MaterializationReport {
  readonly runtimeIdentity: RuntimeIdentityObservation;
  readonly artifactEntries: ArtifactEntryObservation;
  /** An EVM state commitment: `0x` + 64 lowercase hex, NOT a sha256: content digest. */
  readonly postFixtureCommitment: `0x${string}`;
  readonly loadedResources: readonly `sha256:${string}`[];
  readonly isolation: IsolationObservation;
  readonly cost: MaterializationCost;
}

export interface ChainInstance {
  readonly instanceId: string;
  readonly rpcEndpoint: string;
  /** OPTIONAL: a solver's local runner must not be forced to synthesise isolation evidence
   * and cost observations it has no use for. */
  readonly report?: MaterializationReport;
  readonly stop: () => Promise<void>;
}

/** The narrowing every verification path types against. */
export type VerifiedChainInstance = ChainInstance & { readonly report: MaterializationReport };

export interface ChainMaterializer {
  materialize(request: MaterializationRequest): Promise<ChainInstance>;
  /** §5.1 step 6's reset requirement; returns the post-reset state commitment. */
  reset(instance: ChainInstance, signal?: AbortSignal): Promise<`0x${string}`>;
}

export interface ProbeExecutionRequest {
  readonly instance: ChainInstance;
  readonly probeSuite: Uint8Array;
  readonly signal?: AbortSignal;
}
export interface ProbeExecutionResult<Observation> {
  readonly observation: Observation;
  readonly observationDigest: `sha256:${string}`;
}
export interface ProbeExecutor<Observation = unknown> {
  execute(request: ProbeExecutionRequest): Promise<ProbeExecutionResult<Observation>>;
}

export interface ReplayRequest {
  readonly instance: ChainInstance;
  readonly script: ChainSolutionScript;
  /** The effective envelope: the record's, as tightened by the task. */
  readonly envelope: CapabilityEnvelope;
  readonly signal?: AbortSignal;
}
export interface ReplayRefusal {
  readonly reason:
    | "envelope-exceeded" | "operation-not-permitted"
    | "signer-not-in-scope" | "environment-mismatch";
  readonly detail: string;
}
export type ReplayOutcome<Observation = unknown> =
  | { readonly status: "replayed"; readonly observation: Observation;
      readonly observationDigest: `sha256:${string}`;
      readonly reportedValues: Readonly<Record<string, string>>; }
  | { readonly status: "refused"; readonly refusal: ReplayRefusal };
export interface ScriptReplayer<Observation = unknown> {
  replay(request: ReplayRequest): Promise<ReplayOutcome<Observation>>;
}
```

**Four consequences this plan is written against, each load-bearing:**

1. **Commitments are `0x` + 64 hex; digests are `sha256:`.** `postFixtureCommitment` and
   `reset`'s return are EVM **state commitments** compared directly against
   `stateMaterialization.initialStateCommitment`, which CE1's schema spells `Bytes32` and
   hard-rejects when it equals `sourceAnchor.stateRoot`. A `sha256:` spelling would force an
   unspecified conversion at the comparison site, and the first person to write it would
   guess. `loadedResources` and every material digest stay `sha256:` — those genuinely digest
   bytes. This plan's predicate follows: `environment.postFixtureCommitment`,
   `baseline.commitment`, `isolation.resetCommitment`, and the observation's
   `finalStateCommitment` are all `Bytes32Schema`.
2. **`report` is optional; the verification path types against `VerifiedChainInstance`.** A
   materializer that returns no report is `materialization-report-absent` →
   `verification-infrastructure-failure` — **one explicit check**, never a non-null assertion,
   because the whole point of the optional member is that some materializers legitimately do
   not produce one.
3. **`artifactEntries` members are `accounts` / `codeEntries` / `storageSlots`**, matching
   `stateArtifact.entryCounts` exactly. This plan's coverage module uses the same three words
   end to end — input, uncovered sets, and the attestation's `failure.coverage` — because two
   vocabularies for one partition is how an off-by-one mapping gets written and never noticed.
4. **Archive access is caller-owned and fails closed (CE1-F10, normative, CE3 enforces).** A
   materializer handed a record for which `requiresStateBackend(record)` is true, with no
   `stateBackend`, **refuses** and never dials `stateMaterialization.providerLocators`.
   Locators tell a caller where it *may* look; they are not an instruction to this package's
   runtime. Beyond custody, this is what makes the backend's access journal CE4's harvest
   ground truth — a lazily-fetching fork hides exactly the reads the extractor needs to see.

CE1's `src/ports.test.ts` is the compile-time pin: it constructs every fact §5.1 steps 2–6 and
9 read at its declared spelling, so a silent narrowing fails CE1's typecheck rather than
surfacing here.

**Record field paths this plan reads** (design §4.3; CE1 owns the grammar, a divergence is a
stop-and-report):

`record.runtime.{family,version,image.manifestDigest,image.platform,binary,evm.chainId,launch}` ·
`record.sourceAnchor?.{caip2,chainId,blockNumber,blockHash,stateRoot,timestamp,finalityPolicy,headerProof?}` ·
`record.stateMaterialization.{closureClass,constructionMethod,stateArtifact?,artifactFormat,materializer,fidelityClass,sourceProofManifest?,archiveCapabilities?,providerLocators?,initialStateCommitment,mutatesSourceProtocolState?}` ·
`record.fixtures.{modules[],postFixtureCommitment}` ·
`record.determinismControls` · `record.capabilityEnvelope.{rpcAllowlist,signerRoles,permittedChainId,maxima,egressPolicyId}` ·
`record.verificationContract.{probeSuite,probeFormat,observationSchema,expectedBaselineObservationDigest,comparator,requiredClosureCheck,resetRequirements,fixtureProbeCoverage,verificationPolicyId}` ·
`composite.{chainWorld,informationWorlds[],serviceRuntimes[],composition.{routing[],missPolicy,allowlistedOrigins,requestBudget}}`.

### From `integration/evidence-v1` — `@jinn-network/trust-core`

All verified present on `origin/integration/evidence-v1` at `9f4925037`, `packages/trust/core/src/`:

| Symbol | Source file | Used by |
| --- | --- | --- |
| `sealSignedRecord(input): Promise<SealedRecord>` | `dsse.ts:316` | verify, composite |
| `SealedRecord` (`{envelopeBytes, payloadBytes, recordDigest}`) | `dsse.ts:303` | verify |
| `DsseSigner` (a **function** type), `DsseSigningRequest`, `DsseProducedSignature` | `dsse.ts:281–292` | ports, kit |
| `parseDsseEnvelope`, `dssePreAuthEncoding` | `dsse.ts:153,29` | kit |
| `DSSE_PAYLOAD_TYPE` (`application/vnd.in-toto+json`) | `identifiers.ts:3` | verify, kit |
| `IN_TOTO_STATEMENT_TYPE` (`https://in-toto.io/Statement/v1`) | `identifiers.ts:4` | statement |
| `canonicalJsonBytes(value): Uint8Array` | `canonical-json.ts` | observation, staged state |
| `recordDigest(bytes): Sha256Digest`, `sha256Hex(bytes)` | `hashing.ts:10,6` | observation, verify |
| `Sha256Digest` type (`` `sha256:${string}` ``) | `types.ts:12` | everywhere |
| `isCalendarStrictRfc3339(value)` | `rfc3339.ts` | predicate schema, staged state |
| `compareCodeUnitStrings(left, right)` | `order.ts` | observation ordering, coverage sets |

### From `integration/evidence-v1` — `@jinn-network/trust-testing` (devDependency only)

`createEoaTestSigner(seed): EoaTestSigner` (`crypto.ts:60`) — real deterministic
secp256k1/EIP-191 signatures, used by this package's own tests to drive the kit against
genuine keys. **Never** used to derive a fixture chain account (contract 8 keeps fixture keys
out of any seed a reader could reproduce and fund).

### `@jinn-network/attestation-issuer` is a pattern source, not a dependency

`packages/evidence/attestation-issuer/src/statement.ts` builds an in-toto Statement by
assembling `{_type, subject, predicateType, predicate}` and `safeParse`-ing it against a
closed schema, throwing with the first issue's JSON path. That pattern is copied into
`src/statement.ts` here with attribution in the source comment. It is **not imported**: its
public surface (`src/index.ts`) exports only `prepareResultEvaluation`,
`prepareExecutionVerification`, `commitPreparedAttestation`, `parsePreparedAttestation` — no
statement builder — and design §3 gives chain-verification exactly two package edges
(`chain-environment-record`, `trust/core`).

---

## File structure

All paths relative to `packages/environments/chain-verification/`.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`, `README.md` | package scaffold |
| `scripts/pack-smoke.mjs` | tarball shape + packed-import smoke |
| `scripts/generate-goldens.mjs` | regenerates the golden attestation corpus |
| `src/identifiers.ts` | predicate type, protocol URI, schema ids, `MINIMUM_RUN_COUNT`, defaults |
| `src/errors.ts` | `ChainVerificationError`, `invalidInput`, `conformanceFailure` |
| `src/digests.ts` | prefixed/bare-hex schemas, `DigestSet`, `ResourceDescriptor`, the two crossings |
| `src/observation.ts` | canonical chain + information-plane + composite observations, bytes, digest, equality |
| `src/outcomes.ts` | the 14-member outcome vocabulary, run-bearing partition, stages, reasons, dispositions |
| `src/predicate.ts` | `ChainEnvironmentVerificationPredicateSchema` + every cross-field rule |
| `src/subject.ts` | component and composite subject builders (bare-hex DigestSets) |
| `src/statement.ts` | statement schemas, builders, `attestationMatchesRecord`, `requiresComponentAttestations` |
| `src/ports.ts` | `ChainRuntime`, `ArtifactStore`, `Clock`, `ChainVerificationDeps`, blackhole policy |
| `src/resolve.ts` | step 1 — resolve + digest-verify every resource, build the resolution log |
| `src/closure.ts` | step 2 — `assessClosure`, both evidence modes |
| `src/coverage.ts` | step 4 — E13 artifact coverage |
| `src/verify.ts` | `verifyChainEnvironment` — steps 1–9 |
| `src/archive.ts` | §5.2 — `observeArchiveEnvironment` |
| `src/composite.ts` | `verifyCryptoEnvironment`, `assessOriginRouting` |
| `src/abi-encode.ts` | the closed ABI encoder/decoder the v1 predicate vocabulary needs |
| `src/state-reads.ts` | structured read requests: `stateReadKey`, encoding, resolution (CR6) |
| `src/anvil.ts` | `createAnvilMaterializer` (public runtime surface) |
| `src/probes.ts` | `createProbeExecutor` (public runtime surface) |
| `src/replay.ts` | `createScriptReplayer` + the solution-script schema (public runtime surface) |
| `src/staged-state.ts` | pure staged-job algebra + `StagedStateStore` port |
| `src/staged-state-store.ts` | `createFileStagedStateStore` — atomic write, resumable |
| `src/conformance-records.ts` | the fixture chain + composite records the kit verifies |
| `src/index.ts` | public surface |
| `src/testing.ts` | fakes + `describeChainVerificationConformance` + fixture loaders |
| `fixtures/predicate-v1/*.json` | golden + adversarial predicate corpus |
| `fixtures/attestations-v1/*.json` | golden statements the kit pins field-for-field |
| `ANVIL-CAVEATS.md` | T17's measured answer to design §10 |

Repo files this plan also edits (created by the supply program, extended by CE1 on the base
branch): `.github/scripts/environments-package-inventory.test.mjs`,
`.github/scripts/environments-source-boundaries.test.mjs`,
`.github/scripts/environments-packed-types.test.mjs`,
`.github/workflows/environments-ci.yml`.

---

### Task 1: Scaffold the package and register it with the tree guards

**Files:**
- Create: `packages/environments/chain-verification/package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `.yarnrc.yml`, `.gitignore`, `vitest.config.ts`, `README.md`,
  `src/index.ts`, `scripts/pack-smoke.mjs`
- Modify: `.github/scripts/environments-package-inventory.test.mjs`,
  `.github/scripts/environments-source-boundaries.test.mjs`,
  `.github/scripts/environments-packed-types.test.mjs`,
  `.github/workflows/environments-ci.yml`

**Interfaces:**
- Consumes: the `packages/environments/` tree and its guard trio (from
  `integration/evidence-v1`), plus CE1's `chain-record` registration in all three (from
  `chain/ce1-chain-record`). Any absence is a stop-and-report (contract 11).
- Produces: the package directory publishing `@jinn-network/chain-environment-verification`
  with exports `.`, `./testing`, `./fixtures/*`.

- [ ] **Step 1: Confirm the base branch carries CE1's package and its guard registration**

```bash
git rev-parse --abbrev-ref HEAD
ls packages/environments/chain-record/package.json
node -e "const j=require('./packages/environments/chain-record/package.json');console.log(j.name,j.version,JSON.stringify(j.exports))"
grep -n "chain-record" .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs \
  .github/workflows/environments-ci.yml
node -e "
const s=require('node:fs').readFileSync('packages/environments/chain-record/src/index.ts','utf8');
for (const n of ['ChainEnvironmentRecord','CryptoEnvironmentRecord','sealChainEnvironmentRecord',
  'sealCryptoEnvironmentRecord','chainEnvironmentRecordDigest','cryptoEnvironmentRecordDigest',
  'bareHexDigest','CHAIN_ENVIRONMENT_KIND','CRYPTO_ENVIRONMENT_KIND','ChainMaterializer',
  'ProbeExecutor','ScriptReplayer']) if(!s.includes(n)) throw new Error('missing CE1 export: '+n);
console.log('every pinned CE1 export is present');"
```

Expected: branch is `chain/ce3-chain-verification`; the manifest prints
`@jinn-network/chain-environment-record 0.1.0`; `chain-record` appears in all four repo files;
the export check prints its success line. **Any miss → stop and report** (contract 11).

- [ ] **Step 2: Read CE1's port type declarations and reconcile them with this plan**

```bash
sed -n '1,400p' packages/environments/chain-record/src/ports.ts
```

Compare field-by-field with §Consumed interfaces' expected shapes. Write the result into this
plan's §Findings as `F-CE3-0` in one of two forms: *"CE1's port types match; N symbols renamed
at the call sites (list)"* or *"CE1's `<type>` lacks `<field>`, which §5.1 step `<n>` reads —
stop and report."* Do not proceed past a content divergence.

- [ ] **Step 3: Register the package in the inventory guard so it fails**

In `.github/scripts/environments-package-inventory.test.mjs`, add the roster entry after
`chain-record`'s:

```js
  ['chain-verification', '@jinn-network/chain-environment-verification'],
```

Add the graph entry after `chain-record`'s:

```js
  // `chain-verification` is tier 3 and takes exactly the two package edges design §3 gives
  // it: the record kinds it verifies, and trust/core for DSSE + JCS + hashing + ordering.
  // `trust-testing` is a test-only devDependency (the kit signs with real deterministic
  // keys); `trust-resolve` is install-graph only, because a portal's own resolutions do not
  // apply and `trust-testing`'s Jinn dependency must be resolved from here.
  ['chain-verification', {
    dependencies: [
      '@jinn-network/chain-environment-record',
      '@jinn-network/trust-core',
    ],
    devDependencies: ['@jinn-network/trust-resolve', '@jinn-network/trust-testing'],
    optionalDependencies: [],
    peerDependencies: [],
  }],
```

Add the export-map entry to the `expectedExports` map in the third test:

```js
    ['chain-verification', ['.', './fixtures/*', './testing']],
```

Add `@jinn-network/chain-environment-record` to `SIBLING_TREE_DIRS`? **No** — it is in-tree,
so `expectedPortal` finds it through `ENVIRONMENT_PACKAGES`. Leave `SIBLING_TREE_DIRS` alone.

- [ ] **Step 4: Run the guard and watch it fail**

Run: `node --test .github/scripts/environments-package-inventory.test.mjs`
Expected: FAIL — `missing package manifest: .../packages/environments/chain-verification/package.json`.

- [ ] **Step 5: Create the package scaffold**

`package.json`:

```json
{
  "name": "@jinn-network/chain-environment-verification",
  "version": "0.1.0",
  "description": "Closed-state and archive observation protocols for chain environments, their in-toto attestation, and the public materialize/probe/replay runtime surface.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/environments/chain-verification"
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
    "ANVIL-CAVEATS.md",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:anvil": "vitest run --config vitest.anvil.config.ts",
    "goldens": "node scripts/generate-goldens.mjs",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/chain-environment-record": "0.1.0",
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
    "ox": "^0.9.6",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "@jinn-network/chain-environment-record": "portal:../chain-record",
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
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
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
  "exclude": ["src/**/*.test.ts", "src/**/*.anvil.test.ts"]
}
```

`vitest.config.ts` — contract 12: the Anvil suite is out of the default project, so a machine
with no Foundry runs the whole kit and passes.

```ts
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.anvil.test.ts", "node_modules/**"],
  },
});
```

`vitest.anvil.config.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.anvil.test.ts"],
    testTimeout: 300_000,
  },
});
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

`src/index.ts` (grows task by task; starts as the package's identity only):

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  CHAIN_OBSERVATION_SCHEMA_ID,
  COMPOSITE_OBSERVATION_SCHEMA_ID,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
```

`README.md` — the bounded-claims test (T16 step 6) reads this file, so the wording is load-bearing:

````markdown
# @jinn-network/chain-environment-verification

Executes the closed-state protocol against a sealed chain environment record, or the
archive-dependent observation protocol, and produces an in-toto Statement inside a DSSE
envelope. Also exports the public runtime surface — materializer, probe executor, script
replayer — for consumers that want to materialize or replay a world without running any
protocol at all.

## What the attestation claims, exactly

`outcome: "closed-reproducible"` means **K fresh materializations under blackhole produced
identical canonical observations**, and nothing beyond that sentence. It does not speak to
task solvability, grader discrimination, protocol security, market realism, source-chain
fidelity beyond the class the record declares, provider longevity, cross-runtime equivalence,
or safety outside the sandbox. Those claims have other owners.

`outcome: "archive-observed"` is the weaker sibling: *at the recorded time, the named
providers supplied state consistent with the declared anchor and produced these observations.*
It says nothing about offline reproducibility, provider retention, or durable-supply
eligibility, and marketplace supply advertised as re-verifiable evidence must reference a
`closed-state` record instead.

Every other outcome in the closed vocabulary is a negative fact, signed and published as a
first-class attestation.

## The anchor bound

EIP-1186 proofs bind the committed subset to the **declared** anchor root. That the declared
root is the canonical chain's root at that block is a separate trust step: the attestation
records `anchor.authenticity` as `declared` unless the record commits a header-proof artifact,
in which case it records `header-proven`. Nothing here asserts correspondence with a public
chain that the record itself does not carry evidence for.

## The boundary of the world

A sealed instance has no fork backend. State outside the committed slice does not error — it
reads as empty, on every run. What the slice bounds is fidelity, not repeatability. The record
never claims a whole chain when it carries a slice, and neither does this package.

## Closure has two evidence modes

- **fork-backend-refusal** — the runtime is configured with a fork backend, so the protocol
  provokes an upstream read and requires a loud refusal. An attempt that succeeds is
  `offline-dependency-detected`.
- **sealed-boundary** — the instance has no fork backend, so no attempt is possible and the
  absence of errors evidences nothing. Closure is evidenced instead by the boundary rule
  (out-of-slice reads return empty), by every loaded resource appearing in the resolution log,
  and by cross-run observation equality.

## Ports

Everything that touches the world is injected: `runtime` (materializer + probe executor),
`artifactStore` (`getArtifact` / `putArtifact`), `signer` (a `DsseSigner` function — this
package never sees key bytes), `clock`, and the host-declared `verifier` toolchain identity.
`createAnvilMaterializer` takes an injected process host, RPC transport, workspace, and
artifact source; this package spawns no process and opens no socket.

## Digest forms

Scalar digest fields are `sha256:<64 lowercase hex>`. in-toto DigestSet values — subjects and
ResourceDescriptors — are **bare** hex. `toDigestSet` / `fromDigestSet` are the only sanctioned
crossings; the schemas reject each other's form.

## Composite attestations do not substitute for component attestations

A `scope: "composite"` attestation covers what exists only in combination — routing has no
collisions, the whole world boots offline, the K-run observation spans both planes. It does not
cover the chain world or any information world on its own; `requiresComponentAttestations`
lists the component records whose own attestations a consumer must additionally obtain.
````

`scripts/pack-smoke.mjs`:

```js
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordRoot = join(packageRoot, "..", "chain-record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-chain-verification-"));
const recordArchive = join(temporaryRoot, "chain-environment-record.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const verificationArchive = join(temporaryRoot, "chain-environment-verification.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  for (const [root, archive] of [
    [recordRoot, recordArchive],
    [trustCoreRoot, trustCoreArchive],
    [packageRoot, verificationArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  const entries = (await output("tar", ["-tzf", verificationArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/ANVIL-CAVEATS.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
    "package/fixtures/predicate-v1/closed-reproducible.json",
    "package/fixtures/attestations-v1/sealed-stable.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed chain-environment-verification is missing ${required}`);
    }
  }
  const leaked = entries.filter((entry) => /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry));
  if (leaked.length > 0) throw new Error(`test files leaked into tarball: ${leaked.join(", ")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jinn-network/chain-environment-record": `file:${recordArchive}`,
      "@jinn-network/trust-core": `file:${trustCoreArchive}`,
      "@jinn-network/chain-environment-verification": `file:${verificationArchive}`,
      vitest: "4.1.8",
    },
  }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
  await writeFile(join(consumer, "packed-imports.test.mjs"), `
import assert from "node:assert/strict";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  createAnvilMaterializer,
  createProbeExecutor,
  createScriptReplayer,
  verifyChainEnvironment,
  verifyCryptoEnvironment,
} from "@jinn-network/chain-environment-verification";
import {
  createInMemoryArtifactStore,
  describeChainVerificationConformance,
} from "@jinn-network/chain-environment-verification/testing";
import { test } from "vitest";

test("packed chain-environment-verification exposes its distribution contract", () => {
  assert.equal(
    CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    "https://jinn.network/attestations/chain-environment-verification/v1",
  );
  for (const fn of [verifyChainEnvironment, verifyCryptoEnvironment, createAnvilMaterializer,
    createProbeExecutor, createScriptReplayer, describeChainVerificationConformance,
    createInMemoryArtifactStore]) {
    assert.equal(typeof fn, "function");
  }
});
`);
  const vitest = join(consumer, "node_modules", ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest");
  await run(vitest, ["run", "packed-imports.test.mjs"], { cwd: consumer });
  console.log("Packed root/testing imports, fixtures, and archive shape verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

- [ ] **Step 6: Add the source-boundary and packed-types entries**

In `.github/scripts/environments-source-boundaries.test.mjs`:

1. Add `'chain-verification'` to `environmentDirectories`.
2. Add this package's allowlists beside `chain-record`'s:

```js
// `packages/environments/chain-verification` is tier 3: it runs the closed-state and archive
// protocols and seals the attestation. Design §3 gives it exactly two package edges — the
// record kinds it verifies, and trust/core for DSSE + JCS + hashing — so `@jinn-network/
// trust-*` is lifted from the foreign list for this package only.
const CHAIN_VERIFICATION_ALLOWED_EXTERNALS = [
  '@jinn-network/chain-environment-record',
  '@jinn-network/trust-core',
  'zod',
];
const CHAIN_VERIFICATION_ALLOWED_DEPENDENCIES = [
  '@jinn-network/chain-environment-record',
  '@jinn-network/trust-core',
  'zod',
];
const CHAIN_VERIFICATION_ALLOWED_DEV_DEPENDENCIES = [
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
  '@types/node',
  // Test-only differential oracle for the hand-rolled ABI encoder (ruling CR8), exactly as
  // `canonicalize` and `ajv` are test-only oracles for the record package above. Production
  // source never imports it -- the externals assertion below scans production files only.
  'ox',
  'typescript',
  'vitest',
];
const CHAIN_VERIFICATION_ALLOWED_PEER_DEPENDENCIES = ['vitest'];
const CHAIN_VERIFICATION_FOREIGN_PACKAGES = [
  ...ENVIRONMENTS_FOREIGN_PACKAGES.filter((entry) => entry !== '@jinn-network/trust-*'),
  '@jinn-network/trust-resolve',
];
// Finding F-CE3-6: the staged-state file store is this package's only production filesystem
// surface, and it takes its directory as an argument rather than as ambient authority. The
// three test files below read this package's own shipped fixtures and source. Every path is
// named one by one so a new filesystem user needs a deliberate edit here.
const CHAIN_VERIFICATION_FILESYSTEM_SOURCES = [
  'chain-verification/src/staged-state-store.ts',
  'chain-verification/src/testing.ts',
  // The ABI vector corpus loader, shared by the unit and differential suites.
  'chain-verification/src/abi-vectors.ts',
  'chain-verification/src/abi-encode.differential.test.ts',
  'chain-verification/src/staged-state-store.test.ts',
  'chain-verification/src/testing.test.ts',
  'chain-verification/src/bounded-claims.test.ts',
];
// Finding F-CE3-7: design §10's caveats are measured against a real pinned Anvil, which needs
// a process. Exactly one opt-in test file may spawn one; it is excluded from the default
// vitest project, so a machine without Foundry still runs the whole kit.
const CHAIN_VERIFICATION_PROCESS_SOURCES = [
  'chain-verification/src/anvil-caveats.anvil.test.ts',
];
```

3. Add the per-package test, mirroring the existing
   `'environment-verification takes exactly its two approved package edges'` test with the
   constants above, the `['.', './fixtures/*', './testing']` export-map assertion, and the two
   carve-out filters. The ambient-network, locale-sensitive, and bounded-claim sweeps stay
   untouched — this package must pass all of them.

In `.github/scripts/environments-packed-types.test.mjs`, add to `packages` and to
`codeEntrypoints`:

```js
  ['chain-verification', '@jinn-network/chain-environment-verification'],
```
```js
  '@jinn-network/chain-environment-verification',
  '@jinn-network/chain-environment-verification/testing',
```

In `.github/workflows/environments-ci.yml`: add
`docs/superpowers/specs/2026-07-31-chain-environment-family-design.md` and
`docs/superpowers/plans/2026-07-31-chain-ce3-chain-verification.md` to the `paths` list; add a
`chain-verification` job that builds `trust/core`, `trust/testing`, and
`environments/chain-record` first, then runs `yarn install --immutable && yarn typecheck &&
yarn test && yarn build && yarn pack:smoke` in the package, uploads
`environments-chain-verification-dist`, and add the job to `verify.needs`, to its result loop,
and to the distribution-placement step.

- [ ] **Step 7: Install, then run the guards and typecheck**

```bash
cd packages/environments/chain-verification && corepack yarn@4.13.0 install
corepack yarn@4.13.0 typecheck
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs
```
Expected: install resolves the four portals; `typecheck` exits 0 (nothing to compile beyond
`src/index.ts`, which fails until T2 — so run it after T2 if the identifiers module is absent);
both guards pass.

- [ ] **Step 8: Commit**

```bash
git add packages/environments/chain-verification .github/scripts .github/workflows/environments-ci.yml
git commit -m "feat(environments): scaffold @jinn-network/chain-environment-verification"
```

---

### Task 2: Identifiers, errors, and the digest-discipline primitives

**Files:**
- Create: `src/identifiers.ts`, `src/errors.ts`, `src/digests.ts`, `src/digests.test.ts`

**Interfaces:**
- Consumes: `Sha256Digest` from `@jinn-network/trust-core`; `bareHexDigest` from
  `@jinn-network/chain-environment-record` (equivalence check only).
- Produces: `CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE`
  (`https://jinn.network/attestations/chain-environment-verification/v1`),
  `CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI`, `CHAIN_OBSERVATION_SCHEMA_ID`,
  `COMPOSITE_OBSERVATION_SCHEMA_ID`, `MINIMUM_RUN_COUNT = 5`,
  `DEFAULT_PROBE_TIMEOUT_SECONDS = 600`, `ChainVerificationError`, `invalidInput`,
  `conformanceFailure`, `PrefixedSha256Schema`, `BareHexSha256Schema`, `DigestSetSchema`,
  `ResourceDescriptorSchema`, `toDigestSet`, `fromDigestSet`.

- [ ] **Step 1: Write the failing digest-discipline test**

`src/digests.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { bareHexDigest } from "@jinn-network/chain-environment-record";
import { describe, expect, it } from "vitest";

import {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
} from "./digests.js";
import { ChainVerificationError } from "./errors.js";

const HEX = "a".repeat(64);
const PREFIXED = `sha256:${HEX}` as const;

describe("digest discipline", () => {
  it("scalar fields take the prefixed form and reject the bare one", () => {
    expect(PrefixedSha256Schema.safeParse(PREFIXED).success).toBe(true);
    expect(PrefixedSha256Schema.safeParse(HEX).success).toBe(false);
    expect(PrefixedSha256Schema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
  });

  it("in-toto DigestSet values take the bare form and reject the prefixed one", () => {
    expect(BareHexSha256Schema.safeParse(HEX).success).toBe(true);
    expect(BareHexSha256Schema.safeParse(PREFIXED).success).toBe(false);
    // The contract-6 confusion fixture, in its smallest form.
    expect(DigestSetSchema.safeParse({ sha256: PREFIXED }).success).toBe(false);
    expect(DigestSetSchema.safeParse({ sha256: HEX, sha512: HEX }).success).toBe(false);
  });

  it("round-trips through the only two sanctioned crossings", () => {
    expect(toDigestSet(PREFIXED)).toEqual({ sha256: HEX });
    expect(fromDigestSet({ sha256: HEX })).toBe(PREFIXED);
    expect(fromDigestSet(toDigestSet(PREFIXED))).toBe(PREFIXED);
  });

  it("agrees with the record package's bare-hex conversion", () => {
    // Cross-package equivalence (program contract 3): two independent implementations of the
    // same crossing must land on the same bytes, or a subject digest means two things.
    expect(toDigestSet(PREFIXED).sha256).toBe(bareHexDigest(PREFIXED));
  });

  it("refuses a malformed crossing loudly rather than coercing", () => {
    expect(() => toDigestSet(HEX as `sha256:${string}`)).toThrow(ChainVerificationError);
    expect(() => fromDigestSet({ sha256: PREFIXED } as never)).toThrow(ChainVerificationError);
  });

  it("a ResourceDescriptor carries a DigestSet and optional locators only", () => {
    expect(ResourceDescriptorSchema.safeParse({
      name: "state-artifact",
      uri: "ipfs://bafy",
      mediaType: "application/vnd.jinn.chain-state.v1",
      digest: { sha256: HEX },
    }).success).toBe(true);
    expect(ResourceDescriptorSchema.safeParse({ digest: { sha256: PREFIXED } }).success)
      .toBe(false);
    expect(ResourceDescriptorSchema.safeParse({ uri: "ipfs://bafy" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/digests.test.ts`
Expected: FAIL — `Failed to resolve import "./digests.js"`.

- [ ] **Step 3: Write `src/identifiers.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

/** in-toto `predicateType` for this attestation (design §5.3, §14). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/chain-environment-verification/v1" as const;

/** The protocol the predicate's `protocol` field names (design §5.1, §5.2). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI =
  "https://jinn.network/chain-environment-verification/protocol/1.0" as const;

/** Schema id inside the canonical observation, so a stored observation says what shape it
 * is without depending on where it was found. */
export const CHAIN_OBSERVATION_SCHEMA_ID =
  "https://jinn.network/chain-environment/observation/1.0" as const;

/** The composite observation spans the chain plane and the information plane (design §5.1
 * step 6, "the K-run observation covers chain and information planes together"). */
export const COMPOSITE_OBSERVATION_SCHEMA_ID =
  "https://jinn.network/crypto-environment/observation/1.0" as const;

/**
 * K for the v1 profile. Design E4: K inherits the parent floor and does not drop below it
 * because chain probe runs are cheap. A declared floor for a bounded observation, never a
 * convergence threshold.
 */
export const MINIMUM_RUN_COUNT = 5;

/** Per-instance probe-suite wall-clock ceiling in seconds for the v1 profile. */
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 600;

/** Media type of the sealed solution script the replayer consumes (design §14). */
export const CHAIN_SOLUTION_MEDIA_TYPE =
  "application/vnd.jinn.chain-solution.v1+json" as const;
```

- [ ] **Step 4: Write `src/errors.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

export const CHAIN_VERIFICATION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type ChainVerificationErrorCode = (typeof CHAIN_VERIFICATION_ERROR_CODES)[number];

export class ChainVerificationError extends Error {
  override readonly name = "ChainVerificationError";

  constructor(
    readonly code: ChainVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Caller error: malformed input, or a profile rule the caller broke. */
export function invalidInput(message: string, cause?: unknown): never {
  throw new ChainVerificationError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Port error: an injected dependency broke its documented contract. Never an environment
 * fact -- environment facts become attestations, not exceptions.
 */
export function conformanceFailure(message: string, cause?: unknown): never {
  throw new ChainVerificationError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
```

- [ ] **Step 5: Write `src/digests.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";

const PREFIX = "sha256:";

/** Record-body and scalar predicate digest form (design §4.1). */
export const PrefixedSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hex digits>");

/**
 * in-toto DigestSet value form: BARE lowercase hex. A `sha256:`-prefixed value here is
 * non-conformant with in-toto and is rejected (design §5.3).
 */
export const BareHexSha256Schema = z
  .string()
  .regex(
    /^[0-9a-f]{64}$/,
    "in-toto DigestSet values are bare lowercase hex, never sha256:-prefixed",
  );

export const DigestSetSchema = z.strictObject({ sha256: BareHexSha256Schema });
export type DigestSet = z.infer<typeof DigestSetSchema>;

export const ResourceDescriptorSchema = z.strictObject({
  name: z.string().min(1).optional(),
  /** A locator. Never identity -- the digest is (design §4.1). */
  uri: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
  digest: DigestSetSchema,
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

/** The only sanctioned prefixed -> DigestSet crossing. */
export function toDigestSet(digest: Sha256Digest): DigestSet {
  if (!PrefixedSha256Schema.safeParse(digest).success) {
    invalidInput(`Not a sha256:-prefixed lowercase-hex digest: ${String(digest)}`);
  }
  return { sha256: digest.slice(PREFIX.length) };
}

/** The only sanctioned DigestSet -> prefixed crossing. */
export function fromDigestSet(digestSet: DigestSet): Sha256Digest {
  if (!DigestSetSchema.safeParse(digestSet).success) {
    invalidInput("Not a conformant in-toto sha256 DigestSet (bare lowercase hex only).");
  }
  return `${PREFIX}${digestSet.sha256}`;
}
```

- [ ] **Step 6: Run the suite, then the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; all six digest tests pass; the boundary guard passes.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): chain-verification identifiers, errors, and digest discipline"
```

---

### Task 3: The canonical observation — shape, bytes, digest, equality

Design §5.1 step 7 is normative about what the observation covers and about *what gets
hashed*: "The verifier hashes the **canonical observation**, never backend JSON." This module
is that canonicalization, and it is the comparison unit of the whole protocol.

**Files:**
- Create: `src/observation.ts`, `src/observation.test.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `recordDigest`, `compareCodeUnitStrings`, `Sha256Digest`
  from `@jinn-network/trust-core`; `CHAIN_OBSERVATION_SCHEMA_ID`,
  `COMPOSITE_OBSERVATION_SCHEMA_ID` from `./identifiers.js`.
- Produces: `CanonicalChainObservationSchema`, `CanonicalChainObservation`,
  `InformationPlaneObservationSchema`, `CompositeObservationSchema`, `CompositeObservation`,
  `buildCanonicalChainObservation(raw): CanonicalChainObservation`,
  `canonicalChainObservationBytes(observation): Uint8Array`,
  `chainObservationDigest(observation): Sha256Digest`,
  `compositeObservationBytes` / `compositeObservationDigest`,
  `chainObservationsEqual(left, right): boolean`.

**Why every quantity is a string.** A wei balance or a gas figure past 2^53 loses precision as
a JSON number, so two honest runs of the same world could produce different canonical bytes
for the same state. Balances, gas, nonces, block numbers, and timestamps are therefore decimal
strings; addresses, slots, values, topics, and data are lowercase `0x` hex. The schema
enforces the spellings; nothing downstream has to remember.

- [ ] **Step 1: Write the failing observation test**

`src/observation.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_OBSERVATION_SCHEMA_ID } from "./identifiers.js";
import {
  CanonicalChainObservationSchema,
  buildCanonicalChainObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
  chainObservationsEqual,
} from "./observation.js";

const RAW = {
  schema: CHAIN_OBSERVATION_SCHEMA_ID,
  probes: [
    {
      id: "transfer-happy-path",
      transactionDigest: `sha256:${"1".repeat(64)}`,
      receiptStatus: "success",
      gasUsed: "51234",
      logs: [{
        address: "0x00000000000000000000000000000000000000aa",
        topics: [`0x${"2".repeat(64)}`],
        data: "0x00",
      }],
      returnData: "0x",
    },
    {
      id: "out-of-slice-read-is-empty",
      receiptStatus: "not-executed",
      gasUsed: "0",
      logs: [],
      returnData: "0x",
      expectedErrorClass: "empty-account",
      observedErrorClass: "empty-account",
    },
  ],
  touchedState: [
    {
      address: "0x00000000000000000000000000000000000000bb",
      nonce: "1",
      balance: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      codeHash: `0x${"3".repeat(64)}`,
      storage: [
        { slot: `0x${"0".repeat(63)}2`, value: `0x${"0".repeat(63)}9` },
        { slot: `0x${"0".repeat(63)}1`, value: `0x${"0".repeat(63)}7` },
      ],
    },
    {
      address: "0x00000000000000000000000000000000000000aa",
      nonce: "0",
      balance: "0",
      codeHash: `0x${"4".repeat(64)}`,
      storage: [],
    },
  ],
  traceProjectionDigest: `sha256:${"5".repeat(64)}`,
  finalStateCommitment: `0x${"6".repeat(64)}`,
  blocks: [{
    number: "17",
    hash: `0x${"7".repeat(64)}`,
    stateRoot: `0x${"8".repeat(64)}`,
    timestamp: "1900000000",
  }],
} as const;

describe("canonical chain observation", () => {
  it("accepts the reference observation", () => {
    expect(CanonicalChainObservationSchema.safeParse(RAW).success).toBe(true);
  });

  it("sorts touched state and storage, and leaves probes in declared order", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonical.touchedState.map((entry) => entry.address)).toEqual([
      "0x00000000000000000000000000000000000000aa",
      "0x00000000000000000000000000000000000000bb",
    ]);
    const bb = canonical.touchedState[1]!;
    expect(bb.storage.map((slot) => slot.slot)).toEqual([
      `0x${"0".repeat(63)}1`,
      `0x${"0".repeat(63)}2`,
    ]);
    // Probe order is semantic: the suite declares it, so canonicalization must not reorder.
    expect(canonical.probes.map((probe) => probe.id)).toEqual([
      "transfer-happy-path",
      "out-of-slice-read-is-empty",
    ]);
  });

  it("hashes the canonical form, so a permuted input digests identically", () => {
    const permuted = {
      ...RAW,
      touchedState: [RAW.touchedState[1], RAW.touchedState[0]],
    };
    expect(chainObservationDigest(buildCanonicalChainObservation(permuted)))
      .toBe(chainObservationDigest(buildCanonicalChainObservation(RAW)));
    expect(chainObservationsEqual(
      buildCanonicalChainObservation(permuted),
      buildCanonicalChainObservation(RAW),
    )).toBe(true);
  });

  it("digests the RFC 8785 bytes of the canonical form and nothing else", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonicalChainObservationBytes(canonical))
      .toEqual(canonicalJsonBytes(canonical));
    expect(chainObservationDigest(canonical))
      .toBe(recordDigest(canonicalJsonBytes(canonical)));
  });

  it("carries large quantities as strings so precision cannot be lost", () => {
    const canonical = buildCanonicalChainObservation(RAW);
    expect(canonical.touchedState[1]!.balance)
      .toBe("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    expect(() => buildCanonicalChainObservation({
      ...RAW,
      touchedState: [{ ...RAW.touchedState[0], balance: 1 }],
    })).toThrow(ChainVerificationError);
  });

  it("rejects uppercase hex, bare quantities, and unknown keys", () => {
    for (const mutation of [
      { touchedState: [{ ...RAW.touchedState[0], address: "0x00000000000000000000000000000000000000AA" }] },
      { touchedState: [{ ...RAW.touchedState[0], nonce: "0x1" }] },
      { traceProjectionDigest: "5".repeat(64) },
      { unexpected: true },
    ]) {
      expect(CanonicalChainObservationSchema.safeParse({ ...RAW, ...mutation }).success)
        .toBe(false);
    }
  });

  it("detects divergence in any covered dimension", () => {
    const base = buildCanonicalChainObservation(RAW);
    for (const mutation of [
      { finalStateCommitment: `0x${"0".repeat(64)}` },
      { traceProjectionDigest: `sha256:${"0".repeat(64)}` },
      { blocks: [{ ...RAW.blocks[0], timestamp: "1900000001" }] },
      { probes: [{ ...RAW.probes[0], gasUsed: "51235" }, RAW.probes[1]] },
    ]) {
      const other = buildCanonicalChainObservation({ ...RAW, ...mutation });
      expect(chainObservationsEqual(base, other)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/observation.test.ts`
Expected: FAIL — `Failed to resolve import "./observation.js"`.

- [ ] **Step 3: Implement `src/observation.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema } from "./digests.js";
import { invalidInput } from "./errors.js";
import { CHAIN_OBSERVATION_SCHEMA_ID, COMPOSITE_OBSERVATION_SCHEMA_ID } from "./identifiers.js";

/**
 * Every chain quantity travels as a decimal string. A wei balance or a gas figure past 2^53
 * loses precision as a JSON number, which would change the canonical bytes of an unchanged
 * world between two honest runs.
 */
const QuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u, "must be a decimal quantity");
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const Word32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u, "must be a lowercase 0x 32-byte word");
const HexBytesSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/u, "must be lowercase 0x bytes");

export const LogEntrySchema = z.strictObject({
  address: AddressSchema,
  topics: z.array(Word32Schema),
  data: HexBytesSchema,
});

export const PROBE_RECEIPT_STATUSES = ["success", "reverted", "not-executed"] as const;

export const ProbeOutcomeSchema = z.strictObject({
  id: z.string().min(1),
  /** Digest of the raw signed transaction bytes, when the probe sent one. */
  transactionDigest: PrefixedSha256Schema.optional(),
  receiptStatus: z.enum(PROBE_RECEIPT_STATUSES),
  gasUsed: QuantitySchema,
  /** Ordered. Log order is consensus-observable and part of the claim. */
  logs: z.array(LogEntrySchema),
  returnData: HexBytesSchema,
  /** Negative probes declare the class they expect; both sides are recorded so a divergence
   * names which one moved. */
  expectedErrorClass: z.string().min(1).optional(),
  observedErrorClass: z.string().min(1).optional(),
});
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;

export const StorageEntrySchema = z.strictObject({
  slot: Word32Schema,
  value: Word32Schema,
});

export const TouchedStateEntrySchema = z.strictObject({
  address: AddressSchema,
  nonce: QuantitySchema,
  balance: QuantitySchema,
  codeHash: Word32Schema,
  storage: z.array(StorageEntrySchema),
});
export type TouchedStateEntry = z.infer<typeof TouchedStateEntrySchema>;

/** One resolved `callResult` / `reportedValue.groundTruth` read (ruling CR6). */
export const StateReadOutcomeSchema = z.strictObject({
  /** CE2's derived key. CE3 re-derives it identically; the equivalence fixture proves it. */
  key: z.string().min(1),
  /** Which world the read was executed against. Baseline reads are the pre-replay ground truth
   * the design's `reportedValue` rule depends on; mis-tagging one re-opens the gaming case. */
  state: z.enum(["baseline", "post-replay"]),
  to: AddressSchema,
  /** The exact calldata that was sent -- recorded so a third party can re-issue the call. */
  calldata: HexBytesSchema,
  returnData: HexBytesSchema,
  /** `reverted` is a legitimate observation, not an error: a predicate may expect it. */
  status: z.enum(["success", "reverted"]),
});
export type StateReadOutcome = z.infer<typeof StateReadOutcomeSchema>;

export const BlockCommitmentSchema = z.strictObject({
  number: QuantitySchema,
  hash: Word32Schema,
  stateRoot: Word32Schema,
  timestamp: QuantitySchema,
});

/** Design §5.1 step 7's list, one field per clause. */
export const CanonicalChainObservationSchema = z.strictObject({
  schema: z.literal(CHAIN_OBSERVATION_SCHEMA_ID),
  probes: z.array(ProbeOutcomeSchema),
  touchedState: z.array(TouchedStateEntrySchema),
  /**
   * Resolved structured reads, keyed by CE2's `stateReadKey` (ruling CR6). Sorted by key, so
   * the projection's bytes do not depend on the order the reads were issued. This is what the
   * pure predicate evaluator looks up: a key that differs by one character makes it report
   * `unevaluable` for a read that actually happened.
   */
  stateReads: z.array(StateReadOutcomeSchema),
  traceProjectionDigest: PrefixedSha256Schema,
  /** A state commitment, not a content digest: `0x` + 64 hex, the spelling CE1's record uses
   * for `initialStateCommitment` and the spelling `reset` returns. */
  finalStateCommitment: Word32Schema,
  blocks: z.array(BlockCommitmentSchema),
});
export type CanonicalChainObservation = z.infer<typeof CanonicalChainObservationSchema>;

/** Design §5.1 step 6's information-plane probes, as an observation the K-run comparison
 * covers alongside the chain plane. */
export const InformationPlaneObservationSchema = z.strictObject({
  worlds: z.array(z.strictObject({
    world: PrefixedSha256Schema,
    entries: z.array(z.strictObject({
      requestKey: z.string().min(1),
      responseDigest: PrefixedSha256Schema,
    })),
    /** The permuted-header/query probe of design §4.4: two spellings of one request must
     * resolve to one entry, or the world is not repeat-stable. */
    requestKeyEquivalence: z.enum(["equivalent", "divergent"]),
    missPolicyObservation: z.strictObject({
      requestKey: z.string().min(1),
      responseDigest: PrefixedSha256Schema,
    }),
  })),
  budget: z.strictObject({
    requests: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    enforced: z.boolean(),
  }),
});
export type InformationPlaneObservation = z.infer<typeof InformationPlaneObservationSchema>;

export const CompositeObservationSchema = z.strictObject({
  schema: z.literal(COMPOSITE_OBSERVATION_SCHEMA_ID),
  chain: CanonicalChainObservationSchema,
  information: InformationPlaneObservationSchema,
});
export type CompositeObservation = z.infer<typeof CompositeObservationSchema>;

function parseObservation(value: unknown): CanonicalChainObservation {
  const result = CanonicalChainObservationSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain observation at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain observation.",
    );
  }
  return result.data;
}

/**
 * Parses a runtime-supplied observation and puts it in canonical order. Sets (touched state,
 * storage) are sorted by code units; sequences whose order is semantic (probes, logs, blocks)
 * are left exactly as the suite produced them.
 */
export function buildCanonicalChainObservation(value: unknown): CanonicalChainObservation {
  const parsed = parseObservation(value);
  return {
    ...parsed,
    touchedState: [...parsed.touchedState]
      .map((entry) => ({
        ...entry,
        storage: [...entry.storage].sort((left, right) =>
          compareCodeUnitStrings(left.slot, right.slot)),
      }))
      .sort((left, right) => compareCodeUnitStrings(left.address, right.address)),
    stateReads: [...parsed.stateReads]
      .sort((left, right) => compareCodeUnitStrings(left.key, right.key)),
  };
}

/** RFC 8785 bytes of the canonical observation -- the bytes stored through the artifact port
 * and the bytes the digest covers, so a third party can recompute it from what it retrieved. */
export function canonicalChainObservationBytes(
  observation: CanonicalChainObservation,
): Uint8Array {
  return canonicalJsonBytes(parseObservation(observation));
}

export function chainObservationDigest(observation: CanonicalChainObservation): Sha256Digest {
  return recordDigest(canonicalChainObservationBytes(observation));
}

/** Observation equality over the canonical form. Wall time, memory, and every other cost
 * observation stay out of it -- they are recorded, not compared (design §5.3). */
export function chainObservationsEqual(
  left: CanonicalChainObservation,
  right: CanonicalChainObservation,
): boolean {
  return chainObservationDigest(left) === chainObservationDigest(right);
}

export function buildCompositeObservation(value: unknown): CompositeObservation {
  const result = CompositeObservationSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid composite observation at /${first.path.join("/")}: ${first.message}`
        : "Invalid composite observation.",
    );
  }
  return {
    ...result.data,
    chain: buildCanonicalChainObservation(result.data.chain),
  };
}

export function compositeObservationBytes(observation: CompositeObservation): Uint8Array {
  return canonicalJsonBytes(buildCompositeObservation(observation));
}

export function compositeObservationDigest(observation: CompositeObservation): Sha256Digest {
  return recordDigest(compositeObservationBytes(observation));
}
```

- [ ] **Step 4: Run the suite and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; all seven observation tests pass; the boundary guard passes
(note the locale sweep: sorting uses `compareCodeUnitStrings`, never `localeCompare`).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): canonical chain and composite observations"
```

---

### Task 4: The outcome vocabulary, stages, reasons, and dispositions

Design §5.3 gives a **closed** 14-member outcome partition. This module makes it a type, adds
the run-bearing partition the predicate's presence rule needs, and maps a finer reason
taxonomy onto it plus the four-way pipeline disposition.

**Files:**
- Create: `src/outcomes.ts`, `src/outcomes.test.ts`

**Interfaces:**
- Consumes: nothing outside this package.
- Produces: `CHAIN_VERIFICATION_OUTCOMES`, `ChainVerificationOutcome`,
  `RUN_BEARING_OUTCOMES`, `isRunBearingOutcome`, `CHAIN_VERIFICATION_STAGES`,
  `ChainVerificationStage`, `CHAIN_VERIFICATION_FAILURE_REASONS`,
  `ChainVerificationFailureReason`, `outcomeForFailureReason`, `stageForFailureReason`,
  `classifyChainVerificationFailure`, `CHAIN_VERIFICATION_DISPOSITIONS`.

- [ ] **Step 1: Write the failing taxonomy test**

`src/outcomes.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CHAIN_VERIFICATION_DISPOSITIONS,
  CHAIN_VERIFICATION_FAILURE_REASONS,
  CHAIN_VERIFICATION_OUTCOMES,
  CHAIN_VERIFICATION_STAGES,
  RUN_BEARING_OUTCOMES,
  classifyChainVerificationFailure,
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
} from "./outcomes.js";

describe("outcome vocabulary", () => {
  it("is exactly design §5.3's closed partition", () => {
    expect([...CHAIN_VERIFICATION_OUTCOMES]).toEqual([
      "closed-reproducible",
      "archive-observed",
      "artifact-unavailable",
      "runtime-identity-mismatch",
      "source-anchor-mismatch",
      "source-proof-invalid",
      "initial-state-mismatch",
      "offline-dependency-detected",
      "capability-mismatch",
      "probe-divergence",
      "reset-divergence",
      "provider-disagreement",
      "source-coverage-incomplete",
      "verification-infrastructure-failure",
    ]);
    expect(new Set(CHAIN_VERIFICATION_OUTCOMES).size).toBe(14);
  });

  it("splits run-bearing outcomes from the rest, and the split is total", () => {
    expect([...RUN_BEARING_OUTCOMES]).toEqual([
      "closed-reproducible",
      "archive-observed",
      "probe-divergence",
      "reset-divergence",
      "provider-disagreement",
    ]);
    for (const outcome of CHAIN_VERIFICATION_OUTCOMES) {
      expect(isRunBearingOutcome(outcome))
        .toBe((RUN_BEARING_OUTCOMES as readonly string[]).includes(outcome));
    }
  });

  it("maps every reason to exactly one outcome and one stage", () => {
    for (const reason of CHAIN_VERIFICATION_FAILURE_REASONS) {
      expect(CHAIN_VERIFICATION_OUTCOMES).toContain(outcomeForFailureReason(reason));
      expect(CHAIN_VERIFICATION_STAGES).toContain(stageForFailureReason(reason));
      expect(CHAIN_VERIFICATION_DISPOSITIONS)
        .toContain(classifyChainVerificationFailure(reason));
    }
  });

  it("never routes a failure reason to a success outcome", () => {
    for (const reason of CHAIN_VERIFICATION_FAILURE_REASONS) {
      expect(outcomeForFailureReason(reason)).not.toBe("closed-reproducible");
      expect(outcomeForFailureReason(reason)).not.toBe("archive-observed");
    }
  });

  it("reaches every non-success outcome from at least one reason", () => {
    const reachable = new Set(
      CHAIN_VERIFICATION_FAILURE_REASONS.map((reason) => outcomeForFailureReason(reason)),
    );
    for (const outcome of CHAIN_VERIFICATION_OUTCOMES) {
      if (outcome === "closed-reproducible" || outcome === "archive-observed") continue;
      expect(reachable.has(outcome), `${outcome} is unreachable`).toBe(true);
    }
  });

  it("keeps divergence quarantined and infrastructure retryable", () => {
    expect(classifyChainVerificationFailure("probe-observation-divergence")).toBe("quarantined");
    expect(classifyChainVerificationFailure("egress-succeeded")).toBe("quarantined");
    expect(classifyChainVerificationFailure("materializer-failed"))
      .toBe("failed_infrastructure");
    // A record whose claims do not hold needs a corrected record, not another attempt.
    expect(classifyChainVerificationFailure("anchor-root-mismatch")).toBe("awaiting_input");
    expect(classifyChainVerificationFailure("resource-digest-mismatch")).toBe("terminal_policy");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/outcomes.test.ts`
Expected: FAIL — `Failed to resolve import "./outcomes.js"`.

- [ ] **Step 3: Implement `src/outcomes.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Design §5.3's closed outcome partition, in the order the design lists it. Adding a member
 * is a design amendment, not a local choice: consumers match on these identifiers.
 */
export const CHAIN_VERIFICATION_OUTCOMES = [
  "closed-reproducible",
  "archive-observed",
  "artifact-unavailable",
  "runtime-identity-mismatch",
  "source-anchor-mismatch",
  "source-proof-invalid",
  "initial-state-mismatch",
  "offline-dependency-detected",
  "capability-mismatch",
  "probe-divergence",
  "reset-divergence",
  "provider-disagreement",
  "source-coverage-incomplete",
  "verification-infrastructure-failure",
] as const;
export type ChainVerificationOutcome = (typeof CHAIN_VERIFICATION_OUTCOMES)[number];

/**
 * The outcomes for which a complete K-run observation exists. Design §5.3's presence rule is
 * "repetition/observation blocks present iff runs occurred"; this is that rule as a closed
 * set, so the predicate schema can enforce it mechanically rather than by prose (Finding
 * F-CE3-3). Everything else carries partial observations as `evidence`, never as `runs`: a
 * truncated run sequence is not a repetition claim.
 */
export const RUN_BEARING_OUTCOMES = [
  "closed-reproducible",
  "archive-observed",
  "probe-divergence",
  "reset-divergence",
  "provider-disagreement",
] as const;
export type RunBearingOutcome = (typeof RUN_BEARING_OUTCOMES)[number];

export function isRunBearingOutcome(
  outcome: ChainVerificationOutcome,
): outcome is RunBearingOutcome {
  return (RUN_BEARING_OUTCOMES as readonly string[]).includes(outcome);
}

/** The protocol stages of design §5.1, in execution order; steps 8-9 collapse into `compare`. */
export const CHAIN_VERIFICATION_STAGES = [
  "resolve",      // step 1
  "isolate",      // step 2
  "identify",     // step 3
  "provenance",   // step 4
  "instantiate",  // step 5
  "probe",        // step 6
  "execute",      // step 7
  "compare",      // steps 8-9
] as const;
export type ChainVerificationStage = (typeof CHAIN_VERIFICATION_STAGES)[number];

/** The closed reason vocabulary the predicate's `failure.reason` draws from. Free-form
 * detail rides in `failure.detail`; the code is what consumers match. */
export const CHAIN_VERIFICATION_FAILURE_REASONS = [
  // resolve
  "resource-unresolvable",
  "resource-digest-mismatch",
  // isolate + compare-time closure
  "egress-succeeded",
  "fork-backend-fetch-unrefused",
  "uncommitted-resource-loaded",
  "out-of-slice-read-not-empty",
  // identify (step 3 covers determinism controls, per design §5.1)
  "runtime-image-mismatch",
  "runtime-version-mismatch",
  "runtime-chain-id-mismatch",
  "determinism-control-unsupported",
  // provenance
  "anchor-block-mismatch",
  "anchor-root-mismatch",
  "state-proof-invalid",
  "code-hash-mismatch",
  "artifact-entry-uncovered",
  "undeclared-source-mutation",
  // instantiate
  "post-fixture-commitment-mismatch",
  "fixture-transcript-mismatch",
  // probe (capability, isolation, composition)
  "rpc-allowlist-violation",
  "signer-scope-violation",
  "ceiling-not-enforced",
  "fixture-probe-failed",
  "origin-routing-collision",
  "request-key-divergence",
  "miss-policy-violation",
  "request-budget-not-enforced",
  // compare
  "probe-observation-divergence",
  "reset-observation-divergence",
  "provider-observation-disagreement",
  // infrastructure
  "materializer-failed",
  // CE1's `ChainInstance.report` is optional so a solver's local runner is not forced to
  // synthesise evidence it has no use for. A materializer used for verification must produce
  // one; its absence is checked, never asserted away (CE1 correction 3).
  "materialization-report-absent",
  "probe-executor-failed",
  "run-timeout",
  "information-runtime-absent",
] as const;
export type ChainVerificationFailureReason =
  (typeof CHAIN_VERIFICATION_FAILURE_REASONS)[number];

const OUTCOME_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationOutcome>
> = Object.freeze({
  "resource-unresolvable": "artifact-unavailable",
  "resource-digest-mismatch": "artifact-unavailable",

  "egress-succeeded": "offline-dependency-detected",
  "fork-backend-fetch-unrefused": "offline-dependency-detected",
  "uncommitted-resource-loaded": "offline-dependency-detected",
  // §4.2's boundary rule: outside the slice reads EMPTY. A non-empty answer means something
  // supplied state the artifact does not carry.
  "out-of-slice-read-not-empty": "offline-dependency-detected",

  "runtime-image-mismatch": "runtime-identity-mismatch",
  "runtime-version-mismatch": "runtime-identity-mismatch",
  "runtime-chain-id-mismatch": "runtime-identity-mismatch",
  // §5.1 step 3 verifies determinism controls as part of runtime identity, and §10 warns that
  // a pinned Anvil may not support every control a record declares. Declaring a control the
  // runtime cannot apply is exactly the over-claim contract 7 exists to stop.
  "determinism-control-unsupported": "runtime-identity-mismatch",

  "anchor-block-mismatch": "source-anchor-mismatch",
  "anchor-root-mismatch": "source-anchor-mismatch",
  "state-proof-invalid": "source-proof-invalid",
  "code-hash-mismatch": "source-proof-invalid",
  "artifact-entry-uncovered": "source-coverage-incomplete",
  "undeclared-source-mutation": "source-coverage-incomplete",

  "post-fixture-commitment-mismatch": "initial-state-mismatch",
  "fixture-transcript-mismatch": "initial-state-mismatch",

  "rpc-allowlist-violation": "capability-mismatch",
  "signer-scope-violation": "capability-mismatch",
  "ceiling-not-enforced": "capability-mismatch",
  "fixture-probe-failed": "capability-mismatch",
  // Composition properties are part of the declared capability surface of the composite
  // (Finding F-CE3-5): the outcome vocabulary is closed and `capability-mismatch` is the
  // honest member for a world whose declared routing, budget, or miss policy does not hold.
  "origin-routing-collision": "capability-mismatch",
  "request-key-divergence": "capability-mismatch",
  "miss-policy-violation": "capability-mismatch",
  "request-budget-not-enforced": "capability-mismatch",

  "probe-observation-divergence": "probe-divergence",
  "reset-observation-divergence": "reset-divergence",
  "provider-observation-disagreement": "provider-disagreement",

  "materializer-failed": "verification-infrastructure-failure",
  "materialization-report-absent": "verification-infrastructure-failure",
  "probe-executor-failed": "verification-infrastructure-failure",
  "run-timeout": "verification-infrastructure-failure",
  "information-runtime-absent": "verification-infrastructure-failure",
});

const STAGE_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationStage>
> = Object.freeze({
  "resource-unresolvable": "resolve",
  "resource-digest-mismatch": "resolve",
  "egress-succeeded": "isolate",
  "fork-backend-fetch-unrefused": "isolate",
  "uncommitted-resource-loaded": "compare",
  "out-of-slice-read-not-empty": "probe",
  "runtime-image-mismatch": "identify",
  "runtime-version-mismatch": "identify",
  "runtime-chain-id-mismatch": "identify",
  "determinism-control-unsupported": "identify",
  "anchor-block-mismatch": "provenance",
  "anchor-root-mismatch": "provenance",
  "state-proof-invalid": "provenance",
  "code-hash-mismatch": "provenance",
  "artifact-entry-uncovered": "provenance",
  "undeclared-source-mutation": "provenance",
  "post-fixture-commitment-mismatch": "instantiate",
  "fixture-transcript-mismatch": "instantiate",
  "rpc-allowlist-violation": "probe",
  "signer-scope-violation": "probe",
  "ceiling-not-enforced": "probe",
  "fixture-probe-failed": "probe",
  "origin-routing-collision": "probe",
  "request-key-divergence": "probe",
  "miss-policy-violation": "probe",
  "request-budget-not-enforced": "probe",
  "probe-observation-divergence": "compare",
  "reset-observation-divergence": "compare",
  "provider-observation-disagreement": "compare",
  "materializer-failed": "instantiate",
  "materialization-report-absent": "instantiate",
  "probe-executor-failed": "execute",
  "run-timeout": "execute",
  "information-runtime-absent": "resolve",
});

/** The four-way pipeline disposition, rewritten over this package's own vocabulary. */
export const CHAIN_VERIFICATION_DISPOSITIONS = [
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type ChainVerificationDisposition =
  (typeof CHAIN_VERIFICATION_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationDisposition>
> = Object.freeze({
  // The store or the host was having a bad day; the same record may resolve later.
  "resource-unresolvable": "failed_infrastructure",
  "materializer-failed": "failed_infrastructure",
  "materialization-report-absent": "failed_infrastructure",
  "probe-executor-failed": "failed_infrastructure",
  "run-timeout": "failed_infrastructure",
  "information-runtime-absent": "failed_infrastructure",

  // The record names a digest that resolves to other bytes. Retrying the same record can only
  // reproduce it; the record itself must change.
  "resource-digest-mismatch": "terminal_policy",

  // The record makes a claim its own materials do not support. A corrected record is the only
  // thing that moves this forward.
  "runtime-image-mismatch": "awaiting_input",
  "runtime-version-mismatch": "awaiting_input",
  "runtime-chain-id-mismatch": "awaiting_input",
  "determinism-control-unsupported": "awaiting_input",
  "anchor-block-mismatch": "awaiting_input",
  "anchor-root-mismatch": "awaiting_input",
  "state-proof-invalid": "awaiting_input",
  "code-hash-mismatch": "awaiting_input",
  "artifact-entry-uncovered": "awaiting_input",
  "undeclared-source-mutation": "awaiting_input",
  "post-fixture-commitment-mismatch": "awaiting_input",
  "fixture-transcript-mismatch": "awaiting_input",

  // The world ran and behaved against its own declarations, or disagreed with itself. A
  // published fact, not a bug in the pipeline.
  "egress-succeeded": "quarantined",
  "fork-backend-fetch-unrefused": "quarantined",
  "uncommitted-resource-loaded": "quarantined",
  "out-of-slice-read-not-empty": "quarantined",
  "rpc-allowlist-violation": "quarantined",
  "signer-scope-violation": "quarantined",
  "ceiling-not-enforced": "quarantined",
  "fixture-probe-failed": "quarantined",
  "origin-routing-collision": "quarantined",
  "request-key-divergence": "quarantined",
  "miss-policy-violation": "quarantined",
  "request-budget-not-enforced": "quarantined",
  "probe-observation-divergence": "quarantined",
  "reset-observation-divergence": "quarantined",
  "provider-observation-disagreement": "quarantined",
});

export function outcomeForFailureReason(
  reason: ChainVerificationFailureReason,
): ChainVerificationOutcome {
  return OUTCOME_BY_REASON[reason];
}

export function stageForFailureReason(
  reason: ChainVerificationFailureReason,
): ChainVerificationStage {
  return STAGE_BY_REASON[reason];
}

export function classifyChainVerificationFailure(
  reason: ChainVerificationFailureReason,
): ChainVerificationDisposition {
  return DISPOSITION_BY_REASON[reason];
}
```

- [ ] **Step 4: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all six taxonomy tests pass (in particular the totality test —
every non-success outcome is reachable from at least one reason).

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): chain verification outcome vocabulary and failure taxonomy"
```

---

### Task 5: The predicate schema and its cross-field rules

Design §5.3's predicate, as a closed schema whose cross-field rules make the honesty rules
mechanically unforgeable. Every rule below exists because a re-signed payload could otherwise
state something the runs did not show.

**Files:**
- Create: `src/predicate.ts`, `src/predicate.test.ts`

**Interfaces:**
- Consumes: `isCalendarStrictRfc3339` from `@jinn-network/trust-core`; `PrefixedSha256Schema`,
  `ResourceDescriptorSchema` from `./digests.js`; the vocabularies from `./outcomes.js`;
  `CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI`, `MINIMUM_RUN_COUNT` from `./identifiers.js`.
- Produces: `ChainEnvironmentVerificationPredicateSchema`,
  `parseChainEnvironmentVerificationPredicate`, `ChainEnvironmentVerificationPredicate`,
  `VerificationWindow`, `VerifierIdentity`, `EnvironmentObservation`, `RunsBlock`,
  `BaselineBlock`, `IsolationEvidence`, `CostObservations`, `ProviderObservation`,
  `CompositionEvidence`, `FailureBlock`.

- [ ] **Step 1: Write the failing predicate test**

`src/predicate.test.ts` — a valid `closed-reproducible` fixture plus one mutation per rule:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI } from "./identifiers.js";
import {
  ChainEnvironmentVerificationPredicateSchema,
  parseChainEnvironmentVerificationPredicate,
} from "./predicate.js";

const OBSERVATION = `sha256:${"1".repeat(64)}`;
const OBSERVATION_HEX = "1".repeat(64);

function perRun(count: number, digest = OBSERVATION) {
  return Array.from({ length: count }, (_unused, index) => ({
    instanceId: `instance-${index}`,
    observationDigest: digest,
    wallSeconds: 3 + index,
  }));
}

const CLOSED = {
  protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  scope: "component",
  outcome: "closed-reproducible",
  window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:04:00.000Z" },
  verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: `sha256:${"7".repeat(64)}` },
  materials: [{ name: "state-artifact", digest: { sha256: "2".repeat(64) } }],
  environment: {
    closureClass: "closed-state",
    fidelityClass: "anchored-subset",
    anchor: {
      caip2: "eip155:1",
      chainId: 1,
      blockNumber: "20000000",
      blockHash: `0x${"3".repeat(64)}`,
      stateRoot: `0x${"4".repeat(64)}`,
      timestamp: "1900000000",
      finalityPolicy: "finalized",
      authenticity: "declared",
    },
    runtime: {
      family: "anvil",
      version: "1.4.2",
      imageManifestDigest: `sha256:${"5".repeat(64)}`,
      platform: "linux/amd64",
      binaryDigest: `sha256:${"6".repeat(64)}`,
      reportedVersion: "anvil 1.4.2",
      evmConfigurationDigest: `sha256:${"8".repeat(64)}`,
      chainId: 1,
    },
    postFixtureCommitment: `0x${"9".repeat(64)}`,
    controls: { miningMode: "manual", prevrandao: "0x00", initialTimestamp: "1900000000" },
    envelope: {
      rpcAllowlist: { read: ["eth_call"], stateChanging: ["eth_sendRawTransaction"] },
      signerRoles: ["agent"],
      permittedChainId: 1,
      maxima: { transactions: "8", aggregateGas: "4000000" },
      egressPolicyId: "blackhole/1.0",
    },
    coverage: { proofCovered: 12, fixtureDeclared: 3, uncovered: 0, mutatesSourceProtocolState: true },
  },
  runs: {
    count: 5,
    observationDigest: OBSERVATION,
    perRun: perRun(5),
    allObservationsEqual: true,
    freshInstances: true,
  },
  baseline: {
    commitment: `0x${"a".repeat(64)}`,
    observation: { name: "observation", digest: { sha256: OBSERVATION_HEX } },
  },
  isolation: {
    networkPolicy: { egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent" },
    closureEvidenceMode: "sealed-boundary",
    boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
    egressAttempts: [],
    forbiddenProbes: [{ method: "anvil_setBalance", expectedClass: "method-not-allowed", observedClass: "method-not-allowed", passed: true }],
    signerScope: { declaredRoles: ["agent"], exposedAccounts: ["0x00000000000000000000000000000000000000aa"], unexpectedAccounts: [] },
    resolutionLog: { name: "resolution-log", digest: { sha256: "b".repeat(64) } },
  },
  cost: { artifactBytes: 4096, artifactCount: 3, wallSeconds: 21 },
} as const;

function reject(mutation: Record<string, unknown>, note: string): void {
  const candidate = { ...CLOSED, ...mutation };
  expect(
    ChainEnvironmentVerificationPredicateSchema.safeParse(candidate).success,
    note,
  ).toBe(false);
}

describe("chain environment verification predicate", () => {
  it("accepts the reference closed-reproducible predicate", () => {
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(CLOSED).success).toBe(true);
  });

  it("requires the window on every outcome and rejects an inverted one", () => {
    const { window: _window, ...withoutWindow } = CLOSED;
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(withoutWindow).success)
      .toBe(false);
    reject(
      { window: { startedAt: "2026-07-31T09:04:00.000Z", endedAt: "2026-07-31T09:00:00.000Z" } },
      "endedAt must not precede startedAt",
    );
  });

  it("carries runs and baseline iff the outcome is run-bearing", () => {
    const { runs: _runs, baseline: _baseline, ...withoutRuns } = CLOSED;
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(withoutRuns).success)
      .toBe(false);
    // A non-run-bearing outcome carrying runs is the forged-repetition case.
    reject(
      {
        outcome: "artifact-unavailable",
        failure: { stage: "resolve", reason: "resource-unresolvable" },
      },
      "artifact-unavailable must not carry runs",
    );
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...withoutRuns,
      outcome: "artifact-unavailable",
      failure: { stage: "resolve", reason: "resource-unresolvable", detail: "gone" },
    }).success).toBe(true);
  });

  it("requires every per-run observation digest to equal the canonical one", () => {
    const divergent = perRun(5);
    divergent[2] = { ...divergent[2]!, observationDigest: `sha256:${"c".repeat(64)}` };
    reject(
      { runs: { ...CLOSED.runs, perRun: divergent } },
      "closed-reproducible with a divergent per-run digest",
    );
  });

  it("keeps allObservationsEqual honest against the per-run digests", () => {
    const divergent = perRun(5);
    divergent[3] = { ...divergent[3]!, observationDigest: `sha256:${"c".repeat(64)}` };
    reject(
      {
        outcome: "probe-divergence",
        runs: { ...CLOSED.runs, perRun: divergent, allObservationsEqual: true },
        failure: {
          stage: "compare",
          reason: "probe-observation-divergence",
          divergence: {
            referenceRunIndex: 0,
            referenceObservationDigest: OBSERVATION,
            divergentRuns: [{
              index: 3,
              instanceId: "instance-3",
              observationDigest: `sha256:${"c".repeat(64)}`,
              observation: { digest: { sha256: "c".repeat(64) } },
            }],
          },
        },
      },
      "allObservationsEqual must be computed, not asserted",
    );
  });

  it("requires K to be at least the declared floor", () => {
    reject(
      { runs: { ...CLOSED.runs, count: 4, perRun: perRun(4) } },
      "K below the floor",
    );
    reject({ runs: { ...CLOSED.runs, count: 6 } }, "count must equal perRun.length");
  });

  it("requires fresh instance ids when freshInstances is claimed", () => {
    const repeated = perRun(5).map((run) => ({ ...run, instanceId: "instance-0" }));
    reject(
      { runs: { ...CLOSED.runs, perRun: repeated } },
      "a fresh-instantiation claim needs distinct instance ids",
    );
  });

  it("binds the baseline artifact to the canonical observation digest", () => {
    reject(
      { baseline: { ...CLOSED.baseline, observation: { digest: { sha256: "d".repeat(64) } } } },
      "baseline must name the canonical observation",
    );
  });

  it("keeps the closure evidence mode consistent with the fork backend", () => {
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          networkPolicy: { ...CLOSED.isolation.networkPolicy, forkBackend: "present" },
        },
      },
      "a present fork backend is the fork-backend-refusal mode",
    );
  });

  it("requires a refused fetch attempt in fork-backend mode", () => {
    const forkBacked = {
      ...CLOSED.isolation,
      networkPolicy: { ...CLOSED.isolation.networkPolicy, forkBackend: "present" },
      closureEvidenceMode: "fork-backend-refusal",
      boundaryProbe: undefined,
      egressAttempts: [],
    };
    reject(
      { isolation: forkBacked },
      "fork-backend closure evidence is the refusal, so an attempt must be recorded",
    );
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...CLOSED,
      isolation: {
        ...forkBacked,
        egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
      },
    }).success).toBe(true);
  });

  it("requires the boundary probe in sealed mode, and refuses it in the other", () => {
    reject(
      { isolation: { ...CLOSED.isolation, boundaryProbe: undefined } },
      "sealed closure needs the boundary-rule probe, not the absence of errors",
    );
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
        },
      },
      "an out-of-slice read that is not empty is not closure",
    );
  });

  it("refuses a closed-reproducible outcome whose egress attempt succeeded", () => {
    reject(
      {
        isolation: {
          ...CLOSED.isolation,
          egressAttempts: [{ target: "https://archive.example.test", outcome: "succeeded" }],
        },
      },
      "a successful egress is offline-dependency-detected, never closed-reproducible",
    );
  });

  it("ties the failure reason to its outcome and stage", () => {
    reject(
      {
        outcome: "source-coverage-incomplete",
        runs: undefined,
        baseline: undefined,
        failure: { stage: "compare", reason: "artifact-entry-uncovered" },
      },
      "the stage must be the reason's stage",
    );
    reject(
      {
        outcome: "capability-mismatch",
        runs: undefined,
        baseline: undefined,
        failure: { stage: "provenance", reason: "artifact-entry-uncovered" },
      },
      "the outcome must be the reason's outcome",
    );
  });

  it("requires the anchor and coverage blocks exactly when fidelity is not local", () => {
    const { anchor: _anchor, coverage: _coverage, ...localEnvironment } = CLOSED.environment;
    reject({ environment: { ...CLOSED.environment, fidelityClass: "local" } },
      "a local record claims no anchor");
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse({
      ...CLOSED,
      environment: { ...localEnvironment, fidelityClass: "local" },
    }).success).toBe(true);
    reject({ environment: { ...CLOSED.environment, coverage: undefined } },
      "E13 coverage is computed for anchored-subset and full-state");
  });

  it("refuses RPC cost observations on a closed-state run", () => {
    reject({ cost: { ...CLOSED.cost, rpcCalls: 12 } },
      "a closed run that made RPC calls is a contradiction");
  });

  it("requires providers for archive-observed and forbids them for closed-reproducible", () => {
    reject({ providers: [{
      id: "provider-a",
      observedAt: "2026-07-31T09:02:00.000Z",
      rpcCalls: 40,
      rpcBytes: 900,
      observationDigest: OBSERVATION,
    }] }, "a closed-reproducible attestation names no providers");
  });

  it("requires composition iff the scope is composite", () => {
    reject({ scope: "composite" }, "a composite attestation carries the composition block");
  });

  it("throws a pathed error from the parser", () => {
    expect(() => parseChainEnvironmentVerificationPredicate({ ...CLOSED, outcome: "nope" }))
      .toThrow(ChainVerificationError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/predicate.test.ts`
Expected: FAIL — `Failed to resolve import "./predicate.js"`.

- [ ] **Step 3: Implement `src/predicate.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema, ResourceDescriptorSchema } from "./digests.js";
import { invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  CHAIN_VERIFICATION_FAILURE_REASONS,
  CHAIN_VERIFICATION_OUTCOMES,
  CHAIN_VERIFICATION_STAGES,
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
} from "./outcomes.js";

const QuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u, "must be a decimal quantity");
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const Word32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u, "must be a lowercase 0x 32-byte word");

const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

/** When the runs happened. Inside the signed payload on purpose: a re-announced old
 * attestation cannot present itself as fresh (design §5.3). */
export const VerificationWindowSchema = z
  .strictObject({ startedAt: Rfc3339UtcSchema, endedAt: Rfc3339UtcSchema })
  .refine((window) => window.startedAt <= window.endedAt, {
    message: "window.endedAt must not precede window.startedAt",
    path: ["endedAt"],
  });
export type VerificationWindow = z.infer<typeof VerificationWindowSchema>;

/** Host-declared: a library cannot truthfully digest its own build (design §5.3). */
export const VerifierIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: PrefixedSha256Schema,
});
export type VerifierIdentity = z.infer<typeof VerifierIdentitySchema>;

export const CLOSURE_CLASSES = ["closed-state", "archive-dependent"] as const;
export const FIDELITY_CLASSES = ["local", "anchored-subset", "full-state"] as const;

/**
 * Design §4.2 E5, made a field rather than a footnote. `declared` means the proofs bind the
 * committed subset to the root the record states, and the correspondence between that root
 * and any public chain's history is a declaration this attestation does not close.
 */
export const ANCHOR_AUTHENTICITY = ["declared", "header-proven"] as const;

export const SourceAnchorObservationSchema = z.strictObject({
  caip2: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u, "must be a CAIP-2 chain id"),
  chainId: z.number().int().nonnegative(),
  blockNumber: QuantitySchema,
  blockHash: Word32Schema,
  stateRoot: Word32Schema,
  timestamp: QuantitySchema,
  finalityPolicy: z.string().min(1),
  authenticity: z.enum(ANCHOR_AUTHENTICITY),
});

export const RuntimeIdentityObservationSchema = z.strictObject({
  family: z.string().min(1),
  version: z.string().min(1),
  imageManifestDigest: PrefixedSha256Schema,
  platform: z.string().min(1),
  binaryDigest: PrefixedSha256Schema,
  reportedVersion: z.string().min(1),
  evmConfigurationDigest: PrefixedSha256Schema,
  chainId: z.number().int().nonnegative(),
});

export const CapabilityEnvelopeObservationSchema = z.strictObject({
  rpcAllowlist: z.strictObject({
    read: z.array(z.string().min(1)),
    stateChanging: z.array(z.string().min(1)),
  }),
  signerRoles: z.array(z.string().min(1)),
  permittedChainId: z.number().int().nonnegative(),
  maxima: z.record(z.string().min(1), z.string().min(1)),
  egressPolicyId: z.string().min(1),
});

/** E13's computation, reported as counts plus the visibility flag §4.2 requires. */
export const CoverageObservationSchema = z.strictObject({
  proofCovered: z.number().int().nonnegative(),
  fixtureDeclared: z.number().int().nonnegative(),
  uncovered: z.number().int().nonnegative(),
  mutatesSourceProtocolState: z.boolean(),
});

export const EnvironmentObservationSchema = z.strictObject({
  closureClass: z.enum(CLOSURE_CLASSES),
  fidelityClass: z.enum(FIDELITY_CLASSES),
  anchor: SourceAnchorObservationSchema.optional(),
  runtime: RuntimeIdentityObservationSchema,
  /** A state commitment (`0x` + 64 hex), explicitly distinct from `sourceAnchor.stateRoot`
   * and never a `sha256:` content digest -- CE1's record spells it the same way. */
  postFixtureCommitment: Word32Schema,
  /** The controls the instance applied, not the ones the record wished for. */
  controls: z.record(z.string().min(1), z.string()),
  envelope: CapabilityEnvelopeObservationSchema,
  coverage: CoverageObservationSchema.optional(),
});
export type EnvironmentObservation = z.infer<typeof EnvironmentObservationSchema>;

export const RunObservationSchema = z.strictObject({
  /** Design §5.1 step 8: each run is a newly launched process. Distinct ids are how a reader
   * checks that rule instead of trusting it. */
  instanceId: z.string().min(1),
  observationDigest: PrefixedSha256Schema,
  wallSeconds: z.number().nonnegative().finite(),
});
export type RunObservation = z.infer<typeof RunObservationSchema>;

export const RunsBlockSchema = z
  .strictObject({
    count: z.number().int().min(MINIMUM_RUN_COUNT),
    observationDigest: PrefixedSha256Schema,
    perRun: z.array(RunObservationSchema).min(MINIMUM_RUN_COUNT),
    allObservationsEqual: z.boolean(),
    freshInstances: z.boolean(),
  })
  .refine((runs) => runs.count === runs.perRun.length, {
    message: "runs.count must equal runs.perRun.length",
    path: ["count"],
  })
  .refine(
    (runs) => runs.allObservationsEqual
      === runs.perRun.every((run) => run.observationDigest === runs.observationDigest),
    {
      message: "runs.allObservationsEqual must equal the observed per-run equality",
      path: ["allObservationsEqual"],
    },
  )
  .refine(
    (runs) => !runs.freshInstances
      || new Set(runs.perRun.map((run) => run.instanceId)).size === runs.perRun.length,
    {
      message: "a fresh-instantiation claim requires distinct instance ids",
      path: ["freshInstances"],
    },
  );
export type RunsBlock = z.infer<typeof RunsBlockSchema>;

export const BaselineBlockSchema = z.strictObject({
  /** The post-fixture, pre-probe state commitment every run must reproduce (§5.1 step 9). */
  commitment: Word32Schema,
  observation: ResourceDescriptorSchema,
});
export type BaselineBlock = z.infer<typeof BaselineBlockSchema>;

export const NetworkPolicyObservationSchema = z.strictObject({
  egress: z.literal("denied"),
  dns: z.literal("absent"),
  archiveRpc: z.literal("unreachable"),
  forkBackend: z.enum(["absent", "present"]),
});

/** Design §5.1 step 2's two evidence modes. Neither one alone covers both instance shapes,
 * which is why the mode is a field and both are exercised by the kit. */
export const CLOSURE_EVIDENCE_MODES = ["fork-backend-refusal", "sealed-boundary"] as const;
export type ClosureEvidenceMode = (typeof CLOSURE_EVIDENCE_MODES)[number];

export const IsolationEvidenceSchema = z.strictObject({
  networkPolicy: NetworkPolicyObservationSchema,
  closureEvidenceMode: z.enum(CLOSURE_EVIDENCE_MODES),
  /** §4.2's boundary rule as evidence: outside the committed slice, reads are empty. Present
   * for sealed instances, where no fetch is possible and absence of errors proves nothing. */
  boundaryProbe: z.strictObject({
    probeId: z.string().min(1),
    readsEmptyOutsideSlice: z.boolean(),
  }).optional(),
  egressAttempts: z.array(z.strictObject({
    target: z.string().min(1),
    outcome: z.enum(["refused", "succeeded"]),
    detail: z.string().min(1).optional(),
  })),
  forbiddenProbes: z.array(z.strictObject({
    method: z.string().min(1),
    expectedClass: z.string().min(1),
    observedClass: z.string().min(1),
    passed: z.boolean(),
  })),
  signerScope: z.strictObject({
    declaredRoles: z.array(z.string().min(1)),
    exposedAccounts: z.array(AddressSchema),
    unexpectedAccounts: z.array(AddressSchema),
  }),
  /** Design §5.1 step 6's reset requirement, when the record declares one. The post-reset
   * STATE COMMITMENT `ChainMaterializer.reset` returned, compared against the baseline
   * commitment -- not an observation digest. */
  resetCommitment: Word32Schema.optional(),
  resolutionLog: ResourceDescriptorSchema,
});
export type IsolationEvidence = z.infer<typeof IsolationEvidenceSchema>;

/** Design §5.3's cost observations and §5.4's honest table, as recorded facts. Nothing here
 * gates an outcome; cost is what makes third-party re-verification budgetable. */
export const CostObservationsSchema = z.strictObject({
  artifactBytes: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  wallSeconds: z.number().nonnegative().finite(),
  cpuSeconds: z.number().nonnegative().finite().optional(),
  maxMemoryBytes: z.number().int().nonnegative().optional(),
  diskBytes: z.number().int().nonnegative().optional(),
  rpcCalls: z.number().int().nonnegative().optional(),
  rpcBytes: z.number().int().nonnegative().optional(),
});
export type CostObservations = z.infer<typeof CostObservationsSchema>;

export const ProviderObservationSchema = z.strictObject({
  id: z.string().min(1),
  observedAt: Rfc3339UtcSchema,
  rpcCalls: z.number().int().nonnegative(),
  rpcBytes: z.number().int().nonnegative(),
  observationDigest: PrefixedSha256Schema,
});
export type ProviderObservation = z.infer<typeof ProviderObservationSchema>;

export const COMPONENT_ROLES = ["chain-world", "information-world", "service-runtime"] as const;

/** Design §4.4 + §5.1 step 6: what exists only once worlds are combined. */
export const CompositionEvidenceSchema = z.strictObject({
  routing: z.array(z.strictObject({
    origin: z.string().min(1),
    world: PrefixedSha256Schema,
    precedence: z.number().int().nonnegative(),
  })),
  collisions: z.array(z.strictObject({
    origin: z.string().min(1),
    worlds: z.array(PrefixedSha256Schema).min(2),
  })),
  missPolicy: z.string().min(1),
  allowlistedOrigins: z.array(z.string().min(1)),
  requestBudget: z.strictObject({
    requests: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    enforced: z.boolean(),
  }),
  /**
   * Component records, and their own attestations where the verifier had them. A composite
   * attestation never substitutes for these; `requiresComponentAttestations` reads this list.
   */
  components: z.array(z.strictObject({
    role: z.enum(COMPONENT_ROLES),
    record: PrefixedSha256Schema,
    attestation: PrefixedSha256Schema.optional(),
  })).min(1),
  wholeWorldOfflineBoot: z.boolean(),
});
export type CompositionEvidence = z.infer<typeof CompositionEvidenceSchema>;

export const DivergenceSchema = z.strictObject({
  referenceRunIndex: z.number().int().nonnegative(),
  referenceObservationDigest: PrefixedSha256Schema,
  divergentRuns: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    instanceId: z.string().min(1),
    observationDigest: PrefixedSha256Schema,
    observation: ResourceDescriptorSchema,
  })).min(1),
});

export const CoverageFailureSchema = z.strictObject({
  uncoveredAccounts: z.array(AddressSchema),
  uncoveredCodeEntries: z.array(AddressSchema),
  uncoveredStorageSlots: z.array(z.strictObject({ address: AddressSchema, slot: Word32Schema })),
  undeclaredMutations: z.array(AddressSchema),
});

export const FailureBlockSchema = z.strictObject({
  stage: z.enum(CHAIN_VERIFICATION_STAGES),
  reason: z.enum(CHAIN_VERIFICATION_FAILURE_REASONS),
  detail: z.string().min(1).optional(),
  divergence: DivergenceSchema.optional(),
  coverage: CoverageFailureSchema.optional(),
});
export type FailureBlock = z.infer<typeof FailureBlockSchema>;

const PredicateShapeSchema = z.strictObject({
  protocol: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI),
  /** Component and composite claims are different claims; the discriminator is what stops a
   * consumer reading one as the other (Finding F-CE3-4). */
  scope: z.enum(["component", "composite"]),
  outcome: z.enum(CHAIN_VERIFICATION_OUTCOMES),
  window: VerificationWindowSchema,
  verifier: VerifierIdentitySchema,
  /** Every resource step 1 resolved and digest-verified. */
  materials: z.array(ResourceDescriptorSchema).min(1),
  environment: EnvironmentObservationSchema,
  runs: RunsBlockSchema.optional(),
  baseline: BaselineBlockSchema.optional(),
  isolation: IsolationEvidenceSchema,
  cost: CostObservationsSchema,
  providers: z.array(ProviderObservationSchema).min(1).optional(),
  composition: CompositionEvidenceSchema.optional(),
  failure: FailureBlockSchema.optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
});

export const ChainEnvironmentVerificationPredicateSchema = PredicateShapeSchema.superRefine(
  (predicate, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };

    // --- Presence: repetition evidence exists iff a complete K-run observation exists.
    const runBearing = isRunBearingOutcome(predicate.outcome);
    if (runBearing) {
      if (predicate.runs === undefined) issue("a run-bearing outcome requires runs", ["runs"]);
      if (predicate.baseline === undefined) {
        issue("a run-bearing outcome requires a baseline", ["baseline"]);
      }
      if (
        predicate.runs !== undefined
        && predicate.baseline !== undefined
        && predicate.baseline.observation.digest.sha256
          !== predicate.runs.observationDigest.slice("sha256:".length)
      ) {
        issue(
          "baseline.observation must name the canonical observation in runs.observationDigest",
          ["baseline", "observation"],
        );
      }
    } else {
      if (predicate.runs !== undefined) {
        issue("this outcome carries no complete run sequence", ["runs"]);
      }
      if (predicate.baseline !== undefined) {
        issue("this outcome carries no baseline", ["baseline"]);
      }
    }

    // --- The two positive outcomes carry no failure; every other outcome carries one, and
    // the failure's reason is what fixes the outcome and the stage.
    const positive = predicate.outcome === "closed-reproducible"
      || predicate.outcome === "archive-observed";
    if (positive) {
      if (predicate.failure !== undefined) {
        issue("a positive outcome carries no failure block", ["failure"]);
      }
    } else if (predicate.failure === undefined) {
      issue("a negative outcome requires a failure block", ["failure"]);
    } else {
      if (outcomeForFailureReason(predicate.failure.reason) !== predicate.outcome) {
        issue(
          `reason ${predicate.failure.reason} is the outcome `
          + `${outcomeForFailureReason(predicate.failure.reason)}`,
          ["outcome"],
        );
      }
      if (stageForFailureReason(predicate.failure.reason) !== predicate.failure.stage) {
        issue(
          `reason ${predicate.failure.reason} belongs to stage `
          + `${stageForFailureReason(predicate.failure.reason)}`,
          ["failure", "stage"],
        );
      }
    }

    // --- Fidelity determines which source blocks exist (design §4.3).
    const local = predicate.environment.fidelityClass === "local";
    if (local && predicate.environment.anchor !== undefined) {
      issue("a local record claims no source anchor", ["environment", "anchor"]);
    }
    if (!local && predicate.environment.anchor === undefined) {
      issue("anchored-subset and full-state records carry a source anchor",
        ["environment", "anchor"]);
    }
    if (local && predicate.environment.coverage !== undefined) {
      issue("artifact coverage is computed against a source manifest, which local has none of",
        ["environment", "coverage"]);
    }
    if (!local && predicate.environment.coverage === undefined) {
      issue("E13 coverage is computed for anchored-subset and full-state",
        ["environment", "coverage"]);
    }

    // --- Closure evidence mode follows the instance shape, never the verifier's preference.
    const forkBacked = predicate.isolation.networkPolicy.forkBackend === "present";
    const expectedMode = forkBacked ? "fork-backend-refusal" : "sealed-boundary";
    if (predicate.isolation.closureEvidenceMode !== expectedMode) {
      issue(
        `a ${predicate.isolation.networkPolicy.forkBackend} fork backend is the ${expectedMode} mode`,
        ["isolation", "closureEvidenceMode"],
      );
    }
    if (forkBacked) {
      if (predicate.isolation.boundaryProbe !== undefined) {
        issue("the boundary probe is the sealed mode's evidence", ["isolation", "boundaryProbe"]);
      }
      if (predicate.isolation.egressAttempts.length === 0) {
        issue(
          "fork-backend closure is evidenced by a refused fetch, so an attempt must be recorded",
          ["isolation", "egressAttempts"],
        );
      }
    } else if (predicate.isolation.boundaryProbe === undefined) {
      issue(
        "a sealed instance evidences closure through the boundary rule, not absence of errors",
        ["isolation", "boundaryProbe"],
      );
    }

    // --- Cost: a closed run that spent archive RPC is a contradiction.
    if (predicate.environment.closureClass === "closed-state") {
      if (predicate.cost.rpcCalls !== undefined || predicate.cost.rpcBytes !== undefined) {
        issue("a closed-state run makes no archive RPC calls", ["cost", "rpcCalls"]);
      }
      if (predicate.providers !== undefined) {
        issue("a closed-state run names no providers", ["providers"]);
      }
    } else if (predicate.providers === undefined) {
      issue("an archive-dependent observation records the providers it consulted",
        ["providers"]);
    }

    // --- The two positive outcomes, in detail.
    if (predicate.outcome === "closed-reproducible") {
      if (predicate.environment.closureClass !== "closed-state") {
        issue("closed-reproducible is a closed-state claim", ["environment", "closureClass"]);
      }
      predicate.runs?.perRun.forEach((run, index) => {
        if (run.observationDigest !== predicate.runs?.observationDigest) {
          issue(
            "closed-reproducible requires every per-run observation digest to equal the canonical one",
            ["runs", "perRun", index, "observationDigest"],
          );
        }
      });
      if (predicate.runs?.freshInstances !== true) {
        issue("closed-reproducible requires K fresh materializations", ["runs", "freshInstances"]);
      }
      predicate.isolation.egressAttempts.forEach((attempt, index) => {
        if (attempt.outcome !== "refused") {
          issue("a successful egress is offline-dependency-detected",
            ["isolation", "egressAttempts", index, "outcome"]);
        }
      });
      if (!forkBacked && predicate.isolation.boundaryProbe?.readsEmptyOutsideSlice !== true) {
        issue("the boundary rule requires out-of-slice reads to be empty",
          ["isolation", "boundaryProbe", "readsEmptyOutsideSlice"]);
      }
      predicate.isolation.forbiddenProbes.forEach((probe, index) => {
        if (!probe.passed) {
          issue("a failed forbidden-method probe is capability-mismatch",
            ["isolation", "forbiddenProbes", index, "passed"]);
        }
      });
      if (predicate.isolation.signerScope.unexpectedAccounts.length > 0) {
        issue("an unexpected signer account is capability-mismatch",
          ["isolation", "signerScope", "unexpectedAccounts"]);
      }
    }

    if (predicate.outcome === "archive-observed"
      && predicate.environment.closureClass !== "archive-dependent") {
      issue("archive-observed is the archive-dependent class's outcome",
        ["environment", "closureClass"]);
    }

    // --- The three divergence outcomes must carry the evidence they are named for.
    if (predicate.outcome === "probe-divergence") {
      if (predicate.failure?.divergence === undefined) {
        issue("probe-divergence requires divergence evidence", ["failure", "divergence"]);
      }
      if (predicate.runs?.allObservationsEqual !== false) {
        issue("probe-divergence is observed inequality", ["runs", "allObservationsEqual"]);
      }
    }
    if (predicate.outcome === "reset-divergence") {
      if (predicate.isolation.resetCommitment === undefined) {
        issue("reset-divergence requires the post-reset commitment",
          ["isolation", "resetCommitment"]);
      } else if (predicate.isolation.resetCommitment === predicate.baseline?.commitment) {
        issue("a post-reset commitment equal to the baseline is not a divergence",
          ["isolation", "resetCommitment"]);
      }
    }
    if (predicate.outcome === "provider-disagreement") {
      const digests = new Set((predicate.providers ?? []).map((one) => one.observationDigest));
      if (digests.size < 2) {
        issue("provider-disagreement requires two providers that disagreed", ["providers"]);
      }
    }

    // --- E13.
    if (predicate.outcome === "source-coverage-incomplete") {
      const coverage = predicate.failure?.coverage;
      if (coverage === undefined) {
        issue("source-coverage-incomplete requires the uncovered set", ["failure", "coverage"]);
      } else if (
        coverage.uncoveredAccounts.length === 0
        && coverage.uncoveredCodeEntries.length === 0
        && coverage.uncoveredStorageSlots.length === 0
        && coverage.undeclaredMutations.length === 0
      ) {
        issue("an empty uncovered set is not incomplete coverage", ["failure", "coverage"]);
      }
    }
    if (predicate.environment.coverage !== undefined
      && predicate.environment.coverage.uncovered > 0
      && predicate.outcome !== "source-coverage-incomplete") {
      issue("uncovered artifact entries are source-coverage-incomplete",
        ["environment", "coverage", "uncovered"]);
    }

    // --- Composite scope.
    if (predicate.scope === "composite") {
      if (predicate.composition === undefined) {
        issue("a composite attestation carries the composition block", ["composition"]);
      } else {
        const byOrigin = new Map<string, Set<string>>();
        for (const route of predicate.composition.routing) {
          const worlds = byOrigin.get(route.origin) ?? new Set<string>();
          worlds.add(route.world);
          byOrigin.set(route.origin, worlds);
        }
        for (const [origin, worlds] of byOrigin) {
          const declared = predicate.composition.collisions
            .some((collision) => collision.origin === origin);
          if (worlds.size > 1 && !declared) {
            issue(`origin ${origin} is claimed by two worlds without a recorded collision`,
              ["composition", "collisions"]);
          }
        }
        const chainWorlds = predicate.composition.components
          .filter((component) => component.role === "chain-world");
        if (chainWorlds.length !== 1) {
          issue("a composite has exactly one chain world", ["composition", "components"]);
        }
        if (predicate.outcome === "closed-reproducible") {
          if (predicate.composition.collisions.length > 0) {
            issue("routing collisions are capability-mismatch", ["composition", "collisions"]);
          }
          if (!predicate.composition.wholeWorldOfflineBoot) {
            issue("a composite closure claim requires the whole world to boot offline",
              ["composition", "wholeWorldOfflineBoot"]);
          }
          if (!predicate.composition.requestBudget.enforced) {
            issue("an unenforced request budget is capability-mismatch",
              ["composition", "requestBudget", "enforced"]);
          }
        }
      }
    } else if (predicate.composition !== undefined) {
      issue("the composition block belongs to a composite attestation", ["composition"]);
    }
  },
);

export type ChainEnvironmentVerificationPredicate = z.infer<typeof PredicateShapeSchema>;

export function parseChainEnvironmentVerificationPredicate(
  value: unknown,
): ChainEnvironmentVerificationPredicate {
  const result = ChainEnvironmentVerificationPredicateSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain verification predicate at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain verification predicate.",
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all 17 predicate tests pass. If a mutation is *accepted*, the
rule is missing — fix the schema, never the test.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): chain verification predicate schema and cross-field rules"
```

---

### Task 6: Subjects, the Statement, and the normative match rules

Design §5.3's dual subjects with bare-hex DigestSets, the record-subject match rule adopted
verbatim from the parent's adversarial finding, and the composite's never-substitutes rule.

**Files:**
- Create: `src/subject.ts`, `src/statement.ts`, `src/statement.test.ts`

**Interfaces:**
- Consumes: `IN_TOTO_STATEMENT_TYPE`, `Sha256Digest` from `@jinn-network/trust-core`;
  `toDigestSet`, `fromDigestSet`, `DigestSetSchema` from `./digests.js`;
  `CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE` from `./identifiers.js`.
- Produces: `buildChainEnvironmentVerificationSubjects`,
  `buildCryptoEnvironmentVerificationSubjects`,
  `ChainEnvironmentVerificationStatementSchema` (the union),
  `ComponentVerificationStatementSchema`, `CompositeVerificationStatementSchema`,
  `buildChainEnvironmentVerificationStatement`, `buildCryptoEnvironmentVerificationStatement`,
  `parseChainEnvironmentVerificationStatement`, `attestationMatchesRecord`,
  `requiresComponentAttestations`.

- [ ] **Step 1: Write the failing statement test**

`src/statement.test.ts` (imports the `CLOSED` predicate fixture pattern from T5 — extract it
into an exported `buildClosedPredicateFixture()` in `src/statement.test.ts` and have
`src/predicate.test.ts` keep its own copy; the two must not share a helper module, so a
predicate-schema change cannot silently pass both suites):

```ts
// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, type Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  attestationMatchesRecord,
  buildChainEnvironmentVerificationStatement,
  buildCryptoEnvironmentVerificationStatement,
  parseChainEnvironmentVerificationStatement,
  requiresComponentAttestations,
} from "./statement.js";
import { buildChainEnvironmentVerificationSubjects } from "./subject.js";
// `closedPredicate()` and `compositePredicate()` are local builders in this file; they mirror
// the T5 fixture rather than importing it.
import { closedPredicate, compositePredicate } from "./statement.fixtures.js";

const RECORD = `sha256:${"1".repeat(64)}` as Sha256Digest;
const ARTIFACT = `sha256:${"2".repeat(64)}` as Sha256Digest;
const COMPOSITE = `sha256:${"3".repeat(64)}` as Sha256Digest;
const CHAIN_WORLD = `sha256:${"4".repeat(64)}` as Sha256Digest;

describe("subjects", () => {
  it("emits bare-hex DigestSet values in a fixed order", () => {
    const subjects = buildChainEnvironmentVerificationSubjects({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
    });
    expect(subjects).toEqual([
      { name: "environment", digest: { sha256: "1".repeat(64) } },
      { name: "state-artifact", digest: { sha256: "2".repeat(64) } },
    ]);
  });

  it("drops the artifact subject when the record commits no state artifact", () => {
    const subjects = buildChainEnvironmentVerificationSubjects({ recordDigest: RECORD });
    expect(subjects).toEqual([{ name: "environment", digest: { sha256: "1".repeat(64) } }]);
  });

  it("refuses a prefixed digest in a DigestSet position", () => {
    expect(() => buildChainEnvironmentVerificationSubjects({
      recordDigest: "1".repeat(64) as Sha256Digest,
    })).toThrow(ChainVerificationError);
  });
});

describe("statement", () => {
  it("assembles a component statement", () => {
    const statement = buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: closedPredicate(),
    });
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE);
    expect(statement.predicate.scope).toBe("component");
    expect(parseChainEnvironmentVerificationStatement(statement)).toEqual(statement);
  });

  it("refuses a component statement whose predicate claims composite scope", () => {
    expect(() => buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    })).toThrow(ChainVerificationError);
  });

  it("matches only the record subject, never the artifact subject", () => {
    const statement = buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      stateArtifactDigest: ARTIFACT,
      predicate: closedPredicate(),
    });
    expect(attestationMatchesRecord(statement, RECORD)).toBe(true);
    // Two records can share one state artifact. Any-subject matching would extend a narrow
    // claim to a record this attestation never covered.
    expect(attestationMatchesRecord(statement, ARTIFACT)).toBe(false);
  });

  it("assembles a composite statement whose subjects cannot satisfy a component match", () => {
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: COMPOSITE,
      chainWorldDigest: CHAIN_WORLD,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    });
    expect(statement.subject.map((subject) => subject.name))
      .toEqual(["crypto-environment", "chain-world"]);
    expect(attestationMatchesRecord(statement, COMPOSITE)).toBe(true);
    // The never-substitutes rule (design §5.1 step 6), mechanically.
    expect(attestationMatchesRecord(statement, CHAIN_WORLD)).toBe(false);
  });

  it("lists the component records whose own attestations a consumer must still obtain", () => {
    const statement = buildCryptoEnvironmentVerificationStatement({
      compositeDigest: COMPOSITE,
      chainWorldDigest: CHAIN_WORLD,
      predicate: compositePredicate({ chainWorld: CHAIN_WORLD }),
    });
    expect(requiresComponentAttestations(statement)).toEqual([CHAIN_WORLD]);
    // A component statement requires nothing further of the consumer.
    expect(requiresComponentAttestations(buildChainEnvironmentVerificationStatement({
      recordDigest: RECORD,
      predicate: closedPredicate(),
    }))).toEqual([]);
  });
});
```

Also create `src/statement.fixtures.ts` (a test-region module; the boundary guard's test-file
regex does not cover it, so it must import nothing outside this package):

```ts
// SPDX-License-Identifier: Apache-2.0

// Predicate builders for the statement suite. Deliberately a second spelling of the T5
// fixture: if the predicate schema changes, both suites must be updated, and a change that
// only one of them tolerates is caught here.

import { CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI } from "./identifiers.js";
import type { ChainEnvironmentVerificationPredicate } from "./predicate.js";

const DIGEST = (fill: string): `sha256:${string}` => `sha256:${fill.repeat(64)}`;

function base(): Omit<ChainEnvironmentVerificationPredicate, "scope" | "composition"> {
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    outcome: "closed-reproducible",
    window: { startedAt: "2026-07-31T09:00:00.000Z", endedAt: "2026-07-31T09:04:00.000Z" },
    verifier: { id: "https://example.test/verifier", version: "0.1.0", digest: DIGEST("7") },
    materials: [{ name: "state-artifact", digest: { sha256: "2".repeat(64) } }],
    environment: {
      closureClass: "closed-state",
      fidelityClass: "local",
      runtime: {
        family: "anvil",
        version: "1.4.2",
        imageManifestDigest: DIGEST("5"),
        platform: "linux/amd64",
        binaryDigest: DIGEST("6"),
        reportedVersion: "anvil 1.4.2",
        evmConfigurationDigest: DIGEST("8"),
        chainId: 31337,
      },
      postFixtureCommitment: `0x${"9".repeat(64)}`,
      controls: { miningMode: "manual" },
      envelope: {
        rpcAllowlist: { read: ["eth_call"], stateChanging: ["eth_sendRawTransaction"] },
        signerRoles: ["agent"],
        permittedChainId: 31337,
        maxima: { transactions: "8" },
        egressPolicyId: "blackhole/1.0",
      },
    },
    runs: {
      count: 5,
      observationDigest: DIGEST("1"),
      perRun: Array.from({ length: 5 }, (_unused, index) => ({
        instanceId: `instance-${index}`,
        observationDigest: DIGEST("1"),
        wallSeconds: 3 + index,
      })),
      allObservationsEqual: true,
      freshInstances: true,
    },
    baseline: {
      commitment: `0x${"a".repeat(64)}`,
      observation: { name: "observation", digest: { sha256: "1".repeat(64) } },
    },
    isolation: {
      networkPolicy: {
        egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent",
      },
      closureEvidenceMode: "sealed-boundary",
      boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
      egressAttempts: [],
      forbiddenProbes: [],
      signerScope: { declaredRoles: ["agent"], exposedAccounts: [], unexpectedAccounts: [] },
      resolutionLog: { name: "resolution-log", digest: { sha256: "b".repeat(64) } },
    },
    cost: { artifactBytes: 4096, artifactCount: 3, wallSeconds: 21 },
  };
}

export function closedPredicate(): ChainEnvironmentVerificationPredicate {
  return { ...base(), scope: "component" };
}

export function compositePredicate(
  options: { readonly chainWorld: `sha256:${string}` },
): ChainEnvironmentVerificationPredicate {
  return {
    ...base(),
    scope: "composite",
    composition: {
      routing: [],
      collisions: [],
      missPolicy: "declared-miss-response",
      allowlistedOrigins: [],
      requestBudget: { requests: 0, bytes: 0, enforced: true },
      components: [{ role: "chain-world", record: options.chainWorld }],
      wholeWorldOfflineBoot: true,
    },
  };
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/statement.test.ts`
Expected: FAIL — `Failed to resolve import "./subject.js"`.

- [ ] **Step 3: Implement `src/subject.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@jinn-network/trust-core";

import { toDigestSet, type ResourceDescriptor } from "./digests.js";

export interface ChainEnvironmentSubjectInput {
  /** Identity of the sealed chain environment record (`sha256:`-prefixed). */
  readonly recordDigest: Sha256Digest;
  /**
   * The committed state artifact. Mandatory for `closed-state` records and absent for
   * archive-dependent ones, which commit no artifact to invert on.
   */
  readonly stateArtifactDigest?: Sha256Digest;
}

/**
 * The component attestation's subjects, in fixed order: the record first, the state artifact
 * second where one exists. Values are bare hex per in-toto -- `toDigestSet` refuses a
 * prefixed value, which is the contract-6 confusion fixture.
 *
 * The artifact subject exists for discovery inversion only ("find attestations about state
 * artifact X"). Claims about an environment match the record subject; see
 * `attestationMatchesRecord`. Two records can share one artifact, so any-subject matching
 * would extend a narrow claim to a record this attestation never covered.
 */
export function buildChainEnvironmentVerificationSubjects(
  input: ChainEnvironmentSubjectInput,
): readonly [ResourceDescriptor, ...ResourceDescriptor[]] {
  const environment: ResourceDescriptor = {
    name: "environment",
    digest: toDigestSet(input.recordDigest),
  };
  return input.stateArtifactDigest === undefined
    ? [environment]
    : [environment, { name: "state-artifact", digest: toDigestSet(input.stateArtifactDigest) }];
}

export interface CryptoEnvironmentSubjectInput {
  readonly compositeDigest: Sha256Digest;
  readonly chainWorldDigest: Sha256Digest;
}

/**
 * The composite attestation's subjects. Distinct names on purpose: a consumer evaluating a
 * *component* claim matches `environment`, which a composite statement never carries, so a
 * composite can never be read as covering the chain world on its own (design §5.1 step 6).
 */
export function buildCryptoEnvironmentVerificationSubjects(
  input: CryptoEnvironmentSubjectInput,
): readonly [ResourceDescriptor, ResourceDescriptor] {
  return [
    { name: "crypto-environment", digest: toDigestSet(input.compositeDigest) },
    { name: "chain-world", digest: toDigestSet(input.chainWorldDigest) },
  ];
}
```

- [ ] **Step 4: Implement `src/statement.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { IN_TOTO_STATEMENT_TYPE, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { DigestSetSchema, fromDigestSet } from "./digests.js";
import { invalidInput } from "./errors.js";
import { CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE } from "./identifiers.js";
import {
  ChainEnvironmentVerificationPredicateSchema,
  type ChainEnvironmentVerificationPredicate,
} from "./predicate.js";
import {
  buildChainEnvironmentVerificationSubjects,
  buildCryptoEnvironmentVerificationSubjects,
  type ChainEnvironmentSubjectInput,
  type CryptoEnvironmentSubjectInput,
} from "./subject.js";

const ComponentPredicateSchema = ChainEnvironmentVerificationPredicateSchema.refine(
  (predicate) => predicate.scope === "component",
  { message: "a component statement carries a component-scope predicate", path: ["scope"] },
);
const CompositePredicateSchema = ChainEnvironmentVerificationPredicateSchema.refine(
  (predicate) => predicate.scope === "composite",
  { message: "a composite statement carries a composite-scope predicate", path: ["scope"] },
);

export const ComponentVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.union([
    z.tuple([z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema })]),
    z.tuple([
      z.strictObject({ name: z.literal("environment"), digest: DigestSetSchema }),
      z.strictObject({ name: z.literal("state-artifact"), digest: DigestSetSchema }),
    ]),
  ]),
  predicateType: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: ComponentPredicateSchema,
});

export const CompositeVerificationStatementSchema = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.tuple([
    z.strictObject({ name: z.literal("crypto-environment"), digest: DigestSetSchema }),
    z.strictObject({ name: z.literal("chain-world"), digest: DigestSetSchema }),
  ]),
  predicateType: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE),
  predicate: CompositePredicateSchema,
});

export const ChainEnvironmentVerificationStatementSchema = z.union([
  ComponentVerificationStatementSchema,
  CompositeVerificationStatementSchema,
]);
export type ChainEnvironmentVerificationStatement = z.infer<
  typeof ChainEnvironmentVerificationStatementSchema
>;

/**
 * Assembles and validates the in-toto Statement. Follows the `attestation-issuer` pattern
 * (`packages/evidence/attestation-issuer/src/statement.ts`): assemble, `safeParse` against a
 * closed schema, throw with the first issue's JSON path. That package is a pattern source,
 * not a dependency -- it exports no statement builder, and design §3 gives this package two
 * package edges.
 */
export function buildChainEnvironmentVerificationStatement(
  input: ChainEnvironmentSubjectInput & {
    readonly predicate: ChainEnvironmentVerificationPredicate;
  },
): ChainEnvironmentVerificationStatement {
  return parseChainEnvironmentVerificationStatement({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildChainEnvironmentVerificationSubjects(input),
    predicateType: CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  });
}

export function buildCryptoEnvironmentVerificationStatement(
  input: CryptoEnvironmentSubjectInput & {
    readonly predicate: ChainEnvironmentVerificationPredicate;
  },
): ChainEnvironmentVerificationStatement {
  return parseChainEnvironmentVerificationStatement({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: buildCryptoEnvironmentVerificationSubjects(input),
    predicateType: CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
    predicate: input.predicate,
  });
}

export function parseChainEnvironmentVerificationStatement(
  value: unknown,
): ChainEnvironmentVerificationStatement {
  const result = ChainEnvironmentVerificationStatementSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain verification statement at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain verification statement.",
    );
  }
  return result.data;
}

/**
 * The normative subject-match rule (design §5.3). A consumer evaluating a claim about a
 * record MUST match subject[0]. Any-subject matching would silently extend a narrow-scope
 * attestation to a broad-scope record, since two records may share one state artifact and a
 * composite always names its chain world.
 */
export function attestationMatchesRecord(
  statement: ChainEnvironmentVerificationStatement,
  recordDigestValue: Sha256Digest,
): boolean {
  return fromDigestSet(statement.subject[0].digest) === recordDigestValue;
}

/**
 * Design §5.1 step 6: "A composite attestation never substitutes for its components'
 * attestations, nor they for it." This returns the component records whose own attestations
 * a consumer must additionally obtain -- empty for a component statement, because it makes
 * no claim that depends on another one.
 */
export function requiresComponentAttestations(
  statement: ChainEnvironmentVerificationStatement,
): readonly Sha256Digest[] {
  const composition = statement.predicate.composition;
  if (statement.predicate.scope !== "composite" || composition === undefined) return [];
  return composition.components.map((component) => component.record);
}
```

- [ ] **Step 5: Run the suite and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; all nine subject/statement tests pass; the boundary guard passes.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): chain verification subjects, statement, and match rules"
```

---

### Task 7: Ports — runtime, artifact store, clock, deps

Everything that touches the world is injected. There is no ambient Docker, no ambient fetch,
no ambient clock, and no key material anywhere in this package.

**Files:**
- Create: `src/ports.ts`, `src/ports.test.ts`

**Interfaces:**
- Consumes: `ChainMaterializer`, `ProbeExecutor`, `ScriptReplayer`, `ChainInstance`,
  `VerifiedChainInstance`, `MaterializationRequest`, `ResolvedResources`, `NetworkPolicy`,
  `ChainStateBackend`, `requiresStateBackend` from `@jinn-network/chain-environment-record`
  (the adopted shapes, confirmed at T1 step 2); `DsseSigner`, `Sha256Digest` from
  `@jinn-network/trust-core`.
- Produces: `Clock`, `ArtifactPutReceipt`, `ArtifactStore`, `ChainRuntime`,
  `InformationWorldRuntime`, `ChainVerificationDeps`, `DEFAULT_BLACKHOLE_POLICY`,
  `ResolvedResource`.

- [ ] **Step 1: Write the failing ports test**

`src/ports.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_BLACKHOLE_POLICY } from "./ports.js";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));

describe("ports", () => {
  it("blackholes every direction by default", () => {
    expect(DEFAULT_BLACKHOLE_POLICY).toEqual({
      egress: "denied",
      dns: "absent",
      archiveRpc: "unreachable",
      forkBackend: "absent",
    });
    expect(Object.isFrozen(DEFAULT_BLACKHOLE_POLICY)).toBe(true);
  });

  it("takes no ambient authority anywhere in production source", async () => {
    // Custody law as a test rather than a promise: the tree guard checks the same thing, and
    // a package that fails this fails it here first, in seconds.
    const banned = [
      /\bprocess\s*\.\s*env\b/u,
      /(?<![\w$.])fetch\s*\(/u,
      /["']node:child_process["']/u,
      /["']node:net["']/u,
      /["']node:http["']/u,
      /["']node:dns["']/u,
      /\bDate\s*\.\s*now\s*\(/u,
      /new\s+Date\s*\(\s*\)/u,
    ];
    const names = (await readdir(SOURCE_ROOT))
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".test.ts") && name !== "testing.ts");
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const text = await readFile(`${SOURCE_ROOT}${name}`, "utf8");
      for (const pattern of banned) {
        expect(pattern.test(text), `${name} matches ${String(pattern)}`).toBe(false);
      }
    }
  });
});
```

Add `chain-verification/src/ports.test.ts` to `CHAIN_VERIFICATION_FILESYSTEM_SOURCES` in the
tree guard (T1 step 6) when this task lands.

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/ports.test.ts`
Expected: FAIL — `Failed to resolve import "./ports.js"`.

- [ ] **Step 3: Implement `src/ports.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type {
  ChainInstance,
  ChainMaterializer,
  NetworkPolicy,
  ProbeExecutor,
} from "@jinn-network/chain-environment-record";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";

import type { ResourceDescriptor } from "./digests.js";
import type { VerifierIdentity } from "./predicate.js";

/** Injected time. No production module in this package calls `Date.now()`. */
export interface Clock {
  now(): Date;
}

export interface ArtifactPutReceipt {
  readonly digest: Sha256Digest;
  readonly size: number;
}

/**
 * Digest-addressed artifact store. Unlike the SWE sibling's write-only port, this one has a
 * read side, because design §5.1 step 1 resolves and digest-verifies every resource *before*
 * anything is materialized (Finding F-CE3-2). An `EvidenceRepository` adapts in a few lines;
 * this package declares the narrowest surface it uses so it takes no dependency on the
 * evidence tree.
 */
export interface ArtifactStore {
  /** Resolves by digest. Implementations MUST fail rather than return other bytes; the
   * caller re-digests anyway, and a mismatch is `artifact-unavailable`. */
  getArtifact(
    reference: ResourceDescriptor,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>;
  putArtifact(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactPutReceipt>;
}

/** One resource, resolved and digest-verified at step 1. The ordered list of these is the
 * resolution log, whose digest rides in the attestation's isolation evidence. */
export interface ResolvedResource {
  readonly name: string;
  readonly descriptor: ResourceDescriptor;
  readonly digest: Sha256Digest;
  readonly size: number;
}

/**
 * The chain plane's runtime. Two ports, not one: a consumer that only wants to materialize a
 * world (a solver's local runner) supplies a materializer and never a probe executor, which
 * is exactly the seam design §3 declares public.
 */
export interface ChainRuntime {
  readonly materializer: ChainMaterializer;
  readonly probes: ProbeExecutor;
}

/**
 * The information plane's runtime, injected only when a composite composes information
 * worlds. Absent-and-needed is `verification-infrastructure-failure`, never a silent skip:
 * a composite whose information plane was not exercised has not been verified (E14 sequences
 * the chain-only path first, so v1 composites carry an empty `informationWorlds` list and
 * never reach this port).
 */
export interface InformationWorldRuntime {
  serve(request: {
    readonly instance: ChainInstance;
    readonly worldRecords: readonly Uint8Array[];
    readonly corpora: ReadonlyMap<string, Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly observation: unknown; readonly egressAttempts: readonly string[] }>;
}

export interface ChainVerificationDeps {
  readonly runtime: ChainRuntime;
  readonly artifactStore: ArtifactStore;
  /** A signing function. This package never holds, reads, or derives key material. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain (design §5.3, Finding F-CE3-1). */
  readonly verifier: VerifierIdentity;
  /** Composite-only; see `InformationWorldRuntime`. */
  readonly informationRuntime?: InformationWorldRuntime;
}

/**
 * Design §5.1 step 2. Every direction is closed and the instance carries no fork backend,
 * which is the shape a sealed `closed-state` world has. A caller verifying a record whose
 * runtime *is* configured with a fork backend passes `forkBackend: "present"`, and the
 * protocol switches to the refusal evidence mode.
 */
export const DEFAULT_BLACKHOLE_POLICY: NetworkPolicy = Object.freeze({
  egress: "denied",
  dns: "absent",
  archiveRpc: "unreachable",
  forkBackend: "absent",
}) as NetworkPolicy;
```

- [ ] **Step 4: Run the suite and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; both ports tests pass; the guard passes.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src .github/scripts
git commit -m "feat(environments): chain verification ports and the blackhole policy"
```

---

### Task 8: Step 1 resolution and step 2 closure assessment

Design §5.1 step 1 ("resolve and digest-verify every resource before use; no schema
resolution or validation performs network retrieval") and step 2's **two closure evidence
modes**. The mode is a discriminator, not a branch of convenience: writing a check that only
works for fork-backed instances would leave every sealed world unverified, and writing one
that only works for sealed instances would accept a fork-backed instance that quietly fetched.

**Files:**
- Create: `src/resolve.ts`, `src/closure.ts`, `src/closure.test.ts`

**Interfaces:**
- Consumes: `recordDigest`, `canonicalJsonBytes`, `compareCodeUnitStrings`, `Sha256Digest`
  from `@jinn-network/trust-core`; `ArtifactStore`, `ResolvedResource` from `./ports.js`;
  the reason vocabulary from `./outcomes.js`.
- Produces: `resolveMaterials(store, requests, signal): Promise<ResolutionResult>`,
  `canonicalResolutionLogBytes(resolved)`, `assessClosure(input): ClosureAssessment`,
  `ClosureAssessmentInput`, `ClosureAssessment`.

- [ ] **Step 1: Write the failing closure test**

`src/closure.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessClosure } from "./closure.js";

const RESOLVED = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`] as const;

function sealed(overrides: Record<string, unknown> = {}) {
  return {
    networkPolicy: {
      egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "absent",
    },
    egressAttempts: [],
    boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: true },
    resolvedDigests: RESOLVED,
    loadedResources: RESOLVED,
    observationsEqual: true,
    ...overrides,
  } as const;
}

function forkBacked(overrides: Record<string, unknown> = {}) {
  return {
    ...sealed(),
    networkPolicy: {
      egress: "denied", dns: "absent", archiveRpc: "unreachable", forkBackend: "present",
    },
    boundaryProbe: undefined,
    egressAttempts: [{ target: "https://archive.example.test", outcome: "refused" }],
    ...overrides,
  } as const;
}

describe("closure assessment", () => {
  it("names the mode from the instance shape, never from the caller's preference", () => {
    expect(assessClosure(sealed()).mode).toBe("sealed-boundary");
    expect(assessClosure(forkBacked()).mode).toBe("fork-backend-refusal");
  });

  it("accepts a sealed instance on the boundary rule plus cross-run equality", () => {
    const assessment = assessClosure(sealed());
    expect(assessment.closed).toBe(true);
    expect(assessment.reason).toBeUndefined();
    expect(assessment.evidence).toContain("out-of-slice reads are empty");
    expect(assessment.evidence).toContain("cross-run observation equality");
  });

  it("refuses to call a sealed instance closed on absence of errors alone", () => {
    // No boundary probe: nothing was tried, nothing failed, and that is not evidence.
    expect(assessClosure(sealed({ boundaryProbe: undefined })))
      .toMatchObject({ closed: false, reason: "out-of-slice-read-not-empty" });
    expect(assessClosure(sealed({
      boundaryProbe: { probeId: "out-of-slice-read", readsEmptyOutsideSlice: false },
    }))).toMatchObject({ closed: false, reason: "out-of-slice-read-not-empty" });
    // Divergent observations are never closure evidence for a sealed instance.
    expect(assessClosure(sealed({ observationsEqual: false })))
      .toMatchObject({ closed: false, reason: "probe-observation-divergence" });
  });

  it("requires a recorded refusal from a fork-backed instance", () => {
    expect(assessClosure(forkBacked({ egressAttempts: [] })))
      .toMatchObject({ closed: false, reason: "fork-backend-fetch-unrefused" });
    expect(assessClosure(forkBacked({
      egressAttempts: [{ target: "https://archive.example.test", outcome: "succeeded" }],
    }))).toMatchObject({ closed: false, reason: "egress-succeeded" });
  });

  it("fails either mode when a resource outside the resolution log was loaded", () => {
    const stray = `sha256:${"9".repeat(64)}`;
    for (const input of [
      sealed({ loadedResources: [...RESOLVED, stray] }),
      forkBacked({ loadedResources: [...RESOLVED, stray] }),
    ]) {
      expect(assessClosure(input)).toMatchObject({
        closed: false,
        reason: "uncommitted-resource-loaded",
      });
    }
  });

  it("fails either mode on a successful egress", () => {
    for (const input of [
      sealed({ egressAttempts: [{ target: "https://x.test", outcome: "succeeded" }] }),
      forkBacked({ egressAttempts: [{ target: "https://x.test", outcome: "succeeded" }] }),
    ]) {
      expect(assessClosure(input)).toMatchObject({ closed: false, reason: "egress-succeeded" });
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/closure.test.ts`
Expected: FAIL — `Failed to resolve import "./closure.js"`.

- [ ] **Step 3: Implement `src/resolve.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { fromDigestSet, type ResourceDescriptor } from "./digests.js";
import type { ArtifactStore, ResolvedResource } from "./ports.js";

export interface ResolutionRequest {
  readonly name: string;
  readonly descriptor: ResourceDescriptor;
}

export type ResolutionResult =
  | {
    readonly ok: true;
    readonly resolved: readonly ResolvedResource[];
    readonly bytes: ReadonlyMap<string, Uint8Array>;
  }
  | {
    readonly ok: false;
    readonly reason: "resource-unresolvable" | "resource-digest-mismatch";
    readonly detail: string;
  };

/**
 * Design §5.1 step 1. Every resource -- record, runtime image, binary, state artifact,
 * fixtures, probe suite, comparator -- is resolved by digest and re-digested before use, and
 * the resolution log is what step 9 checks the instance's loaded set against. The store is
 * injected, so "no network retrieval" is a property of the call graph and not of a promise.
 */
export async function resolveMaterials(
  store: ArtifactStore,
  requests: readonly ResolutionRequest[],
  signal?: AbortSignal,
): Promise<ResolutionResult> {
  const resolved: ResolvedResource[] = [];
  const bytes = new Map<string, Uint8Array>();

  for (const request of requests) {
    const expected = fromDigestSet(request.descriptor.digest);
    let payload: Uint8Array;
    try {
      payload = await store.getArtifact(
        request.descriptor,
        signal === undefined ? undefined : { signal },
      );
    } catch (cause) {
      return {
        ok: false,
        reason: "resource-unresolvable",
        detail: `${request.name} (${expected}): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
    const actual = recordDigest(payload);
    if (actual !== expected) {
      return {
        ok: false,
        reason: "resource-digest-mismatch",
        detail: `${request.name} resolved to ${actual}, not ${expected}`,
      };
    }
    resolved.push({
      name: request.name,
      descriptor: request.descriptor,
      digest: actual,
      size: payload.length,
    });
    bytes.set(actual, payload);
  }

  return { ok: true, resolved, bytes };
}

/** RFC 8785 bytes of the resolution log, sorted by digest so the log's identity does not
 * depend on the order the verifier happened to resolve in. */
export function canonicalResolutionLogBytes(
  resolved: readonly ResolvedResource[],
): Uint8Array {
  const entries = [...resolved]
    .map((entry) => ({ name: entry.name, digest: entry.digest, size: entry.size }))
    .sort((left, right) => compareCodeUnitStrings(left.digest, right.digest));
  return canonicalJsonBytes({ entries });
}

export function resolutionLogDigest(resolved: readonly ResolvedResource[]): Sha256Digest {
  return recordDigest(canonicalResolutionLogBytes(resolved));
}
```

- [ ] **Step 4: Implement `src/closure.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type { ChainVerificationFailureReason } from "./outcomes.js";

export type ClosureEvidenceMode = "fork-backend-refusal" | "sealed-boundary";

export interface ClosureAssessmentInput {
  readonly networkPolicy: {
    readonly egress: "denied";
    readonly dns: "absent";
    readonly archiveRpc: "unreachable";
    readonly forkBackend: "absent" | "present";
  };
  readonly egressAttempts: readonly {
    readonly target: string;
    readonly outcome: "refused" | "succeeded";
  }[];
  /** Present only for sealed instances: §4.2's boundary rule, observed. */
  readonly boundaryProbe?: {
    readonly probeId: string;
    readonly readsEmptyOutsideSlice: boolean;
  };
  /** Digests of everything step 1 resolved. */
  readonly resolvedDigests: readonly string[];
  /** Digests of everything the instances actually loaded. */
  readonly loadedResources: readonly string[];
  /** Step 9's equality result. A sealed instance's closure evidence includes it. */
  readonly observationsEqual: boolean;
}

export interface ClosureAssessment {
  readonly mode: ClosureEvidenceMode;
  readonly closed: boolean;
  readonly reason?: ChainVerificationFailureReason;
  readonly detail?: string;
  /** Plain-language list of what the assessment rests on, for the attestation's reader. */
  readonly evidence: readonly string[];
}

/**
 * Design §5.1 step 2, both modes.
 *
 * A sealed instance has no fork backend at all, so no fetch can be attempted and the absence
 * of egress errors evidences nothing. Its closure rests on three positive facts: out-of-slice
 * reads are empty (§4.2's boundary rule), nothing outside the resolution log was loaded, and
 * the K observations agree.
 *
 * A fork-backed instance can attempt an upstream read, so the protocol provokes one and the
 * evidence is the recorded refusal. An attempt that succeeded is `offline-dependency-detected`
 * in either mode; so is a resource the resolution log never named.
 */
export function assessClosure(input: ClosureAssessmentInput): ClosureAssessment {
  const mode: ClosureEvidenceMode = input.networkPolicy.forkBackend === "present"
    ? "fork-backend-refusal"
    : "sealed-boundary";

  const succeeded = input.egressAttempts.find((attempt) => attempt.outcome === "succeeded");
  if (succeeded !== undefined) {
    return {
      mode,
      closed: false,
      reason: "egress-succeeded",
      detail: `egress to ${succeeded.target} succeeded`,
      evidence: [],
    };
  }

  const resolved = new Set(input.resolvedDigests);
  const stray = input.loadedResources.filter((digest) => !resolved.has(digest));
  if (stray.length > 0) {
    return {
      mode,
      closed: false,
      reason: "uncommitted-resource-loaded",
      detail: `loaded ${stray.length} resource(s) outside the resolution log: ${stray.join(", ")}`,
      evidence: [],
    };
  }

  if (mode === "fork-backend-refusal") {
    if (input.egressAttempts.length === 0) {
      return {
        mode,
        closed: false,
        reason: "fork-backend-fetch-unrefused",
        detail: "a fork-backed instance was not made to attempt an upstream read",
        evidence: [],
      };
    }
    return {
      mode,
      closed: true,
      evidence: [
        `${input.egressAttempts.length} upstream fetch attempt(s) refused`,
        "no resource outside the resolution log was loaded",
      ],
    };
  }

  // Sealed: three positive facts, none of which is "nothing went wrong".
  if (input.boundaryProbe === undefined || !input.boundaryProbe.readsEmptyOutsideSlice) {
    return {
      mode,
      closed: false,
      reason: "out-of-slice-read-not-empty",
      detail: input.boundaryProbe === undefined
        ? "a sealed instance was not probed for the boundary rule"
        : `probe ${input.boundaryProbe.probeId} did not read empty outside the slice`,
      evidence: [],
    };
  }
  if (!input.observationsEqual) {
    return {
      mode,
      closed: false,
      reason: "probe-observation-divergence",
      detail: "a sealed instance's closure rests on cross-run equality, which did not hold",
      evidence: [],
    };
  }
  return {
    mode,
    closed: true,
    evidence: [
      "out-of-slice reads are empty",
      "no resource outside the resolution log was loaded",
      "cross-run observation equality",
    ],
  };
}
```

- [ ] **Step 5: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all six closure tests pass. In particular, the two
"refuses to call a sealed instance closed on absence of errors alone" assertions must pass —
they are the check contract 7 exists for.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): resource resolution and two-mode closure assessment"
```

---

### Task 9: E13 artifact coverage

Design §4.2 E13, normative: *for `anchored-subset` and `full-state` records, every account,
code, and storage entry present in the state artifact MUST be either proof-covered by the
source manifest or declared as a fixture mutation.* Without it an author can prove real
protocol code and most storage against the true root while the artifact also carries one
tampered oracle slot — neither proven nor declared — and every other check in §5.1 passes.

**Files:**
- Create: `src/coverage.ts`, `src/coverage.test.ts`

**Interfaces:**
- Consumes: `compareCodeUnitStrings` from `@jinn-network/trust-core`; the reason vocabulary
  from `./outcomes.js`; CE1's `ArtifactEntryIndex`.
- Produces: `SourceProofManifest`, `FixtureMutationDeclaration`, `CoverageAssessmentInput`,
  `CoverageAssessment`, `assessArtifactCoverage(input): CoverageAssessment`.

**On the manifest type (answers CE4's cross-plan question).** CE4 produces the coverage
manifest; CE3 consumes it and is the only place `source-coverage-incomplete` is decided. The
type is `SourceProofManifest`, exported from this package, and CE4 imports it rather than
declaring a second shape. It is intentionally *data* — no proof verification lives in it; the
EIP-1186 verification of each entry is a separate step-4 check whose result the manifest
carries as `verified`.

- [ ] **Step 1: Write the failing coverage test**

`src/coverage.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessArtifactCoverage } from "./coverage.js";

const AAVE = "0x00000000000000000000000000000000000000aa";
const ORACLE = "0x00000000000000000000000000000000000000bb";
const FUNDED = "0x00000000000000000000000000000000000000cc";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

function input(overrides: Record<string, unknown> = {}) {
  return {
    fidelityClass: "anchored-subset",
    entries: {
      accounts: [AAVE, ORACLE, FUNDED],
      codeEntries: [AAVE],
      storageSlots: [{ address: AAVE, slot: SLOT_1 }, { address: ORACLE, slot: SLOT_2 }],
    },
    manifest: {
      anchorStateRoot: `0x${"3".repeat(64)}`,
      accounts: [{ address: AAVE, verified: true }, { address: ORACLE, verified: true }],
      codeEntries: [{ address: AAVE, codeHash: `0x${"4".repeat(64)}`, verified: true }],
      storageSlots: [
        { address: AAVE, slot: SLOT_1, verified: true },
        { address: ORACLE, slot: SLOT_2, verified: true },
      ],
    },
    fixtureMutations: [
      { address: FUNDED, kind: "account" },
    ],
    mutatesSourceProtocolState: false,
    ...overrides,
  } as const;
}

describe("E13 artifact coverage", () => {
  it("passes when every entry is proof-covered or fixture-declared", () => {
    const assessment = assessArtifactCoverage(input());
    expect(assessment).toMatchObject({ complete: true, proofCovered: 5, fixtureDeclared: 1 });
    expect(assessment.uncovered).toBe(0);
    expect(assessment.reason).toBeUndefined();
  });

  it("catches the tampered slot that no other check would see", () => {
    // The forged-slice gap, exactly: real code and real storage proven, plus one extra slot
    // that the manifest never mentions and no fixture declares.
    const tampered = input({
      entries: {
        accounts: [AAVE, ORACLE, FUNDED],
        codeEntries: [AAVE],
        storageSlots: [
          { address: AAVE, slot: SLOT_1 },
          { address: ORACLE, slot: SLOT_2 },
          { address: ORACLE, slot: `0x${"0".repeat(63)}9` },
        ],
      },
    });
    const assessment = assessArtifactCoverage(tampered);
    expect(assessment.complete).toBe(false);
    expect(assessment.reason).toBe("artifact-entry-uncovered");
    expect(assessment.uncoveredStorageSlots).toEqual([
      { address: ORACLE, slot: `0x${"0".repeat(63)}9` },
    ]);
    expect(assessment.uncovered).toBe(1);
  });

  it("reports uncovered accounts and code separately", () => {
    const assessment = assessArtifactCoverage(input({
      manifest: { ...input().manifest, codeEntries: [] },
    }));
    expect(assessment.uncoveredCodeEntries).toEqual([AAVE]);
    expect(assessment.reason).toBe("artifact-entry-uncovered");
  });

  it("treats an unverified proof entry as no coverage at all", () => {
    const assessment = assessArtifactCoverage(input({
      manifest: {
        ...input().manifest,
        storageSlots: [
          { address: AAVE, slot: SLOT_1, verified: true },
          { address: ORACLE, slot: SLOT_2, verified: false },
        ],
      },
    }));
    expect(assessment.complete).toBe(false);
    expect(assessment.uncoveredStorageSlots).toEqual([{ address: ORACLE, slot: SLOT_2 }]);
  });

  it("requires the visibility flag when a fixture mutates proof-covered protocol state", () => {
    const assessment = assessArtifactCoverage(input({
      fixtureMutations: [{ address: FUNDED, kind: "account" }, { address: AAVE, kind: "storage", slot: SLOT_1 }],
      mutatesSourceProtocolState: false,
    }));
    expect(assessment.complete).toBe(false);
    expect(assessment.reason).toBe("undeclared-source-mutation");
    expect(assessment.undeclaredMutations).toEqual([AAVE]);
    // Declared, it is legal: mutating real protocol state is how scenarios are built.
    expect(assessArtifactCoverage(input({
      fixtureMutations: [{ address: FUNDED, kind: "account" }, { address: AAVE, kind: "storage", slot: SLOT_1 }],
      mutatesSourceProtocolState: true,
    })).complete).toBe(true);
  });

  it("does not apply to local records", () => {
    const assessment = assessArtifactCoverage(input({
      fidelityClass: "local",
      manifest: undefined,
    }));
    expect(assessment).toMatchObject({ applicable: false, complete: true, uncovered: 0 });
  });

  it("requires a manifest for anchored-subset and full-state", () => {
    expect(assessArtifactCoverage(input({ manifest: undefined })))
      .toMatchObject({ complete: false, reason: "artifact-entry-uncovered" });
  });

  it("returns uncovered sets in code-unit order", () => {
    const assessment = assessArtifactCoverage(input({ manifest: { ...input().manifest, accounts: [] } }));
    expect(assessment.uncoveredAccounts).toEqual([AAVE, ORACLE]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/coverage.test.ts`
Expected: FAIL — `Failed to resolve import "./coverage.js"`.

- [ ] **Step 3: Implement `src/coverage.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/trust-core";

import type { ChainVerificationFailureReason } from "./outcomes.js";

/**
 * What the record's source-proof manifest asserts, as data. Proof *verification* is step 4's
 * own check; this type carries its per-entry result so coverage and validity stay separable
 * (an entry with an invalid proof covers nothing, which is why `verified` is read here too).
 * CE4 produces this shape; nothing re-declares it.
 */
export interface SourceProofManifest {
  readonly anchorStateRoot: string;
  readonly accounts: readonly { readonly address: string; readonly verified: boolean }[];
  readonly codeEntries: readonly {
    readonly address: string;
    readonly codeHash: string;
    readonly verified: boolean;
  }[];
  readonly storageSlots: readonly {
    readonly address: string;
    readonly slot: string;
    readonly verified: boolean;
  }[];
}

export interface FixtureMutationDeclaration {
  readonly address: string;
  readonly kind: "account" | "code" | "storage";
  readonly slot?: string;
}

/** CE1's `ArtifactEntryObservation`, restated as this module's input. Member names match
 * `stateArtifact.entryCounts` exactly -- two vocabularies for one partition is how an
 * off-by-one mapping gets written and never noticed (CE1 correction 2). */
export interface ArtifactEntryIndexInput {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

export interface CoverageAssessmentInput {
  readonly fidelityClass: "local" | "anchored-subset" | "full-state";
  readonly entries: ArtifactEntryIndexInput;
  readonly manifest?: SourceProofManifest;
  readonly fixtureMutations: readonly FixtureMutationDeclaration[];
  /** §4.2: a record that mutates any proof-covered protocol account MUST set this, so
   * diligence does not require reading every fixture module. */
  readonly mutatesSourceProtocolState: boolean;
}

export interface CoverageAssessment {
  readonly applicable: boolean;
  readonly complete: boolean;
  readonly proofCovered: number;
  readonly fixtureDeclared: number;
  readonly uncovered: number;
  readonly uncoveredAccounts: readonly string[];
  readonly uncoveredCodeEntries: readonly string[];
  readonly uncoveredStorageSlots: readonly { readonly address: string; readonly slot: string }[];
  readonly undeclaredMutations: readonly string[];
  readonly reason?: ChainVerificationFailureReason;
}

const sortStrings = (values: readonly string[]): readonly string[] =>
  [...values].sort(compareCodeUnitStrings);

const storageKey = (address: string, slot: string): string => `${address}#${slot}`;

/**
 * E13. Every artifact entry must be proof-covered or fixture-declared; anything else is
 * `source-coverage-incomplete`. Declared mutations of real protocol state stay legal -- that
 * is how scenarios are built -- but they must be visible, which is what the
 * `mutatesSourceProtocolState` flag is for.
 */
export function assessArtifactCoverage(
  input: CoverageAssessmentInput,
): CoverageAssessment {
  const empty = {
    uncoveredAccounts: [] as readonly string[],
    uncoveredCodeEntries: [] as readonly string[],
    uncoveredStorageSlots: [] as readonly { readonly address: string; readonly slot: string }[],
    undeclaredMutations: [] as readonly string[],
  };

  if (input.fidelityClass === "local") {
    // A local world claims no correspondence to any public chain, so there is no manifest to
    // be covered against and nothing to prove about the rest of the artifact.
    return {
      applicable: false,
      complete: true,
      proofCovered: 0,
      fixtureDeclared: input.fixtureMutations.length,
      uncovered: 0,
      ...empty,
    };
  }

  const provenAccounts = new Set(
    (input.manifest?.accounts ?? []).filter((one) => one.verified).map((one) => one.address),
  );
  const provenCode = new Set(
    (input.manifest?.codeEntries ?? []).filter((one) => one.verified).map((one) => one.address),
  );
  const provenStorage = new Set(
    (input.manifest?.storageSlots ?? [])
      .filter((one) => one.verified)
      .map((one) => storageKey(one.address, one.slot)),
  );

  const fixtureAccounts = new Set(
    input.fixtureMutations
      .filter((one) => one.kind === "account")
      .map((one) => one.address),
  );
  const fixtureCode = new Set(
    input.fixtureMutations.filter((one) => one.kind === "code").map((one) => one.address),
  );
  const fixtureStorage = new Set(
    input.fixtureMutations
      .filter((one) => one.kind === "storage" && one.slot !== undefined)
      .map((one) => storageKey(one.address, one.slot as string)),
  );

  const uncoveredAccounts = sortStrings(input.entries.accounts.filter(
    (address) => !provenAccounts.has(address) && !fixtureAccounts.has(address),
  ));
  const uncoveredCodeEntries = sortStrings(input.entries.codeEntries.filter(
    (address) => !provenCode.has(address) && !fixtureCode.has(address),
  ));
  const uncoveredStorageSlots = [...input.entries.storageSlots]
    .filter((entry) => {
      const key = storageKey(entry.address, entry.slot);
      return !provenStorage.has(key) && !fixtureStorage.has(key);
    })
    .sort((left, right) => compareCodeUnitStrings(
      storageKey(left.address, left.slot),
      storageKey(right.address, right.slot),
    ));

  // A fixture that writes over proof-covered protocol state is legal and must be visible.
  const undeclaredMutations = input.mutatesSourceProtocolState
    ? []
    : sortStrings([...new Set(input.fixtureMutations
      .filter((mutation) => {
        if (mutation.kind === "account") return provenAccounts.has(mutation.address);
        if (mutation.kind === "code") return provenCode.has(mutation.address);
        return mutation.slot !== undefined
          && provenStorage.has(storageKey(mutation.address, mutation.slot));
      })
      .map((mutation) => mutation.address))]);

  const uncovered = uncoveredAccounts.length + uncoveredCodeEntries.length
    + uncoveredStorageSlots.length;
  const proofCovered = provenAccounts.size + provenCode.size + provenStorage.size;
  const fixtureDeclared = fixtureAccounts.size + fixtureCode.size + fixtureStorage.size;

  const reason: ChainVerificationFailureReason | undefined = uncovered > 0
    ? "artifact-entry-uncovered"
    : undeclaredMutations.length > 0
      ? "undeclared-source-mutation"
      : undefined;

  return {
    applicable: true,
    complete: reason === undefined,
    proofCovered,
    fixtureDeclared,
    uncovered,
    uncoveredAccounts,
    uncoveredCodeEntries,
    uncoveredStorageSlots,
    undeclaredMutations,
    ...(reason === undefined ? {} : { reason }),
  };
}
```

- [ ] **Step 4: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all eight coverage tests pass, including the tampered-slot case
that no other §5.1 check would catch.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): E13 artifact coverage assessment"
```

---

### Task 10: `verifyChainEnvironment` — design §5.1 steps 1–9

The closed-state driver. It throws only for caller error (`INVALID_INPUT`) or a port that
broke its contract (`CONFORMANCE_FAILURE`); every environment fact — including every negative
one — comes back as a signed attestation.

**Files:**
- Create: `src/verify.ts`, `src/verify.test.ts`

**Interfaces:**
- Consumes: `sealChainEnvironmentRecord`, `chainEnvironmentRecordDigest`,
  `ChainEnvironmentRecord` from `@jinn-network/chain-environment-record`;
  `sealSignedRecord`, `DSSE_PAYLOAD_TYPE`, `recordDigest`, `Sha256Digest` from
  `@jinn-network/trust-core`; every T2–T9 module.
- Produces: `verifyChainEnvironment(deps, record, options?): Promise<SealedAttestation>`,
  `SealedAttestation`, `VerifyChainEnvironmentOptions`.

**Pinned signature.** `verifyChainEnvironment(deps, record)` is a correct call: `options` is
optional, and every configuration that can default honestly (K, network policy, probe
timeout) lives there. `deps` injects `{runtime, artifactStore, signer, clock, verifier}` —
`verifier` is host-declared per Finding F-CE3-1.

- [ ] **Step 1: Write the failing happy-path test**

`src/verify.test.ts` — a stub runtime local to this suite (T16 promotes the published kit):

```ts
// SPDX-License-Identifier: Apache-2.0

import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { DSSE_PAYLOAD_TYPE, dssePreAuthEncoding, parseDsseEnvelope, recordDigest, type DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { buildConformanceChainRecord } from "./conformance-records.js";
import { canonicalChainObservationBytes, chainObservationDigest } from "./observation.js";
import { DEFAULT_BLACKHOLE_POLICY, type ArtifactStore, type ChainRuntime } from "./ports.js";
import { verifyChainEnvironment } from "./verify.js";

const eoa = createEoaTestSigner("chain-verification-verify-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

// `createStubRuntime`, `createStubArtifactStore`, `createFixedClock`, `VERIFIER` and the
// reference observation are defined in this file for now; T16 replaces them with the
// published kit and this suite keeps only the assertions the kit does not make.
// (Implementation note for the executing agent: write them as the smallest thing that drives
// `verifyChainEnvironment`, then delete them in T16 step 3 in favour of `./testing.js`.)

describe("verifyChainEnvironment", () => {
  it("attests closed-reproducible over K fresh instances", async () => {
    const runtime = createStubRuntime({ kind: "sealed-stable" });
    const artifactStore = createStubArtifactStore();
    const attestation = await verifyChainEnvironment(
      { runtime, artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );

    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe("closed-reproducible");
    expect(predicate.scope).toBe("component");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.runs?.allObservationsEqual).toBe(true);
    expect(predicate.runs?.freshInstances).toBe(true);
    expect(predicate.isolation.closureEvidenceMode).toBe("sealed-boundary");
    expect(predicate.failure).toBeUndefined();
    expect(attestation.outcome).toBe("closed-reproducible");
    expect(new Set(attestation.instanceIds).size).toBe(5);
    expect(attestation.observations).toHaveLength(5);
  });

  it("materializes K times under the blackhole policy, never once", async () => {
    const runtime = createStubRuntime({ kind: "sealed-stable" });
    await verifyChainEnvironment(
      { runtime, artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    expect(runtime.materializeRequests).toHaveLength(5);
    for (const request of runtime.materializeRequests) {
      expect(request.networkPolicy).toEqual(DEFAULT_BLACKHOLE_POLICY);
    }
    // Snapshot/revert inside one process is testing convenience, never verification: each run
    // must be its own materialization (design §5.1 step 8).
    expect(new Set(runtime.materializeRequests.map((one) => one.instanceId)).size).toBe(5);
    expect(runtime.stopCount).toBe(5);
  });

  it("stores the canonical observation and the resolution log through the artifact port", async () => {
    const artifactStore = createStubArtifactStore();
    const attestation = await verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore, signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const observationDigest = chainObservationDigest(attestation.observations[0]!);
    expect(artifactStore.stored.get(observationDigest))
      .toEqual(canonicalChainObservationBytes(attestation.observations[0]!));
    expect(attestation.statement.predicate.baseline?.observation.digest.sha256)
      .toBe(observationDigest.slice("sha256:".length));
    const logDigest = attestation.statement.predicate.isolation.resolutionLog.digest.sha256;
    expect(artifactStore.stored.has(`sha256:${logDigest}`)).toBe(true);
  });

  it("seals a DSSE envelope whose payload is the statement", async () => {
    const attestation = await verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const envelope = parseDsseEnvelope(attestation.envelopeBytes);
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(JSON.parse(new TextDecoder().decode(envelope.payloadBytes)))
      .toEqual(attestation.statement);
    expect(attestation.attestationDigest).toBe(recordDigest(attestation.envelopeBytes));
    const preAuth = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
    expect(preAuth.length).toBeGreaterThan(0);
  });

  it("refuses K below the floor, and refuses an archive-dependent record", async () => {
    const deps = { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER };
    await expect(verifyChainEnvironment(deps, buildConformanceChainRecord(), { runCount: 4 }))
      .rejects.toThrow(/at least 5/u);
    const archiveRecord = buildConformanceChainRecord({ closureClass: "archive-dependent" });
    await expect(verifyChainEnvironment(deps, archiveRecord))
      .rejects.toThrow(/observeArchiveEnvironment/u);
  });

  it("is byte-stable across repeated runs of the same scenario", async () => {
    const run = async () => verifyChainEnvironment(
      { runtime: createStubRuntime({ kind: "sealed-stable" }), artifactStore: createStubArtifactStore(), signer, clock: createFixedClock(), verifier: VERIFIER },
      buildConformanceChainRecord(),
    );
    const [first, second] = [await run(), await run()];
    expect(second.statement).toEqual(first.statement);
    expect(second.envelopeBytes).toEqual(first.envelopeBytes);
  });
});
```

- [ ] **Step 2: Write `src/conformance-records.ts` (the record the suite verifies)**

Contract 8 governs this file: every fixture address is generated once for this record and
never funded, and none is a well-known development address. Author them as literal constants
with the comment below, and let T16 step 6's deny-list test enforce it.

```ts
// SPDX-License-Identifier: Apache-2.0

// The conformance chain world and the composite that wraps it. Fixture addresses here were
// generated once for this record and are used nowhere else (design §8, program contract 8).
// They hold nothing on any chain. Funding one of them would turn every published solution
// script into a replayable mainnet transaction from it -- a hazard for whoever funds it, and
// the reason these keys are never reused across records.

import {
  parseChainEnvironmentRecord,
  parseCryptoEnvironmentRecord,
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  type ChainEnvironmentRecord,
  type CryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";

export const CONFORMANCE_AGENT_ACCOUNT = "0x2f1c6ba4f0d7e4b8c9a3057e61d2b8f4a7c0e913";
export const CONFORMANCE_COUNTERPARTY_ACCOUNT = "0x8d43a5e2907c16bf4de0913a7bc25f8e04617d2a";
export const CONFORMANCE_PROTOCOL_ACCOUNT = "0xb17e05c3f4a2986d1c7be0435928fda6017c34e8";

export interface ConformanceRecordOptions {
  readonly closureClass?: "closed-state" | "archive-dependent";
  readonly fidelityClass?: "local" | "anchored-subset" | "full-state";
}

/**
 * Built with CE1's parser rather than as a bare literal, so a record shape this package
 * assumes but CE1 rejects fails here rather than three tasks later.
 */
export function buildConformanceChainRecord(
  options: ConformanceRecordOptions = {},
): ChainEnvironmentRecord {
  // Assemble the literal per design §4.3's blocks, then round-trip it:
  //   const candidate = { kind: CHAIN_ENVIRONMENT_KIND, runtime: {...}, sourceAnchor: {...},
  //     stateMaterialization: {...}, fixtures: {...}, determinismControls: {...},
  //     capabilityEnvelope: {...}, verificationContract: {...} };
  //   return parseChainEnvironmentRecord(sealChainEnvironmentRecord(candidate));
  // The executing agent fills the literal from CE1's fixtures (`@jinn-network/
  // chain-environment-record/testing`), preferring CE1's own conformance record where it
  // ships one and overriding only `closureClass` / `fidelityClass` from `options`.
  throw new Error("filled in step 2");
}

export function buildConformanceCompositeRecord(
  options: { readonly informationWorlds?: readonly string[] } = {},
): CryptoEnvironmentRecord {
  // A chain-only composite by default: `informationWorlds` is empty, which is the v1 case
  // design §5 sequences first (E14) and the CE6 gate the program §5 names.
  throw new Error("filled in step 2");
}
```

**This is the one place the plan hands the executing agent a shape rather than a literal**, and
deliberately: CE1 owns the field grammar and ships fixtures, so hand-authoring a second literal
here would fork it. The step is complete when `buildConformanceChainRecord()` round-trips
through CE1's parser and `throw new Error` is gone. A `TODO`, a placeholder digest, or a
literal that does not round-trip fails the placeholder scan in the branch gate.

- [ ] **Step 3: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/verify.test.ts`
Expected: FAIL — `Failed to resolve import "./verify.js"`.

- [ ] **Step 4: Implement `src/verify.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  chainEnvironmentRecordDigest,
  sealChainEnvironmentRecord,
  type ChainEnvironmentRecord,
  type ChainInstance,
  type NetworkPolicy,
  type VerifiedChainInstance,
} from "@jinn-network/chain-environment-record";
import {
  DSSE_PAYLOAD_TYPE,
  recordDigest,
  sealSignedRecord,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { assessClosure, type ClosureAssessment } from "./closure.js";
import { assessArtifactCoverage, type CoverageAssessment } from "./coverage.js";
import { PrefixedSha256Schema, fromDigestSet, toDigestSet, type ResourceDescriptor } from "./digests.js";
import { conformanceFailure, invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  buildCanonicalChainObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
  type CanonicalChainObservation,
} from "./observation.js";
import {
  outcomeForFailureReason,
  stageForFailureReason,
  type ChainVerificationFailureReason,
  type ChainVerificationOutcome,
} from "./outcomes.js";
import { DEFAULT_BLACKHOLE_POLICY, type ArtifactStore, type ChainVerificationDeps, type ResolvedResource } from "./ports.js";
import type {
  ChainEnvironmentVerificationPredicate,
  EnvironmentObservation,
  FailureBlock,
  IsolationEvidence,
} from "./predicate.js";
import { canonicalResolutionLogBytes, resolveMaterials, type ResolutionRequest } from "./resolve.js";
import {
  buildChainEnvironmentVerificationStatement,
  type ChainEnvironmentVerificationStatement,
} from "./statement.js";

export type { ChainVerificationDeps } from "./ports.js";

export interface VerifyChainEnvironmentOptions {
  /** K. Defaults to, and may never be below, `MINIMUM_RUN_COUNT`. */
  readonly runCount?: number;
  /** Defaults to `DEFAULT_BLACKHOLE_POLICY`. Pass `forkBackend: "present"` when the runtime
   * under test is configured with one; the closure evidence mode follows. */
  readonly networkPolicy?: NetworkPolicy;
  readonly probeTimeoutSeconds?: number;
  /** Namespace for the fresh instance ids this call requests. */
  readonly instanceIdPrefix?: string;
  readonly signal?: AbortSignal;
}

export interface SealedAttestation {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Identity of the sealed envelope. */
  readonly attestationDigest: Sha256Digest;
  readonly statement: ChainEnvironmentVerificationStatement;
  /** Also at `statement.predicate.outcome`; surfaced so a caller need not reach in. */
  readonly outcome: ChainVerificationOutcome;
  /**
   * Instance ids of the K runs, in run order. Not part of the signed payload: a host-side
   * check that each run got a fresh materialization rather than a snapshot revert.
   */
  readonly instanceIds: readonly string[];
  /**
   * The K canonical observations, in run order. Not signed -- their digests are -- and
   * returned so a caller comparing against its own baseline (an extraction widen loop) does
   * not have to re-run the protocol to see what diverged.
   */
  readonly observations: readonly CanonicalChainObservation[];
}

interface RunRecord {
  readonly instanceId: string;
  readonly observation: CanonicalChainObservation;
  readonly digest: Sha256Digest;
  readonly wallSeconds: number;
}

interface ObservationContext {
  readonly resolved: readonly ResolvedResource[];
  readonly environment: EnvironmentObservation;
  readonly isolation: Omit<IsolationEvidence, "closureEvidenceMode" | "resolutionLog">;
  readonly closure: ClosureAssessment;
  readonly coverage: CoverageAssessment;
  readonly cost: { artifactBytes: number; artifactCount: number; wallSeconds: number };
}

type Observed =
  | { readonly kind: "runs"; readonly runs: readonly RunRecord[]; readonly context: ObservationContext }
  | {
    readonly kind: "failed";
    readonly reason: ChainVerificationFailureReason;
    readonly detail: string;
    readonly context: ObservationContext;
    readonly partial?: FailureBlock["coverage"];
    readonly divergence?: FailureBlock["divergence"];
    readonly instanceIds: readonly string[];
    readonly observations: readonly CanonicalChainObservation[];
  };

function toRfc3339Utc(instant: Date): string {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) invalidInput("The injected clock returned an invalid Date.");
  return new Date(milliseconds).toISOString();
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function storeArtifact(
  store: ArtifactStore,
  bytes: Uint8Array,
  descriptor: { readonly name: string; readonly mediaType: string },
  signal: AbortSignal | undefined,
): Promise<ResourceDescriptor> {
  const expected = recordDigest(bytes);
  const receipt = await store.putArtifact(bytes, signal === undefined ? undefined : { signal });
  if (receipt.digest !== expected) {
    conformanceFailure(
      `Artifact store returned ${receipt.digest} for bytes digesting to ${expected}.`,
    );
  }
  return { ...descriptor, digest: toDigestSet(expected) };
}

/**
 * Executes design §5.1's closed-state protocol against `record` and returns a DSSE-sealed
 * in-toto Statement.
 *
 * The claim is bounded: `outcome: "closed-reproducible"` means K fresh materializations under
 * blackhole produced identical canonical observations -- no more. Divergence, isolation
 * breaches, coverage gaps, and infrastructure failures are signed and returned by the same
 * call. This function throws only for caller error (`INVALID_INPUT`) or a port that broke its
 * contract (`CONFORMANCE_FAILURE`), never for an environment fact.
 */
export async function verifyChainEnvironment(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  options: VerifyChainEnvironmentOptions = {},
): Promise<SealedAttestation> {
  const runCount = options.runCount ?? MINIMUM_RUN_COUNT;
  if (!Number.isInteger(runCount) || runCount < MINIMUM_RUN_COUNT) {
    invalidInput(
      `This profile requires at least ${MINIMUM_RUN_COUNT} fresh materializations; received ${String(options.runCount)}.`,
    );
  }
  if (record.stateMaterialization.closureClass !== "closed-state") {
    invalidInput(
      "verifyChainEnvironment runs the closed-state protocol; an archive-dependent record is "
      + "observed through observeArchiveEnvironment, which makes the weaker claim design §5.2 "
      + "allows it to make.",
    );
  }

  // Subject identity: re-seal the parsed record. Sealing is a pure JCS-once function, so this
  // reproduces the record's identity bytes -- provided the caller parsed exact bytes, which
  // CE1's parser enforces (Finding F-CE3-8).
  const recordBytes = sealChainEnvironmentRecord(record);
  const recordDigestValue = PrefixedSha256Schema.parse(
    chainEnvironmentRecordDigest(recordBytes),
  ) as Sha256Digest;

  const startedAt = toRfc3339Utc(deps.clock.now());
  const observed = await observe(deps, record, {
    runCount,
    networkPolicy: options.networkPolicy ?? DEFAULT_BLACKHOLE_POLICY,
    probeTimeoutSeconds: options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS,
    instanceIdPrefix: options.instanceIdPrefix ?? recordDigestValue.slice("sha256:".length, 16),
    signal: options.signal,
  });
  const endedAt = toRfc3339Utc(deps.clock.now());

  const resolutionLog = await storeArtifact(
    deps.artifactStore,
    canonicalResolutionLogBytes(observed.context.resolved),
    { name: "resolution-log", mediaType: "application/json" },
    options.signal,
  );

  const predicate = observed.kind === "runs"
    ? await buildRunsPredicate(deps, { startedAt, endedAt }, observed, resolutionLog, options.signal)
    : buildFailurePredicate(deps, { startedAt, endedAt }, observed, resolutionLog);

  const stateArtifact = record.stateMaterialization.stateArtifact;
  const statement = buildChainEnvironmentVerificationStatement({
    recordDigest: recordDigestValue,
    ...(stateArtifact === undefined
      ? {}
      : { stateArtifactDigest: fromDigestSet(stateArtifact.digest) }),
    predicate,
  });

  const sealed = await sealSignedRecord({
    record: statement,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: deps.signer,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    attestationDigest: sealed.recordDigest,
    statement,
    outcome: predicate.outcome,
    instanceIds: observed.kind === "runs"
      ? observed.runs.map((run) => run.instanceId)
      : observed.instanceIds,
    observations: observed.kind === "runs"
      ? observed.runs.map((run) => run.observation)
      : observed.observations,
  };
}
```

- [ ] **Step 5: Implement `observe` in the same file — steps 1 through 9**

```ts
interface ObserveOptions {
  readonly runCount: number;
  readonly networkPolicy: NetworkPolicy;
  readonly probeTimeoutSeconds: number;
  readonly instanceIdPrefix: string;
  readonly signal: AbortSignal | undefined;
}

/** Step 1's request list, read straight off the record's blocks. */
function materialRequests(record: ChainEnvironmentRecord): readonly ResolutionRequest[] {
  const requests: ResolutionRequest[] = [
    { name: "materializer", descriptor: record.stateMaterialization.materializer },
    { name: "probe-suite", descriptor: record.verificationContract.probeSuite },
    { name: "comparator", descriptor: record.verificationContract.comparator },
  ];
  if (record.stateMaterialization.stateArtifact !== undefined) {
    requests.push({ name: "state-artifact", descriptor: record.stateMaterialization.stateArtifact });
  }
  if (record.stateMaterialization.sourceProofManifest !== undefined) {
    requests.push({
      name: "source-proof-manifest",
      descriptor: record.stateMaterialization.sourceProofManifest,
    });
  }
  if (record.sourceAnchor?.headerProof !== undefined) {
    requests.push({ name: "header-proof", descriptor: record.sourceAnchor.headerProof });
  }
  record.fixtures.modules.forEach((module, index) => {
    requests.push({ name: `fixture-${index}-${module.id}`, descriptor: module.artifact });
  });
  return requests;
}

async function observe(
  deps: ChainVerificationDeps,
  record: ChainEnvironmentRecord,
  options: ObserveOptions,
): Promise<Observed> {
  // --- Step 1: resolve and digest-verify everything before anything is materialized.
  const resolution = await resolveMaterials(
    deps.artifactStore,
    materialRequests(record),
    options.signal,
  );
  if (!resolution.ok) {
    return {
      kind: "failed",
      reason: resolution.reason,
      detail: resolution.detail,
      context: emptyContext(record, options),
      instanceIds: [],
      observations: [],
    };
  }

  const runs: RunRecord[] = [];
  const instanceIds: string[] = [];
  const observations: CanonicalChainObservation[] = [];
  let coverage: CoverageAssessment | undefined;
  let identity: VerifiedChainInstance | undefined;
  let egressAttempts: IsolationEvidence["egressAttempts"] = [];
  let forbiddenProbes: IsolationEvidence["forbiddenProbes"] = [];
  let signerScope: IsolationEvidence["signerScope"] = {
    declaredRoles: record.capabilityEnvelope.signerRoles,
    exposedAccounts: [],
    unexpectedAccounts: [],
  };
  let loadedResources: string[] = [];
  let resetCommitment: `0x${string}` | undefined;
  let wallSeconds = 0;

  // --- Steps 2 through 8: K fresh materializations under the blackhole policy.
  for (let index = 0; index < options.runCount; index += 1) {
    const instanceId = `${options.instanceIdPrefix}-run-${index}`;
    let instance: ChainInstance;
    try {
      instance = await deps.runtime.materializer.materialize({
        record,
        instanceId,
        networkPolicy: options.networkPolicy,
        resources: { byDigest: resolution.bytes },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return fail("materializer-failed", `run ${index}: ${describeCause(cause)}`);
    }
    instanceIds.push(instance.instanceId);
    // `report` is optional on CE1's `ChainInstance` so a solver's local runner is never forced
    // to synthesise isolation evidence and cost observations it has no use for. A materializer
    // used for VERIFICATION must produce one; its absence is an infrastructure fact, checked
    // explicitly rather than asserted away (CE1 correction 3).
    if (instance.report === undefined) {
      return fail("materialization-report-absent", `run ${index}: instance ${instance.instanceId}`);
    }
    const verified = instance as VerifiedChainInstance;
    identity ??= verified;
    egressAttempts = [...egressAttempts, ...verified.report.isolation.egressAttempts];
    loadedResources = [...loadedResources, ...verified.report.loadedResources];
    wallSeconds += verified.report.cost.wallSeconds;

    try {
      // --- Step 3: runtime identity, including the determinism controls (design §5.1 step 3;
      // §10 is why `unsupportedControls` is checked rather than assumed empty).
      const identityFailure = checkRuntimeIdentity(record, verified);
      if (identityFailure !== undefined) return fail(identityFailure.reason, identityFailure.detail);

      // --- Step 4: source provenance + E13 coverage. The artifact is the same bytes on every
      // run, so this is computed once, on the first instance.
      if (coverage === undefined) {
        coverage = assessArtifactCoverage({
          fidelityClass: record.stateMaterialization.fidelityClass,
          entries: verified.report.artifactEntries,
          ...(resolution.bytes.has(sourceManifestDigest(record))
            ? { manifest: decodeSourceProofManifest(resolution, record) }
            : {}),
          fixtureMutations: declaredFixtureMutations(record),
          mutatesSourceProtocolState:
            record.stateMaterialization.mutatesSourceProtocolState ?? false,
        });
        if (!coverage.complete) {
          return fail(
            coverage.reason ?? "artifact-entry-uncovered",
            `${coverage.uncovered} artifact entr(ies) are neither proof-covered nor fixture-declared`,
            {
              uncoveredAccounts: coverage.uncoveredAccounts,
              uncoveredCodeEntries: coverage.uncoveredCodeEntries,
              uncoveredStorageSlots: coverage.uncoveredStorageSlots,
              undeclaredMutations: coverage.undeclaredMutations,
            },
          );
        }
        const anchorFailure = checkSourceAnchor(record, verified);
        if (anchorFailure !== undefined) return fail(anchorFailure.reason, anchorFailure.detail);
      }

      // --- Step 5: the post-fixture commitment is the agent-visible world's commitment, and
      // is explicitly NOT the source anchor's state root (design §4.3).
      if (verified.report.postFixtureCommitment
        !== record.stateMaterialization.initialStateCommitment) {
        return fail(
          "post-fixture-commitment-mismatch",
          `run ${index}: instantiated ${verified.report.postFixtureCommitment}, record declares `
          + `${record.stateMaterialization.initialStateCommitment}`,
        );
      }

      // --- Step 6: capability and isolation probes.
      forbiddenProbes = verified.report.isolation.forbiddenProbes
        .map((probe) => ({ ...probe, passed: probe.observedClass === probe.expectedClass }));
      const failedProbe = forbiddenProbes.find((probe) => !probe.passed);
      if (failedProbe !== undefined) {
        return fail(
          "rpc-allowlist-violation",
          `run ${index}: ${failedProbe.method} answered ${failedProbe.observedClass}, expected `
          + failedProbe.expectedClass,
        );
      }
      const unexpectedAccounts = verified.report.isolation.exposedSignerAccounts
        .filter((account) => !declaredFixtureAccounts(record).includes(account));
      signerScope = {
        declaredRoles: record.capabilityEnvelope.signerRoles,
        exposedAccounts: verified.report.isolation.exposedSignerAccounts,
        unexpectedAccounts,
      };
      if (unexpectedAccounts.length > 0) {
        return fail("signer-scope-violation", `run ${index}: ${unexpectedAccounts.join(", ")}`);
      }
      const unenforced = verified.report.isolation.ceilingChecks.find((one) => !one.enforced);
      if (unenforced !== undefined) {
        return fail("ceiling-not-enforced", `run ${index}: ${unenforced.name}`);
      }

      // --- Step 7: the deterministic probe suite. The canonical observation is hashed;
      // whatever shape the backend returned is not.
      let probeResult;
      try {
        probeResult = await deps.runtime.probes.execute({
          instance,
          probeSuiteBytes: resolution.bytes.get(fromDigestSet(record.verificationContract.probeSuite.digest))!,
          comparatorBytes: resolution.bytes.get(fromDigestSet(record.verificationContract.comparator.digest))!,
          timeoutSeconds: options.probeTimeoutSeconds,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        return fail("probe-executor-failed", `run ${index}: ${describeCause(cause)}`);
      }
      if (probeResult.timedOut) {
        return fail("run-timeout", `run ${index} exceeded ${options.probeTimeoutSeconds}s`);
      }
      const observation = buildCanonicalChainObservation(probeResult.observation);
      observations.push(observation);
      runs.push({
        instanceId: instance.instanceId,
        observation,
        digest: chainObservationDigest(observation),
        wallSeconds: probeResult.cost.wallSeconds,
      });
      wallSeconds += probeResult.cost.wallSeconds;

      // --- Step 6's reset requirement, checked on the first instance only: the record says
      // whether reset must reproduce the baseline.
      if (index === 0 && record.verificationContract.resetRequirements !== "none") {
        const postReset = await deps.runtime.materializer.reset(instance, options.signal);
        resetCommitment = postReset;
        if (postReset !== verified.report.postFixtureCommitment) {
          return fail(
            "reset-observation-divergence",
            `reset produced ${postReset}, baseline is ${verified.report.postFixtureCommitment}`,
          );
        }
      }
    } finally {
      // Teardown is on the instance, not the materializer: CE1's `ChainInstance` owns its own
      // `stop`, and a verifier that leaks instances on the failing path is one nobody can run
      // K times.
      await instance.stop();
    }
  }

  // --- Step 9: compare.
  const reference = runs[0]!;
  const divergent = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.digest !== reference.digest);
  const observationsEqual = divergent.length === 0;

  const closure = assessClosure({
    networkPolicy: options.networkPolicy,
    egressAttempts,
    ...(options.networkPolicy.forkBackend === "absent"
      ? { boundaryProbe: boundaryProbeFrom(reference.observation, record) }
      : {}),
    resolvedDigests: resolution.resolved.map((one) => one.digest),
    loadedResources,
    observationsEqual,
  });

  const context: ObservationContext = {
    resolved: resolution.resolved,
    environment: buildEnvironmentObservation(record, identity!, coverage),
    isolation: {
      networkPolicy: options.networkPolicy,
      ...(options.networkPolicy.forkBackend === "absent"
        ? { boundaryProbe: boundaryProbeFrom(reference.observation, record) }
        : {}),
      egressAttempts,
      forbiddenProbes,
      signerScope,
      ...(resetCommitment === undefined ? {} : { resetCommitment }),
    },
    closure,
    coverage: coverage!,
    cost: {
      artifactBytes: resolution.resolved.reduce((total, one) => total + one.size, 0),
      artifactCount: resolution.resolved.length,
      wallSeconds,
    },
  };

  if (!closure.closed && closure.reason !== "probe-observation-divergence") {
    return {
      kind: "failed",
      reason: closure.reason!,
      detail: closure.detail ?? "closure assessment failed",
      context,
      instanceIds,
      observations,
    };
  }
  if (!observationsEqual) {
    return {
      kind: "failed",
      reason: "probe-observation-divergence",
      detail: `${divergent.length} of ${runs.length} runs diverged from run 0`,
      context,
      instanceIds,
      observations,
      divergence: {
        referenceRunIndex: 0,
        referenceObservationDigest: reference.digest,
        divergentRuns: divergent.map(({ run, index }) => ({
          index,
          instanceId: run.instanceId,
          observationDigest: run.digest,
          observation: { name: `observation-run-${index}`, digest: toDigestSet(run.digest) },
        })),
      },
    };
  }

  return { kind: "runs", runs, context };

  function fail(
    reason: ChainVerificationFailureReason,
    detail: string,
    partial?: FailureBlock["coverage"],
  ): Observed {
    return {
      kind: "failed",
      reason,
      detail,
      context: {
        resolved: resolution.ok ? resolution.resolved : [],
        environment: buildEnvironmentObservation(record, identity, coverage),
        isolation: {
          networkPolicy: options.networkPolicy,
          egressAttempts,
          forbiddenProbes,
          signerScope,
        },
        closure: { mode: options.networkPolicy.forkBackend === "present"
          ? "fork-backend-refusal" : "sealed-boundary", closed: false, evidence: [] },
        coverage: coverage ?? {
          applicable: false, complete: false, proofCovered: 0, fixtureDeclared: 0,
          uncovered: 0, uncoveredAccounts: [], uncoveredCodeEntries: [], uncoveredStorageSlots: [],
          undeclaredMutations: [],
        },
        cost: {
          artifactBytes: resolution.ok
            ? resolution.resolved.reduce((total, one) => total + one.size, 0) : 0,
          artifactCount: resolution.ok ? resolution.resolved.length : 0,
          wallSeconds,
        },
      },
      instanceIds,
      observations,
      ...(partial === undefined ? {} : { partial }),
    };
  }
}
```

The helper functions `emptyContext`, `checkRuntimeIdentity`, `checkSourceAnchor`,
`buildEnvironmentObservation`, `boundaryProbeFrom`, `declaredFixtureAccounts`,
`declaredFixtureMutations`, `sourceManifestDigest`, and `decodeSourceProofManifest` are
small, pure, and written in the same file; each reads exactly the record paths listed in
§Consumed interfaces and returns either `undefined` or a `{reason, detail}` pair. Their unit
coverage arrives with T11's per-outcome tests.

- [ ] **Step 6: Implement the two predicate builders in the same file**

```ts
async function buildRunsPredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "runs" }>,
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = observed.runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "component",
    outcome: "closed-reproducible",
    window,
    verifier: deps.verifier,
    materials: observed.context.resolved.map((one) => ({
      name: one.name,
      digest: toDigestSet(one.digest),
    })),
    environment: observed.context.environment,
    runs: {
      count: observed.runs.length,
      observationDigest: reference.digest,
      perRun: observed.runs.map((run) => ({
        instanceId: run.instanceId,
        observationDigest: run.digest,
        wallSeconds: run.wallSeconds,
      })),
      allObservationsEqual: true,
      freshInstances:
        new Set(observed.runs.map((run) => run.instanceId)).size === observed.runs.length,
    },
    baseline: {
      commitment: observed.context.environment.postFixtureCommitment,
      observation: baselineDescriptor,
    },
    isolation: {
      ...observed.context.isolation,
      closureEvidenceMode: observed.context.closure.mode,
      resolutionLog,
    },
    cost: observed.context.cost,
  } as ChainEnvironmentVerificationPredicate;
}

function buildFailurePredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "failed" }>,
  resolutionLog: ResourceDescriptor,
): ChainEnvironmentVerificationPredicate {
  return {
    protocol: CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
    scope: "component",
    outcome: outcomeForFailureReason(observed.reason),
    window,
    verifier: deps.verifier,
    materials: observed.context.resolved.map((one) => ({
      name: one.name,
      digest: toDigestSet(one.digest),
    })),
    environment: observed.context.environment,
    isolation: {
      ...observed.context.isolation,
      closureEvidenceMode: observed.context.closure.mode,
      resolutionLog,
    },
    cost: observed.context.cost,
    failure: {
      stage: stageForFailureReason(observed.reason),
      reason: observed.reason,
      detail: observed.detail,
      ...(observed.divergence === undefined ? {} : { divergence: observed.divergence }),
      ...(observed.partial === undefined ? {} : { coverage: observed.partial }),
    },
  } as ChainEnvironmentVerificationPredicate;
}
```

Note the shape of the two: `probe-divergence` is a **run-bearing** outcome, so its predicate
carries `runs` and `baseline` and reaches this builder through a small third branch that T11
adds. `buildFailurePredicate` covers the pre-run outcomes only; a divergence that reached
`buildFailurePredicate` would fail the predicate's own presence rule, loudly, at build time.

- [ ] **Step 7: Run the suite and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; all six `verifyChainEnvironment` tests pass; the guard passes
(no ambient network identifier, no `process.env`, no `Date.now`).

- [ ] **Step 8: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): verifyChainEnvironment closed-state protocol"
```

---

### Task 11: Negative outcomes as first-class attestations

Design D3 (parent law, carried): negative outcomes are published attestations, not thrown
exceptions. This task adds the run-bearing divergence branch to the driver and proves that
each outcome in the closed vocabulary is actually producible.

**Files:**
- Modify: `src/verify.ts` (the third predicate branch)
- Create: `src/verify-negative.test.ts`

**Interfaces:**
- Consumes: T10's driver and stub runtime.
- Produces: `buildDivergencePredicate` (module-private), and the guarantee that every outcome
  reachable by the closed-state protocol has a test.

- [ ] **Step 1: Write the failing per-outcome test**

`src/verify-negative.test.ts` — one case per outcome, each driving the stub runtime into the
condition and asserting the whole attestation, not a field:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConformanceChainRecord } from "./conformance-records.js";
import { CHAIN_VERIFICATION_OUTCOMES } from "./outcomes.js";
import { parseChainEnvironmentVerificationStatement } from "./statement.js";
import { verifyChainEnvironment } from "./verify.js";
// `run(scenario)` wraps the T10 stub runtime; each scenario name below drives one condition.

const CASES: readonly (readonly [string, string, string])[] = [
  // [scenario, expected outcome, expected failure.reason]
  ["artifact-missing", "artifact-unavailable", "resource-unresolvable"],
  ["artifact-wrong-bytes", "artifact-unavailable", "resource-digest-mismatch"],
  ["runtime-version-drift", "runtime-identity-mismatch", "runtime-version-mismatch"],
  ["unsupported-prevrandao", "runtime-identity-mismatch", "determinism-control-unsupported"],
  ["anchor-root-drift", "source-anchor-mismatch", "anchor-root-mismatch"],
  ["bad-state-proof", "source-proof-invalid", "state-proof-invalid"],
  ["coverage-incomplete", "source-coverage-incomplete", "artifact-entry-uncovered"],
  ["undeclared-mutation", "source-coverage-incomplete", "undeclared-source-mutation"],
  ["post-fixture-drift", "initial-state-mismatch", "post-fixture-commitment-mismatch"],
  ["upstream-fetch-succeeds", "offline-dependency-detected", "egress-succeeded"],
  ["loads-uncommitted-resource", "offline-dependency-detected", "uncommitted-resource-loaded"],
  ["fork-backend-unrefused", "offline-dependency-detected", "fork-backend-fetch-unrefused"],
  ["out-of-slice-not-empty", "offline-dependency-detected", "out-of-slice-read-not-empty"],
  ["forbidden-method-allowed", "capability-mismatch", "rpc-allowlist-violation"],
  ["extra-signer-exposed", "capability-mismatch", "signer-scope-violation"],
  ["divergent-on-run-3", "probe-divergence", "probe-observation-divergence"],
  ["reset-drifts", "reset-divergence", "reset-observation-divergence"],
  ["materializer-explodes", "verification-infrastructure-failure", "materializer-failed"],
  ["materializer-omits-report", "verification-infrastructure-failure", "materialization-report-absent"],
  ["probe-times-out", "verification-infrastructure-failure", "run-timeout"],
];

describe("negative outcomes are signed attestations, not exceptions", () => {
  it.each(CASES)("%s attests %s / %s", async (scenario, outcome, reason) => {
    const attestation = await run(scenario);
    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe(outcome);
    expect(predicate.failure?.reason).toBe(reason);
    // Signed and structurally valid, exactly like a positive result.
    expect(parseChainEnvironmentVerificationStatement(attestation.statement))
      .toEqual(attestation.statement);
    expect(attestation.envelopeBytes.length).toBeGreaterThan(0);
    expect(attestation.outcome).toBe(outcome);
  });

  it("carries runs and baseline for divergence, and neither for pre-run failures", async () => {
    const divergent = await run("divergent-on-run-3");
    expect(divergent.statement.predicate.runs?.count).toBe(5);
    expect(divergent.statement.predicate.runs?.allObservationsEqual).toBe(false);
    expect(divergent.statement.predicate.baseline).toBeDefined();
    expect(divergent.statement.predicate.failure?.divergence?.divergentRuns)
      .toEqual([expect.objectContaining({ index: 2 })]);

    const early = await run("artifact-missing");
    expect(early.statement.predicate.runs).toBeUndefined();
    expect(early.statement.predicate.baseline).toBeUndefined();
    expect(early.observations).toEqual([]);
  });

  it("stores every divergent observation so a third party can re-compare", async () => {
    const { artifactStore, attestation } = await runWithStore("divergent-on-run-3");
    for (const divergentRun of attestation.statement.predicate.failure!.divergence!.divergentRuns) {
      expect(artifactStore.stored.has(`sha256:${divergentRun.observation.digest.sha256}`))
        .toBe(true);
    }
  });

  it("covers every outcome the closed-state protocol can reach", () => {
    // `archive-observed` and `provider-disagreement` belong to §5.2 and are covered in T12;
    // everything else must appear above, so a new outcome cannot ship untested.
    const covered = new Set(CASES.map(([, outcome]) => outcome));
    covered.add("closed-reproducible");   // T10
    covered.add("archive-observed");      // T12
    covered.add("provider-disagreement"); // T12
    expect([...CHAIN_VERIFICATION_OUTCOMES].filter((outcome) => !covered.has(outcome)))
      .toEqual([]);
  });

  it("dismantles every instance it created, even on the failing path", async () => {
    const { runtime } = await runWithRuntime("post-fixture-drift");
    expect(runtime.stopCount).toBe(runtime.materializeRequests.length);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/verify-negative.test.ts`
Expected: FAIL — the divergence case fails the predicate's presence rule
(`a run-bearing outcome requires runs`), because `buildFailurePredicate` emits no `runs`.

- [ ] **Step 3: Add the divergence branch to `src/verify.ts`**

```ts
/**
 * `probe-divergence` is run-bearing: the K runs completed and disagreed, which is a fact
 * about the environment and carries the full repetition evidence. `baseline` is run 0's
 * observation -- one observation among divergent ones, not the environment's answer -- and a
 * reader who takes it without also reading `failure.divergence` is reading past the claim.
 */
async function buildDivergencePredicate(
  deps: ChainVerificationDeps,
  window: { readonly startedAt: string; readonly endedAt: string },
  observed: Extract<Observed, { kind: "failed" }>,
  runs: readonly RunRecord[],
  resolutionLog: ResourceDescriptor,
  signal: AbortSignal | undefined,
): Promise<ChainEnvironmentVerificationPredicate> {
  const reference = runs[0]!;
  const baselineDescriptor = await storeArtifact(
    deps.artifactStore,
    canonicalChainObservationBytes(reference.observation),
    { name: "observation", mediaType: "application/json" },
    signal,
  );
  // Each divergent observation is stored too, so a third party can re-run the comparison
  // rather than take the verifier's word for which runs disagreed.
  for (const run of runs.slice(1).filter((one) => one.digest !== reference.digest)) {
    await storeArtifact(
      deps.artifactStore,
      canonicalChainObservationBytes(run.observation),
      { name: `observation-${run.instanceId}`, mediaType: "application/json" },
      signal,
    );
  }
  return {
    ...buildFailurePredicate(deps, window, observed, resolutionLog),
    runs: {
      count: runs.length,
      observationDigest: reference.digest,
      perRun: runs.map((run) => ({
        instanceId: run.instanceId,
        observationDigest: run.digest,
        wallSeconds: run.wallSeconds,
      })),
      allObservationsEqual: false,
      freshInstances: new Set(runs.map((run) => run.instanceId)).size === runs.length,
    },
    baseline: {
      commitment: observed.context.environment.postFixtureCommitment,
      observation: baselineDescriptor,
    },
  } as ChainEnvironmentVerificationPredicate;
}
```

Carry the completed `RunRecord[]` on the `failed` variant (`readonly completedRuns?: readonly
RunRecord[]`) and select the branch in `verifyChainEnvironment`:

```ts
  const predicate = observed.kind === "runs"
    ? await buildRunsPredicate(deps, window, observed, resolutionLog, options.signal)
    : observed.completedRuns !== undefined && isRunBearingOutcome(outcomeForFailureReason(observed.reason))
      ? await buildDivergencePredicate(deps, window, observed, observed.completedRuns, resolutionLog, options.signal)
      : buildFailurePredicate(deps, window, observed, resolutionLog);
```

- [ ] **Step 4: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all 19 parameterized cases plus the five structural tests pass.
The coverage test is the gate: if a new outcome is added to the vocabulary and not tested here,
this suite fails.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): negative chain verification outcomes as signed attestations"
```

---

### Task 12: §5.2 archive-dependent observation

Design §5.2 is deliberately weaker and honestly labeled. It is a sibling entry point, not a
mode of the closed-state one, so a caller cannot accidentally get the weak claim while
believing they ran the strong protocol.

**Files:**
- Create: `src/archive.ts`, `src/archive.test.ts`

**Interfaces:**
- Consumes: T10's `observe` helpers (extract the shared per-instance checks into
  `src/instance-checks.ts` in this task so both drivers use one implementation), the ports,
  the predicate, the statement builder.
- Produces: `observeArchiveEnvironment(deps, record, options?): Promise<SealedAttestation>`,
  `ObserveArchiveOptions` (adds `providers: readonly ArchiveProviderSpec[]`),
  `ArchiveProviderSpec`.

- [ ] **Step 1: Write the failing archive test**

`src/archive.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { observeArchiveEnvironment } from "./archive.js";
import { buildConformanceChainRecord } from "./conformance-records.js";

const RECORD = () => buildConformanceChainRecord({ closureClass: "archive-dependent" });

describe("observeArchiveEnvironment", () => {
  it("attests archive-observed, never closed-reproducible", async () => {
    const attestation = await runArchive({ kind: "two-agreeing-providers" });
    const { predicate } = attestation.statement;
    expect(predicate.outcome).toBe("archive-observed");
    expect(predicate.environment.closureClass).toBe("archive-dependent");
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.providers).toHaveLength(2);
    expect(predicate.cost.rpcCalls).toBeGreaterThan(0);
  });

  it("records providers, observation time, and RPC cost per provider", async () => {
    const { predicate } = (await runArchive({ kind: "two-agreeing-providers" })).statement;
    for (const provider of predicate.providers ?? []) {
      expect(provider.id).toMatch(/provider-/u);
      expect(provider.observedAt).toMatch(/Z$/u);
      expect(provider.rpcCalls).toBeGreaterThan(0);
      expect(provider.rpcBytes).toBeGreaterThan(0);
    }
  });

  it("attests provider-disagreement when providers do not agree", async () => {
    const { predicate } = (await runArchive({ kind: "providers-disagree" })).statement;
    expect(predicate.outcome).toBe("provider-disagreement");
    expect(predicate.failure?.reason).toBe("provider-observation-disagreement");
    expect(new Set((predicate.providers ?? []).map((one) => one.observationDigest)).size)
      .toBe(2);
  });

  it("refuses a closed-state record", async () => {
    await expect(observeArchiveEnvironment(archiveDeps(), buildConformanceChainRecord()))
      .rejects.toThrow(/verifyChainEnvironment/u);
  });

  it("refuses a provider with no caller-owned state backend, and never reads the locators",
    async () => {
      // CE1-F10: locators tell a caller where it MAY look; they are not an instruction to this
      // runtime. A record needing archive access with no backend injected fails closed.
      await expect(observeArchiveEnvironment(
        archiveDeps(), RECORD(), { providers: [{ id: "provider-a" } as never] },
      )).rejects.toThrow(/stateBackend/u);
      const { runtime } = await runArchiveWithRuntime({ kind: "two-agreeing-providers" });
      for (const request of runtime.materializeRequests) {
        expect(request.stateBackend).toBeDefined();
      }
      expect(runtime.locatorReads).toBe(0);
    });

  it("never claims closure: no boundary probe, no closed-reproducible outcome", async () => {
    const { predicate } = (await runArchive({ kind: "two-agreeing-providers" })).statement;
    expect(predicate.isolation.closureEvidenceMode).toBe("fork-backend-refusal");
    expect(predicate.isolation.boundaryProbe).toBeUndefined();
    expect(predicate.outcome).not.toBe("closed-reproducible");
  });

  it("warns in the detail when only one provider was available", async () => {
    const { predicate } = (await runArchive({ kind: "single-provider" })).statement;
    expect(predicate.outcome).toBe("archive-observed");
    expect(predicate.providers).toHaveLength(1);
    // Design §5.2 asks for two independently operated providers "where policy permits"; one is
    // permitted and recorded as such, never silently upgraded.
    expect(predicate.evidence?.some((one) => one.name === "provider-availability-note"))
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/archive.test.ts`
Expected: FAIL — `Failed to resolve import "./archive.js"`.

- [ ] **Step 3: Implement `src/archive.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Design §5.2, the authoring class. K fresh materializations against at least two
 * independently operated providers where policy permits, the same probe suite, and an
 * attestation that records providers, observation time, RPC methods/calls/bytes, and any
 * disagreement.
 *
 * What `archive-observed` means, in full: at the recorded time, these providers supplied
 * state consistent with the declared anchor and produced these observations. It does not
 * speak to offline repeatability, provider retention, or durable-pool eligibility.
 * Marketplace supply advertised as re-verifiable evidence MUST reference a `closed-state`
 * record instead, which is why this entry point can never emit `closed-reproducible`.
 */
```

Implementation shape (same structure as T10's driver, with three differences the code makes
explicit):

1. `record.stateMaterialization.closureClass` must be `archive-dependent`; anything else is
   `invalidInput` naming `verifyChainEnvironment`.
2. The network policy is **not** the blackhole: archive RPC is reachable by construction, so
   the isolation block records `forkBackend: "present"` and the closure evidence mode is
   `fork-backend-refusal` **with no closure claim** — `assessClosure` is not called, because
   there is nothing closed to assess, and the outcome partition forbids `closed-reproducible`
   for this class anyway.
3. Runs are grouped by provider. Each provider contributes its own K materializations (or
   `ceil(K / providers.length)` at minimum, never fewer than one per provider), and the
   provider block records `{id, observedAt, rpcCalls, rpcBytes, observationDigest}`. Providers
   whose observation digests differ produce `provider-observation-disagreement`; providers who
   agree produce `archive-observed` with `runs` spanning every materialization.

`ArchiveProviderSpec` is `{id: string; stateBackend: ChainStateBackend}` — **the archive access
is the caller's**, per CE1-F10. Each provider's K materializations carry that provider's backend
on `MaterializationRequest.stateBackend`; the shared `deps.runtime` is reused across providers.

**The fail-closed rule (CE1-F10, normative, enforced here).** `requiresStateBackend(record)` is
true for every archive-dependent record. `observeArchiveEnvironment` validates up front that
each provider supplies a backend and refuses with `invalidInput` otherwise — a wiring bug, not
an environment fact. Neither this driver nor `createAnvilMaterializer` ever reads
`stateMaterialization.providerLocators`: locators tell a *caller* where it may look; they are
not an instruction to this package's runtime. Beyond custody, this is what makes the backend's
access journal CE4's harvest ground truth — a lazily-fetching fork hides exactly the reads the
extractor needs to see, which is why the fetching belongs to the caller.

- [ ] **Step 4: Extract `src/instance-checks.ts`**

Move `checkRuntimeIdentity`, `checkSourceAnchor`, `buildEnvironmentObservation`,
`declaredFixtureAccounts`, `declaredFixtureMutations` out of `src/verify.ts` into
`src/instance-checks.ts` and import them from both drivers. Two implementations of "is this
the runtime the record names" is exactly the drift that lets one path accept what the other
rejects.

- [ ] **Step 5: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all six archive tests pass and every earlier suite still passes
after the extraction.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): archive-dependent observation and its weaker claim"
```

---

### Task 13: `verifyCryptoEnvironment` — the composite protocol

Design §5.1 step 6's component-vs-composite split and §4.4's composition block. This function
checks **only what exists in combination**; it never re-verifies a component and never stands
in for one.

**Files:**
- Create: `src/composite.ts`, `src/composite.test.ts`

**Interfaces:**
- Consumes: `sealCryptoEnvironmentRecord`, `cryptoEnvironmentRecordDigest`,
  `CryptoEnvironmentRecord` from `@jinn-network/chain-environment-record`; T10's driver
  helpers; `InformationWorldRuntime` from `./ports.js`.
- Produces: `verifyCryptoEnvironment(deps, composite, options?): Promise<SealedAttestation>`,
  `assessOriginRouting(routing): readonly RoutingCollision[]`, `RoutingCollision`.

- [ ] **Step 1: Write the failing composite test**

`src/composite.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assessOriginRouting, verifyCryptoEnvironment } from "./composite.js";
import { buildConformanceCompositeRecord } from "./conformance-records.js";
import { attestationMatchesRecord, requiresComponentAttestations } from "./statement.js";

const WORLD_A = `sha256:${"a".repeat(64)}`;
const WORLD_B = `sha256:${"b".repeat(64)}`;

describe("origin routing", () => {
  it("finds no collision when precedence is declared", () => {
    expect(assessOriginRouting([
      { origin: "api.llama.fi", world: WORLD_A, precedence: 0 },
      { origin: "api.llama.fi", world: WORLD_B, precedence: 1 },
    ])).toEqual([]);
  });

  it("calls two worlds at one origin with equal precedence a collision", () => {
    // Design §4.4: two corpora claiming one origin is a repeatability hazard, not a merge.
    expect(assessOriginRouting([
      { origin: "api.llama.fi", world: WORLD_A, precedence: 0 },
      { origin: "api.llama.fi", world: WORLD_B, precedence: 0 },
    ])).toEqual([{ origin: "api.llama.fi", worlds: [WORLD_A, WORLD_B] }]);
  });

  it("is order-insensitive and reports worlds in code-unit order", () => {
    const forward = assessOriginRouting([
      { origin: "x.test", world: WORLD_B, precedence: 0 },
      { origin: "x.test", world: WORLD_A, precedence: 0 },
    ]);
    expect(forward).toEqual([{ origin: "x.test", worlds: [WORLD_A, WORLD_B] }]);
  });
});

describe("verifyCryptoEnvironment", () => {
  it("attests a chain-only composite closed-reproducible", async () => {
    const attestation = await runComposite({ kind: "chain-only-stable" });
    const { predicate } = attestation.statement;
    expect(predicate.scope).toBe("composite");
    expect(predicate.outcome).toBe("closed-reproducible");
    expect(predicate.composition?.collisions).toEqual([]);
    expect(predicate.composition?.wholeWorldOfflineBoot).toBe(true);
    expect(predicate.composition?.components.filter((one) => one.role === "chain-world"))
      .toHaveLength(1);
    expect(predicate.runs?.count).toBe(5);
  });

  it("does not substitute for its components' attestations", async () => {
    const attestation = await runComposite({ kind: "chain-only-stable" });
    const chainWorld = attestation.statement.predicate.composition!.components[0]!.record;
    // The composite's subject[0] is the composite; the chain world is subject[1] and can never
    // satisfy a component match (design §5.1 step 6).
    expect(attestationMatchesRecord(attestation.statement, chainWorld)).toBe(false);
    expect(requiresComponentAttestations(attestation.statement)).toContain(chainWorld);
  });

  it("attests capability-mismatch for colliding origins", async () => {
    const { predicate } = (await runComposite({ kind: "colliding-origins" })).statement;
    expect(predicate.outcome).toBe("capability-mismatch");
    expect(predicate.failure?.reason).toBe("origin-routing-collision");
    expect(predicate.composition?.collisions).toHaveLength(1);
  });

  it("attests offline-dependency-detected when a component cannot boot offline", async () => {
    const { predicate } = (await runComposite({ kind: "component-needs-network" })).statement;
    expect(predicate.outcome).toBe("offline-dependency-detected");
    expect(predicate.composition?.wholeWorldOfflineBoot).toBe(false);
  });

  it("fails closed when information worlds are composed with no information runtime", async () => {
    const { predicate } = (await runComposite({
      kind: "information-worlds-without-runtime",
    })).statement;
    expect(predicate.outcome).toBe("verification-infrastructure-failure");
    expect(predicate.failure?.reason).toBe("information-runtime-absent");
  });

  it("covers both planes in the K-run observation when a world is composed", async () => {
    const { predicate } = (await runComposite({ kind: "one-information-world" })).statement;
    expect(predicate.runs?.count).toBe(5);
    expect(predicate.composition?.components.some((one) => one.role === "information-world"))
      .toBe(true);
    // The composite observation spans chain + information; its digest is what the K runs
    // compared, so a corpus that answered differently on run 3 is a probe-divergence.
    expect(predicate.runs?.allObservationsEqual).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/composite.test.ts`
Expected: FAIL — `Failed to resolve import "./composite.js"`.

- [ ] **Step 3: Implement `assessOriginRouting` in `src/composite.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { compareCodeUnitStrings } from "@jinn-network/trust-core";

export interface RoutingEntry {
  readonly origin: string;
  readonly world: string;
  readonly precedence: number;
}

export interface RoutingCollision {
  readonly origin: string;
  readonly worlds: readonly string[];
}

/**
 * Design §4.4: two corpora claiming `api.llama.fi` is a reproducibility hazard, not a merge.
 * Declared precedence resolves it -- the higher-precedence world answers -- so a collision is
 * exactly the case where two or more worlds claim one origin at the same precedence and
 * nothing in the record says which one wins.
 */
export function assessOriginRouting(
  routing: readonly RoutingEntry[],
): readonly RoutingCollision[] {
  const byOriginAndPrecedence = new Map<string, Map<number, Set<string>>>();
  for (const entry of routing) {
    const byPrecedence = byOriginAndPrecedence.get(entry.origin) ?? new Map<number, Set<string>>();
    const worlds = byPrecedence.get(entry.precedence) ?? new Set<string>();
    worlds.add(entry.world);
    byPrecedence.set(entry.precedence, worlds);
    byOriginAndPrecedence.set(entry.origin, byPrecedence);
  }

  const collisions: RoutingCollision[] = [];
  for (const [origin, byPrecedence] of byOriginAndPrecedence) {
    for (const worlds of byPrecedence.values()) {
      if (worlds.size > 1) {
        collisions.push({ origin, worlds: [...worlds].sort(compareCodeUnitStrings) });
      }
    }
  }
  return collisions.sort((left, right) => compareCodeUnitStrings(left.origin, right.origin));
}
```

- [ ] **Step 4: Implement `verifyCryptoEnvironment` in the same file**

The driver, in the order the checks must run:

1. **Resolve** the composite's components by digest through the artifact store: the chain
   world record, every information world record, every service runtime descriptor. A
   resolution failure is `artifact-unavailable`, exactly as for a component.
2. **Routing** — `assessOriginRouting(composite.composition.routing)`. A non-empty result is
   `origin-routing-collision` → `capability-mismatch`, and the collisions are recorded in the
   composition block whether or not they gate. This check precedes materialization because it
   is a property of the record alone, and paying for five materializations to discover it
   would be wasteful and no more truthful.
3. **Information runtime presence** — if `composite.informationWorlds.length > 0` and
   `deps.informationRuntime === undefined`, `information-runtime-absent` →
   `verification-infrastructure-failure`. **Fail closed:** a composite whose information plane
   was never exercised has not been verified, and silently skipping it would be the exact
   over-claim contract 7 forbids. (E14 sequences the chain-only path first, so v1 composites
   carry an empty list and never reach this branch.)
4. **Whole-world offline boot, K times** — for each of K runs: materialize the chain world
   under the blackhole policy, serve the information worlds through
   `deps.informationRuntime.serve` against the same instance, and build a **composite
   observation** spanning both planes. A materialization or serve that requires network is
   `offline-dependency-detected` with `wholeWorldOfflineBoot: false`.
5. **Compare** the K composite observation digests. Inequality is `probe-divergence`; equality
   with a closed closure assessment and no collisions is `closed-reproducible` at composite
   scope.
6. **Component attestations are referenced, never recomputed.** The composition block lists
   `{role, record, attestation?}` for every component, filling `attestation` only where the
   caller supplied one through `options.componentAttestations`. Nothing here verifies a
   component; `requiresComponentAttestations` is what tells a consumer what it still owes.

```ts
export interface VerifyCryptoEnvironmentOptions extends VerifyChainEnvironmentOptions {
  /** Component attestations the caller already holds, by component record digest. Recorded in
   * the composition block; never treated as a substitute for obtaining them. */
  readonly componentAttestations?: ReadonlyMap<string, `sha256:${string}`>;
}

export function verifyCryptoEnvironment(
  deps: ChainVerificationDeps,
  composite: CryptoEnvironmentRecord,
  options?: VerifyCryptoEnvironmentOptions,
): Promise<SealedAttestation>;
```

Subjects are `[crypto-environment, chain-world]` via
`buildCryptoEnvironmentVerificationStatement`, so a component-match query can never be
satisfied by a composite statement.

- [ ] **Step 5: Run the suite**

Run: `corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test`
Expected: typecheck 0 errors; all nine composite tests pass, including the
never-substitutes assertion and the fail-closed information-runtime case.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): composite crypto environment verification"
```

---

### Task 13A: Structured read requests — encoding, keying, and state tagging (ruling CR6)

**Coordinator ruling CR6 is law here.** The declarative `abiRef+args` predicate form ships in
v1, and **CE3 owns the encoding**. CE2 stays pure and emits *structured* read requests — an ABI
reference plus arguments, no calldata bytes — because `viem` is banned tree-wide in
`task-supply` by the source-boundary guard, so a scenario package cannot encode calldata and a
parameterized template cannot pre-encode at authoring time. Encoding belongs where the call
happens: this package, behind the runtime port, already making the RPC call.

**Encoder decision (mine, per CR6's "your call, but state it").** `src/abi-encode.ts` is a
**hand-rolled, closed** encoder/decoder covering exactly the ABI types the v1 predicate
vocabulary can express: `address`, `bool`, `uintN` / `intN` (N a multiple of 8, values carried
as decimal strings), `bytesN`, dynamic `bytes`, `string`, and one level of static or dynamic
array over those. Three reasons. (a) It keeps this package's allowed-externals list at three
entries, so the boundary guard stays a short list a reviewer can read rather than a transitive
graph. (b) The surface is closed by the predicate vocabulary, so a general-purpose encoder
would admit ABI features no predicate can express — tuples, nested arrays, structs — and
inviting them in would be inviting a call this family cannot grade. (c) It is specified
byte-for-byte by the Solidity ABI specification, which supplies worked examples that become the
golden vector corpus. **Fallback, stated now rather than discovered later:** if the golden
corpus turns up a type the vocabulary needs and the hand-rolled encoder gets wrong, add `ox` to
`CHAIN_VERIFICATION_ALLOWED_EXTERNALS` and delete this module. That is a guard edit and a
dependency-graph edit in one PR, not a redesign.

**Files:**
- Create: `src/abi-encode.ts`, `src/abi-encode.test.ts`, `src/state-reads.ts`,
  `src/abi-encode.differential.test.ts`, `src/abi-vectors.ts`,
  `src/state-reads.test.ts`, `fixtures/abi-vectors-v1/vectors.json`,
  `fixtures/state-read-keys-v1/keys.json`
- Modify: `src/observation.ts` (the `stateReads` projection landed in T3), `src/probes.ts` and
  `src/replay.ts` (T14 consumes this module)

**Interfaces:**
- Consumes: `compareCodeUnitStrings`, `canonicalJsonBytes`, `recordDigest` from
  `@jinn-network/trust-core`; `RpcTransport` from `./runtime-hosts.js`; `StateReadOutcome` from
  `./observation.js`.
- Produces: `AbiValueTypeSchema`, `encodeAbiCall(selectorSource, types, values): string`,
  `decodeAbiReturn(types, returnData): readonly string[]`, `StructuredReadRequestSchema`,
  `StructuredReadRequest`, `stateReadKey(request): string`,
  `resolveStateReads(transport, endpoint, requests, options): Promise<readonly StateReadOutcome[]>`.

**The shape CE2 emits and CE3 resolves:**

```ts
export const StructuredReadRequestSchema = z.strictObject({
  /** The contract to call. */
  to: AddressSchema,
  /** The ABI function signature, canonical form: `name(type,type)`. This IS the `abiRef` --
   * a signature string is self-describing, needs no registry lookup, and is what the
   * selector is derived from, so there is no way for a reference and its target to drift. */
  signature: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*\((|[a-z0-9\[\],]+)\)$/u),
  /** Arguments, positionally, each already a string in this family's spelling: decimal for
   * numerics, lowercase `0x` for addresses and byte types, "true"/"false" for bool. */
  args: z.array(z.string()),
  /** Return types, positionally, so the decoder needs no ABI registry either. */
  returns: z.array(AbiValueTypeSchema),
  /** Which world to read. `baseline` is the design's pre-replay ground truth. */
  state: z.enum(["baseline", "post-replay"]),
});
```

- [ ] **Step 1: Write the failing ABI vector test — spec examples AND the adversarial corpus**

**Ruling CR8's condition, and why it is the right condition.** Spec-derived vectors prove the
happy path, and dynamic encoding is not the happy path: head/tail offsets, `bytes` / `string`,
and arrays are where encoder bugs actually live. A wrong encoding does not throw — it calls a
**different function**, gets an answer, and the task is graded on that answer. That is the worst
failure mode available to this family, because every downstream check passes while the verdict
is about something nobody asked. So the corpus is adversarial by construction, not by
afterthought.

`src/abi-encode.test.ts` drives `fixtures/abi-vectors-v1/vectors.json` — each vector is
`{name, signature, types, values, expectedCalldata}`. Three groups, all required:

*Group A — the Solidity ABI specification's worked examples,* transcribed with their published
calldata: `baz(uint32,bool)`, `bar(bytes3[2])`, `sam(bytes,bool,uint256[])`,
`f(uint256,uint32[],bytes10,bytes)`.

*Group B — the adversarial cases (CR8, mandatory; each with its expected calldata):*

| Case | Vector | What it pins |
| --- | --- | --- |
| Empty dynamic array | `f(uint256[])` with `[]` | offset points past the head to a lone zero length word |
| Empty `bytes` | `f(bytes)` with `0x` | zero length, and **no** padding word after it |
| Zero-length `string` | `f(string)` with `""` | same as `bytes`, and not confused with a one-word empty string |
| Dynamic at the head/tail seam | `f(bytes,uint256)` with `0xff`, `1` | the offset is measured from the start of the **argument block**, not the calldata |
| Dynamic flanked by statics | `f(uint256,bytes,uint256)` with `1`, `0xff`, `2` | the head keeps its slot while the tail moves; the classic off-by-one-word bug |
| Dynamic array of dynamic members | `f(bytes[])` with `["0x", "0xff"]` | two levels of offsets, inner offsets relative to the inner block |
| Max-width unsigned | `f(uint256)` with `2**256 - 1`; `f(uint8)` with `255` | boundary value encodes, `2**256` and `256` are refused |
| Max/min-width signed | `f(int256)` with `2**255 - 1` and `-2**255`; `f(int8)` with `127` and `-128` | two's-complement sign extension at both ends; out-of-range refused |

*Group C — one vector per admitted type,* so no type ships unexercised.

Assertions: every vector encodes to its expected calldata byte-for-byte; every vector
round-trips through `decodeAbiReturn`; and an out-of-range `uintN` / `intN`, a mis-cased
address, an argument count that does not match the signature, and a type outside the closed set
each throw `ChainVerificationError` rather than encoding something plausible. The decode side
gets its own adversarial trio: empty return data, a dynamic return whose declared offset runs
past the buffer, and revert data.

- [ ] **Step 1A: Write the differential test against an independent encoder**

**CR8's second condition. The guard permits this, and here is the receipt** — a reviewer should
verify these four lines rather than take the allowance on trust
(`.github/scripts/environments-source-boundaries.test.mjs` and
`environments-package-inventory.test.mjs`, both on `integration/evidence-v1`):

1. **Direct precedent in this exact tree.** `RECORD_ALLOWED_DEV_DEPENDENCIES` (source-boundaries
   guard, ~line 53) is
   `['@jinn-network/evidence-protocol', '@types/node', 'ajv', 'canonicalize', 'typescript', 'vitest']`.
   `canonicalize` and `ajv` are third-party, **test-only differential oracles** already approved
   here: `canonicalize` cross-checks the record package's own JCS implementation, `ajv` its
   published JSON Schemas. This is the same pattern for the same reason — a self-consistent
   implementation cannot catch its own misreading of a specification.
2. **The production-externals assertion cannot be tripped by a test file.** At ~line 470 it
   builds `externals` from `productionFiles` only (`allFiles` minus the test regex and
   `testing.ts`), so a `.test.ts` import of a third-party package never reaches
   `CHAIN_VERIFICATION_ALLOWED_EXTERNALS`. Production source stays at its three externals plus
   `@noble/hashes`.
3. **devDependencies are an explicit, editable allowlist,** asserted by `deepEqual` at ~line 465
   against `CHAIN_VERIFICATION_ALLOWED_DEV_DEPENDENCIES`. Adding the oracle is a one-line guard
   edit in the same PR — deliberate and visible, which is the point.
4. **The dependency graph is untouched.** `jinnDependencyNames` in the inventory guard filters to
   names starting `@jinn-network/`, so a non-Jinn devDependency never enters the approved graph.

So: add `ox` to `devDependencies` and to `CHAIN_VERIFICATION_ALLOWED_DEV_DEPENDENCIES`. `ox` is
chosen over the alternatives deliberately — it is the **same package the F-CE3-13 fallback would
promote to a production dependency**, so if the differential test says the hand-rolled module is
wrong, the remedy is already scoped and already installed rather than a fresh evaluation under
pressure.

`src/abi-encode.differential.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

// Test-only differential oracle. Same pattern, and same justification, as `canonicalize` in
// packages/environments/record: an implementation that only checks itself cannot catch its own
// misreading of a specification, and a wrong ABI encoding does not throw -- it calls a
// different function and the task gets graded on that answer.

import { AbiFunction, AbiParameters, Hex } from "ox";
import { describe, expect, it } from "vitest";

import { encodeAbiCall } from "./abi-encode.js";
import { loadAbiVectors } from "./abi-vectors.js";

describe("abi encoder, differentially", () => {
  it("agrees with an independent encoder on every committed vector", async () => {
    const vectors = await loadAbiVectors();
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors) {
      const ours = encodeAbiCall(vector.signature, vector.types, vector.values);
      const selector = AbiFunction.getSelector(vector.signature);
      const theirs = Hex.concat(
        selector,
        AbiParameters.encode(AbiParameters.from(vector.types), toOxValues(vector)),
      );
      expect(ours, `${vector.name}: encoders disagree`).toBe(theirs);
      // And both must agree with what the corpus committed, or the corpus is the thing that
      // is wrong -- which is worth knowing before either encoder is trusted.
      expect(ours, `${vector.name}: corpus disagrees`).toBe(vector.expectedCalldata);
    }
  });

  it("agrees on the boundary values the closed type set admits", () => {
    // Swept rather than enumerated: for each admitted width, the minimum, the maximum, and the
    // first value outside the range, which both encoders must refuse.
    for (const bits of [8, 16, 32, 64, 128, 256]) {
      for (const value of boundaryValues(bits)) {
        expect(encodeAbiCall(`f(uint${bits})`, [`uint${bits}`], [value]))
          .toBe(oxEncode(`f(uint${bits})`, [`uint${bits}`], [value]));
      }
      expect(() => encodeAbiCall(`f(uint${bits})`, [`uint${bits}`], [overflowOf(bits)]))
        .toThrow();
    }
  });
});
```

`src/abi-vectors.ts` is the shared corpus loader (test-region, so it joins the filesystem
allowlist in the tree guard alongside `testing.ts`).

**If either step surfaces a gap the closed type set cannot encode correctly, take the fallback
immediately: add `ox` to `dependencies` and to `CHAIN_VERIFICATION_ALLOWED_EXTERNALS`, delete
`src/abi-encode.ts`, and point `encodeAbiCall` at it.** Do not patch the module. The cost was
scoped honestly in F-CE3-13 — a guard edit plus a dependency edit in one PR — and patching an
encoder that a differential test has already caught being wrong is how the family ends up
trusting a module nobody has a reason to trust.

- [ ] **Step 2: Write the failing key + resolution test**

`src/state-reads.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ChainVerificationError } from "./errors.js";
import { resolveStateReads, stateReadKey } from "./state-reads.js";

const REQUEST = {
  to: "0x00000000000000000000000000000000000000aa",
  signature: "getReserveData(address)",
  args: ["0x00000000000000000000000000000000000000bb"],
  returns: ["uint256"],
  state: "baseline",
} as const;

describe("stateReadKey", () => {
  it("is a pure function of the request", () => {
    expect(stateReadKey(REQUEST)).toBe(stateReadKey({ ...REQUEST }));
  });

  it("separates the two worlds, so a baseline read never answers a post-replay lookup", () => {
    expect(stateReadKey(REQUEST))
      .not.toBe(stateReadKey({ ...REQUEST, state: "post-replay" }));
  });

  it("distinguishes every field a different call would differ in", () => {
    for (const mutation of [
      { to: "0x00000000000000000000000000000000000000cc" },
      { signature: "getReserveData(address,uint256)" },
      { args: ["0x00000000000000000000000000000000000000cc"] },
      { returns: ["uint128"] },
    ]) {
      expect(stateReadKey({ ...REQUEST, ...mutation })).not.toBe(stateReadKey(REQUEST));
    }
  });

  it("matches the committed key corpus CE2 derives against", async () => {
    // The cross-package equivalence fixture (program contract 3's shape, applied to a key
    // instead of a seal). CE5 -- the first branch that can see both CE2 and CE3 -- asserts
    // CE2's derivation against this same file. A key that differs by one character makes the
    // pure evaluator report `unevaluable` for a read that actually happened, which is the
    // failure this fixture exists to make impossible to ship.
    const corpus = await loadKeyCorpus();
    for (const entry of corpus) {
      expect(stateReadKey(entry.request)).toBe(entry.key);
    }
    expect(corpus.length).toBeGreaterThanOrEqual(8);
  });
});

describe("resolveStateReads", () => {
  it("encodes once, calls through the transport, and keys the outcome", async () => {
    const transport = fakeRpcTransport({ "0x...": "0x" + "0".repeat(63) + "7" });
    const outcomes = await resolveStateReads(transport, "http://runner.local", [REQUEST], {
      state: "baseline",
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      key: stateReadKey(REQUEST),
      state: "baseline",
      to: REQUEST.to,
      status: "success",
    });
    expect(outcomes[0]!.calldata.startsWith("0x")).toBe(true);
  });

  it("produces identical calldata on every run for the same request", async () => {
    const first = await resolveStateReads(fakeRpcTransport(), "http://runner.local", [REQUEST], { state: "baseline" });
    const second = await resolveStateReads(fakeRpcTransport(), "http://runner.local", [REQUEST], { state: "baseline" });
    expect(second[0]!.calldata).toBe(first[0]!.calldata);
    expect(second[0]!.key).toBe(first[0]!.key);
  });

  it("executes only the reads tagged for the world it was given", async () => {
    // The mechanism behind the design's pre-replay ground-truth rule: a baseline-tagged read
    // must not be executed against the replayed world, or an agent could move the value it was
    // asked to report and be graded correct for reporting what it just created.
    const transport = fakeRpcTransport();
    const outcomes = await resolveStateReads(
      transport,
      "http://runner.local",
      [REQUEST, { ...REQUEST, state: "post-replay" }],
      { state: "baseline" },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.state).toBe("baseline");
    expect(transport.calls).toHaveLength(1);
  });

  it("records a revert as an observation, not an error", async () => {
    const outcomes = await resolveStateReads(
      revertingTransport(), "http://runner.local", [REQUEST], { state: "baseline" },
    );
    expect(outcomes[0]).toMatchObject({ status: "reverted", returnData: expect.any(String) });
  });

  it("refuses a request whose args do not match its signature", async () => {
    await expect(resolveStateReads(
      fakeRpcTransport(), "http://runner.local",
      [{ ...REQUEST, args: [] }], { state: "baseline" },
    )).rejects.toThrow(ChainVerificationError);
  });
});
```

- [ ] **Step 3: Implement `src/abi-encode.ts`**

Selector is the first four bytes of keccak-256 over the canonical signature; arguments are
encoded per the ABI specification's head/tail layout. Keccak-256 comes from the same
noble-class primitive CE1 uses for hashing — add `@noble/hashes` to this package's
`dependencies`, to `CHAIN_VERIFICATION_ALLOWED_EXTERNALS`, to
`CHAIN_VERIFICATION_ALLOWED_DEPENDENCIES`, and to the inventory guard's dependency-graph entry
in the same PR (T1 step 3 and step 6 both grow by one line; `@noble/hashes` is already an
approved external for `packages/environments/record`, so the tree gains no new supplier).

- [ ] **Step 4: Implement `src/state-reads.ts`**

```ts
/**
 * Ruling CR6: CE2 emits structured read requests and stays pure; CE3 turns them into calls,
 * because encoding belongs where the call happens and `viem` is banned in the `task-supply`
 * tree a scenario package would otherwise have to encode from.
 *
 * `stateReadKey` is the contract between the two packages: the pure evaluator looks up the
 * projection at the key it derived, so CE3's derivation must be byte-identical to CE2's. It is
 * therefore a pure function of the request, computed over RFC 8785 canonical bytes of a fixed
 * field set, and pinned by a committed corpus both packages assert against.
 */
export function stateReadKey(request: StructuredReadRequest): string {
  const canonical = canonicalJsonBytes({
    to: request.to,
    signature: request.signature,
    args: request.args,
    returns: request.returns,
    state: request.state,
  });
  return recordDigest(canonical);
}
```

`resolveStateReads(transport, endpoint, requests, options)` filters `requests` to those whose
`state` equals `options.state`, encodes each through `encodeAbiCall`, issues one `eth_call`
per request through the injected `RpcTransport`, and returns `StateReadOutcome[]` sorted by
key. A revert is `status: "reverted"` with the revert bytes in `returnData` — a legitimate
observation a predicate may expect, never a thrown error.

- [ ] **Step 5: Wire it into the probe executor and the replayer (T14)**

`createProbeExecutor` resolves the record's baseline-tagged reads on the freshly materialized
world **before any probe transaction runs**, and post-replay-tagged reads are not its business.
`createScriptReplayer` resolves post-replay-tagged reads **after** the last script operation.
Both fold the outcomes into the observation's `stateReads` projection. This ordering is the
whole mechanism behind the design's pre-replay ground-truth rule: a baseline read executed
after the replay would let an agent supply liquidity, move the rate, report the rate it just
created, and be graded correct. A test in `src/runtime-surface.test.ts` asserts the ordering
directly — the baseline read's `eth_call` must appear in the transport's call log **before** the
first `eth_sendRawTransaction`.

- [ ] **Step 6: Run the suites and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; the ABI vector corpus (spec + adversarial + per-type), the
differential suite, the key corpus, and the resolution suite all pass; both guards pass with
`@noble/hashes` added to the approved **externals** and `ox` added to the approved
**devDependencies**. If the differential suite disagrees anywhere, stop and take the F-CE3-13
fallback rather than adjusting either the module or the corpus to match.

- [ ] **Step 7: Commit**

```bash
git add packages/environments/chain-verification .github/scripts
git commit -m "feat(environments): resolve declarative structured reads into keyed observations"
```

---

### Task 14: The public runtime surface — materializer, probe executor, script replayer

Design §3, an architecture-review finding: **four consumers need materialize/replay without
any verification protocol** — the verifier itself, the admission observation port, the
evaluation replayer, and a solver's own local runner, which materializes an instance to drive
its agent against and wants none of the verification machinery. So these are exported from the
root entrypoint, and their type declarations live in CE1 so a consumer can depend on the
contract without depending on this capability.

**Custody is the design constraint here.** "Wrap Anvil" would mean spawning processes and
opening sockets, which this tier may not do. So the adapter speaks the Anvil wire protocol
over an injected `ProcessHost`, `RpcTransport`, and `WorkspaceHost`: a host that runs Anvil in
Docker, a host that runs a local binary, and a test that runs neither all satisfy the same
three ports.

**Files:**
- Create: `src/runtime-hosts.ts`, `src/anvil.ts`, `src/probes.ts`, `src/replay.ts`,
  `src/runtime-surface.test.ts`

**Interfaces:**
- Consumes: `ChainMaterializer`, `ProbeExecutor`, `ScriptReplayer`, `ChainInstance`,
  `MaterializationRequest`, `ResolvedResources`, `NetworkPolicy`, `ReplayRequest`,
  `ReplayOutcome`, `ReplayRefusal`, `CapabilityEnvelope`, `ChainSolutionScript`,
  `SOLUTION_OPERATION_KINDS`, `parseChainSolutionScript` from
  `@jinn-network/chain-environment-record`; `Clock` from `./ports.js`; the observation builders.
- Produces: `ProcessHost`, `SpawnedProcess`, `RpcTransport`, `WorkspaceHost`,
  `AnvilMaterializerConfig`, `VerifiedChainMaterializer`,
  `createAnvilMaterializer(config): VerifiedChainMaterializer`,
  `ProbeExecutorConfig`, `createProbeExecutor(config): ProbeExecutor`,
  `ScriptReplayerConfig`, `createScriptReplayer(config): ScriptReplayer<CanonicalChainObservation>`.
  **Not** the solution script: `ChainSolutionScriptSchema` and its neighbours are CE1's
  (F-CE3-11) and are re-exported by nobody.

- [ ] **Step 1: Write the failing runtime-surface test**

`src/runtime-surface.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createAnvilMaterializer } from "./anvil.js";
import { buildConformanceChainRecord } from "./conformance-records.js";
import { ChainVerificationError } from "./errors.js";
import { DEFAULT_BLACKHOLE_POLICY } from "./ports.js";
import { createProbeExecutor } from "./probes.js";
import { createScriptReplayer, parseChainSolutionScript } from "./replay.js";
// `fakeProcessHost()`, `fakeRpcTransport(script)`, `fakeWorkspace()` are local fakes: they
// record calls and answer scripted JSON-RPC results. No process is spawned anywhere.

describe("createAnvilMaterializer", () => {
  it("launches the pinned runtime through the injected process host, never directly", async () => {
    const processHost = fakeProcessHost();
    const materializer = createAnvilMaterializer({
      processHost,
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: PINNED,
      supportedControls: ["miningMode", "initialTimestamp", "blockGasLimit", "coinbase"],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(processHost.spawns).toHaveLength(1);
    expect(processHost.spawns[0]!.command).toContain("anvil");
    expect(instance.instanceId).toBe("instance-0");
    await instance.stop();
    expect(processHost.kills).toBe(1);
  });

  it("refuses archive-dependent work with no caller-owned backend, and ignores locators",
    async () => {
      const processHost = fakeProcessHost();
      const materializer = createAnvilMaterializer({
        processHost, rpcTransport: fakeRpcTransport("healthy"), workspace: fakeWorkspace(),
        clock: createFixedClock(), pinnedRuntime: PINNED, supportedControls: [],
      });
      await expect(materializer.materialize({
        record: buildConformanceChainRecord({ closureClass: "archive-dependent" }),
        instanceId: "instance-0",
        networkPolicy: { ...DEFAULT_BLACKHOLE_POLICY, forkBackend: "present" },
        resources: { byDigest: new Map() },
      })).rejects.toThrow(ChainVerificationError);
      // Nothing was spawned, so no locator reached a launch line or an environment variable.
      expect(processHost.spawns).toHaveLength(0);
    });

  it("reports the entry index it LOADED, not the one the artifact declared", async () => {
    // CE4 cross-checks producer against loader; an index copied from the input would make that
    // check vacuous while looking like it passed.
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(), rpcTransport: fakeRpcTransport("partial-load"),
      workspace: fakeWorkspace(), clock: createFixedClock(), pinnedRuntime: PINNED,
      supportedControls: [],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(instance.report.artifactEntries.storageSlots)
      .not.toEqual(DECLARED_ENTRY_COUNTS.storageSlots);
  });

  it("refuses a record naming a runtime other than the pinned one", async () => {
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(),
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: { ...PINNED, version: "1.0.0" },
      supportedControls: [],
    });
    await expect(materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    })).rejects.toThrow(ChainVerificationError);
  });

  it("reports controls the pinned version cannot apply instead of pretending", async () => {
    // Design §10: `prevrandao` control at the Anvil level has been inconsistent across
    // versions. A materializer that silently ignored a declared control would make the
    // attestation state a control the runs did not have.
    const materializer = createAnvilMaterializer({
      processHost: fakeProcessHost(),
      rpcTransport: fakeRpcTransport("healthy"),
      workspace: fakeWorkspace(),
      clock: createFixedClock(),
      pinnedRuntime: PINNED,
      supportedControls: ["miningMode", "initialTimestamp"],
    });
    const instance = await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    expect(instance.runtimeIdentity.unsupportedControls).toContain("prevrandao");
  });

  it("passes the blackhole policy to the launch arguments", async () => {
    const processHost = fakeProcessHost();
    const materializer = createAnvilMaterializer({
      processHost, rpcTransport: fakeRpcTransport("healthy"), workspace: fakeWorkspace(),
      clock: createFixedClock(), pinnedRuntime: PINNED, supportedControls: [],
    });
    await materializer.materialize({
      record: buildConformanceChainRecord(),
      instanceId: "instance-0",
      networkPolicy: DEFAULT_BLACKHOLE_POLICY,
      resources: { byDigest: new Map() },
    });
    const args = processHost.spawns[0]!.args.join(" ");
    // A sealed instance is launched with NO fork url at all -- the boundary rule, at the
    // launch line.
    expect(args).not.toContain("--fork-url");
    expect(processHost.spawns[0]!.env["ANVIL_NO_NETWORK"]).toBeDefined();
  });
});

describe("createProbeExecutor", () => {
  it("returns a raw observation the caller canonicalizes, and reports its own cost", async () => {
    const executor = createProbeExecutor({
      rpcTransport: fakeRpcTransport("probe-suite"),
      clock: createFixedClock(),
    });
    const result = await executor.execute({
      instance: fakeInstance(),
      probeSuiteBytes: new TextEncoder().encode(JSON.stringify({ probes: [] })),
      comparatorBytes: new TextEncoder().encode("{}"),
      timeoutSeconds: 30,
    });
    expect(result.timedOut).toBe(false);
    expect(result.cost.wallSeconds).toBeGreaterThanOrEqual(0);
    expect(result.observation).toBeTypeOf("object");
  });
});

describe("createScriptReplayer", () => {
  it("replays only CE1's four declared operations", () => {
    // The script schema is CE1's; this asserts the replayer handles each operation kind and
    // has no opinion about the grammar. Grammar rejection is CE1's own suite.
    expect([...SOLUTION_OPERATION_KINDS].sort())
      .toEqual(["mine", "report", "signedTransaction", "timeWarp"]);
  });

  it("refuses an operation outside the envelope rather than grading it", async () => {
    const replayer = createScriptReplayer({
      rpcTransport: fakeRpcTransport("healthy"),
      clock: createFixedClock(),
    });
    const result = await replayer.replay({
      instance: fakeInstance({ maxima: { transactions: "1" } }),
      script: { operations: [
        { op: "signedTransaction", raw: "0xf86b01" },
        { op: "signedTransaction", raw: "0xf86b02" },
      ] },
      timeoutSeconds: 30,
    });
    // A script exceeding the envelope is refused, not judged (design §8).
    expect(result.status).toBe("refused");
    expect(result.refusal.reason).toBe("envelope-exceeded");
    expect(result.refusal.detail).toContain("operation 1");
  });

  it("bounds time advancement to the record's declared window", async () => {
    const replayer = createScriptReplayer({
      rpcTransport: fakeRpcTransport("healthy"), clock: createFixedClock(),
    });
    const result = await replayer.replay({
      instance: fakeInstance({ timeWarpBounds: { maxSeconds: "600" } }),
      script: { operations: [{ op: "timeWarp", seconds: "86400" }] },
      timeoutSeconds: 30,
    });
    expect(result.status).toBe("refused");
    expect(result.refusal.reason).toBe("envelope-exceeded");
    expect(result.refusal.detail).toContain("timeWarp");
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/runtime-surface.test.ts`
Expected: FAIL — `Failed to resolve import "./anvil.js"`.

- [ ] **Step 3: Implement `src/runtime-hosts.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * The three seams that let this package speak to a running simulator without holding any
 * ambient authority. A host that runs Anvil in a container, a host that runs a local binary,
 * and a test that runs neither all satisfy these; nothing here knows which it got.
 */

export interface SpawnedProcess {
  readonly pid: string;
  /** Runner-local endpoint the RPC transport dials. Never a public address. */
  readonly endpoint: string;
  wait(): Promise<{ readonly exitCode: number; readonly stderr: string }>;
  kill(): Promise<void>;
}

export interface ProcessHost {
  spawn(request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<SpawnedProcess>;
}

export interface RpcTransport {
  send(request: {
    readonly endpoint: string;
    readonly method: string;
    readonly params: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface WorkspaceHost {
  create(instanceId: string): Promise<{ readonly path: string }>;
  write(path: string, name: string, bytes: Uint8Array): Promise<string>;
  destroy(path: string): Promise<void>;
}
```

- [ ] **Step 4: Implement `src/anvil.ts`, `src/probes.ts`, `src/replay.ts`**

`src/anvil.ts` — `createAnvilMaterializer(config): VerifiedChainMaterializer`, where

```ts
/** Narrower than CE1's port on purpose: a materializer built for verification always produces
 * a report, so the verification path carries no `undefined` check it could not act on. It
 * still satisfies `ChainMaterializer` wherever the broader contract is what a consumer wants. */
export type VerifiedChainMaterializer = ChainMaterializer & {
  materialize(request: MaterializationRequest): Promise<VerifiedChainInstance>;
};
```

Its six obligations:

1. **Refuse to reach for archive state it was not handed (CE1-F10, normative).** When
   `requiresStateBackend(record)` is true and `request.stateBackend` is `undefined`,
   `materialize` throws `INVALID_INPUT`. Fork-backend reads are served from that injected
   object and from nowhere else; it never reads
   `record.stateMaterialization.providerLocators` — not to dial them, not to log them. Locators
   are information for a caller, not a capability for this runtime, and a materializer that
   fetched its own inputs would hold ambient authority no closure claim over it could survive.
2. **Refuse a record it is not pinned for.** `record.runtime.family`, `version`, and
   `binary` must match `config.pinnedRuntime` exactly; anything else is `invalidInput`. A
   materializer that launches whatever a record asks for is not a pinned runtime.
3. **Build the launch line from the record's canonical semantic launch configuration**, never
   from a CLI string riding as evidence (design §4.3). For a sealed instance the line carries
   **no fork url at all**, which is the boundary rule expressed at launch.
4. **Report what happened, never what was declared.** Every determinism control the record
   declares that is not in `config.supportedControls` lands in
   `RuntimeIdentityObservation.unsupportedControls`, where step 3 turns it into
   `determinism-control-unsupported`; T17 fills `supportedControls` honestly for the pinned
   version. `postFixtureCommitment` is emitted in the record's `0x` + 64-hex spelling, because
   §5.1 step 5 compares it directly against `initialStateCommitment` and a conversion at that
   comparison site is exactly where a conversion is dangerous. And
   `report.artifactEntries` is populated from **what the instance actually loaded**, never from
   what the artifact's own header declared: CE4 uses the entry index as a loader-vs-producer
   cross-check, and an index derived from the input would make that check vacuous while looking
   like it passed.
5. **Implement `reset` as a fresh materialization.** For a `closed-state` record
   `resetMechanism` is `fresh-process`, so "materialize afresh and return the new post-fixture
   commitment" is the correct semantics rather than a stub — and it is the only implementation
   under which `reset-divergence` means what §5.1 step 6 says.
6. **Load state and fixtures from `request.resources.byDigest` only** — the digest-keyed map step 1
   resolved. It never reads a path the record supplied, so a resource outside the resolution
   log cannot be loaded by construction, and `loadedResources` reports exactly what was.

`src/probes.ts` — `createProbeExecutor(config): ProbeExecutor`. It executes the resolved probe
suite against the instance's endpoint through `RpcTransport`, collects raw results, and
returns them as `observation: unknown` **without canonicalizing**. Canonicalization belongs to
`buildCanonicalChainObservation`, so the executor cannot decide what gets hashed.

`src/replay.ts` — `createScriptReplayer(config): ScriptReplayer<CanonicalChainObservation>`.
**It declares no script schema.** Per F-CE3-11, CE1 owns `ChainSolutionScriptSchema`,
`ChainSolutionScript`, `ChainSolutionOperation`, `SOLUTION_OPERATION_KINDS`,
`CHAIN_SOLUTION_MEDIA_TYPE`, `sealChainSolutionScript`, `parseChainSolutionScript`, and
`CapabilityEnvelope`; this module imports every one of them, because `ScriptReplayer` cannot be
typed without the script and the script therefore belongs beside the port type. A second
spelling here would be exactly the fork design §3 homed the types in CE1 to prevent.

The four operations are closed (design E10). The replayer enforces the **effective** envelope
— the record's, as tightened by the task, arriving as `ReplayRequest.envelope` — and
**refuses** rather than executes when an operation exceeds it: transaction count, aggregate
value, gas ceilings, permitted chain id, time-warp bounds. A refusal is CE1's
`ReplayOutcome` `{status: "refused", refusal: {reason, detail}}` with `reason` drawn from
CE1's closed set (`envelope-exceeded` · `operation-not-permitted` · `signer-not-in-scope` ·
`environment-mismatch`); the offending operation index rides in `detail`. Design §8: a script
exceeding the envelope is refused, not graded. On the replayed path the outcome carries
`reportedValues` — the `report` operations' names and values, which is what the evaluation
family's read-and-report predicate shape resolves against.

- [ ] **Step 5: Run the suite and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; all nine runtime-surface tests pass; the guard passes — in
particular, no `node:child_process` and no ambient network identifier appears anywhere in
`src/`, because the adapter holds ports rather than capabilities.

- [ ] **Step 6: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): public materializer, probe executor, and script replayer"
```

---

### Task 15: The staged, crash-safe state machine

A rewrite over this package's own vocabulary. The SWE package's staged state is reference
only: the stages differ (this protocol resolves, isolates, identifies, instantiates, probes,
compares), and the retry policy differs because a chain materialization is cheap while an
archive observation is provider-priced.

**Files:**
- Create: `src/staged-state.ts`, `src/staged-state.test.ts`, `src/staged-state-store.ts`,
  `src/staged-state-store.test.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `compareCodeUnitStrings`, `isCalendarStrictRfc3339`,
  `Sha256Digest` from `@jinn-network/trust-core`; the failure taxonomy from `./outcomes.js`.
- Produces: `STAGED_STATE_SCHEMA_VERSION`, `STAGED_STAGES`, `STAGED_DISPOSITIONS`,
  `MAX_INFRASTRUCTURE_ATTEMPTS`, `StagedJob`, `StagedStateFile`, `StagedStateStore`,
  `createStagedStateFile`, `upsertStagedJobs`, `advanceStagedJob`, `recordStagedAttested`,
  `recordStagedFailure`, `dueStagedJobs`, `parseStagedStateFile`, `serializeStagedStateFile`,
  `createFileStagedStateStore(directory)`.

- [ ] **Step 1: Write the failing state-machine test**

`src/staged-state.test.ts` asserts, at minimum:

- A job is keyed by the **record digest**: one record, one job, and `upsertStagedJobs` is
  idempotent (an existing key keeps its stage, disposition, and `createdAt`).
- `STAGED_STAGES` is `["discovered", "resolving", "materializing", "probing", "comparing",
  "attesting", "complete"]` and `advanceStagedJob` only moves forward.
- `recordStagedFailure` routes by `classifyChainVerificationFailure`:
  `failed_infrastructure` increments `attempts` and sets a `nextAttemptAt` fence, and after
  `MAX_INFRASTRUCTURE_ATTEMPTS` (3) becomes terminal with a
  `verification-infrastructure-failure` attestation to publish; `quarantined`, `awaiting_input`,
  and `terminal_policy` are terminal immediately with their own attestation to publish.
- **Every disposition ends with a published attestation.** There is no path where a job stops
  and nothing is said — that is design D3's negative-outcomes rule expressed as a state
  machine invariant, and the test asserts it over all four dispositions.
- `dueStagedJobs(file, now)` returns pending jobs plus retrying jobs whose fence has passed,
  in code-unit order of key, and the fence comparison is a plain string comparison over RFC
  3339 UTC instants (which is only meaningful because every timestamp is validated into that
  one shape on the way in).
- A round-trip through `serializeStagedStateFile` / `parseStagedStateFile` is byte-stable, and
  a file with an unknown `schemaVersion` is rejected rather than migrated.

`src/staged-state-store.test.ts` asserts crash safety against a real temporary directory:
write to a sibling temporary file and rename over the target, so a reader never sees a partial
file; a truncated file on disk is a loud parse failure, never a silently empty state; and two
sequential `save` calls leave exactly one file.

- [ ] **Step 2: Run and watch them fail**

Run: `corepack yarn@4.13.0 vitest run src/staged-state.test.ts src/staged-state-store.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement both modules**

`src/staged-state.ts` is pure: schemas, the job algebra, and the `StagedStateStore` **port**
(`load(): Promise<StagedStateFile>`, `save(file): Promise<void>`). No filesystem.

`src/staged-state-store.ts` is the only production file in this package that imports
`node:fs/promises`, and it **takes its directory as an argument** — explicit, not ambient:

```ts
export function createFileStagedStateStore(directory: string): StagedStateStore;
```

Atomic write: serialize, write to `${directory}/.staged-state.<counter>.tmp`, `rename` over
`${directory}/staged-state.json`. The counter is derived from the file's own `updatedAt`, not
from a random source, so the module needs no ambient randomness either.

- [ ] **Step 4: Run the suites and the guards**

```bash
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: typecheck 0 errors; both staged-state suites pass; the guard passes with the
filesystem carve-out covering exactly `staged-state-store.ts`, `testing.ts`, and the named
test files — a second production filesystem user anywhere in the tree still fails it.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification/src
git commit -m "feat(environments): staged crash-safe chain verification pipeline state"
```

---

### Task 16: The conformance kit — fake chain runtime, scripted scenarios, exact attestations

Program contract 12: the kit runs against **fakes**, never Docker, and asserts the exact
attestation each scenario produces — field-for-field against a committed golden, not a
spot-check. This task also assembles the public surface and lands the two contract tests
(bounded claims, fixture keys) that are enforcement rather than promise.

**Files:**
- Create: `src/testing.ts`, `src/testing.test.ts`, `src/bounded-claims.test.ts`,
  `src/fixture-keys.test.ts`, `scripts/generate-goldens.mjs`,
  `fixtures/attestations-v1/{sealed-stable,fork-backend-refusal,divergent-on-run-3,artifact-unavailable,upstream-fetch-succeeds,coverage-incomplete,composite-chain-only,composite-colliding-origins}.json`,
  `fixtures/attestations-v1/README.md`,
  `fixtures/predicate-v1/{closed-reproducible,archive-observed,invalid-prefixed-digest-set,invalid-runs-on-non-run-bearing,invalid-closed-with-divergent-per-run,invalid-k-below-minimum,invalid-sealed-without-boundary-probe,invalid-reason-outcome-mismatch,invalid-coverage-uncovered-but-reproducible}.json`
- Modify: `src/index.ts`, `README.md`

**Interfaces:**
- Consumes: `DsseSigner`, `parseDsseEnvelope`, `dssePreAuthEncoding`, `recordDigest` from
  `@jinn-network/trust-core`; `createEoaTestSigner` from `@jinn-network/trust-testing`
  (devDependency, used only by `src/testing.test.ts` and the golden generator); every T2–T15
  export.
- Produces: `CHAIN_CONFORMANCE_SCENARIOS`, `ScriptedChainScenario`,
  `createScriptedChainRuntime(scenario)`, `createInMemoryArtifactStore()`,
  `createFixedClock()`, `CONFORMANCE_VERIFIER_IDENTITY`, `loadGoldenStatement(name)`,
  `describeChainVerificationConformance(options)`.

- [ ] **Step 1: Write the failing kit-driver test**

`src/testing.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recoverEip191Address } from "@jinn-network/trust-core";
import type { DsseSigner } from "@jinn-network/trust-core";

import { describeChainVerificationConformance } from "./testing.js";

// Real, deterministic secp256k1/EIP-191 signatures over the DSSE pre-authentication encoding.
// The kit holds no key material of its own; the host supplies both the signer and the
// verifier for its key type.
const eoa = createEoaTestSigner("chain-environment-verification-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

describeChainVerificationConformance({
  signer,
  verifySignature: ({ preAuthEncoding, signature, keyid }) =>
    recoverEip191Address(preAuthEncoding, signature).toLowerCase() === keyid?.toLowerCase(),
});
```

(If `recoverEip191Address` is not exported from `trust-core` on the base branch, drop the
`verifySignature` option — the kit treats it as optional exactly so a host without a
verifier for its key type still runs every other leg. Confirm which, per contract 11.)

- [ ] **Step 2: Run and watch it fail**

Run: `corepack yarn@4.13.0 vitest run src/testing.test.ts`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [ ] **Step 3: Implement `src/testing.ts`**

The eight scenarios, each a scripted `ChainRuntime` that touches nothing — no process, no
socket, no disk:

| Scenario | Drives | Expected outcome |
| --- | --- | --- |
| `sealed-stable` | 5 identical observations, no fork backend, boundary probe reads empty | `closed-reproducible`, mode `sealed-boundary` |
| `fork-backend-refusal` | fork backend present, upstream fetch attempted and refused, 5 identical observations | `closed-reproducible`, mode `fork-backend-refusal` |
| `divergent-on-run-3` | run 2 returns a different `finalStateCommitment` | `probe-divergence` |
| `artifact-unavailable` | the artifact store throws for the state artifact | `artifact-unavailable` |
| `upstream-fetch-succeeds` | the instance reports an egress attempt that succeeded | `offline-dependency-detected` |
| `coverage-incomplete` | the artifact entry index carries one storage slot outside the manifest and outside every fixture declaration | `source-coverage-incomplete` |
| `composite-chain-only` | a composite with an empty `informationWorlds` list, 5 identical composite observations | `closed-reproducible` at composite scope |
| `composite-colliding-origins` | two information worlds claiming one origin at equal precedence | `capability-mismatch` |

The two closure modes are separate scenarios on purpose: a kit that only exercised sealed
instances would let a fork-backed regression through, and one that only exercised fork-backed
instances would never test the boundary rule.

```ts
// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture loading only) and
// is allowlisted for this file in the tree guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import { verifyCryptoEnvironment } from "./composite.js";
import {
  buildConformanceChainRecord,
  buildConformanceCompositeRecord,
} from "./conformance-records.js";
import { canonicalChainObservationBytes, chainObservationDigest } from "./observation.js";
import type { ArtifactStore, ChainRuntime, Clock } from "./ports.js";
import type { VerifierIdentity } from "./predicate.js";
import { parseChainEnvironmentVerificationStatement } from "./statement.js";
import { verifyChainEnvironment } from "./verify.js";

export const CHAIN_CONFORMANCE_SCENARIOS = [
  "sealed-stable",
  "fork-backend-refusal",
  "divergent-on-run-3",
  "artifact-unavailable",
  "upstream-fetch-succeeds",
  "coverage-incomplete",
  "composite-chain-only",
  "composite-colliding-origins",
] as const;
export type ScriptedChainScenario = (typeof CHAIN_CONFORMANCE_SCENARIOS)[number];

export const CONFORMANCE_VERIFIER_IDENTITY: VerifierIdentity = Object.freeze({
  id: "https://jinn.network/chain-environment-verification/conformance-verifier",
  version: "0.1.0",
  digest: `sha256:${"7".repeat(64)}`,
}) as VerifierIdentity;

export interface ScriptedChainRuntime extends ChainRuntime {
  /** Instance ids handed out, in run order. Distinct ids prove each run was its own
   * materialization rather than a snapshot revert. */
  readonly instanceIds: readonly string[];
  readonly materializeRequests: readonly { readonly networkPolicy: unknown }[];
  readonly stopCount: number;
}

/** A fake chain runtime with scripted observations. It touches nothing. */
export function createScriptedChainRuntime(
  scenario: ScriptedChainScenario,
): ScriptedChainRuntime { /* … */ }

export interface InMemoryArtifactStore extends ArtifactStore {
  readonly artifacts: ReadonlyMap<Sha256Digest, Uint8Array>;
}
export function createInMemoryArtifactStore(
  options?: { readonly missing?: readonly Sha256Digest[] },
): InMemoryArtifactStore { /* … */ }

/** Yields the window's start, then its end, then repeats the end. */
export function createFixedClock(
  startedAt = "2026-07-31T09:00:00.000Z",
  endedAt = "2026-07-31T09:04:00.000Z",
): Clock { /* … */ }

export type GoldenStatementName = ScriptedChainScenario;
export async function loadGoldenStatement(name: GoldenStatementName): Promise<unknown> {
  const path = fileURLToPath(
    new URL(`attestations-v1/${name}.json`, new URL("../fixtures/", import.meta.url)),
  );
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface DsseSignatureCheck {
  /** Re-derived by the kit from the sealed envelope, never taken on trust. */
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export interface ChainVerificationConformanceOptions {
  /** The host's signer. The kit holds no key material of its own. */
  readonly signer: DsseSigner;
  /** Optional: turns on the DSSE verification leg for the host's key type. */
  readonly verifySignature?: (check: DsseSignatureCheck) => boolean;
}

/**
 * Runs the capability against the fake runtime for each scripted scenario and asserts the
 * exact statement it produces against the committed golden. Requires `vitest` (an optional
 * peer) with `globals: true` -- the suite functions are read off `globalThis` at call time so
 * importing this module outside a test run (the golden generator does exactly that) never
 * pulls vitest's worker state into a plain Node process.
 */
export function describeChainVerificationConformance(
  options: ChainVerificationConformanceOptions,
): void {
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");
  /* … the assertions in step 4 … */
}
```

- [ ] **Step 4: The kit's assertions**

`describeChainVerificationConformance` asserts, for each scenario:

1. **The exact statement** equals the committed golden.
2. **Fresh instantiation**: `new Set(attestation.instanceIds).size === 5` for every run-bearing
   scenario, and `stopCount === materializeRequests.length` for all eight — including the
   failing ones, because a verifier that leaks instances on the failure path is a verifier
   nobody can run K times.
3. **The blackhole travelled**: every `materializeRequests[i].networkPolicy` equals the policy
   the signed predicate declares. A declared control the runs did not have is exactly the
   over-claim contract 7 forbids.
4. **Every result is signed**: `parseDsseEnvelope` yields `application/vnd.in-toto+json`, at
   least one signature, and a payload that round-trips through
   `parseChainEnvironmentVerificationStatement` to the returned statement;
   `attestationDigest === recordDigest(envelopeBytes)`. Negative attestations are first-class.
5. **Signatures verify** (when `verifySignature` is supplied) against the kit-re-derived
   pre-authentication encoding, **and a one-byte payload edit no longer verifies** — without
   the negative leg the positive one proves nothing about what was signed.
6. **Both closure modes** produce `closed-reproducible` with the mode the instance shape
   dictates, and neither scenario's evidence would satisfy the other's rule.
7. **The composite never substitutes**: `attestationMatchesRecord(composite, chainWorld)` is
   `false` and `requiresComponentAttestations(composite)` lists the chain world.
8. **Repeat-stability of the kit itself**: running one scenario twice yields identical
   statements and identical envelope bytes.

- [ ] **Step 5: Generate and eyeball the goldens**

`scripts/generate-goldens.mjs` drives `dist/` (so the goldens are generated by the built
artifact, not by `src/`) with the same fixed clock and the conformance signer, writing each
statement as pretty JSON with a trailing newline. Then:

```bash
cd packages/environments/chain-verification
corepack yarn@4.13.0 build && corepack yarn@4.13.0 goldens
```

**Read all eight files** and check them against design §5.3 by eye before committing:

- `sealed-stable.json` — `outcome: "closed-reproducible"`; `scope: "component"`;
  `runs.count` 5 with five identical `perRun.observationDigest` values;
  `runs.allObservationsEqual: true`; `runs.freshInstances: true`; no `failure`;
  `isolation.closureEvidenceMode: "sealed-boundary"` with
  `boundaryProbe.readsEmptyOutsideSlice: true` and `egressAttempts: []`; both subjects'
  `digest.sha256` values **bare hex**; `cost` carries no `rpcCalls`.
- `fork-backend-refusal.json` — same outcome, `closureEvidenceMode: "fork-backend-refusal"`,
  no `boundaryProbe`, and at least one `egressAttempts` entry with `outcome: "refused"`.
- `divergent-on-run-3.json` — `outcome: "probe-divergence"`; `runs` and `baseline` both
  present; `runs.allObservationsEqual: false`;
  `failure.divergence.divergentRuns` exactly `[{index: 2, …}]`.
- `artifact-unavailable.json` — no `runs`, no `baseline`; `failure`
  `{stage: "resolve", reason: "resource-unresolvable", detail: …}`.
- `upstream-fetch-succeeds.json` — `outcome: "offline-dependency-detected"`,
  `failure.reason: "egress-succeeded"`, and the successful attempt visible in
  `isolation.egressAttempts`.
- `coverage-incomplete.json` — `outcome: "source-coverage-incomplete"`;
  `environment.coverage.uncovered` ≥ 1; `failure.coverage.uncoveredStorageSlots` names the slot.
- `composite-chain-only.json` — `scope: "composite"`; subjects
  `["crypto-environment", "chain-world"]`; `composition.collisions: []`;
  `composition.components` with exactly one `chain-world` and no `information-world`.
- `composite-colliding-origins.json` — `outcome: "capability-mismatch"`;
  `failure.reason: "origin-routing-collision"`; one entry in `composition.collisions`.

`fixtures/attestations-v1/README.md`:

```markdown
# Golden chain verification attestations

Generated by the kit against the fake chain runtime and frozen. Regenerating them is allowed
only when the design changes; a diff here is a claim change, and reviewers read it as one. The
DSSE envelope is deliberately not pinned: envelope bytes depend on the signer, and the kit is
parameterized on the host's signer.
```

Then copy `sealed-stable.json`'s `predicate` into
`fixtures/predicate-v1/closed-reproducible.json` and the archive golden's into
`archive-observed.json`, and hand-author the seven adversarial predicate fixtures by mutating
them:

- `invalid-prefixed-digest-set.json` — `baseline.observation.digest.sha256` carries a
  `sha256:` prefix (the contract-6 confusion fixture).
- `invalid-runs-on-non-run-bearing.json` — `outcome: "artifact-unavailable"` with `runs`.
- `invalid-closed-with-divergent-per-run.json` — `closed-reproducible` with `perRun[2]`
  carrying a different `observationDigest`.
- `invalid-k-below-minimum.json` — `runs.count` 4 with four `perRun` entries.
- `invalid-sealed-without-boundary-probe.json` — `sealed-boundary` mode with `boundaryProbe`
  deleted: closure asserted from the absence of errors.
- `invalid-reason-outcome-mismatch.json` — `outcome: "capability-mismatch"` with
  `failure.reason: "artifact-entry-uncovered"`.
- `invalid-coverage-uncovered-but-reproducible.json` — `environment.coverage.uncovered: 1`
  with `outcome: "closed-reproducible"` (the forged-slice attestation).

- [ ] **Step 6: Add the fixture-corpus, bounded-claims, and fixture-key tests**

Append the fixture-corpus suite to `src/testing.test.ts`: the two golden predicates parse, all
seven `invalid-*` fixtures are rejected, and the count is asserted so a deleted fixture fails
the suite.

`src/bounded-claims.test.ts` (contract 7 — **enforced, not promised**):

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Absolutes this layer may never use about its own output. The claim is "K fresh
// materializations under blackhole produced identical canonical observations"; anything
// stronger is over-claiming (design §5.3 bounded claims, program contract 7).
const FORBIDDEN = [
  /\bdeterministic(?:ally)?\b/iu,
  /\bnon-?deterministic\b/iu,
  /\bguarantee[sd]?\b/iu,
  /\btrustless\b/iu,
  /\bauthenticated against\b/iu,
  /\bmainnet[- ]equivalent\b/iu,
  /\bfully reproducible\b/iu,
];

// "verified" and "proven" are legitimate in bounded form -- EIP-1186 proofs prove a subset
// against a declared root, and step 1 verifies a digest. A line earns them only by naming what
// bounds the claim.
const BOUNDED_WORDS = /\b(verified|verifies|verifiable|proven|proves)\b/iu;
const BOUNDING = new RegExp([
  'declared', 'subset', 'slice', 'attestation', 'digest', 'proof-covered', 'EIP-1186',
  'bounded', 'never', 'MUST NOT', 'no claim', 'does not', 'cannot', 'K fresh',
].join('|'), 'iu');

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`);
}

describe("bounded claims", () => {
  it("no shipped file uses a forbidden absolute", async () => {
    // Source, the scripts that generate and smoke the published artifacts, and the fixture
    // corpus -- every file a third party reads. This file is the only exception: it must
    // spell the banned words to ban them.
    const paths = [
      ...await filesUnder(SOURCE_ROOT),
      ...await filesUnder(`${PACKAGE_ROOT}scripts`),
      ...await filesUnder(`${PACKAGE_ROOT}fixtures`),
    ].filter((path) => !path.endsWith("bounded-claims.test.ts"));
    expect(paths.some((path) => path.includes("/scripts/"))).toBe(true);
    expect(paths.some((path) => path.includes("/fixtures/"))).toBe(true);
    for (const path of paths) {
      const text = await readFile(path, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(text), `${path} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("every use of verified/proven names what bounds it", async () => {
    const paths = (await filesUnder(SOURCE_ROOT))
      .filter((path) => !path.endsWith("bounded-claims.test.ts"));
    const findings = [];
    for (const path of paths) {
      const text = await readFile(path, "utf8");
      text.split("\n").forEach((line, index) => {
        if (BOUNDED_WORDS.test(line) && !BOUNDING.test(line)) {
          findings.push(`${path}:${index + 1} -> ${line.trim()}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });

  it("the README and the caveats note state the bound explicitly", async () => {
    const readme = await readFile(`${PACKAGE_ROOT}README.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(readme), `README matches ${String(pattern)}`).toBe(false);
    }
    expect(readme).toContain("K fresh materializations under blackhole produced identical canonical observations");
    expect(readme).toContain("It does not speak to");
    expect(readme).toContain("no fork backend");
    const caveats = await readFile(`${PACKAGE_ROOT}ANVIL-CAVEATS.md`, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(caveats), `ANVIL-CAVEATS matches ${String(pattern)}`).toBe(false);
    }
  });
});
```

`src/fixture-keys.test.ts` (contract 8, design §8 — **enforced, not promised**):

```ts
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

// The ten Foundry/Hardhat default accounts derived from the well-known "test test … junk"
// mnemonic. Design §8: because a sandbox may report chain id 1 for contract compatibility,
// every EIP-155 transaction in a published solution script is a structurally valid mainnet
// transaction from that fixture address, permanently. It is inert only because the address
// holds nothing -- inert by economics, not by cryptography. A fixture address that someone
// might fund turns every published script into a replayable mainnet transaction from it.
const WELL_KNOWN = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
];

describe("fixture keys", () => {
  it("uses no well-known development address anywhere it ships", async () => {
    const roots = ["src", "fixtures", "scripts"];
    const paths = [];
    for (const root of roots) {
      const entries = await readdir(`${PACKAGE_ROOT}${root}`, {
        recursive: true, withFileTypes: true,
      });
      paths.push(...entries.filter((entry) => entry.isFile())
        .map((entry) => `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`));
    }
    for (const path of paths.filter((one) => !one.endsWith("fixture-keys.test.ts"))) {
      const text = (await readFile(path, "utf8")).toLowerCase();
      for (const address of WELL_KNOWN) {
        expect(text.includes(address), `${path} carries ${address}`).toBe(false);
      }
      expect(/test\s+test\s+test\s+test/iu.test(text), `${path} carries a dev mnemonic`)
        .toBe(false);
    }
  });

  it("never carries private key material", async () => {
    const entries = await readdir(`${PACKAGE_ROOT}src`, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((one) => one.isFile())) {
      const text = await readFile(
        `${entry.parentPath.replace(/\/*$/u, "/")}${entry.name}`, "utf8",
      );
      // A 32-byte hex literal in this package would be a key, a digest, or a storage word;
      // digests and words carry their own prefixes, so a bare one is a finding.
      expect(/(?<![0-9a-fx:])[0-9a-f]{64}(?![0-9a-f])/u.test(text.replace(/["'`]/gu, "")))
        .toBe(false);
    }
  });
});
```

- [ ] **Step 7: Assemble `src/index.ts`**

Export every public symbol from T2–T15, in module order, matching the shape of the SWE
sibling's `index.ts`. The root entrypoint must **not** re-export `./testing.js` — the tree
guard checks it. The public runtime surface (`createAnvilMaterializer`, `createProbeExecutor`,
`createScriptReplayer`, and the three host port types) is exported from the **root**, because
design §3 gives all four consumers one export boundary. The solution script is **not**
re-exported: it is CE1's, and a consumer that needs it depends on CE1 directly (F-CE3-11).

- [ ] **Step 8: Run the full gate**

```bash
cd packages/environments/chain-verification
corepack yarn@4.13.0 typecheck
corepack yarn@4.13.0 test
corepack yarn@4.13.0 build
corepack yarn@4.13.0 pack:smoke
cd ../../.. && node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs
```
Expected: typecheck 0 errors; every suite passes (the kit's eight scenarios plus its
structural legs, the predicate corpus, bounded claims, fixture keys, and every earlier suite);
`build` emits `dist/`; `pack:smoke` prints its success line; all three guards pass.

- [ ] **Step 9: Commit**

```bash
git add packages/environments/chain-verification
git commit -m "feat(environments): chain verification conformance kit and golden attestations"
```

---

### Task 17: Verify design §10's Anvil caveats against the pinned version

Program §6 and the design's own §10 both say these are **verified at CE3 implementation, not
assumed**: dump-state fidelity on forked instances has real bug history, and deterministic
`prevrandao` control at the Anvil (not cheatcode) level has been inconsistent across versions.
This task measures both against the version this package pins, and the measurement decides
which determinism controls a record may honestly declare.

**Files:**
- Create: `src/anvil-caveats.anvil.test.ts`, `ANVIL-CAVEATS.md`
- Modify: `.github/scripts/environments-source-boundaries.test.mjs` (the one-file process
  carve-out from T1 step 6), `README.md`

**Interfaces:**
- Consumes: `createAnvilMaterializer`, `createProbeExecutor` and the three host ports; a real
  Anvil binary supplied by the machine, not by this package.
- Produces: `ANVIL-CAVEATS.md` and the honest value of `supportedControls` that every host
  wiring `createAnvilMaterializer` should pass.

**Contract 12 compliance:** this suite lives in `*.anvil.test.ts`, which `vitest.config.ts`
excludes from the default project, and it `skipIf`s itself when no binary is present. A
machine with no Foundry runs `yarn test` green and this suite simply does not run.

- [ ] **Step 1: Write the caveat probes**

`src/anvil-caveats.anvil.test.ts` — this is the **one** file permitted to spawn a process, and
it implements a real `ProcessHost` / `RpcTransport` / `WorkspaceHost` inline over
`node:child_process` and `node:http` so the package's own source stays clean:

```ts
// SPDX-License-Identifier: Apache-2.0

// Opt-in. Excluded from the default vitest project (see vitest.config.ts) and skipped when
// no Anvil binary is on PATH. Design §10 says these two behaviours must be measured against
// the pinned version rather than assumed, so this file measures them.

import { describe, expect, it } from "vitest";

const PINNED_VERSION = "<the version the package pins>";

describe.skipIf(!anvilAvailable())(`anvil ${PINNED_VERSION} caveats`, () => {
  it("reports the pinned version", async () => {
    expect(await anvilVersion()).toContain(PINNED_VERSION);
  });

  it("applies prevrandao at the launch level, or says it does not", async () => {
    // Launch two instances with the same declared prevrandao and mine one block in each.
    // If the pinned version honours the launch-level control, both blocks report the same
    // prevrandao. If it does not, this test records that fact -- and `supportedControls`
    // must omit `prevrandao`, so a record declaring it fails step 3 rather than riding on a
    // control the runs did not have.
    const [first, second] = await Promise.all([minedBlock(), minedBlock()]);
    expect({ prevrandaoStable: first.prevrandao === second.prevrandao })
      .toMatchObject({ prevrandaoStable: expect.any(Boolean) });
    // The assertion is recorded in ANVIL-CAVEATS.md, not asserted true: this test measures.
    await recordCaveat("prevrandao", first.prevrandao === second.prevrandao);
  });

  it("round-trips a dumped state without losing entries", async () => {
    // Fork nothing; construct a small local world, write a handful of accounts, code, and
    // storage slots, dump, relaunch from the dump, and compare the entry index. §7's
    // widen-and-re-verify loop exists because this has failed historically on forked
    // instances; the measurement says whether it also fails on the pinned version.
    const before = await buildAndIndexWorld();
    const after = await relaunchFromDumpAndIndex(before.dump);
    await recordCaveat("dumpFidelityLocal", entryIndexesEqual(before.index, after.index));
    expect(after.index.accounts.length).toBeGreaterThan(0);
  });

  it("round-trips a dumped state from a FORKED instance, or says it does not", async () => {
    // Needs an archive endpoint, which CI does not have; skipped unless one is provided to
    // the suite as an explicit argument. Recorded either way.
    await recordCaveat("dumpFidelityForked", await measureForkedDumpFidelity());
  });
});
```

- [ ] **Step 2: Run it against the pinned version**

```bash
cd packages/environments/chain-verification
anvil --version
corepack yarn@4.13.0 test:anvil
```
Expected: the suite runs (or skips cleanly with no binary) and writes its four measurements.

- [ ] **Step 3: Write `ANVIL-CAVEATS.md` from what was measured**

The file records, for the pinned version: the exact version string; each of the four
measurements with its observed result and the date; and — the load-bearing part — **the
resulting `supportedControls` list**, with one line per control saying whether the pinned
version applies it at the launch level. A control that could not be shown to apply is omitted,
so a record declaring it fails step 3 with `determinism-control-unsupported` instead of the
attestation stating a control the runs did not have.

If dump fidelity on forked instances is not clean, the note says so and points at design §7's
widen-and-re-verify loop as the reason the pipeline never trusts a dump — which is exactly why
that loop is mandatory rather than optional, and is the finding CE4 needs.

- [ ] **Step 4: Land the guard carve-out and run the full gate**

Add `chain-verification/src/anvil-caveats.anvil.test.ts` to
`CHAIN_VERIFICATION_PROCESS_SOURCES` in `.github/scripts/environments-source-boundaries.test.mjs`
and wire it into the assertion so exactly that one path may import `node:child_process` /
`node:http`, and every other file in the tree still fails on them.

```bash
cd packages/environments/chain-verification && corepack yarn@4.13.0 test
cd ../../.. && node --test .github/scripts/environments-source-boundaries.test.mjs
```
Expected: the default suite is unchanged and green (the Anvil file is excluded); the guard
passes with exactly one process carve-out.

- [ ] **Step 5: Commit**

```bash
git add packages/environments/chain-verification .github/scripts
git commit -m "chore(environments): measure the pinned Anvil's determinism and dump caveats"
```

---

## Verification before completion (branch gate)

Before this branch is reported complete, run and show the output of all of:

```bash
cd packages/environments/chain-verification
corepack yarn@4.13.0 typecheck && corepack yarn@4.13.0 test \
  && corepack yarn@4.13.0 build && corepack yarn@4.13.0 pack:smoke
cd ../../..
node --test .github/scripts/environments-package-inventory.test.mjs \
  .github/scripts/environments-source-boundaries.test.mjs \
  .github/scripts/environments-packed-types.test.mjs \
  .github/scripts/custody-boundaries.test.mjs
# Custody + tier sweeps, as a second pair of eyes on the guards.
grep -rn "process\.env\|node:child_process\|node:net\|node:http\|localeCompare\|Intl\." \
  packages/environments/chain-verification/src \
  | grep -v "anvil-caveats.anvil.test.ts" && echo "BOUNDARY VIOLATION" || echo "clean"
grep -rln "@jinn-network/core\|@jinn-network/plugin\|jinn-layer\|client/src" \
  packages/environments/chain-verification/src && echo "FROZEN-TRIO IMPORT" || echo "clean"
# Placeholder scan (contract 10): no unfilled stub may ship.
grep -rn "TODO\|FIXME\|filled in step\|implement this\|<name>" \
  packages/environments/chain-verification/src \
  packages/environments/chain-verification/fixtures && echo "PLACEHOLDER" || echo "clean"
```

Then request one independent high-effort review against the design (§4.2–§4.4, §5, §8, §10)
per program §5, before CE4 or CE5 builds on this branch.

---

## Findings (2026-07-31)

Design defects and program/spec tensions found while planning. Contract 1: these are proposals
with dispositions, not applied patches. Each is restated in-package as a comment at the site it
affects.

**F-CE3-0 — CE1 port-shape reconciliation (filled at T1 step 2).**
This plan writes its driver against the port shapes named in §Consumed interfaces. T1 step 2
reads CE1's actual declarations and records the result here: a name difference is a mechanical
rename at the call sites; a missing field the protocol reads is a stop-and-report.

**F-CE3-1 — `verifyChainEnvironment`'s dependency set needs the verifier identity.**
Program §3 pins `deps` as `{runtime, artifactStore, signer, clock, verifier}` and design §5.3
requires the predicate to carry `verifier: {id, version, digest}`. A library cannot truthfully
digest its own build at runtime; manufacturing a value would be exactly the over-claiming
contract 7 exists to prevent. *Disposition:* already pinned correctly — recorded so a reviewer
reading the parent's C2 (where this was a finding) sees it was carried, not re-litigated. K,
network policy, and timeout ride in an optional third `options` argument, so
`verifyChainEnvironment(deps, record)` stays a correct call.

**F-CE3-2 — the artifact port needs a read side.**
Design §5.1 step 1 resolves and digest-verifies **every** resource before use. The SWE
sibling's `ArtifactStore` is write-only (`putArtifact`), because its resources arrive inside a
container image. *Disposition proposed:* CE3's `ArtifactStore` declares both `getArtifact` and
`putArtifact`. The pinned dep **name** is unchanged, so program §3 needs no amendment; the note
exists so a reviewer comparing the two packages does not read the extra method as drift.

**F-CE3-3 — §5.3's presence rule needs a run-bearing partition, and mid-run failures carry no runs.**
§5.3 says "repetition/observation blocks present iff runs occurred," which is unambiguous for
a clean K-run and ambiguous for a failure at run 3. *Disposition (interpretation, no spec
change):* `RUN_BEARING_OUTCOMES` is the closed set for which a **complete** K-run observation
exists (`closed-reproducible`, `archive-observed`, `probe-divergence`, `reset-divergence`,
`provider-disagreement`); every other outcome carries partial observations as `evidence` and
no `runs`/`baseline`, because a truncated run sequence is not a repetition claim. This makes
the presence rule mechanical rather than prose.

**F-CE3-4 — one predicate type covers two different claims.**
§5.3 names a single predicate type, and §5.1 step 6 requires that a composite attestation
never substitute for a component's. Nothing in §5.3 says how a consumer tells them apart.
*Disposition proposed:* a required `scope: "component" | "composite"` field plus distinct
subject-name tuples (`[environment, state-artifact]` vs `[crypto-environment, chain-world]`),
so `attestationMatchesRecord` returns `false` for a composite asked about its chain world —
the never-substitutes rule expressed structurally rather than as guidance. Design §5.3 to
record the discriminator; no new predicate type is minted.

**F-CE3-5 — composition failures have no dedicated outcome, and the vocabulary is closed.**
§5.1 step 6 requires composite checks (routing collisions, request-key equivalence, miss
policy, request budget), but §5.3's 14-member partition has no member for them and cannot grow
without a design amendment. *Disposition proposed:* they map to `capability-mismatch`, because
composition routing, budget, and miss policy are part of the declared capability surface of
the composite world, and the finer `failure.reason` (`origin-routing-collision`,
`request-key-divergence`, `miss-policy-violation`, `request-budget-not-enforced`) preserves the
detail. Recorded rather than silently assumed, because a reader of §5.3 would not predict it.

**F-CE3-6 — the tree guard needs one filesystem carve-out.**
Design §5 requires a staged, crash-safe pipeline state library; atomic write means
`node:fs/promises`, which the `packages/environments/` boundary guard forbids outside the
testing region. *Disposition proposed:* CE3 lands the amendment in T1 — a named list covering
`chain-verification/src/staged-state-store.ts` (which takes its directory as an argument),
`src/testing.ts`, and three named test files. Every other file in the tree still fails on a
filesystem import. Same shape as the SWE sibling's F-C2-5, so the guard grows a second narrow
list rather than a general exemption.

**F-CE3-7 — measuring §10's caveats needs a process, which the tier may not have.**
§10 requires the `prevrandao` and dump-fidelity caveats to be *verified against the pinned
version*, which means launching a real Anvil. *Disposition proposed:* exactly one opt-in test
file (`src/anvil-caveats.anvil.test.ts`) may import `node:child_process`; it is excluded from
the default vitest project and skips when no binary is present, so contract 12 holds. The
package's own source still spawns nothing — the materializer takes a `ProcessHost`. The
measurement's output is `supportedControls`, and a control that could not be shown to apply is
omitted, so a record declaring it fails step 3 rather than the attestation stating a control
the runs did not have.

**F-CE3-8 — the subject digest is recomputed, not carried.**
`verifyChainEnvironment` takes a *parsed* `ChainEnvironmentRecord`, but the subject must name
the digest of the record's **sealed bytes**. The implementation re-seals via CE1's
`sealChainEnvironmentRecord` and digests that. Sound only because sealing is
JCS-once-deterministic and CE1's parser rejects non-exact bytes. *Disposition:* no change
proposed; recorded because CE3's correctness depends on a CE1 property. If CE1's parser turns
out to tolerate non-canonical input, this becomes a blocker and both entry points must take
record **bytes** instead — a stop-and-report.

**F-CE3-9 — the canonical observation has three candidate homes and one shape. (RESOLVED.)**
Program §3 assigns `CanonicalChainObservationSchema` to CE2 (pure, no chain dependency), while
CE3 must own the canonicalization because §5.1 step 7's rule ("the verifier hashes the
canonical observation, never backend JSON") is a verification-capability property, and CE3's
branch bases on CE1 rather than CE2. *Disposition, confirmed against CE1's filed plan:* CE1
declares **no** observation type — its `ProbeExecutor<Observation = unknown>` and
`ScriptReplayer<Observation = unknown>` take the observation as a type parameter, and its plan
states the reason in the same words. So CE3 owns the schema, the canonical bytes, and the
digest; CE2's `CanonicalChainObservationSchema` is the evaluator-side re-declaration, validated
against CE3's by a cross-package equivalence fixture at CE5 — which merges CE2 and bases on
CE3, so it is the first branch that can see both. This follows the house rule for sealing
(re-implement per package, prove equivalence by fixture) rather than minting a shared runtime
schema module. Program §3's CE2 bullet should note the equivalence obligation.

**F-CE3-10 — `verifyCryptoEnvironment` needs an information-plane port the pinned dep set omits.**
Program §3 pins five deps; §5.1 step 6's composite probes require serving information-world
corpora. *Disposition proposed:* an **optional** sixth member, `informationRuntime`, so the
pinned call shape `verifyCryptoEnvironment(deps, composite)` is unchanged and the chain-only
v1 path (empty `informationWorlds`, per E14) never needs it. Composing information worlds with
no runtime injected is `information-runtime-absent` →
`verification-infrastructure-failure` — fail closed, never a silent skip. CE6 supplies the
implementation.

**F-CE3-11 — the solution script's home. (RESOLVED: CE1 owns it.)**
Design §14 names the solution media type and program §3 assigned it to no one. CE1's filed plan
(Task 11) claims it: `CHAIN_SOLUTION_MEDIA_TYPE`, `SOLUTION_OPERATION_KINDS`,
`ChainSolutionScriptSchema`, `ChainSolutionScript`, `ChainSolutionOperation`,
`sealChainSolutionScript`, `parseChainSolutionScript`, together with `CapabilityEnvelope`.
*Disposition:* CE1's claim is right — `ScriptReplayer` cannot be typed without the script, so
the script belongs beside the port type. **CE3 declares none of these and imports all of
them**; T14's `createScriptReplayer` consumes CE1's `ChainSolutionScript`, CE1's
`CapabilityEnvelope`, and CE1's closed `ReplayRefusal.reason` set
(`envelope-exceeded` | `operation-not-permitted` | `signer-not-in-scope` |
`environment-mismatch`) rather than the `{operationIndex, reason}` shape sketched in T14's
test. Program §3's CE1 bullet should gain the solution-script line, which CE1's own plan
already files as a finding.

**F-CE3-12 — CE1's `ChainMaterializer` / `ChainInstance` do not carry what §5.1 reads. (BLOCKING.)**
CE1 declares `ChainInstance` as `{instanceId, rpcEndpoint, stop}` and
`MaterializationRequest` as `{record, resources, signal?}`. Seven facts the closed-state
protocol reads have no home: the verifier-assigned `instanceId` and the `networkPolicy` on the
request (steps 8 and 2 — a blackhole that does not travel with the request is a control the
attestation would state without the run having had it); `runtimeIdentity` including
`unsupportedControls` (step 3, and §10's whole point); `artifactEntries` (step 4's E13
computation); `postFixtureCommitment` (step 5); `isolation` — egress attempts,
forbidden-probe results, exposed signers, ceiling checks (step 6); `loadedResources` and
`cost` (step 9 and §5.3's cost block); and `reset` (step 6's reset requirement, against which
`reset-divergence` is decided).

*Disposition proposed (sent to plan-ce1, first choice):* CE1 keeps the ports type-only and
grows three declarations —

```ts
export interface MaterializationRequest {
  readonly record: ChainEnvironmentRecord;
  readonly resources: ResolvedResources;
  /** Verifier-assigned, so K distinct ids are the verifier's claim rather than the runtime's. */
  readonly instanceId: string;
  /** The blackhole travels WITH the request (§5.1 step 2). */
  readonly networkPolicy: NetworkPolicy;
  readonly signal?: AbortSignal;
}
export interface NetworkPolicy {
  readonly egress: "denied";
  readonly dns: "absent";
  readonly archiveRpc: "unreachable";
  readonly forkBackend: "absent" | "present";
}
export interface MaterializationReport {
  readonly runtimeIdentity: {
    readonly imageManifestDigest: `sha256:${string}`; readonly platform: string;
    readonly reportedVersion: string; readonly binaryDigest: `sha256:${string}`;
    readonly evmConfigurationDigest: `sha256:${string}`; readonly chainId: number;
    readonly appliedControls: Readonly<Record<string, string>>;
    readonly unsupportedControls: readonly string[];
  };
  readonly artifactEntries: {
    readonly accounts: readonly string[]; readonly code: readonly string[];
    readonly storage: readonly { readonly address: string; readonly slot: string }[];
  };
  readonly postFixtureCommitment: `sha256:${string}`;
  readonly loadedResources: readonly `sha256:${string}`[];
  readonly isolation: {
    readonly networkPolicy: NetworkPolicy;
    readonly egressAttempts: readonly {
      readonly target: string; readonly outcome: "refused" | "succeeded";
      readonly detail?: string;
    }[];
    readonly forbiddenProbes: readonly {
      readonly method: string; readonly expectedClass: string; readonly observedClass: string;
    }[];
    readonly exposedSignerAccounts: readonly string[];
    readonly ceilingChecks: readonly { readonly name: string; readonly enforced: boolean }[];
  };
  readonly cost: {
    readonly wallSeconds: number; readonly cpuSeconds?: number;
    readonly maxMemoryBytes?: number; readonly diskBytes?: number;
    readonly rpcCalls?: number; readonly rpcBytes?: number;
  };
}
export interface ChainInstance {
  readonly instanceId: string;
  readonly rpcEndpoint: string;
  /** What the materialization observed about itself. A solver's local runner ignores it. */
  readonly report: MaterializationReport;
  readonly stop: () => Promise<void>;
}
export interface ChainMaterializer {
  materialize(request: MaterializationRequest): Promise<ChainInstance>;
  /** §5.1 step 6's reset requirement; returns the post-reset commitment. */
  reset(instance: ChainInstance, signal?: AbortSignal): Promise<`sha256:${string}`>;
}
```

All data, no behaviour, so CE1 stays tier 2; one member added to `ChainInstance` so a solver's
local runner still gets a two-field handle it can ignore the rest of. *Second choice, if CE1
declines:* CE3 declares a `ChainVerificationRuntime` port extending CE1's, and the family
carries two shapes for one instance — the drift design §3 homed the types in CE1 to prevent.
Recorded as second choice, not adopted silently.

Until one disposition lands, **Task 1 step 2 is a stop-and-report**.

**Status: RESOLVED, first disposition adopted in full (coordinator ruling CR3).** CE1's plan is
amended in place and this plan is written against the amended shapes throughout — no parallel
`ChainVerificationRuntime`, no second instance type. CE1 made three corrections while adopting,
all of them right and all of them applied here: (1) `postFixtureCommitment` and `reset`'s
return are `` `0x${string}` `` state commitments, not `sha256:` content digests, because §5.1
step 5 compares them directly against `initialStateCommitment` and a conversion at that site is
where a conversion is dangerous — the predicate's `environment.postFixtureCommitment`,
`baseline.commitment`, `isolation.resetCommitment`, and the observation's
`finalStateCommitment` all follow, while `loadedResources` and every material digest stay
`sha256:`; (2) `artifactEntries` members are `accounts` / `codeEntries` / `storageSlots`,
matching `stateArtifact.entryCounts` member-for-member, and this plan uses those three words
end to end — input, uncovered sets, and `failure.coverage`; (3) `report` is **optional** on
`ChainInstance` with `VerifiedChainInstance` exported as the narrowing, so a solver's local
runner is never forced to *produce* isolation evidence and cost observations it has no use for
— which is the decisive consumer in design §3's seam argument. Its absence on a verification
path is `materialization-report-absent` → `verification-infrastructure-failure`, one explicit
check, never a non-null assertion. CE1 also landed `MaterializationRequest.stateBackend` +
`requiresStateBackend` (CE1-F10, from CE4); the fail-closed rule and the never-read-the-locators
rule are CE3's to enforce and are written into T12 and T14.

**F-CE3-13 — CR6 gives CE3 the `abiRef+args` encoding; the encoder is hand-rolled and closed.**
Coordinator ruling CR6 (law, not a finding): the declarative predicate form ships in v1, CE2
emits structured read requests and stays pure, and CE3 encodes — because `viem` is banned
tree-wide in `task-supply`, so a scenario package cannot encode calldata and a parameterized
template cannot pre-encode at authoring time. *Recorded here for the part that is a CE3
decision:* `src/abi-encode.ts` is hand-rolled over the closed set of ABI types the v1 predicate
vocabulary can express, rather than pulling a general-purpose encoder, so the allowed-externals
list stays three entries plus `@noble/hashes` (already an approved supplier in this tree, for
keccak-256 over the signature) and no ABI feature enters that no predicate can grade. Golden
vectors come from the Solidity ABI specification's worked examples. The stated fallback is to
add `ox` and delete the module — a guard edit plus a dependency-graph edit in one PR, not a
redesign.

*Ruling CR8 accepted the encoder on these merits with one condition, and the condition is the
right one:* spec-derived vectors prove the happy path, and dynamic encoding is not the happy
path — a wrong encoding does not throw, it calls a different function and the task is graded on
that answer, which is the worst failure mode this family can produce. T13A therefore requires
(a) an **adversarial** golden corpus alongside the spec examples — empty array, empty `bytes`,
zero-length `string`, a dynamic member at the head/tail seam, a dynamic member flanked by
statics, a dynamic array of dynamic members, and max/min-width `uintN` / `intN` at the
boundary, each with expected calldata — and (b) a **differential test against an independent
encoder**. The tree guard permits (b) as a test-only devDependency, and the plan names the
receipt rather than asserting the allowance: `packages/environments/record` already carries
`canonicalize` and `ajv` as third-party test-only differential oracles in
`RECORD_ALLOWED_DEV_DEPENDENCIES`, the production-externals assertion scans production files
only, devDependencies are an explicit `deepEqual` allowlist, and the inventory guard's
dependency graph filters to `@jinn-network/` names so a non-Jinn devDependency never enters it.
**A component review should verify those four lines independently rather than take this
paragraph's word for it.** The oracle is `ox` specifically because it is the same package the
fallback would promote to production — so if the differential test says the hand-rolled module
is wrong, the remedy is already scoped and already installed. Per CR8, a gap either check
surfaces triggers the fallback immediately rather than a patch.

Two consequences ride with the ruling and are implemented in T13A rather than assumed:
`stateReadKey` must be byte-identical to CE2's derivation (a cross-package key corpus both
packages assert against, CE5 being the first branch that can see both), and the
`baseline` / `post-replay` tag must be honoured by *execution ordering* — baseline reads run on
the freshly materialized world before any probe or script operation — because that ordering is
the entire mechanism behind the design's pre-replay ground-truth rule for `reportedValue`.

---

## Self-review

**Design §5.1 coverage, step by step.**
Step 1 (resolve and digest-verify every resource, no network in validation) — `src/resolve.ts`,
driven from `materialRequests`, failures → `artifact-unavailable` (T8, T10, T11).
Step 2 (blackhole; the two evidence modes) — `DEFAULT_BLACKHOLE_POLICY` travels on every
materialize request and `assessClosure` handles both modes with separate scenarios in the kit
(T7, T8, T16). Step 3 (runtime identity **including determinism controls**) —
`checkRuntimeIdentity` plus `unsupportedControls`, whose honest value T17 measures. Step 4
(source provenance per Axis B **and E13 coverage**, with E5's bound stated) —
`checkSourceAnchor` + `assessArtifactCoverage`, and `anchor.authenticity` is a predicate field
so `declared` vs `header-proven` is in the signed payload (T9, T10). Step 5 (instantiate,
apply fixtures, compare the post-fixture commitment against `initialStateCommitment`, **not**
against the source root) — T10, with the design's warning restated at the site. Step 6
(capability and isolation probes; **the component/composite split**) — `forbiddenProbes`,
signer scope, ceilings, reset, and `verifyCryptoEnvironment`'s combination-only checks (T10,
T13). Step 7 (the probe suite; the canonical observation's ten dimensions; hash the canonical
form) — `src/observation.ts` and `createProbeExecutor`, which deliberately does **not**
canonicalize (T3, T14). Step 8 (K ≥ 5 fresh processes; snapshot/revert is never verification)
— `MINIMUM_RUN_COUNT`, one materialize per run, distinct instance ids asserted by the schema
*and* by the kit (T10, T16). Step 9 (compare: commitments, observations, no egress, no
uncommitted resource, capability probes) — the compare block plus `assessClosure` (T10).

**§5.2** — `observeArchiveEnvironment` as a sibling entry point that cannot emit
`closed-reproducible`, records providers/time/RPC cost, and produces `provider-disagreement`
(T12). **§5.3** — dual subjects with the record-subject match rule, bare-hex DigestSets, the
window inside the payload, host-declared verifier, materials, environment observation,
repetition evidence (K, instance ids, per-run digests, equality result, fresh-instantiation
confirmation), isolation evidence (policy, egress attempts, forbidden probes, signer scope,
resolution-log digest), cost observations, the closed 14-member outcome vocabulary, and the
bounded-claims list enforced by a test over source, scripts, fixtures, and the README (T5, T6,
T16). **§5.4** — the cost block is exactly what makes closed-state re-verification budgetable
from artifact sizes and K, and RPC counts are structurally forbidden on a closed-state run.
**§4.4** — routing collisions, whole-world offline boot, both-plane K-run observation, and the
never-substitutes rule (T13, T16). **§10** — measured, not assumed (T17).

**Pinned-name check against program §3 "CE3 produces".**
`CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE` =
`https://jinn.network/attestations/chain-environment-verification/v1` (T2). ✓
`verifyChainEnvironment(deps, record): Promise<SealedAttestation>` with `deps` injecting
`{runtime, artifactStore, signer, clock, verifier}` (T10). ✓
`verifyCryptoEnvironment(deps, composite)` doing composite-level routing collisions and
whole-world closure (T13). ✓ `createAnvilMaterializer(config)`, `createProbeExecutor(...)`,
`createScriptReplayer(...)` on the root export (T14). ✓ Dual subjects, bare-hex DigestSets,
record-subject match rule (T6). ✓ All spelled exactly; no pinned name is altered. Two
additions are recorded as findings rather than taken silently: the optional `informationRuntime`
dep (F-CE3-10) and the `scope` discriminator (F-CE3-4).

**Cross-plan reconciliation against CE1's filed plan (2026-07-31).** Read after drafting, and
three items moved. (a) Every pinned CE1 symbol this plan consumes exists and is spelled
identically — `sealChainEnvironmentRecord`, `parseChainEnvironmentRecord`,
`chainEnvironmentRecordDigest`, `cryptoEnvironmentRecordDigest`, `bareHexDigest`,
`CHAIN_ENVIRONMENT_KIND`, `CRYPTO_ENVIRONMENT_KIND`, and the three port types. (b) CE1 declares
no observation type and parameterizes `ProbeExecutor<Observation>` / `ScriptReplayer<Observation>`
for the reason F-CE3-9 argues, which **resolves** that finding in this plan's favour with no
program amendment. (c) CE1 claims the solution script and `CapabilityEnvelope`, which
**supersedes** this plan's original F-CE3-11 disposition — T14 now imports all of it and
declares none of it. (d) F-CE3-12 — CE1's instance and request carrying none of the seven facts §5.1 steps 2–6 and 9
read — was **raised, accepted in full, and closed** under coordinator ruling CR3: CE1 widened
rather than CE3 forking, and this plan is written against the amended shapes throughout, with
CE1's three corrections applied (`0x` state commitments vs `sha256:` content digests; the
`accounts` / `codeEntries` / `storageSlots` vocabulary used end to end; optional `report` +
`VerifiedChainInstance`, with `materialization-report-absent` as an explicit check rather than a
non-null assertion). (e) CE1-F10 landed `MaterializationRequest.stateBackend` +
`requiresStateBackend`; the fail-closed rule and the never-read-`providerLocators` rule are
CE3's to enforce (T12, T14), along with CE4's point that `artifactEntries` must report what the
instance **loaded** rather than what the artifact declared. (f) Coordinator ruling **CR6** gives
CE3 the `abiRef+args` encoding (T13A). Nothing in this plan is left waiting on another
component.

**Ruling CR8 coverage.** The encoder is accepted with a condition, and both halves are in
T13A: an adversarial golden corpus enumerated case-by-case with expected calldata (empty array,
empty `bytes`, zero-length `string`, head/tail seam, dynamic flanked by statics, dynamic array
of dynamic members, max/min-width `uintN` / `intN`), and a differential suite against `ox` as a
test-only devDependency. The allowance is evidenced rather than asserted — `canonicalize` and
`ajv` are the standing precedent in the sibling `record` package, the production-externals
assertion scans production files only, and the dependency graph filters to `@jinn-network/`
names — and a component review is asked to verify those guard lines independently. The fallback
trigger is written as an instruction, not a hope: a disagreement stops the task and promotes
`ox` to a production dependency rather than adjusting the module or the corpus to agree.

**Ruling CR6 coverage.** (1) Structured reads are resolved to real calls in T13A —
encode, execute behind the runtime port, decode into the observation's `stateReads` projection
at CE2's `stateReadKey`. (2) Determinism: the key derivation and the encoding are pure
functions of the request, tested by a same-request-same-bytes property and pinned by a golden
vector corpus, with a cross-package key-equivalence fixture that CE5 asserts against CE2 —
because a key that differs by one character makes the pure evaluator report `unevaluable` for a
read that actually happened. (3) `state: "baseline" | "post-replay"` is honoured by
construction: baseline reads execute on the freshly materialized world *before* any probe or
replay operation, which is the mechanism enforcing the design's pre-replay ground-truth rule for
`reportedValue`, and a mis-tag is a test failure rather than a silent re-opening of the gaming
case §6.2 closed.

**Placeholder scan.** No `TODO`, `FIXME`, `<name>`, or "implement this" appears in any code
block. Two constructs are deliberately shaped rather than literal, and both are gated: (a)
`src/conformance-records.ts`'s two builders, whose literals must come from CE1's fixtures
because CE1 owns the field grammar — T10 step 2 states the completion condition and the branch
gate greps for `filled in step`; (b) `src/testing.ts`'s three fake factories, whose bodies are
mechanical and whose *assertions* are fully specified in T16 step 4. Eight golden attestations
are the only generated artifacts; T16 step 5 gives the exact generator, the exact command, and
the by-eye check per file before they are committed.

**Contracts that bite this component.** *Bounded claims* — a two-tier test (forbidden
absolutes; `verified`/`proven` only on lines that name what bounds them) over source, scripts,
fixtures, README, and the caveats note, plus a README assertion for the exact bound sentence.
*Custody* — five injected deps plus one optional sixth; one argument-scoped filesystem file;
one opt-in process test file; no `process.env`, no `Date.now`, no ambient network identifier,
no Docker anywhere in source — the Anvil adapter holds a `ProcessHost` instead. *Digest
discipline* — two schemas that reject each other's form, the crossing functions as the only
sanctioned path, a cross-package equivalence check against CE1's `bareHexDigest`, and the
confusion fixture in both the unit tests and the fixture corpus. *Fixture keys* — a deny-list
test over the ten well-known development addresses and the dev mnemonic, plus a bare-32-byte-hex
scan, with §8's bait-hazard reasoning stated at the site. *Fakes not Docker* — the kit's eight
scenarios run against a scripted runtime; the single Anvil suite is out of the default project
and skips cleanly. *§10 verified, not assumed* — T17 measures and `supportedControls` carries
the result, so a control the pinned version cannot apply fails step 3 instead of appearing in
a signed attestation.
