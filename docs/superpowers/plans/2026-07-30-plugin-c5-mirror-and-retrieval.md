# C5 — Public-Corpus Mirror, Retrieval, and Trust Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give the runtime a local, always-available view of the public evidence plane and the ability to fetch exact bytes from it — with untrusted content gated before it can influence anything. When this lands, `plugin/runtime` can follow a set of announced archives, mirror what they announce into a local SQLite catalog and object store, refuse anything whose producer is not admitted by trust policy, and hand C6 a paged, already-filtered enumeration to rank.

**Architecture:** three layers, each fail-closed, stacked so that no untrusted byte reaches ranking un-gated.

1. **Acquisition.** `@jinn-network/record-discovery-client`'s chain walk (`coldSync` / `returningSync`) reads announcement entries from a followed archive against a durable high-water mark. The walk runs under an **exclusive advisory lock with skip-if-held**, so N concurrent runtime instances never contend.
2. **Admission.** Chain verification, then source (announcer) admission at the announcement boundary, then producer admission at the read boundary. Each rejection **excludes**; there is no permissive default anywhere in the construction path.
3. **Materialization and reading.** Admitted announcements go through `@jinn-network/evidence-discovery`'s `createEvidenceIndexer`, which fetches the record bytes through a **mirroring repository** (local first, upstream on miss, digest-validated, written back), validates them against `evidence/protocol`, and projects them into an `@jinn-network/evidence-catalog-sqlite` catalog. The read surface serves that catalog and nothing else.

The load-bearing structural property: **`CorpusReader` has no sync method and holds no reference to `CorpusMirror`.** Cross-plan contract 5 ("mirror sync never blocks pickup") is enforced by the type, not by a convention a caller can forget. A caller literally cannot await a sync from the read path.

The second structural property: **there is no permissive admission factory.** `composeAdmission()` with no parts rejects; a runtime with no trust policy configured admits no producer. Rejection is fail-closed; plain *absence* of results stays fail-open — an empty page and work proceeds.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:` resolution); zod 4.4.3; `better-sqlite3` 13.0.1; vitest 4.

---

## Stacked-PR discipline

- **Branch:** `plugin/c5-mirror-and-retrieval`
- **Base branch:** `plugin/c3-product-tree`
- Every PR in this train targets `plugin/c3-product-tree`, **never** `integration/evidence-v1`. The base merges upward on its own train.
- No agent self-merge. Independent per-component review before C6 builds on this.

### Consumes (by providing branch)

| Symbol | From | Providing branch |
| --- | --- | --- |
| `RuntimeConfig`, `RuntimeConfigSource`, `resolveRuntimeConfig` | `plugin/runtime/src/config.ts` | **`plugin/c3-product-tree`** |
| `PluginRuntimeError`, `RUNTIME_ERROR_CODES` | `plugin/runtime/src/errors.ts` | **`plugin/c3-product-tree`** |
| `HealthCheck`, `HealthReport` | `plugin/runtime/src/health.ts` | **`plugin/c3-product-tree`** |
| `RuntimeLogger` | `plugin/runtime/src/logger.ts` | **`plugin/c3-product-tree`** |
| `RuntimeCapability`, `CapabilityContext` | `plugin/runtime/src/capability.ts` | **`plugin/c3-product-tree`** |
| the guard trio + `plugin-tree-ci.yml` | `.github/scripts/plugin-tree-*.test.mjs` | **`plugin/c3-product-tree`** |
| everything under `@jinn-network/{record-discovery-*,evidence-*,trust-*}` | `packages/` | **`integration/evidence-v1`** (already merged, PR #2292) |

Nothing here consumes C4. C4 (`plugin/c4-capture`) is a sibling on the same base.

### File ownership — how C4 and C5 merge cleanly at C6

| Path | Owner |
| --- | --- |
| `plugin/runtime/src/corpus/**` | **C5, exclusively** |
| `plugin/runtime/src/capture/**` | C4, exclusively |
| `plugin/runtime/src/config.ts` | **shared** — C3 authored it; C4 and C5 each append one config block + one `RuntimeConfig` field group |
| `plugin/runtime/src/index.ts` | **shared** — C4 and C5 each append one `export * from "./<component>/index.js";` line |
| `plugin/runtime/package.json` | **shared** — each appends dependency + resolution entries |
| `.github/scripts/plugin-tree-package-inventory.test.mjs` | **shared** — each appends its dependency-graph rows |
| `.github/scripts/plugin-tree-guard-common.mjs` | **shared** — each extends the closed-world `APPROVED_RUNTIME_*` maps (C3 R-C3-63/64; finding C5-P2) |

Every shared file is **append-only** for both components: C4 and C5 add distinct, non-overlapping blocks at the end of the relevant object/array. Merging C4 into C5's head at C6 is a mechanical union in the shared files. Task 1 places C5's config block after a `// --- C5: public-corpus mirror ---` banner comment so the union point is unambiguous.

**C5 owns no `plugin/runtime/src/relevance/**` file.** C6 declares `EvidencePlane`; C5 tags candidates with the string literal `"public"`, which is assignable to it without an adapter and without a reverse dependency.

### Restacking

`plugin/c3-product-tree` is squash-merged when its own train lands, so its commits do not survive by hash and `git rebase` onto the new base will replay C5's commits against a base that already contains their content in squashed form. Use `--onto`:

```bash
git fetch origin
# BEFORE the base is squash-merged, record the base tip C5 branched from:
git rev-parse origin/plugin/c3-product-tree   # save as <old-base>
# AFTER the base is squash-merged into integration/evidence-v1:
git rebase --onto origin/integration/evidence-v1 <old-base> plugin/c5-mirror-and-retrieval
```

**Coherence check after any restack** — all four must hold before pushing:

```bash
cd plugin/runtime && yarn install && yarn typecheck && yarn test
node --test ../../.github/scripts/plugin-tree-package-inventory.test.mjs
node --test ../../.github/scripts/plugin-tree-source-boundaries.test.mjs
git diff --stat origin/integration/evidence-v1...HEAD -- plugin/runtime/src/corpus
```

The last command must list **only** files under `plugin/runtime/src/corpus/` plus the four shared files above. Anything else means the rebase pulled in base content as C5 changes — reset and redo with the correct `<old-base>`.

---

## Global constraints

- Node `>=22`; `"type": "module"`; **every relative import carries the `.js` extension**.
- **No `process.env` anywhere under `plugin/runtime/src/`** except `src/bin.ts` (C3's boundary guard). C5 reads no environment variable at all — see Task 1's deliberate hardening.
- **No `localeCompare`, no `toLocale*`, no `Intl`** in production source. Sort with a code-unit comparator.
- **stdout is reserved** for the future MCP stdio transport. All diagnostics go through the injected `RuntimeLogger`.
- The frozen trio (`@jinn-network/core`, `@jinn-network/plugin`, `@jinn-network/jinn-layer`) is unimportable; so are `client`, `sdk`, `autopilot`, `indexer*`, `evidence-publication`, `evidence-contribution`, `viem`, and the `marketplace-*` / `benchmarking-*` / `task-execution-*` families.
- **Custody law C1–C5:** no key material in any parameter position; no ambient authority acquisition; DSSE verification is an **injected port**, never implemented here; the package carries npm trusted-publisher provenance (C3 already set `publishConfig`).
- Every task ends with `yarn typecheck && yarn test` in `plugin/runtime`, outputs shown.
- A wrong or ambiguous design discovered here is a **finding with a proposed disposition** (Findings section), never a silent patch.

---

## File structure

All paths relative to `plugin/runtime/`.

| File | Responsibility |
| --- | --- |
| `src/corpus/errors.ts` | `CorpusMirrorError` + its code constants |
| `src/corpus/order.ts` | `compareCodeUnitStrings` — the locale-free comparator |
| `src/corpus/high-water-mark.ts` | durable file-backed `HighWaterMarkStore` |
| `src/corpus/lock.ts` | `tryAcquireSyncLock` — exclusive, **skip-if-held** |
| `src/corpus/admission.ts` | `CorpusAdmission`, trust-policy producer admission, followed-source admission, composition — all fail-closed |
| `src/corpus/chain-verification.ts` | `ChainVerification` port + driver-backed and rejecting implementations |
| `src/corpus/announcements.ts` | discovery `AnnouncementEntry` → `EvidenceRecordAnnouncement[]`, source admission applied |
| `src/corpus/repositories.ts` | serving-plane (read-only) repository, mirroring repository, `EvidenceRepositoryResolver` |
| `src/corpus/store.ts` | `openCorpusMirrorStore` — catalog + object store lifecycle |
| `src/corpus/mirror.ts` | `createCorpusMirror` — the sync loop |
| `src/corpus/read.ts` | `createCorpusReader` — **the C6 seam**; producer admission; no sync method |
| `src/corpus/retrieve.ts` | `createCorpusRetrieval` — exact-byte fetch + validation |
| `src/corpus/capability.ts` | `createCorpusCapability` — the `RuntimeCapability` C3's runtime starts |
| `src/corpus/index.ts` | the component barrel |
| `src/corpus/*.test.ts` | co-located tests |
| `fixtures/corpus/**` | fixture archive bytes for the integration test |

Files this plan also edits (append-only): `src/config.ts`, `src/index.ts`, `package.json`, `.github/scripts/plugin-tree-package-inventory.test.mjs`, `.github/scripts/plugin-tree-guard-common.mjs`, `.github/workflows/plugin-tree-ci.yml`.

---

### Task 1: Declare dependencies, extend the config surface, register the guards

**Files:**
- Modify: `plugin/runtime/package.json` (dependencies, resolutions)
- Modify: `plugin/runtime/src/config.ts` (append the C5 block)
- Create: `plugin/runtime/src/corpus/config.test.ts`
- Modify: `.github/scripts/plugin-tree-package-inventory.test.mjs`
- Modify: `.github/workflows/plugin-tree-ci.yml`

**Interfaces:**
- Consumes: `RuntimeConfig`, `RuntimeConfigSource`, `resolveRuntimeConfig` from `plugin/runtime/src/config.ts` (branch `plugin/c3-product-tree`); `PluginRuntimeError` from `plugin/runtime/src/errors.ts` (same branch).
- Produces: `interface MirrorSourceConfig { agent: string; name: string; servingRoot: string; archiveRootUrl: string; repositoryId: string }`; `interface CorpusTrustConfig { genesisDigest: string; policyDirectory: string; producerPurpose: string }`; `interface CorpusConfig { sources: readonly MirrorSourceConfig[]; maxEntriesPerSync: number; syncTimeoutMs: number; acknowledgeUnverifiedChain: boolean; trust?: CorpusTrustConfig }`; and four new `RuntimeConfig` fields — `mirrorCatalogPath`, `mirrorObjectsDirectory`, `mirrorLockPath`, `corpus`.

**The deliberate hardening in this task:** the set of followed archives and the trust genesis anchor are **file-configured only, never environment-settable**. C3's precedence is defaults < `file` < `env`; C5 declares no env key at all, and Task 1's test proves that setting a plausibly-named variable has no effect. Environment is ambient; custody law C2 forbids acquiring authority ambiently, and "which archives may inject content into my agent's context" is authority.

- [x] **Step 1: Write the failing test**

`src/corpus/config.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "../config.js";

const base = {
  env: {} as Readonly<Record<string, string | undefined>>,
  homeDirectory: "/home/agent/.jinn-plugin",
};

const source = () => ({
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
});

describe("corpus configuration", () => {
  test("defaults to following no archives and mirroring nothing", () => {
    const config = resolveRuntimeConfig(base);
    expect(config.corpus.sources).toEqual([]);
    expect(config.corpus.maxEntriesPerSync).toBe(500);
    expect(config.corpus.syncTimeoutMs).toBe(30_000);
    expect(config.corpus.acknowledgeUnverifiedChain).toBe(false);
    expect(config.corpus.trust).toBeUndefined();
  });

  test("derives the mirror paths from the home directory", () => {
    const config = resolveRuntimeConfig(base);
    expect(config.mirrorCatalogPath).toBe("/home/agent/.jinn-plugin/mirror/catalog.sqlite");
    expect(config.mirrorObjectsDirectory).toBe("/home/agent/.jinn-plugin/mirror/objects");
    expect(config.mirrorLockPath).toBe("/home/agent/.jinn-plugin/mirror-sync.lock");
  });

  test("accepts a followed archive from the config file", () => {
    const config = resolveRuntimeConfig({ ...base, file: { corpus: { sources: [source()] } } });
    expect(config.corpus.sources).toHaveLength(1);
    expect(config.corpus.sources[0]!.repositoryId).toBe("archive.test/attempts");
  });

  test("the environment cannot add, remove, or redirect a followed archive", () => {
    const config = resolveRuntimeConfig({
      ...base,
      env: {
        JINN_PLUGIN_CORPUS_SOURCES: JSON.stringify([source()]),
        JINN_PLUGIN_CORPUS_TRUST_GENESIS: `sha256:${"a".repeat(64)}`,
      },
      file: { corpus: { sources: [source()] } },
    });
    expect(config.corpus.sources).toHaveLength(1);
    expect(config.corpus.sources[0]!.servingRoot).toBe("https://archive.test");
    expect(config.corpus.trust).toBeUndefined();
  });

  test("rejects a non-https serving root", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { sources: [{ ...source(), servingRoot: "http://archive.test" }] } },
      }),
    ).toThrow(/https/);
  });

  test("rejects a source name outside the record-discovery grammar", () => {
    expect(() =>
      resolveRuntimeConfig({ ...base, file: { corpus: { sources: [{ ...source(), name: "Attempts" }] } } }),
    ).toThrow(/source-name/);
  });

  test("rejects two sources sharing one repository id", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { sources: [source(), { ...source(), name: "evaluations" }] } },
      }),
    ).toThrow(/repository id/);
  });

  test("rejects the same archive followed twice", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: {
          corpus: { sources: [source(), { ...source(), repositoryId: "archive.test/attempts-2" }] },
        },
      }),
    ).toThrow(/followed twice/);
  });

  test("accepts a trust configuration and defaults the producer purpose", () => {
    const config = resolveRuntimeConfig({
      ...base,
      file: {
        corpus: { trust: { genesisDigest: `sha256:${"b".repeat(64)}`, policyDirectory: "policy" } },
      },
    });
    expect(config.corpus.trust?.producerPurpose).toBe("jinn:corpus-producer");
    expect(config.corpus.trust?.policyDirectory).toBe("/home/agent/.jinn-plugin/policy");
  });

  test("rejects a malformed genesis digest", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        file: { corpus: { trust: { genesisDigest: "not-a-digest", policyDirectory: "policy" } } },
      }),
    ).toThrow();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/config.test.ts`
Expected: FAIL — `config.corpus` is `undefined`, so the first assertion throws `TypeError: Cannot read properties of undefined (reading 'sources')`.

- [x] **Step 3: Append the C5 block to `src/config.ts`**

**First (finding C5-P1):** extend C3's `RuntimeConfigFileSchema` so a file document that
carries `corpus` is not rejected by `z.strictObject` before corpus resolution runs.
Keep corpus *validation* out of this schema — only admit the key:

```ts
export const RuntimeConfigFileSchema = z.strictObject({
  home: z.string().min(1).optional(),
  logLevel: LogLevelSchema.optional(),
  /** C5 — opaque here; `resolveCorpusConfig` owns validation (file-only authority). */
  corpus: z.unknown().optional(),
});
```

Then insert immediately before the existing `resolveRuntimeConfig` export:

```ts
// --- C5: public-corpus mirror -------------------------------------------
//
// The set of followed archives and the trust genesis anchor are FILE-ONLY.
// C5 declares no environment key: "which archives may inject content into
// this agent's context" is authority, and custody law C2 forbids acquiring
// authority ambiently. An operator changes what is followed by editing the
// config document, which is reviewable and diffable; an environment
// variable is neither.

/**
 * A local copy of `SOURCE_NAME_GRAMMAR` from
 * `@jinn-network/record-discovery-protocol/src/identifiers.ts`. Copied
 * rather than imported so this module stays dependency-pure per C3's
 * contract; `src/corpus/announcements.test.ts` asserts the two are equal,
 * so a drift upstream fails the build rather than silently diverging.
 */
const SOURCE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const HttpsUrlSchema = z.string().refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an absolute https URL" },
);

const MirrorSourceConfigSchema = z.strictObject({
  agent: z.string().min(1),
  name: z.string().regex(SOURCE_NAME_PATTERN, "must match the record-discovery source-name grammar"),
  servingRoot: HttpsUrlSchema,
  archiveRootUrl: HttpsUrlSchema,
  repositoryId: z.string().min(1),
});

const CorpusTrustConfigSchema = z.strictObject({
  genesisDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  policyDirectory: z.string().min(1),
  producerPurpose: z.string().min(1).default("jinn:corpus-producer"),
});

const CorpusConfigSchema = z.strictObject({
  sources: z.array(MirrorSourceConfigSchema).default([]),
  maxEntriesPerSync: z.number().int().positive().max(10_000).default(500),
  syncTimeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /**
   * Opt-in acknowledgement that this runtime mirrors without verifying
   * announcement-chain signatures (C5 Finding F1). Default `false` means the
   * mirror indexes nothing and says so in its health check — fail-closed.
   */
  acknowledgeUnverifiedChain: z.boolean().default(false),
  trust: CorpusTrustConfigSchema.optional(),
});

export type MirrorSourceConfig = z.infer<typeof MirrorSourceConfigSchema>;
export type CorpusTrustConfig = z.infer<typeof CorpusTrustConfigSchema>;
export type CorpusConfig = z.infer<typeof CorpusConfigSchema>;

function resolveCorpusConfig(file: unknown, homeDirectory: string): CorpusConfig {
  const raw = (file as { readonly corpus?: unknown } | undefined)?.corpus;
  const parsed = CorpusConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      `corpus configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const byArchive = new Set<string>();
  const byRepository = new Set<string>();
  for (const source of parsed.data.sources) {
    const archive = `${source.agent}/${source.name}`;
    if (byArchive.has(archive)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `corpus archive ${archive} is followed twice.`,
      );
    }
    byArchive.add(archive);
    if (byRepository.has(source.repositoryId)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `corpus repository id ${source.repositoryId} is claimed by more than one archive.`,
      );
    }
    byRepository.add(source.repositoryId);
  }

  return {
    ...parsed.data,
    ...(parsed.data.trust === undefined
      ? {}
      : {
          trust: {
            ...parsed.data.trust,
            policyDirectory: resolve(homeDirectory, parsed.data.trust.policyDirectory),
          },
        }),
  };
}
```

Then extend the `RuntimeConfig` interface with:

```ts
  /** C5 — the public-corpus mirror's own catalog, separate from `catalogPath`. */
  readonly mirrorCatalogPath: string;
  /** C5 — the public-corpus mirror's own object store, separate from `archiveDirectory`. */
  readonly mirrorObjectsDirectory: string;
  /** C5 — the exclusive advisory lock guarding mirror sync (cross-plan contract 5). */
  readonly mirrorLockPath: string;
  readonly corpus: CorpusConfig;
```

and extend the object `resolveRuntimeConfig` returns with:

```ts
    mirrorCatalogPath: join(homeDirectory, "mirror", "catalog.sqlite"),
    mirrorObjectsDirectory: join(homeDirectory, "mirror", "objects"),
    mirrorLockPath: join(homeDirectory, "mirror-sync.lock"),
    corpus: resolveCorpusConfig(source.file, homeDirectory),
```

Add `resolve` to the existing `node:path` import.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/config.test.ts && yarn typecheck`
Expected: PASS (10 tests).

- [x] **Step 5: Declare the dependencies**

In `plugin/runtime/package.json`, extend `dependencies`:

```json
    "@jinn-network/evidence-catalog-sqlite": "0.1.0",
    "@jinn-network/evidence-discovery": "0.1.0",
    "@jinn-network/evidence-protocol": "0.1.0",
    "@jinn-network/evidence-repository": "0.1.0",
    "@jinn-network/evidence-retrieval": "0.1.0",
    "@jinn-network/record-discovery-client": "0.1.0",
    "@jinn-network/record-discovery-protocol": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "better-sqlite3": "13.0.1"
```

and `resolutions`:

```json
    "@jinn-network/evidence-catalog-sqlite": "portal:../../packages/evidence/catalog-sqlite",
    "@jinn-network/evidence-discovery": "portal:../../packages/evidence/discovery",
    "@jinn-network/evidence-protocol": "portal:../../packages/evidence/protocol",
    "@jinn-network/evidence-repository": "portal:../../packages/evidence/repository",
    "@jinn-network/evidence-retrieval": "portal:../../packages/evidence/retrieval",
    "@jinn-network/record-discovery-client": "portal:../../packages/discovery/client",
    "@jinn-network/record-discovery-protocol": "portal:../../packages/discovery/protocol",
    "@jinn-network/trust-core": "portal:../../packages/trust/core"
```

Add `"@types/better-sqlite3": "7.6.11"` to `devDependencies` (**exact** pin — no `^`;
C3 closed-world maps reject range specs; finding C5-P2).

- [x] **Step 6: Register the dependency graph and closed-world approved maps**

In `.github/scripts/plugin-tree-package-inventory.test.mjs`, extend the `JINN_DEPENDENCY_GRAPH` row for `'runtime'` with the eight `@jinn-network/*` names above, keeping the array sorted.

**Also (finding C5-P2 — C3 R-C3-63/64):** edit `.github/scripts/plugin-tree-guard-common.mjs` so the closed-world exact maps match the new package.json. Updating only `JINN_DEPENDENCY_GRAPH` is not enough — source-boundaries and inventory call `validateExactDependencySections` / `undeclaredDependencies` / `resolutionViolations` against these maps:

1. `APPROVED_RUNTIME_DEPENDENCIES` — keep `zod: '4.4.3'`; add `better-sqlite3: '13.0.1'` and each of the eight `@jinn-network/*` packages at `'0.1.0'`.
2. `APPROVED_RUNTIME_DEV_DEPENDENCIES` — add `'@types/better-sqlite3': '7.6.11'` (exact).
3. `APPROVED_RUNTIME_RESOLUTIONS` — keep `vite: '6.4.3'`; add the eight `portal:../../packages/...` entries exactly as declared in `package.json` `resolutions`.

No allowlist edit is needed: C3's `SIBLING_TREE_DIRS` and `PERMITTED_PACKAGES` pre-seed all eight, including `@jinn-network/evidence-discovery` (added by C3 correction 2). **Name-collision caution for every later task:** `@jinn-network/evidence-discovery` (`packages/evidence/discovery` — the *catalog* contract) is a different package from the `@jinn-network/record-discovery-*` family (`packages/discovery/*` — the *announcement* protocol and client). The mirror reads from `record-discovery-client` and writes into a catalog typed by `evidence-discovery`.

- [x] **Step 7: Install and run both guards**

```bash
cd plugin/runtime && yarn install && cd ../..
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```
Expected: both PASS.

- [x] **Step 8: Add the portal build steps to CI**

In `.github/workflows/plugin-tree-ci.yml`, in the `runtime` job's "Build cross-tree portal dependencies from source" step, append one build per new portal dependency in dependency order (`trust/core`, `discovery/protocol`, `discovery/client`, `evidence/protocol`, `evidence/repository`, `evidence/discovery`, `evidence/catalog-sqlite`, `evidence/retrieval`):

```yaml
          for pkg in trust/core discovery/protocol discovery/client \
                     evidence/protocol evidence/repository evidence/discovery \
                     evidence/catalog-sqlite evidence/retrieval; do
            (cd "packages/$pkg" && yarn install --immutable && yarn build)
          done
```

- [x] **Step 9: Commit**

```bash
git add plugin/runtime/package.json plugin/runtime/yarn.lock plugin/runtime/src/config.ts \
        plugin/runtime/src/corpus/config.test.ts \
        .github/scripts/plugin-tree-package-inventory.test.mjs \
        .github/scripts/plugin-tree-guard-common.mjs \
        .github/workflows/plugin-tree-ci.yml
git commit -m "feat(plugin-runtime): declare the corpus mirror's stack dependencies and file-only source configuration"
```

---

### Task 2: Errors and the locale-free comparator

**Files:**
- Create: `plugin/runtime/src/corpus/errors.ts`, `src/corpus/order.ts`, `src/corpus/errors.test.ts`

**Interfaces:**
- Consumes: `PluginRuntimeError` from `plugin/runtime/src/errors.ts` (branch `plugin/c3-product-tree`).
- Produces: `class CorpusMirrorError extends PluginRuntimeError` with `readonly code: string` and `readonly cause?: unknown`; `const CORPUS_ERROR_CODES` (frozen); `compareCodeUnitStrings(left: string, right: string): number`.

- [x] **Step 1: Write the failing test**

`src/corpus/errors.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "../errors.js";
import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

describe("corpus errors", () => {
  test("subclasses the runtime error so callers can catch one type", () => {
    const error = new CorpusMirrorError(CORPUS_ERROR_CODES.syncLockIo, "lock unavailable");
    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect(error.name).toBe("CorpusMirrorError");
    expect(error.code).toBe("corpus-sync-lock-io");
  });

  test("carries a cause without losing the message", () => {
    const cause = new Error("EACCES");
    const error = new CorpusMirrorError(CORPUS_ERROR_CODES.mirrorStoreIo, "cannot open", { cause });
    expect(error.message).toBe("cannot open");
    expect(error.cause).toBe(cause);
  });

  test("every code is namespaced so it never collides with a C3 or C4 code", () => {
    for (const code of Object.values(CORPUS_ERROR_CODES)) {
      expect(code.startsWith("corpus-")).toBe(true);
    }
  });

  test("the codes object is frozen", () => {
    expect(Object.isFrozen(CORPUS_ERROR_CODES)).toBe(true);
  });
});

describe("compareCodeUnitStrings", () => {
  test("orders by UTF-16 code unit, not by locale", () => {
    expect(compareCodeUnitStrings("Z", "a")).toBe(-1);
    expect(compareCodeUnitStrings("a", "a")).toBe(0);
    expect(compareCodeUnitStrings("b", "a")).toBe(1);
  });

  test("sorts a key list deterministically", () => {
    expect(["b", "ä", "Z", "a"].sort(compareCodeUnitStrings)).toEqual(["Z", "a", "b", "ä"]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors.js"` from `src/corpus/errors.test.ts`.

- [x] **Step 3: Write the implementation**

`src/corpus/order.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * Compares by UTF-16 code unit. `localeCompare` and `Intl` are banned in
 * production source under `plugin/runtime/src/`; see
 * `.github/scripts/plugin-tree-source-boundaries.test.mjs`.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
```

`src/corpus/errors.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { PluginRuntimeError } from "../errors.js";

/**
 * C3 declares `PluginRuntimeError.code` as a plain string precisely so a
 * component can add codes without editing a closed union. Every C5 code is
 * `corpus-`-prefixed so it never collides with C3's or C4's.
 */
export const CORPUS_ERROR_CODES = Object.freeze({
  syncLockIo: "corpus-sync-lock-io",
  highWaterMarkIo: "corpus-high-water-mark-io",
  highWaterMarkCorrupt: "corpus-high-water-mark-corrupt",
  mirrorStoreIo: "corpus-mirror-store-io",
  recordDigestMismatch: "corpus-record-digest-mismatch",
  repositoryReadOnly: "corpus-repository-read-only",
  sourceMismatch: "corpus-source-mismatch",
} as const);

export type CorpusErrorCode = (typeof CORPUS_ERROR_CODES)[keyof typeof CORPUS_ERROR_CODES];

export class CorpusMirrorError extends PluginRuntimeError {
  override readonly cause?: unknown;

  constructor(code: CorpusErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(code, message);
    this.name = "CorpusMirrorError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Extracts a Node `error.code` without widening the type of an unknown throw. */
export function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/errors.test.ts && yarn typecheck`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): corpus error codes and the locale-free comparator"
```

---

### Task 3: The durable high-water-mark store

**Files:**
- Create: `plugin/runtime/src/corpus/high-water-mark.ts`, `src/corpus/high-water-mark.test.ts`

**Interfaces:**
- Consumes: `HighWaterMark`, `HighWaterMarkStore`, `SourceIdentity` from `@jinn-network/record-discovery-protocol` (frozen at `packages/discovery/protocol/src/verify/ports.ts:73-81` — `HighWaterMark extends SourceCursor` adding `issuedAt`, and `HighWaterMarkStore` is `{ get(source): Promise<HighWaterMark | undefined>; put(source, mark): Promise<void> }`); `CorpusMirrorError` (Task 2).
- Produces: `createFileHighWaterMarkStore(options: { readonly filePath: string }): HighWaterMarkStore`; `const HIGH_WATER_MARK_FORMAT`.

`packages/discovery/client/src/high-water-mark.ts:17-18` ships only an in-memory store and says so: *"Positions are lost on process exit -- suitable for tests and short-lived processes only."* A session-scoped runtime that re-cold-syncs every session would storm the archive; this is the durable implementation of the same frozen port.

- [x] **Step 1: Write the failing test**

`src/corpus/high-water-mark.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CorpusMirrorError } from "./errors.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";

const alice = { agent: "https://agents.test/alice", name: "attempts" };
const bob = { agent: "https://agents.test/bob", name: "attempts" };

const mark = (sequence: string) => ({
  sequence,
  entry: `sha256:${"a".repeat(64)}` as const,
  issuedAt: "2026-07-30T00:00:00Z",
});

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-hwm-"));
  filePath = join(directory, "state", "mirror-state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file-backed high-water-mark store", () => {
  test("returns undefined for a source it has never seen", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    expect(await store.get(alice)).toBeUndefined();
  });

  test("survives process restart — a second store instance reads the mark", async () => {
    const first = createFileHighWaterMarkStore({ filePath });
    await first.put(alice, mark("0000000000000007"));

    const second = createFileHighWaterMarkStore({ filePath });
    expect(await second.get(alice)).toEqual(mark("0000000000000007"));
  });

  test("keys by (agent, name) so two agents' sources do not collide", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(alice, mark("0000000000000001"));
    await store.put(bob, mark("0000000000000009"));

    const reopened = createFileHighWaterMarkStore({ filePath });
    expect((await reopened.get(alice))?.sequence).toBe("0000000000000001");
    expect((await reopened.get(bob))?.sequence).toBe("0000000000000009");
  });

  test("overwrites an existing mark in place", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(alice, mark("0000000000000001"));
    await store.put(alice, mark("0000000000000002"));
    expect((await createFileHighWaterMarkStore({ filePath }).get(alice))?.sequence).toBe(
      "0000000000000002",
    );
  });

  test("writes the state file owner-only", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(alice, mark("0000000000000001"));
    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writes keys in code-unit order so the file diffs cleanly", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(bob, mark("0000000000000001"));
    await store.put(alice, mark("0000000000000001"));
    const body = await readFile(filePath, "utf8");
    expect(body.indexOf("alice")).toBeLessThan(body.indexOf("bob"));
  });

  test("refuses a corrupt state file rather than silently cold-syncing from genesis", async () => {
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(alice, mark("0000000000000001"));
    await writeFile(filePath, "{ not json", "utf8");

    const reopened = createFileHighWaterMarkStore({ filePath });
    await expect(reopened.get(alice)).rejects.toBeInstanceOf(CorpusMirrorError);
  });

  test("refuses a structurally invalid state file", async () => {
    await writeFile(filePath.replace(/[^/]+$/u, ""), "", "utf8").catch(() => undefined);
    const store = createFileHighWaterMarkStore({ filePath });
    await store.put(alice, mark("0000000000000001"));
    await writeFile(filePath, JSON.stringify({ format: "wrong", marks: {} }), "utf8");

    await expect(createFileHighWaterMarkStore({ filePath }).get(alice)).rejects.toBeInstanceOf(
      CorpusMirrorError,
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/high-water-mark.test.ts`
Expected: FAIL — `Failed to resolve import "./high-water-mark.js"`.

- [x] **Step 3: Write the implementation**

`src/corpus/high-water-mark.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  HighWaterMark,
  HighWaterMarkStore,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import { z } from "zod";

import { CORPUS_ERROR_CODES, CorpusMirrorError, describeError, nodeErrorCode } from "./errors.js";
import { compareCodeUnitStrings } from "./order.js";

export const HIGH_WATER_MARK_FORMAT = "jinn-corpus-mirror-high-water-marks/1" as const;

const HighWaterMarkSchema = z.strictObject({
  sequence: z.string().regex(/^[0-9]{16}$/),
  entry: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  issuedAt: z.string().min(1),
});

const StateFileSchema = z.strictObject({
  format: z.literal(HIGH_WATER_MARK_FORMAT),
  marks: z.record(z.string(), HighWaterMarkSchema),
});

function sourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/**
 * A durable `HighWaterMarkStore`. `record-discovery-client` ships only an
 * in-memory implementation and documents it as unsuitable for anything but
 * short-lived processes; a session-scoped runtime that lost its position
 * every session would cold-sync every followed archive on every start.
 *
 * A corrupt or structurally invalid state file is an ERROR, not an absent
 * mark. Treating corruption as "never synced" would silently replay every
 * archive from genesis — a quiet, expensive failure mode. Because sync
 * failure never reaches the read path (see `read.ts`), failing loudly here
 * degrades relevance, never availability.
 */
export function createFileHighWaterMarkStore(options: {
  readonly filePath: string;
}): HighWaterMarkStore {
  let cache: Map<string, HighWaterMark> | undefined;

  async function load(): Promise<Map<string, HighWaterMark>> {
    if (cache !== undefined) return cache;

    let text: string;
    try {
      text = await readFile(options.filePath, "utf8");
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        cache = new Map();
        return cache;
      }
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkIo,
        `Unable to read the mirror state file at ${options.filePath}.`,
        { cause: error },
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkCorrupt,
        `The mirror state file at ${options.filePath} is not valid JSON: ${describeError(error)}`,
        { cause: error },
      );
    }

    const parsed = StateFileSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkCorrupt,
        `The mirror state file at ${options.filePath} is not a recognized ${HIGH_WATER_MARK_FORMAT} document.`,
      );
    }

    cache = new Map(Object.entries(parsed.data.marks) as [string, HighWaterMark][]);
    return cache;
  }

  async function persist(marks: ReadonlyMap<string, HighWaterMark>): Promise<void> {
    const ordered: Record<string, HighWaterMark> = {};
    for (const key of [...marks.keys()].sort(compareCodeUnitStrings)) {
      ordered[key] = marks.get(key)!;
    }
    const body = `${JSON.stringify({ format: HIGH_WATER_MARK_FORMAT, marks: ordered }, null, 2)}\n`;

    const temporaryPath = `${options.filePath}.${String(process.pid)}.tmp`;
    try {
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
      await unlink(temporaryPath).catch(() => undefined);
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, options.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new CorpusMirrorError(
        CORPUS_ERROR_CODES.highWaterMarkIo,
        `Unable to write the mirror state file at ${options.filePath}.`,
        { cause: error },
      );
    }
  }

  return {
    async get(source: SourceIdentity): Promise<HighWaterMark | undefined> {
      return (await load()).get(sourceKey(source));
    },
    async put(source: SourceIdentity, value: HighWaterMark): Promise<void> {
      const marks = await load();
      marks.set(sourceKey(source), value);
      await persist(marks);
    },
  };
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/high-water-mark.test.ts && yarn typecheck`
Expected: PASS (8 tests).

- [x] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): durable file-backed high-water-mark store for corpus sync"
```

---

### Task 4: The exclusive advisory sync lock, skip-if-held

**Files:**
- Create: `plugin/runtime/src/corpus/lock.ts`, `src/corpus/lock.test.ts`

**Interfaces:**
- Consumes: `CorpusMirrorError`, `nodeErrorCode` (Task 2); `better-sqlite3`.
- Produces: `interface CorpusSyncLock { close(): Promise<void> }`; `tryAcquireSyncLock(path: string): Promise<CorpusSyncLock | undefined>`; `const CORPUS_SYNC_LOCK_FORMAT`.

This is cross-plan contract 5's mechanism. The stack's precedent is `packages/evidence/local-runtime/src/lock.ts:36-48`, which takes the same SQLite `locking_mode = EXCLUSIVE` + `BEGIN EXCLUSIVE` lock — but that one **retries three times and then throws `ROOT_IN_USE`** (`lock.ts:24`, `:73-84`), because a local runtime that cannot open its root has failed. A mirror sync that cannot get the lock has **not** failed: another instance is already doing the work. So this variant does not retry and does not throw — it returns `undefined`, and the caller reports `skipped-locked`.

- [x] **Step 1: Write the failing test**

`src/corpus/lock.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CORPUS_SYNC_LOCK_FORMAT, tryAcquireSyncLock } from "./lock.js";

let directory: string;
let lockPath: string;
let child: ChildProcess | undefined;

const HOLDER_SCRIPT = `
const Database = require('better-sqlite3');
const database = new Database(process.argv[1], { timeout: 0 });
database.pragma('busy_timeout = 0');
database.pragma('locking_mode = EXCLUSIVE');
database.exec('CREATE TABLE IF NOT EXISTS corpus_sync_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL)');
database.prepare('INSERT INTO corpus_sync_lock(singleton, format) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING').run(process.argv[2]);
database.exec('BEGIN EXCLUSIVE');
database.prepare('UPDATE corpus_sync_lock SET format = format WHERE singleton = 1').run();
process.stdout.write('held\\n');
setInterval(() => {}, 60000);
`;

async function startHolder(path: string): Promise<ChildProcess> {
  const process_ = spawn(
    process.execPath,
    ["-e", HOLDER_SCRIPT, path, CORPUS_SYNC_LOCK_FORMAT],
    { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("holder did not report")), 15_000);
    process_.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("held")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    process_.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  return process_;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-lock-"));
  lockPath = join(directory, "nested", "mirror-sync.lock");
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe("mirror sync lock", () => {
  test("acquires when free", async () => {
    const lock = await tryAcquireSyncLock(lockPath);
    expect(lock).toBeDefined();
    await lock!.close();
  });

  test("creates the lock file owner-only, making its parent directory", async () => {
    const lock = await tryAcquireSyncLock(lockPath);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    await lock!.close();
  });

  test("SKIPS rather than waits when already held in this process", async () => {
    const first = await tryAcquireSyncLock(lockPath);
    expect(first).toBeDefined();

    const started = Date.now();
    const second = await tryAcquireSyncLock(lockPath);
    const elapsed = Date.now() - started;

    expect(second).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);

    await first!.close();
  });

  test("SKIPS rather than waits when held by another process", async () => {
    const lock = await tryAcquireSyncLock(lockPath);
    await lock!.close();

    child = await startHolder(lockPath);

    const started = Date.now();
    const attempt = await tryAcquireSyncLock(lockPath);
    const elapsed = Date.now() - started;

    expect(attempt).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
  });

  test("becomes acquirable again once the holder releases", async () => {
    const first = await tryAcquireSyncLock(lockPath);
    await first!.close();
    const second = await tryAcquireSyncLock(lockPath);
    expect(second).toBeDefined();
    await second!.close();
  });

  test("close is idempotent", async () => {
    const lock = await tryAcquireSyncLock(lockPath);
    await lock!.close();
    await expect(lock!.close()).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/lock.test.ts`
Expected: FAIL — `Failed to resolve import "./lock.js"`.

- [x] **Step 3: Write the implementation**

`src/corpus/lock.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { CORPUS_ERROR_CODES, CorpusMirrorError, nodeErrorCode } from "./errors.js";

export const CORPUS_SYNC_LOCK_FORMAT = "jinn-corpus-mirror-sync-lock" as const;

export interface CorpusSyncLock {
  close(): Promise<void>;
}

function sqliteCode(error: unknown): string | undefined {
  return nodeErrorCode(error);
}

async function ensureLockFile(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.close();
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return;
    throw new CorpusMirrorError(
      CORPUS_ERROR_CODES.syncLockIo,
      `Unable to prepare the mirror sync lock at ${path}.`,
      { cause: error },
    );
  }
}

/**
 * Acquires the exclusive advisory lock guarding mirror sync, or returns
 * `undefined` when another instance already holds it (cross-plan contract 5).
 *
 * SKIP-IF-HELD, deliberately: the stack's precedent
 * (`packages/evidence/local-runtime/src/lock.ts`) retries three times and
 * then throws `ROOT_IN_USE`, because a local runtime that cannot open its
 * root has failed. A mirror sync that cannot take the lock has NOT failed —
 * a peer instance is already doing exactly this work — so waiting would
 * convert concurrency into latency for no benefit. `busy_timeout = 0` makes
 * SQLite report contention immediately rather than blocking.
 *
 * SQLite's unix VFS shares lock state across connections within one process,
 * so two instances in one process contend exactly as two processes do.
 */
export async function tryAcquireSyncLock(path: string): Promise<CorpusSyncLock | undefined> {
  await ensureLockFile(path);

  let database: Database.Database | undefined;
  try {
    database = new Database(path, { fileMustExist: true, timeout: 0 });
    database.pragma("busy_timeout = 0");
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec(
      "CREATE TABLE IF NOT EXISTS corpus_sync_lock (" +
        "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO corpus_sync_lock(singleton, format) VALUES (1, ?) " +
          "ON CONFLICT(singleton) DO NOTHING",
      )
      .run(CORPUS_SYNC_LOCK_FORMAT);
    database.exec("BEGIN EXCLUSIVE");
    database.prepare("UPDATE corpus_sync_lock SET format = format WHERE singleton = 1").run();

    let closed = false;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          database?.exec("ROLLBACK");
        } catch {
          // The lock is released by closing the connection regardless.
        } finally {
          database?.close();
          database = undefined;
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the acquisition failure.
    }
    if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(sqliteCode(error) ?? "")) return undefined;
    throw new CorpusMirrorError(
      CORPUS_ERROR_CODES.syncLockIo,
      `Unable to acquire the mirror sync lock at ${path}.`,
      { cause: error },
    );
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/lock.test.ts && yarn typecheck`
Expected: PASS (6 tests). The two skip tests must each report an elapsed time well under 1 s — that is the proof the lock skips rather than waits.

- [x] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): exclusive skip-if-held advisory lock for mirror sync"
```

---

### Task 5: Trust admission — fail-closed in both halves

**Files:**
- Create: `plugin/runtime/src/corpus/admission.ts`, `src/corpus/admission.test.ts`

**Interfaces:**
- Consumes: `SourceIdentity` from `@jinn-network/record-discovery-protocol`; `verifyPolicyChain`, `DsseChainVerifier`, `PolicyChainVerificationResult`, `Sha256Digest` from `@jinn-network/trust-core` (`packages/trust/core/src/policy.ts:250-256` — `verifyPolicyChain(versions: readonly Uint8Array[], options: VerifyPolicyChainOptions): PolicyChainVerificationResult`, where `VerifyPolicyChainOptions = { genesisAnchor: { digest }, now: string, dsseVerifier: DsseChainVerifier }`); `MirrorSourceConfig` (Task 1).
- Produces: `type AdmissionRejectionReason`; `type AdmissionDecision`; `interface CorpusAdmission { admitSource(source: SourceIdentity): AdmissionDecision; admitProducer(producerId: string): AdmissionDecision }`; `createFollowedSourceAdmission(sources): CorpusAdmission`; `createTrustPolicyAdmission(options: TrustPolicyAdmissionOptions): CorpusAdmission`; `createDeniedProducerAdmission(reason?): CorpusAdmission`; `composeAdmission(...parts): CorpusAdmission`; `const DEFAULT_CORPUS_PRODUCER_PURPOSE`.

Two custody-law points, both structural. **C1/C3:** `DsseChainVerifier` is an *injected port*, exactly as `trust-core` itself keeps it (`policy.ts:196-206` explains why: `did:key` is multicodec and the curve library is a stack-wide decision). C5 implements no cryptography and accepts no key material. **Fail-closed:** there is no permissive factory. `composeAdmission()` with zero parts rejects; a runtime with no trust configuration gets `createDeniedProducerAdmission()`.

`jinn:corpus-producer` is a namespaced extension purpose, which `TrustPolicySchema` explicitly admits (`policy.ts:37-42`: the pattern is `/^[a-z][a-z0-9-]*:[A-Za-z0-9-]+$/`, and the comment reads *"Deployments extend under their own namespaces"*).

- [ ] **Step 1: Write the failing test**

`src/corpus/admission.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import type { DsseChainVerifier } from "@jinn-network/trust-core";
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_CORPUS_PRODUCER_PURPOSE,
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
} from "./admission.js";

const alice = { agent: "https://agents.test/alice", name: "attempts" };
const mallory = { agent: "https://agents.test/mallory", name: "attempts" };

const source = {
  agent: alice.agent,
  name: alice.name,
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const GENESIS = `sha256:${"c".repeat(64)}` as const;
const alwaysValid: DsseChainVerifier = () => ({ validSignerKeyids: [] });

describe("followed-source admission", () => {
  test("admits a configured archive", () => {
    expect(createFollowedSourceAdmission([source]).admitSource(alice).status).toBe("admitted");
  });

  test("rejects an archive this runtime does not follow", () => {
    const decision = createFollowedSourceAdmission([source]).admitSource(mallory);
    expect(decision).toEqual({ status: "rejected", reason: "source-not-followed" });
  });

  test("rejects everything when no archive is configured", () => {
    expect(createFollowedSourceAdmission([]).admitSource(alice).status).toBe("rejected");
  });
});

describe("trust-policy producer admission — fail-closed", () => {
  const options = {
    genesisDigest: GENESIS,
    producerPurpose: DEFAULT_CORPUS_PRODUCER_PURPOSE,
    now: () => "2026-07-30T00:00:00Z",
    dsseVerifier: alwaysValid,
  };

  test("rejects every producer when no policy version is available", () => {
    const admission = createTrustPolicyAdmission({ ...options, policyVersions: [] });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-unavailable",
    });
  });

  test("rejects every producer when the chain does not verify", () => {
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new TextEncoder().encode("not a dsse envelope")],
    });
    expect(admission.admitProducer("https://agents.test/alice").status).toBe("rejected");
  });

  test("maps an expired policy to its own reason", () => {
    const verify = vi.fn(() => ({ ok: false, reason: "policy-expired" as const }));
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: verify,
    });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-expired",
    });
  });

  test("admits only a producer listed under the configured purpose", () => {
    const newest = {
      purposes: {
        [DEFAULT_CORPUS_PRODUCER_PURPOSE]: {
          accepted: ["https://agents.test/alice"],
          requiredStrength: "attested",
        },
      },
    };
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: () => ({ ok: true, newest } as never),
    });
    expect(admission.admitProducer("https://agents.test/alice").status).toBe("admitted");
    expect(admission.admitProducer("https://agents.test/mallory")).toEqual({
      status: "rejected",
      reason: "producer-not-listed",
    });
  });

  test("rejects when the configured purpose is absent from the policy", () => {
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: () => ({ ok: true, newest: { purposes: {} } } as never),
    });
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "producer-not-listed",
    });
  });

  test("verifies the chain once per clock reading, not once per producer", () => {
    const verify = vi.fn(() => ({ ok: true, newest: { purposes: {} } }) as never);
    const admission = createTrustPolicyAdmission({
      ...options,
      policyVersions: [new Uint8Array([1])],
      verifyChain: verify,
    });
    admission.admitProducer("a");
    admission.admitProducer("b");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  test("passes the injected verifier through and never verifies signatures itself", () => {
    const dsseVerifier = vi.fn(() => ({ validSignerKeyids: [] }));
    createTrustPolicyAdmission({
      ...options,
      dsseVerifier,
      policyVersions: [new TextEncoder().encode("x")],
    }).admitProducer("a");
    // The real verifyPolicyChain rejects the malformed envelope before it
    // reaches the verifier; the point under test is that C5 supplies no
    // cryptography of its own and holds no key material.
    expect(dsseVerifier.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("composition", () => {
  test("an empty composition admits nothing — there is no permissive default", () => {
    const admission = composeAdmission();
    expect(admission.admitSource(alice).status).toBe("rejected");
    expect(admission.admitProducer("anyone").status).toBe("rejected");
  });

  test("one rejection is enough to reject", () => {
    const admission = composeAdmission(
      createFollowedSourceAdmission([source]),
      createDeniedProducerAdmission(),
    );
    expect(admission.admitSource(alice).status).toBe("admitted");
    expect(admission.admitProducer("https://agents.test/alice")).toEqual({
      status: "rejected",
      reason: "policy-unavailable",
    });
  });

  test("returns the first rejection's reason, not a generic one", () => {
    const admission = composeAdmission(createFollowedSourceAdmission([source]));
    expect(admission.admitSource(mallory)).toEqual({
      status: "rejected",
      reason: "source-not-followed",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/admission.test.ts`
Expected: FAIL — `Failed to resolve import "./admission.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/admission.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";
import {
  verifyPolicyChain,
  type DsseChainVerifier,
  type PolicyChainVerificationResult,
  type Sha256Digest,
  type VerifyPolicyChainOptions,
} from "@jinn-network/trust-core";

import type { MirrorSourceConfig } from "../config.js";

/**
 * The purpose under which a trust policy lists agents whose records this
 * runtime will admit into an agent's context. A namespaced extension
 * purpose, which `TrustPolicySchema` explicitly admits alongside the nine
 * core purposes (`packages/trust/core/src/policy.ts:37-42`).
 */
export const DEFAULT_CORPUS_PRODUCER_PURPOSE = "jinn:corpus-producer" as const;

export type AdmissionRejectionReason =
  | "source-not-followed"
  | "producer-not-listed"
  | "policy-unavailable"
  | "policy-invalid"
  | "policy-expired";

export type AdmissionDecision =
  | { readonly status: "admitted" }
  | { readonly status: "rejected"; readonly reason: AdmissionRejectionReason };

export interface CorpusAdmission {
  admitSource(source: SourceIdentity): AdmissionDecision;
  admitProducer(producerId: string): AdmissionDecision;
}

const ADMITTED: AdmissionDecision = Object.freeze({ status: "admitted" });

function reject(reason: AdmissionRejectionReason): AdmissionDecision {
  return Object.freeze({ status: "rejected", reason });
}

function archiveKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

/** Admits exactly the archives this runtime is configured to follow. */
export function createFollowedSourceAdmission(
  sources: readonly MirrorSourceConfig[],
): CorpusAdmission {
  const followed = new Set(sources.map(archiveKey));
  return Object.freeze({
    admitSource(source: SourceIdentity): AdmissionDecision {
      return followed.has(archiveKey(source)) ? ADMITTED : reject("source-not-followed");
    },
    admitProducer(): AdmissionDecision {
      // Producer admission is not this half's concern; composition supplies it.
      return ADMITTED;
    },
  });
}

export type PolicyChainVerifier = (
  versions: readonly Uint8Array[],
  options: VerifyPolicyChainOptions,
) => PolicyChainVerificationResult;

export interface TrustPolicyAdmissionOptions {
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: Sha256Digest;
  readonly producerPurpose: string;
  readonly now: () => string;
  /** Injected per custody law C1/C3: C5 implements no cryptography. */
  readonly dsseVerifier: DsseChainVerifier;
  /** Seam for tests; production uses trust-core's own `verifyPolicyChain`. */
  readonly verifyChain?: PolicyChainVerifier;
}

/**
 * Producer admission over a hash-linked, dual-threshold-signed trust-policy
 * chain. Fail-closed at every branch: no policy, an unverifiable chain, an
 * expired chain, a missing purpose, and an unlisted producer all REJECT.
 * There is no code path through this function that admits by default.
 */
export function createTrustPolicyAdmission(
  options: TrustPolicyAdmissionOptions,
): CorpusAdmission {
  const verifyChain = options.verifyChain ?? verifyPolicyChain;
  let memo: { readonly now: string; readonly result: PolicyChainVerificationResult } | undefined;

  function currentPolicy(): PolicyChainVerificationResult {
    const now = options.now();
    if (memo !== undefined && memo.now === now) return memo.result;
    const result = verifyChain(options.policyVersions, {
      genesisAnchor: { digest: options.genesisDigest },
      now,
      dsseVerifier: options.dsseVerifier,
    });
    memo = { now, result };
    return result;
  }

  return Object.freeze({
    admitSource(): AdmissionDecision {
      // Source (announcer) admission is the followed-source half's concern.
      return ADMITTED;
    },
    admitProducer(producerId: string): AdmissionDecision {
      if (options.policyVersions.length === 0) return reject("policy-unavailable");

      const outcome = currentPolicy();
      if (!outcome.ok || outcome.newest === undefined) {
        return reject(outcome.reason === "policy-expired" ? "policy-expired" : "policy-invalid");
      }

      const entry = outcome.newest.purposes[options.producerPurpose];
      if (entry === undefined || !entry.accepted.includes(producerId)) {
        return reject("producer-not-listed");
      }
      return ADMITTED;
    },
  });
}

/**
 * The admission a runtime with no trust configuration gets. Named so the
 * absence of a policy is a visible construction choice rather than a
 * forgotten one; there is deliberately no `createOpenAdmission`.
 */
export function createDeniedProducerAdmission(
  reason: AdmissionRejectionReason = "policy-unavailable",
): CorpusAdmission {
  return Object.freeze({
    admitSource(): AdmissionDecision {
      return ADMITTED;
    },
    admitProducer(): AdmissionDecision {
      return reject(reason);
    },
  });
}

/**
 * Conjunction: every part must admit. An EMPTY composition rejects — the
 * fail-closed identity, not the fail-open one, so a wiring mistake that
 * drops every part denies rather than admits.
 */
export function composeAdmission(...parts: readonly CorpusAdmission[]): CorpusAdmission {
  if (parts.length === 0) {
    return Object.freeze({
      admitSource: (): AdmissionDecision => reject("source-not-followed"),
      admitProducer: (): AdmissionDecision => reject("policy-unavailable"),
    });
  }
  return Object.freeze({
    admitSource(source: SourceIdentity): AdmissionDecision {
      for (const part of parts) {
        const decision = part.admitSource(source);
        if (decision.status === "rejected") return decision;
      }
      return ADMITTED;
    },
    admitProducer(producerId: string): AdmissionDecision {
      for (const part of parts) {
        const decision = part.admitProducer(producerId);
        if (decision.status === "rejected") return decision;
      }
      return ADMITTED;
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/admission.test.ts && yarn typecheck`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): fail-closed source and producer admission over trust policy"
```

---

### Task 6: The chain-verification port

**Files:**
- Create: `plugin/runtime/src/corpus/chain-verification.ts`, `src/corpus/chain-verification.test.ts`

**Interfaces:**
- Consumes: `SyncedEntry`, `SyncedHead`, `VerifyDriver` from `@jinn-network/record-discovery-client` (`packages/discovery/client/src/verify-driver.ts:56-63` — `VerifyDriver.verifySource(opts: VerifySourceOptions): Promise<SourceChainOutcome>`, where `VerifySourceOptions = { source, head, headSignature, entries, firstAdoption }`); `SourceIdentity`, `SourceHead`, `SourceChainOutcome` from `@jinn-network/record-discovery-protocol`; `DsseEnvelope` from `@jinn-network/trust-core`.
- Produces: `type ChainVerificationOutcome`; `interface ChainVerificationInput`; `interface ChainVerification { readonly mode: "verified" | "unverified"; verify(input): Promise<ChainVerificationOutcome> }`; `createDriverChainVerification(driver: VerifyDriver): ChainVerification`; `createRejectingChainVerification(): ChainVerification`; `createUnverifiedChainVerification(acknowledgement: UnverifiedChainAcknowledgement): ChainVerification`.

`packages/discovery/client/src/sync.ts:16-19` states the boundary plainly: *"Linkage depth here is data acquisition only -- `verify-driver.ts` (Task 20) is what actually VERIFIES the walked chain … this module just fetches and parses the wire bytes."* A mirror built on `coldSync`/`returningSync` alone therefore verifies nothing. This task makes that fact a *typed, required decision at construction* instead of an omission nobody notices.

- [ ] **Step 1: Write the failing test**

`src/corpus/chain-verification.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import type { VerifyDriver } from "@jinn-network/record-discovery-client";
import { describe, expect, test, vi } from "vitest";

import {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
} from "./chain-verification.js";

const head = {
  protocol: "https://jinn.network/record-discovery/1.0",
  origin: "https://agents.test/alice/attempts",
  sequence: "0000000000000003",
  entry: `sha256:${"a".repeat(64)}` as const,
  issuedAt: "2026-07-30T00:00:00Z",
  refreshBy: "2026-08-30T00:00:00Z",
};

const envelope = { payloadType: "x", payload: "e30=", signatures: [] } as never;

const input = {
  source: { agent: "https://agents.test/alice", name: "attempts" },
  head,
  headSignature: envelope,
  entries: [],
  firstAdoption: true,
};

describe("rejecting chain verification (the default)", () => {
  test("rejects everything and reports its mode", async () => {
    const verification = createRejectingChainVerification();
    expect(verification.mode).toBe("unverified");
    await expect(verification.verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "chain-verification-not-configured",
    });
  });
});

describe("acknowledged unverified chain verification", () => {
  test("admits only when the exact acknowledgement is supplied", async () => {
    const verification = createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT);
    expect(verification.mode).toBe("unverified");
    await expect(verification.verify(input)).resolves.toEqual({ status: "ok" });
  });
});

describe("driver-backed chain verification", () => {
  test("reports verified mode and passes the head, signature, and entries through", async () => {
    const verifySource = vi.fn(async () => ({ status: "ok" }) as never);
    const driver = { verifySource } as unknown as VerifyDriver;
    const verification = createDriverChainVerification(driver);

    expect(verification.mode).toBe("verified");
    await expect(verification.verify(input)).resolves.toEqual({ status: "ok" });

    const passed = verifySource.mock.calls[0]![0] as { firstAdoption: boolean; head: unknown };
    expect(passed.firstAdoption).toBe(true);
    expect(passed.head).toBe(head);
  });

  test("rejects when the driver rejects, surfacing the outcome status", async () => {
    const driver = {
      verifySource: async () => ({ status: "fork-detected" }) as never,
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "fork-detected",
    });
  });

  test("rejects an unsigned head rather than accepting the unpublished profile", async () => {
    const driver = { verifySource: vi.fn() } as unknown as VerifyDriver;
    await expect(
      createDriverChainVerification(driver).verify({ ...input, headSignature: undefined }),
    ).resolves.toEqual({ status: "rejected", reason: "head-unsigned" });
    expect((driver.verifySource as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  test("rejects when the driver throws instead of returning", async () => {
    const driver = {
      verifySource: async () => {
        throw new Error("transport failed");
      },
    } as unknown as VerifyDriver;
    await expect(createDriverChainVerification(driver).verify(input)).resolves.toEqual({
      status: "rejected",
      reason: "verification-failed",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/chain-verification.test.ts`
Expected: FAIL — `Failed to resolve import "./chain-verification.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/chain-verification.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { SyncedEntry, VerifyDriver } from "@jinn-network/record-discovery-client";
import type { SourceHead, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import type { DsseEnvelope } from "@jinn-network/trust-core";

import { describeError } from "./errors.js";

export interface ChainVerificationInput {
  readonly source: SourceIdentity;
  readonly head: SourceHead;
  readonly headSignature?: DsseEnvelope;
  readonly entries: readonly SyncedEntry[];
  readonly firstAdoption: boolean;
}

export type ChainVerificationOutcome =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reason: string };

export interface ChainVerification {
  readonly mode: "verified" | "unverified";
  verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome>;
}

/**
 * `record-discovery-client`'s `coldSync`/`returningSync` are DATA ACQUISITION
 * ONLY — `packages/discovery/client/src/sync.ts:16-19` says so explicitly:
 * `verify-driver.ts` is what verifies a walked chain. A mirror is therefore
 * required to state which of the three postures it takes, at construction,
 * with no default.
 */

/** The construction-time default: verify nothing, admit nothing. */
export function createRejectingChainVerification(): ChainVerification {
  return Object.freeze({
    mode: "unverified" as const,
    async verify(): Promise<ChainVerificationOutcome> {
      return { status: "rejected", reason: "chain-verification-not-configured" };
    },
  });
}

export const UNVERIFIED_CHAIN_ACKNOWLEDGEMENT =
  "announcement-chain-signatures-are-not-verified-by-this-runtime" as const;

export type UnverifiedChainAcknowledgement = typeof UNVERIFIED_CHAIN_ACKNOWLEDGEMENT;

/**
 * Mirrors without verifying announcement-chain signatures. The literal
 * acknowledgement argument makes the posture impossible to acquire by
 * accident, and the `mode: "unverified"` field makes the capability's health
 * check report it rather than pretending. Downstream gates (record-digest
 * validation in the indexer, producer admission at read) still hold.
 */
export function createUnverifiedChainVerification(
  acknowledgement: UnverifiedChainAcknowledgement,
): ChainVerification {
  void acknowledgement;
  return Object.freeze({
    mode: "unverified" as const,
    async verify(): Promise<ChainVerificationOutcome> {
      return { status: "ok" };
    },
  });
}

/** The real posture: `record-discovery-client`'s verification driver. */
export function createDriverChainVerification(driver: VerifyDriver): ChainVerification {
  return Object.freeze({
    mode: "verified" as const,
    async verify(input: ChainVerificationInput): Promise<ChainVerificationOutcome> {
      const headSignature = input.headSignature;
      if (headSignature === undefined) {
        // The unpublished-source profile omits head signatures. A runtime
        // that injects corpus content into a live agent session does not
        // accept it. Fail-closed.
        return { status: "rejected", reason: "head-unsigned" };
      }

      const signed = input.entries.filter(
        (entry): entry is SyncedEntry & { signature: DsseEnvelope } => entry.signature !== undefined,
      );

      async function* entries(): AsyncGenerator<{
        entry: SyncedEntry["entry"];
        signature: DsseEnvelope;
      }> {
        for (const item of signed) yield { entry: item.entry, signature: item.signature };
      }

      try {
        const outcome = await driver.verifySource({
          source: input.source,
          head: input.head,
          headSignature,
          entries: entries(),
          firstAdoption: input.firstAdoption,
        });
        return outcome.status === "ok"
          ? { status: "ok" }
          : { status: "rejected", reason: outcome.status };
      } catch (error) {
        return { status: "rejected", reason: "verification-failed", ...{} } as ChainVerificationOutcome &
          { reason: string } extends never
          ? never
          : { status: "rejected"; reason: string } extends never
            ? never
            : { status: "rejected", reason: "verification-failed" };
      }
    },
  });
}
```

> The `catch` block above is written awkwardly by the type gymnastics; replace its body with the plain form and keep the diagnostic:
>
> ```ts
>       } catch (error) {
>         void describeError(error);
>         return { status: "rejected", reason: "verification-failed" };
>       }
> ```

- [ ] **Step 4: Simplify the catch block as noted, then run the test**

Run: `cd plugin/runtime && yarn test src/corpus/chain-verification.test.ts && yarn typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): required chain-verification posture for the corpus mirror"
```

---

### Task 7: Announcement adaptation with source admission

**Files:**
- Create: `plugin/runtime/src/corpus/announcements.ts`, `src/corpus/announcements.test.ts`

**Interfaces:**
- Consumes: `AnnouncementEntry`, `RECORD_KINDS`, `SOURCE_NAME_GRAMMAR`, `LOCATION_PROFILE_HTTPS`, `LOCATION_PROFILE_IPFS` from `@jinn-network/record-discovery-protocol` (`packages/discovery/protocol/src/identifiers.ts:14-38`, `src/entry.ts:31-38`); `EvidenceRecordAnnouncement` from `@jinn-network/evidence-discovery` (`packages/evidence/discovery/src/catalog/types.ts:181-190`); `EvidenceRecordFamily` from `@jinn-network/evidence-repository`; `CorpusAdmission` (Task 5); `MirrorSourceConfig` (Task 1).
- Produces: `type ExclusionReason`; `interface ExcludedAnnouncement { announcementId: string; reason: ExclusionReason; detail: string }`; `interface AnnouncementAdaptation { announcements: readonly EvidenceRecordAnnouncement[]; excluded: readonly ExcludedAnnouncement[] }`; `adaptAnnouncementEntry(entry, source, admission): AnnouncementAdaptation`; `const FAMILY_BY_RECORD_KIND`; `sourceIdOf(source): string`.

- [ ] **Step 1: Write the failing test**

`src/corpus/announcements.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import {
  LOCATION_PROFILE_HTTPS,
  LOCATION_PROFILE_IPFS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  SOURCE_NAME_GRAMMAR,
} from "@jinn-network/record-discovery-protocol";
import { describe, expect, test } from "vitest";

import { createFollowedSourceAdmission } from "./admission.js";
import { adaptAnnouncementEntry, sourceIdOf } from "./announcements.js";

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const admission = createFollowedSourceAdmission([source]);

const digest = (fill: string) => `sha256:${fill.repeat(64)}` as const;

const entry = (announcements: unknown[]) =>
  ({
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: source.agent, name: source.name },
    sequence: "0000000000000002",
    previous: digest("0"),
    timestamp: "2026-07-30T00:00:00Z",
    announcements,
  }) as never;

const available = (kind: string, fill = "a") => ({
  announcementId: `ann-${fill}`,
  action: "available" as const,
  record: { kind, digest: digest(fill) },
});

describe("source-name grammar pin", () => {
  test("the config module's local copy matches the protocol's grammar", () => {
    // config.ts keeps a local copy so it stays dependency-pure; this is the
    // assertion that keeps the copy honest.
    expect(SOURCE_NAME_GRAMMAR.source).toBe(
      /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.source,
    );
  });
});

describe("announcement adaptation", () => {
  test("maps the three evidence record kinds onto their families", () => {
    const result = adaptAnnouncementEntry(
      entry([
        available(RECORD_KINDS.executionEvidence, "a"),
        available(RECORD_KINDS.resultEvaluation, "b"),
        available(RECORD_KINDS.executionVerification, "c"),
      ]),
      source,
      admission,
    );
    expect(result.announcements.map((a) => (a as { reference: { family: string } }).reference.family))
      .toEqual(["execution-evidence", "result-evaluation", "execution-verification"]);
    expect(result.excluded).toEqual([]);
  });

  test("stamps the configured source id and repository id on every announcement", () => {
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.executionEvidence)]),
      source,
      admission,
    );
    const first = result.announcements[0] as { sourceId: string; repositoryId: string };
    expect(first.sourceId).toBe("https://agents.test/alice/attempts");
    expect(first.sourceId).toBe(sourceIdOf(source));
    expect(first.repositoryId).toBe("archive.test/attempts");
  });

  test("excludes a record kind this runtime does not mirror", () => {
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.task), available(RECORD_KINDS.plugin, "b")]),
      source,
      admission,
    );
    expect(result.announcements).toEqual([]);
    expect(result.excluded.map((e) => e.reason)).toEqual(["unsupported-kind", "unsupported-kind"]);
  });

  test("carries a withdrawal through untouched", () => {
    const result = adaptAnnouncementEntry(
      entry([
        { announcementId: "ann-w", action: "withdrawn", retracts: "ann-a", reason: "superseded" },
      ]),
      source,
      admission,
    );
    expect(result.announcements[0]).toEqual({
      kind: "withdrawn",
      sourceId: "https://agents.test/alice/attempts",
      announcementId: "ann-w",
      retractsAnnouncementId: "ann-a",
    });
  });

  test("lifts an https location into the evidence location shape", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: LOCATION_PROFILE_HTTPS, locator: "https://archive.test/records/aa" }],
        },
      ]),
      source,
      admission,
    );
    expect((result.announcements[0] as { publishedLocation: unknown }).publishedLocation).toEqual({
      bindingProfile: LOCATION_PROFILE_HTTPS,
      locator: { uri: "https://archive.test/records/aa" },
    });
  });

  test("lifts an ipfs location under its own locator key", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: LOCATION_PROFILE_IPFS, locator: "bafy" }],
        },
      ]),
      source,
      admission,
    );
    expect((result.announcements[0] as { publishedLocation: unknown }).publishedLocation).toEqual({
      bindingProfile: LOCATION_PROFILE_IPFS,
      locator: { cid: "bafy" },
    });
  });

  test("indexes without a published location when no profile is recognized", () => {
    const result = adaptAnnouncementEntry(
      entry([
        {
          ...available(RECORD_KINDS.executionEvidence),
          locations: [{ profile: "https://example.test/unknown", locator: "x" }],
        },
      ]),
      source,
      admission,
    );
    expect(result.announcements).toHaveLength(1);
    expect(result.announcements[0]).not.toHaveProperty("publishedLocation");
  });

  test("TRUST: excludes every announcement from an archive this runtime does not follow", () => {
    const foreign = entry([available(RECORD_KINDS.executionEvidence)]) as unknown as {
      source: { agent: string; name: string };
    };
    foreign.source = { agent: "https://agents.test/mallory", name: "attempts" };

    const result = adaptAnnouncementEntry(foreign as never, source, admission);
    expect(result.announcements).toEqual([]);
    expect(result.excluded).toEqual([
      { announcementId: "ann-a", reason: "admission-rejected", detail: "source-mismatch" },
    ]);
  });

  test("TRUST: excludes everything when the admission rejects the configured archive", () => {
    const denyAll = createFollowedSourceAdmission([]);
    const result = adaptAnnouncementEntry(
      entry([available(RECORD_KINDS.executionEvidence)]),
      source,
      denyAll,
    );
    expect(result.announcements).toEqual([]);
    expect(result.excluded[0]).toEqual({
      announcementId: "ann-a",
      reason: "admission-rejected",
      detail: "source-not-followed",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/announcements.test.ts`
Expected: FAIL — `Failed to resolve import "./announcements.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/announcements.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRecordAnnouncement, JsonValue } from "@jinn-network/evidence-discovery";
import type { EvidenceRecordFamily, Sha256Digest } from "@jinn-network/evidence-repository";
import {
  LOCATION_PROFILE_HTTPS,
  LOCATION_PROFILE_IPFS,
  RECORD_KINDS,
  type AnnouncementEntry,
  type PublishedLocation,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";

export const FAMILY_BY_RECORD_KIND: ReadonlyMap<string, EvidenceRecordFamily> = new Map([
  [RECORD_KINDS.executionEvidence, "execution-evidence"],
  [RECORD_KINDS.resultEvaluation, "result-evaluation"],
  [RECORD_KINDS.executionVerification, "execution-verification"],
]);

export type ExclusionReason = "admission-rejected" | "unsupported-kind";

export interface ExcludedAnnouncement {
  readonly announcementId: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export interface AnnouncementAdaptation {
  readonly announcements: readonly EvidenceRecordAnnouncement[];
  readonly excluded: readonly ExcludedAnnouncement[];
}

export function sourceIdOf(source: Pick<MirrorSourceConfig, "agent" | "name">): string {
  return `${source.agent}/${source.name}`;
}

/**
 * Record discovery carries a location as `{ profile, locator: string }`;
 * the evidence catalog carries one as `{ bindingProfile, locator: object }`.
 * The two models are not unified upstream (C5 Finding F2); this function is
 * the single bridging point, and an unrecognized profile yields no location
 * rather than an invented one.
 */
function toPublishedLocation(
  locations: readonly PublishedLocation[] | undefined,
): { readonly bindingProfile: string; readonly locator: Readonly<Record<string, JsonValue>> } | undefined {
  for (const location of locations ?? []) {
    if (location.profile === LOCATION_PROFILE_HTTPS) {
      return { bindingProfile: location.profile, locator: { uri: location.locator } };
    }
    if (location.profile === LOCATION_PROFILE_IPFS) {
      return { bindingProfile: location.profile, locator: { cid: location.locator } };
    }
  }
  return undefined;
}

/**
 * Adapts one announcement entry into the evidence indexer's announcement
 * shape, applying SOURCE (announcer) admission first.
 *
 * Admission runs here, at the acquisition boundary, so a rejected archive's
 * content never enters the catalog at all. PRODUCER admission runs later, in
 * `read.ts`, because the producing agent's identity lives inside the record
 * and is only known after projection — and because running it at read time
 * means a policy change takes effect immediately over already-mirrored
 * content instead of requiring a re-sync.
 */
export function adaptAnnouncementEntry(
  entry: AnnouncementEntry,
  source: MirrorSourceConfig,
  admission: CorpusAdmission,
): AnnouncementAdaptation {
  const excludeAll = (detail: string): AnnouncementAdaptation => ({
    announcements: [],
    excluded: entry.announcements.map((announcement) => ({
      announcementId: announcement.announcementId,
      reason: "admission-rejected" as const,
      detail,
    })),
  });

  if (entry.source.agent !== source.agent || entry.source.name !== source.name) {
    return excludeAll("source-mismatch");
  }

  const decision = admission.admitSource({ agent: entry.source.agent, name: entry.source.name });
  if (decision.status === "rejected") return excludeAll(decision.reason);

  const sourceId = sourceIdOf(source);
  const announcements: EvidenceRecordAnnouncement[] = [];
  const excluded: ExcludedAnnouncement[] = [];

  for (const announcement of entry.announcements) {
    if (announcement.action === "withdrawn") {
      announcements.push({
        kind: "withdrawn",
        sourceId,
        announcementId: announcement.announcementId,
        retractsAnnouncementId: announcement.retracts,
      });
      continue;
    }

    const family = FAMILY_BY_RECORD_KIND.get(announcement.record.kind);
    if (family === undefined) {
      excluded.push({
        announcementId: announcement.announcementId,
        reason: "unsupported-kind",
        detail: announcement.record.kind,
      });
      continue;
    }

    const publishedLocation = toPublishedLocation(announcement.locations);
    announcements.push({
      kind: "available",
      sourceId,
      announcementId: announcement.announcementId,
      repositoryId: source.repositoryId,
      reference: { family, digest: announcement.record.digest as Sha256Digest },
      ...(publishedLocation === undefined ? {} : { publishedLocation }),
    });
  }

  return { announcements, excluded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/announcements.test.ts && yarn typecheck`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): adapt discovery announcements to evidence announcements under source admission"
```

---

### Task 8: Repositories — read-only serving plane, mirroring cache, resolver

**Files:**
- Create: `plugin/runtime/src/corpus/repositories.ts`, `src/corpus/repositories.test.ts`

**Interfaces:**
- Consumes: `EvidenceRepository`, `EvidenceRecordReference`, `EvidenceArtifactReference`, `NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES` from `@jinn-network/evidence-repository` (`packages/evidence/repository/src/types.ts:39-62` — `getRecord(reference, options?): Promise<Uint8Array | null>`, `putRecord(family, bytes, options?): Promise<RepositoryWriteReceipt<EvidenceRecordReference>>`, plus the artifact pair); `EvidenceRepositoryResolver` from `@jinn-network/evidence-discovery` (`catalog/types.ts:204-209` — `resolve(repositoryId, options?): Promise<EvidenceRepository | null>`); `recordDigest` from `@jinn-network/evidence-protocol`; `recordPath` from `@jinn-network/record-discovery-protocol` (`identifiers.ts:57`); `Transport` from `@jinn-network/record-discovery-client` (`ports.ts:28-30` — note the quoted method name `"fetch"`).
- Produces: `const MIRROR_REPOSITORY_ID`; `createServingPlaneRepository(options: { servingRoot: string; transport: Transport }): EvidenceRepository`; `createMirroringRepository(options: { upstream: EvidenceRepository; local: EvidenceRepository }): EvidenceRepository`; `createCorpusRepositoryResolver(options: { sources; local; transport }): EvidenceRepositoryResolver`.

The mirroring repository is what makes the mirror a *mirror* rather than a proxy: `createEvidenceIndexer` fetches record bytes through the resolved repository in order to project them (`packages/evidence/discovery/src/indexer/index-announcement.ts` — resolve, `getRecord`, digest check, `validateAndProjectEvidenceRecord`, `putRecordProjection`), so routing that fetch through a local-first cache populates the object store as a side effect of indexing. A second read of the same record never touches the network.

- [ ] **Step 1: Write the failing test**

`src/corpus/repositories.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";
import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CorpusMirrorError } from "./errors.js";
import {
  MIRROR_REPOSITORY_ID,
  createCorpusRepositoryResolver,
  createMirroringRepository,
  createServingPlaneRepository,
} from "./repositories.js";

const bytes = new TextEncoder().encode('{"hello":"world"}');
const digest = recordDigest(bytes);
const reference = { family: "execution-evidence", digest } as const;

function transportServing(body: Uint8Array, status = 200): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<TransportResponse> {
      calls.push(url);
      return { status, bytes: body };
    },
  };
}

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-repo-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("serving-plane repository", () => {
  test("fetches a record from the protocol's records path", async () => {
    const transport = transportServing(bytes);
    const repository = createServingPlaneRepository({ servingRoot: source.servingRoot, transport });
    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    expect(transport.calls[0]).toBe(`https://archive.test/records/${digest.slice("sha256:".length)}`);
  });

  test("REFUSES bytes whose digest does not match the reference", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(new TextEncoder().encode("tampered")),
    });
    await expect(repository.getRecord(reference)).rejects.toBeInstanceOf(CorpusMirrorError);
    await expect(repository.getRecord(reference)).rejects.toMatchObject({
      code: "corpus-record-digest-mismatch",
    });
  });

  test("returns null for a not-found response rather than throwing", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(new Uint8Array(), 404),
    });
    await expect(repository.getRecord(reference)).resolves.toBeNull();
  });

  test("is read-only — writing refuses loudly", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(bytes),
    });
    await expect(repository.putRecord("execution-evidence", bytes)).rejects.toMatchObject({
      code: "corpus-repository-read-only",
    });
  });

  test("returns null for artifacts — the serving plane defines no artifact path", async () => {
    const repository = createServingPlaneRepository({
      servingRoot: source.servingRoot,
      transport: transportServing(bytes),
    });
    await expect(repository.getArtifact({ digest })).resolves.toBeNull();
  });
});

describe("mirroring repository", () => {
  test("fetches upstream on a miss, writes locally, and serves locally thereafter", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = { getRecord: vi.fn(async () => bytes) } as unknown as Parameters<
      typeof createMirroringRepository
    >[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    await expect(repository.getRecord(reference)).resolves.toEqual(bytes);
    expect((upstream.getRecord as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  test("returns null when upstream has nothing, and caches no negative result", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = { getRecord: vi.fn(async () => null) } as unknown as Parameters<
      typeof createMirroringRepository
    >[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).resolves.toBeNull();
    await expect(repository.getRecord(reference)).resolves.toBeNull();
    expect((upstream.getRecord as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  test("REFUSES to cache upstream bytes whose digest does not match", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const upstream = {
      getRecord: async () => new TextEncoder().encode("tampered"),
    } as unknown as Parameters<typeof createMirroringRepository>[0]["upstream"];
    const repository = createMirroringRepository({ upstream, local });

    await expect(repository.getRecord(reference)).rejects.toMatchObject({
      code: "corpus-record-digest-mismatch",
    });
    await expect(local.getRecord(reference)).resolves.toBeNull();
  });
});

describe("repository resolver", () => {
  test("resolves the mirror id to the local object store", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const resolver = createCorpusRepositoryResolver({
      sources: [source],
      local,
      transport: transportServing(bytes),
    });
    await expect(resolver.resolve(MIRROR_REPOSITORY_ID)).resolves.toBe(local);
  });

  test("resolves a configured source id to a mirroring repository over its serving root", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const transport = transportServing(bytes);
    const resolver = createCorpusRepositoryResolver({ sources: [source], local, transport });

    const repository = await resolver.resolve("archive.test/attempts");
    expect(repository).not.toBeNull();
    await expect(repository!.getRecord(reference)).resolves.toEqual(bytes);
    await expect(repository!.getRecord(reference)).resolves.toEqual(bytes);
    expect(transport.calls).toHaveLength(1);
  });

  test("returns null for an unconfigured repository id", async () => {
    const local = await createFilesystemEvidenceRepository({ rootDir: join(directory, "objects") });
    const resolver = createCorpusRepositoryResolver({
      sources: [source],
      local,
      transport: transportServing(bytes),
    });
    await expect(resolver.resolve("archive.evil/attempts")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/repositories.test.ts`
Expected: FAIL — `Failed to resolve import "./repositories.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/repositories.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";
import { recordDigest } from "@jinn-network/evidence-protocol";
import {
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import type { Transport } from "@jinn-network/record-discovery-client";
import { recordPath } from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";

/** The repository id under which the mirror's own object store resolves. */
export const MIRROR_REPOSITORY_ID = "jinn:corpus-mirror" as const;

function readOnly(): never {
  throw new CorpusMirrorError(
    CORPUS_ERROR_CODES.repositoryReadOnly,
    "The public-corpus serving plane is read-only; this runtime does not publish.",
  );
}

export interface ServingPlaneRepositoryOptions {
  readonly servingRoot: string;
  readonly transport: Transport;
}

/**
 * A read-only `EvidenceRepository` over one archive's record-discovery
 * serving plane. Record bytes are re-hashed against the requested reference
 * before they are returned: a digest mismatch is refused loudly, never
 * silently proxied to a caller that might trust it.
 *
 * `getArtifact` returns `null`: the record-discovery serving paths
 * (`identifiers.ts:55-58`) define `/records/<digest>` and nothing for
 * artifacts, and inventing a path here would be a protocol change made by an
 * application. Recorded as C5 Finding F3.
 */
export function createServingPlaneRepository(
  options: ServingPlaneRepositoryOptions,
): EvidenceRepository {
  return Object.freeze({
    capabilities: NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,

    async getRecord(
      reference: EvidenceRecordReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      operation?.signal?.throwIfAborted();
      const response = await options.transport.fetch(
        options.servingRoot + recordPath(reference.digest),
      );
      if (response.status >= 400) return null;
      if (recordDigest(response.bytes) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Bytes served for ${reference.digest} do not re-hash to that digest.`,
        );
      }
      return response.bytes;
    },

    async getArtifact(
      _reference: EvidenceArtifactReference,
      _operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      return null;
    },

    async putRecord(
      _family: EvidenceRecordFamily,
      _bytes: Uint8Array,
    ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
      return readOnly();
    },

    async putArtifact(_bytes: Uint8Array): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
      return readOnly();
    },
  });
}

export interface MirroringRepositoryOptions {
  readonly upstream: EvidenceRepository;
  readonly local: EvidenceRepository;
}

/**
 * Local first, upstream on a miss, digest-validated, written back. This is
 * what turns the indexer's own byte fetch into the mirroring step: indexing
 * an announcement populates the local object store as a side effect, so
 * every later read of that record is local and always-available.
 *
 * A digest mismatch refuses BEFORE the write, so a tampering upstream cannot
 * poison the local store.
 */
export function createMirroringRepository(
  options: MirroringRepositoryOptions,
): EvidenceRepository {
  return Object.freeze({
    capabilities: options.local.capabilities,

    async getRecord(
      reference: EvidenceRecordReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      const cached = await options.local.getRecord(reference, operation);
      if (cached !== null) return cached;

      const fetched = await options.upstream.getRecord(reference, operation);
      if (fetched === null) return null;
      if (recordDigest(fetched) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Upstream bytes for ${reference.digest} do not re-hash to that digest; refusing to mirror them.`,
        );
      }
      await options.local.putRecord(reference.family, fetched, operation);
      return fetched;
    },

    async getArtifact(
      reference: EvidenceArtifactReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      const cached = await options.local.getArtifact(reference, operation);
      if (cached !== null) return cached;

      const fetched = await options.upstream.getArtifact(reference, operation);
      if (fetched === null) return null;
      if (recordDigest(fetched) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Upstream artifact bytes for ${reference.digest} do not re-hash to that digest.`,
        );
      }
      await options.local.putArtifact(fetched, operation);
      return fetched;
    },

    async putRecord(
      family: EvidenceRecordFamily,
      bytes: Uint8Array,
      operation?: RepositoryOperationOptions,
    ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
      return options.local.putRecord(family, bytes, operation);
    },

    async putArtifact(
      bytes: Uint8Array,
      operation?: RepositoryOperationOptions,
    ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
      return options.local.putArtifact(bytes, operation);
    },
  });
}

export interface CorpusRepositoryResolverOptions {
  readonly sources: readonly MirrorSourceConfig[];
  readonly local: EvidenceRepository;
  readonly transport: Transport;
}

/**
 * Resolves the mirror's own store plus one mirroring repository per followed
 * archive. An unconfigured id resolves to `null` — the resolver is an
 * allowlist, so a record announcing an unknown repository is unfetchable
 * rather than an invitation to reach an arbitrary host.
 */
export function createCorpusRepositoryResolver(
  options: CorpusRepositoryResolverOptions,
): EvidenceRepositoryResolver {
  const byId = new Map<string, EvidenceRepository>([[MIRROR_REPOSITORY_ID, options.local]]);
  for (const source of options.sources) {
    byId.set(
      source.repositoryId,
      createMirroringRepository({
        upstream: createServingPlaneRepository({
          servingRoot: source.servingRoot,
          transport: options.transport,
        }),
        local: options.local,
      }),
    );
  }

  return Object.freeze({
    async resolve(repositoryId: string): Promise<EvidenceRepository | null> {
      return byId.get(repositoryId) ?? null;
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/repositories.test.ts && yarn typecheck`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): serving-plane, mirroring, and allowlist repositories for the corpus"
```

---

### Task 9: The mirror store, opened per operation

**Files:**
- Create: `plugin/runtime/src/corpus/store.ts`, `src/corpus/store.test.ts`

**Interfaces:**
- Consumes: `createSqliteEvidenceCatalog`, `openSqliteEvidenceCatalog`, `SqliteEvidenceCatalog` from `@jinn-network/evidence-catalog-sqlite` (`packages/evidence/catalog-sqlite/src/catalog.ts:139` and `:167`, both `Promise<SqliteEvidenceCatalog>`, options `{ databasePath, generation }` / `{ databasePath }`); `CATALOG_SCHEMA_VERSION`, `CatalogGeneration` from `@jinn-network/evidence-discovery` (`catalog/types.ts:28-34`); `createFilesystemEvidenceRepository` from `@jinn-network/evidence-repository/fs` (`src/fs/index.ts:583-585`).
- Produces: `const CORPUS_PROJECTOR_VERSION`; `interface CorpusMirrorStore { readonly catalog: SqliteEvidenceCatalog; readonly repository: EvidenceRepository; close(): Promise<void> }`; `interface OpenCorpusMirrorStoreOptions { catalogPath: string; objectsDirectory: string; now?: () => Date }`; `openCorpusMirrorStore(options): Promise<CorpusMirrorStore>`; `withCorpusMirrorStore<T>(options, use): Promise<T>`.

**The two-lock ordering rule (C3 correction F-C3-8, resolved here).** This runtime holds two distinct locks and they are never nested in the other order:

1. **The mirror sync lock** (`tryAcquireSyncLock`, Task 4) — skip-if-held, taken **first**, released **last**. It is cheap, so a losing instance discards its attempt before opening anything.
2. **The mirror catalog handle** — opened *inside* the sync lock for a write pass, and *without* any sync lock for a read. This is safe where C4's local archive is not: `openCatalogDatabase` puts the catalog in **WAL journal mode with `busy_timeout = 5000`** (`packages/evidence/catalog-sqlite/src/database.ts:187-196`), so concurrent readers and one writer coexist. C4's `openLocalEvidenceRuntime` takes an exclusive-or-fail root lock (`local-runtime/src/lock.ts:37,46,80`); the mirror deliberately does **not** go through local-runtime, precisely so a reader is never starved by a writer.

Per C3's rule the store is opened per operation and closed in a `finally` — `withCorpusMirrorStore` exists so no caller can forget.

- [ ] **Step 1: Write the failing test**

`src/corpus/store.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  CORPUS_PROJECTOR_VERSION,
  openCorpusMirrorStore,
  withCorpusMirrorStore,
} from "./store.js";

let directory: string;
let options: { catalogPath: string; objectsDirectory: string };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-store-"));
  options = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("corpus mirror store", () => {
  test("creates the catalog and object store on first open", async () => {
    const store = await openCorpusMirrorStore(options);
    try {
      expect(store.catalog.generation.projectorVersion).toBe(CORPUS_PROJECTOR_VERSION);
      expect((await stat(options.catalogPath)).isFile()).toBe(true);
      expect((await stat(options.objectsDirectory)).isDirectory()).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("creates the catalog owner-only", async () => {
    const store = await openCorpusMirrorStore(options);
    await store.close();
    expect((await stat(options.catalogPath)).mode & 0o777).toBe(0o600);
  });

  test("reopens an existing catalog rather than recreating it", async () => {
    const first = await openCorpusMirrorStore(options);
    const created = first.catalog.generation.createdAt;
    await first.close();

    const second = await openCorpusMirrorStore(options);
    try {
      expect(second.catalog.generation.createdAt).toBe(created);
    } finally {
      await second.close();
    }
  });

  test("permits a concurrent second reader — the mirror is WAL, not exclusive-or-fail", async () => {
    const writer = await openCorpusMirrorStore(options);
    try {
      const reader = await openCorpusMirrorStore(options);
      try {
        await expect(
          reader.catalog.findExecutions({ limit: 1 }),
        ).resolves.toMatchObject({ items: [] });
      } finally {
        await reader.close();
      }
    } finally {
      await writer.close();
    }
  });

  test("withCorpusMirrorStore closes the store even when the body throws", async () => {
    await expect(
      withCorpusMirrorStore(options, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");

    // A second open proves the first handle was released.
    const store = await openCorpusMirrorStore(options);
    await store.close();
  });

  test("close is idempotent", async () => {
    const store = await openCorpusMirrorStore(options);
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/store.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { lstat } from "node:fs/promises";

import {
  createSqliteEvidenceCatalog,
  openSqliteEvidenceCatalog,
  type SqliteEvidenceCatalog,
} from "@jinn-network/evidence-catalog-sqlite";
import { CATALOG_SCHEMA_VERSION } from "@jinn-network/evidence-discovery";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";

import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";

export const CORPUS_PROJECTOR_VERSION = "jinn-plugin-corpus-mirror/1.0.0" as const;

export interface CorpusMirrorStore {
  readonly catalog: SqliteEvidenceCatalog;
  readonly repository: EvidenceRepository;
  close(): Promise<void>;
}

export interface OpenCorpusMirrorStoreOptions {
  readonly catalogPath: string;
  readonly objectsDirectory: string;
  readonly now?: () => Date;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Opens the public-corpus mirror's own catalog and object store.
 *
 * Deliberately NOT `openLocalEvidenceRuntime`: that takes an exclusive-or-fail
 * root lock (`packages/evidence/local-runtime/src/lock.ts:37,46,80`), which
 * would let a mid-write sync starve a concurrent pickup. The SQLite catalog
 * opened directly runs in WAL with `busy_timeout = 5000`
 * (`packages/evidence/catalog-sqlite/src/database.ts:187-196`), so one writer
 * and many readers coexist — which is exactly what "sync never blocks pickup"
 * requires at the storage layer.
 *
 * Per C3's capability rule, this is opened PER OPERATION and closed after;
 * prefer `withCorpusMirrorStore`.
 */
export async function openCorpusMirrorStore(
  options: OpenCorpusMirrorStoreOptions,
): Promise<CorpusMirrorStore> {
  const now = options.now ?? (() => new Date());
  const repository = await createFilesystemEvidenceRepository({
    rootDir: options.objectsDirectory,
  });

  let catalog: SqliteEvidenceCatalog;
  if (await exists(options.catalogPath)) {
    catalog = await openSqliteEvidenceCatalog({ databasePath: options.catalogPath });
  } else {
    try {
      catalog = await createSqliteEvidenceCatalog({
        databasePath: options.catalogPath,
        generation: {
          catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
          projectorVersion: CORPUS_PROJECTOR_VERSION,
          createdAt: now().toISOString(),
        },
      });
    } catch (error) {
      // `createSqliteEvidenceCatalog` reserves the file with O_CREAT|O_EXCL,
      // so a concurrent instance can win this race. Re-open rather than fail.
      if (await exists(options.catalogPath)) {
        catalog = await openSqliteEvidenceCatalog({ databasePath: options.catalogPath });
      } else {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.mirrorStoreIo,
          `Unable to create the corpus mirror catalog at ${options.catalogPath}.`,
          { cause: error },
        );
      }
    }
  }

  let closed = false;
  return {
    catalog,
    repository,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await catalog.close();
    },
  };
}

/** Opens the store, runs `use`, and closes the store on every path. */
export async function withCorpusMirrorStore<T>(
  options: OpenCorpusMirrorStoreOptions,
  use: (store: CorpusMirrorStore) => Promise<T>,
): Promise<T> {
  const store = await openCorpusMirrorStore(options);
  try {
    return await use(store);
  } finally {
    await store.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/store.test.ts && yarn typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): per-operation corpus mirror store over a WAL catalog"
```

---

### Task 10: The mirror sync loop

**Files:**
- Create: `plugin/runtime/src/corpus/mirror.ts`, `src/corpus/mirror.test.ts`

**Interfaces:**
- Consumes: `coldSync`, `returningSync`, `fetchHead`, `SourceEndpoint`, `SyncedEntry`, `Transport` from `@jinn-network/record-discovery-client` (`packages/discovery/client/src/sync.ts:79`, `:123`, `:145` — `coldSync(source, ports): AsyncIterable<SyncedEntry>`, `returningSync(source, hwm: SourceCursor, ports): AsyncIterable<SyncedEntry>`, `fetchHead(source, transport): Promise<SyncedHead>`); `sealJson` from `@jinn-network/record-discovery-protocol` (`sealing.ts` — used identically at `client/src/verify-driver.ts:111` to compute an entry digest); `createEvidenceIndexer` from `@jinn-network/evidence-discovery/indexer` (`indexer/index-announcement.ts:224` — `createEvidenceIndexer({ repositories, catalog }): EvidenceIndexer`); `tryAcquireSyncLock` (Task 4); `adaptAnnouncementEntry` (Task 7); `ChainVerification` (Task 6); `withCorpusMirrorStore` (Task 9); `createCorpusRepositoryResolver` (Task 8); `RuntimeLogger` from `plugin/runtime/src/logger.ts` (branch `plugin/c3-product-tree`).
- Produces: `type MirrorSyncStatus`; `interface MirrorSourceSyncReport`; `interface MirrorSyncOutcome`; `interface CorpusMirror { syncOnce(options?): Promise<MirrorSyncOutcome> }`; `interface CreateCorpusMirrorOptions`; `createCorpusMirror(options): CorpusMirror`.

**The contract this task must satisfy literally:** `syncOnce` **never throws** and **never waits on the lock**. Every failure is a value in the returned outcome. That is what lets C7 fire it opportunistically at session start and post-pickup and simply drop the promise.

- [ ] **Step 1: Write the failing test**

`src/corpus/mirror.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import {
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  headPath,
  sealJson,
} from "@jinn-network/record-discovery-protocol";
import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFollowedSourceAdmission } from "./admission.js";
import {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
} from "./chain-verification.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createCorpusMirror } from "./mirror.js";
import { withCorpusMirrorStore } from "./store.js";

// A minimal, well-formed execution-evidence record is loaded from the fixture
// built in Task 14; this suite only needs bytes whose digest is stable and a
// projection outcome, so it uses the shared fixture loader.
import { executionEvidenceFixture } from "./testing-fixture.js";

const AGENT = "https://agents.test/alice";
const NAME = "attempts";

const source = {
  agent: AGENT,
  name: NAME,
  servingRoot: "https://archive.test",
  archiveRootUrl: `https://archive.test${archivePagePath(NAME, "0000000000000001")}`,
  repositoryId: "archive.test/attempts",
};

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string };
let lockPath: string;
let statePath: string;

function buildArchive(recordBytes: Uint8Array): { transport: Transport; entryDigest: string } {
  const digest = recordDigest(recordBytes);
  const entry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: NAME },
    sequence: "0000000000000001",
    previous: null,
    timestamp: "2026-07-30T00:00:00Z",
    announcements: [
      {
        announcementId: "ann-1",
        action: "available",
        record: { kind: RECORD_KINDS.executionEvidence, digest },
      },
    ],
  };
  const entryDigest = sealJson(entry).digest;
  const head = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${AGENT}/${NAME}`,
    sequence: "0000000000000001",
    entry: entryDigest,
    issuedAt: "2026-07-30T00:00:00Z",
    refreshBy: "2026-08-30T00:00:00Z",
  };
  const page = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: `${AGENT}/${NAME}`,
    page: "0000000000000001",
    prevArchive: null,
    entries: [{ entry }],
  };

  const json = (value: unknown): TransportResponse => ({
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  });

  return {
    entryDigest,
    transport: {
      async fetch(url: string): Promise<TransportResponse> {
        if (url === `https://archive.test${headPath(NAME)}`) return json(head);
        if (url === source.archiveRootUrl) return json(page);
        if (url === `https://archive.test/records/${digest.slice("sha256:".length)}`) {
          return { status: 200, bytes: recordBytes };
        }
        return { status: 404, bytes: new Uint8Array() };
      },
    },
  };
}

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mirror(overrides: Partial<Parameters<typeof createCorpusMirror>[0]> = {}) {
  const { transport } = buildArchive(executionEvidenceFixture.bytes);
  return createCorpusMirror({
    sources: [source],
    maxEntriesPerSync: 500,
    lockPath,
    storePaths: paths,
    highWaterMarks: createFileHighWaterMarkStore({ filePath: statePath }),
    admission: createFollowedSourceAdmission([source]),
    chainVerification: createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT),
    transport,
    log: log(),
    ...overrides,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-mirror-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
  };
  lockPath = join(directory, "mirror-sync.lock");
  statePath = join(directory, "mirror-state.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("mirror sync", () => {
  test("mirrors an announced record from a fixture archive into the catalog", async () => {
    const outcome = await mirror().syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]).toMatchObject({ status: "synced", entriesWalked: 1, indexed: 1 });

    await withCorpusMirrorStore(paths, async (store) => {
      const page = await store.catalog.findExecutions({ limit: 10 });
      expect(page.items).toHaveLength(1);
    });
  });

  test("mirrors the record BYTES, not just the projection", async () => {
    await mirror().syncOnce();
    await withCorpusMirrorStore(paths, async (store) => {
      const bytes = await store.repository.getRecord({
        family: "execution-evidence",
        digest: recordDigest(executionEvidenceFixture.bytes),
      });
      expect(bytes).toEqual(executionEvidenceFixture.bytes);
    });
  });

  test("advances the high-water mark to the newest walked entry", async () => {
    const store = createFileHighWaterMarkStore({ filePath: statePath });
    await mirror({ highWaterMarks: store }).syncOnce();
    const mark = await store.get({ agent: AGENT, name: NAME });
    expect(mark?.sequence).toBe("0000000000000001");
    expect(mark?.issuedAt).toBe("2026-07-30T00:00:00Z");
  });

  test("a second pass walks nothing new", async () => {
    const marks = createFileHighWaterMarkStore({ filePath: statePath });
    await mirror({ highWaterMarks: marks }).syncOnce();
    const second = await mirror({ highWaterMarks: marks }).syncOnce();
    expect(second.sources[0]!.entriesWalked).toBe(0);
    expect(second.status).toBe("synced");
  });

  test("SKIPS without waiting when the lock is held, and never throws", async () => {
    const held = await tryAcquireSyncLock(lockPath);
    try {
      const started = Date.now();
      const outcome = await mirror().syncOnce();
      expect(outcome).toEqual({ status: "skipped-locked", sources: [] });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await held!.close();
    }
  });

  test("TRUST: an unverified chain posture that is not acknowledged indexes nothing", async () => {
    const outcome = await mirror({ chainVerification: createRejectingChainVerification() }).syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      indexed: 0,
      failure: { code: "chain-verification-rejected" },
    });

    await withCorpusMirrorStore(paths, async (store) => {
      expect((await store.catalog.findExecutions({ limit: 10 })).items).toEqual([]);
    });
  });

  test("TRUST: an archive this runtime does not follow contributes nothing", async () => {
    const outcome = await mirror({ admission: createFollowedSourceAdmission([]) }).syncOnce();
    expect(outcome.sources[0]).toMatchObject({ indexed: 0, excluded: 1 });
    await withCorpusMirrorStore(paths, async (store) => {
      expect((await store.catalog.findExecutions({ limit: 10 })).items).toEqual([]);
    });
  });

  test("reports a transport failure as a value instead of throwing", async () => {
    const outcome = await mirror({
      transport: {
        async fetch(): Promise<never> {
          throw new Error("network down");
        },
      },
    }).syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure?.message).toContain("network down");
  });

  test("one bad record does not wedge the rest of a source's entries", async () => {
    const { transport } = buildArchive(new TextEncoder().encode("not an evidence record"));
    const outcome = await mirror({ transport }).syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]).toMatchObject({ entriesWalked: 1, indexed: 0, rejected: 1 });
  });

  test("honours the per-pass entry bound", async () => {
    const outcome = await mirror({ maxEntriesPerSync: 0 }).syncOnce();
    expect(outcome.sources[0]!.entriesWalked).toBe(0);
  });

  test("reports partial when one of two sources fails", async () => {
    const other = { ...source, name: "evaluations", repositoryId: "archive.test/evaluations" };
    const outcome = await mirror({
      sources: [source, other],
      admission: createFollowedSourceAdmission([source, other]),
    }).syncOnce();
    expect(outcome.status).toBe("partial");
    expect(outcome.sources.map((report) => report.status)).toEqual(["synced", "failed"]);
  });
});
```

- [ ] **Step 2: Add the shared fixture loader used by this and later suites**

`src/corpus/testing-fixture.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
// Test-only. Not exported from `src/corpus/index.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(
  new URL("../../fixtures/corpus/execution-evidence.valid.json", import.meta.url),
);

/**
 * A conforming Execution Evidence record, taken byte-for-byte from
 * `packages/evidence/protocol`'s own golden fixture so this tree never
 * authors a second copy of the record family's truth.
 */
export const executionEvidenceFixture = {
  bytes: new Uint8Array(readFileSync(path)),
};
```

Populate the fixture in Task 14 Step 1; until then this suite fails at fixture load, which is the expected red.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/mirror.test.ts`
Expected: FAIL — `Failed to resolve import "./mirror.js"`.

- [ ] **Step 4: Write the implementation**

`src/corpus/mirror.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { createEvidenceIndexer } from "@jinn-network/evidence-discovery/indexer";
import {
  coldSync,
  fetchHead,
  returningSync,
  type SourceEndpoint,
  type SyncedEntry,
  type Transport,
} from "@jinn-network/record-discovery-client";
import {
  sealJson,
  type AnnouncementEntry,
  type HighWaterMarkStore,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import type { CorpusAdmission } from "./admission.js";
import { adaptAnnouncementEntry } from "./announcements.js";
import type { ChainVerification } from "./chain-verification.js";
import { describeError } from "./errors.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createCorpusRepositoryResolver } from "./repositories.js";
import { withCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

export type MirrorSyncStatus = "synced" | "skipped-locked" | "partial" | "failed";

export interface MirrorSourceSyncReport {
  readonly source: SourceIdentity;
  readonly status: "synced" | "failed";
  readonly entriesWalked: number;
  readonly indexed: number;
  readonly rejected: number;
  readonly withdrawn: number;
  readonly excluded: number;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface MirrorSyncOutcome {
  readonly status: MirrorSyncStatus;
  readonly sources: readonly MirrorSourceSyncReport[];
}

export interface CorpusMirror {
  syncOnce(options?: { readonly signal?: AbortSignal }): Promise<MirrorSyncOutcome>;
}

export interface CreateCorpusMirrorOptions {
  readonly sources: readonly MirrorSourceConfig[];
  readonly maxEntriesPerSync: number;
  readonly lockPath: string;
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly highWaterMarks: HighWaterMarkStore;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  readonly transport: Transport;
  readonly log: RuntimeLogger;
}

interface Counters {
  entriesWalked: number;
  indexed: number;
  rejected: number;
  withdrawn: number;
  excluded: number;
}

/**
 * The public-corpus mirror.
 *
 * LOCK ORDERING (C3 finding F-C3-8, resolved): the skip-if-held sync lock is
 * taken FIRST and released LAST; the catalog handle is opened INSIDE it and
 * closed before the lock is released. A losing instance discards its attempt
 * before opening anything. Readers (`read.ts`) take no sync lock at all — the
 * catalog is WAL, so a mid-write sync never blocks a pickup.
 *
 * `syncOnce` NEVER THROWS. Every failure — lock I/O, transport, chain
 * verification, a malformed record — is a value in the returned outcome, so a
 * caller can fire it opportunistically and drop the promise.
 */
export function createCorpusMirror(options: CreateCorpusMirrorOptions): CorpusMirror {
  async function collect(
    source: MirrorSourceConfig,
    counters: Counters,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly entries: SyncedEntry[]; readonly head: Awaited<ReturnType<typeof fetchHead>> }> {
    const endpoint: SourceEndpoint = {
      agent: source.agent,
      name: source.name,
      servingRoot: source.servingRoot,
      archiveRootUrl: source.archiveRootUrl,
    };
    const head = await fetchHead(endpoint, options.transport);
    const mark = await options.highWaterMarks.get({ agent: source.agent, name: source.name });
    const walk =
      mark === undefined
        ? coldSync(endpoint, { transport: options.transport })
        : returningSync(
            endpoint,
            { sequence: mark.sequence, entry: mark.entry },
            { transport: options.transport },
          );

    const entries: SyncedEntry[] = [];
    for await (const synced of walk) {
      if (signal?.aborted === true) break;
      if (counters.entriesWalked >= options.maxEntriesPerSync) break;
      counters.entriesWalked += 1;
      entries.push(synced);
    }
    return { entries, head };
  }

  async function syncSource(
    source: MirrorSourceConfig,
    indexer: ReturnType<typeof createEvidenceIndexer>,
    signal: AbortSignal | undefined,
  ): Promise<MirrorSourceSyncReport> {
    const identity: SourceIdentity = { agent: source.agent, name: source.name };
    const counters: Counters = {
      entriesWalked: 0,
      indexed: 0,
      rejected: 0,
      withdrawn: 0,
      excluded: 0,
    };

    try {
      const firstAdoption = (await options.highWaterMarks.get(identity)) === undefined;
      const { entries, head } = await collect(source, counters, signal);

      const verification = await options.chainVerification.verify({
        source: identity,
        head: head.head,
        ...(head.signature === undefined ? {} : { headSignature: head.signature }),
        entries,
        firstAdoption,
      });
      if (verification.status === "rejected") {
        return {
          source: identity,
          status: "failed",
          ...counters,
          failure: { code: "chain-verification-rejected", message: verification.reason },
        };
      }

      let latest: AnnouncementEntry | undefined;
      for (const synced of entries) {
        const adaptation = adaptAnnouncementEntry(synced.entry, source, options.admission);
        counters.excluded += adaptation.excluded.length;

        for (const announcement of adaptation.announcements) {
          try {
            const result = await indexer.index(
              announcement,
              signal === undefined ? undefined : { signal },
            );
            if (result.status === "indexed") counters.indexed += 1;
            else if (result.status === "rejected") counters.rejected += 1;
            else counters.withdrawn += 1;
          } catch (error) {
            // One unfetchable or nonconforming record must not wedge the rest
            // of a source's entries.
            counters.rejected += 1;
            options.log.warn("corpus.mirror.index-failed", {
              announcementId: announcement.announcementId,
              message: describeError(error),
            });
          }
        }
        latest = synced.entry;
      }

      if (latest !== undefined) {
        await options.highWaterMarks.put(identity, {
          sequence: latest.sequence,
          entry: sealJson(latest).digest,
          issuedAt: head.head.issuedAt,
        });
      }

      return { source: identity, status: "synced", ...counters };
    } catch (error) {
      return {
        source: identity,
        status: "failed",
        ...counters,
        failure: { code: "source-sync-failed", message: describeError(error) },
      };
    }
  }

  return Object.freeze({
    async syncOnce(operation?: { readonly signal?: AbortSignal }): Promise<MirrorSyncOutcome> {
      let lock;
      try {
        lock = await tryAcquireSyncLock(options.lockPath);
      } catch (error) {
        options.log.warn("corpus.mirror.lock-failed", { message: describeError(error) });
        return { status: "failed", sources: [] };
      }
      if (lock === undefined) return { status: "skipped-locked", sources: [] };

      try {
        return await withCorpusMirrorStore(options.storePaths, async (store) => {
          const indexer = createEvidenceIndexer({
            repositories: createCorpusRepositoryResolver({
              sources: options.sources,
              local: store.repository,
              transport: options.transport,
            }),
            catalog: store.catalog,
          });

          const reports: MirrorSourceSyncReport[] = [];
          for (const source of options.sources) {
            reports.push(await syncSource(source, indexer, operation?.signal));
          }

          const failed = reports.filter((report) => report.status === "failed").length;
          const status: MirrorSyncStatus =
            failed === 0 ? "synced" : failed === reports.length ? "failed" : "partial";
          return { status, sources: reports };
        });
      } catch (error) {
        options.log.error("corpus.mirror.sync-failed", { message: describeError(error) });
        return { status: "failed", sources: [] };
      } finally {
        await lock.close();
      }
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/mirror.test.ts && yarn typecheck`
Expected: PASS (11 tests) once Task 14's fixture exists. Until then this suite is red only on the fixture read; run it again at the end of Task 14.

- [ ] **Step 6: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): the corpus mirror sync loop under a skip-if-held lock"
```

---

### Task 11: The corpus reader — the C6 seam, producer admission, no sync method

**Files:**
- Create: `plugin/runtime/src/corpus/read.ts`, `src/corpus/read.test.ts`

**Interfaces:**
- Consumes: `CatalogRecordProjection`, `ExecutionCatalogQuery`, `EvaluationCatalogQuery`, `VerificationCatalogQuery`, `EvidenceRecordLocation` from `@jinn-network/evidence-discovery` (`catalog/types.ts:110-113`, `:115-149`, `:165-168`); the catalog reader methods on `SqliteEvidenceCatalog` (`packages/evidence/catalog-sqlite/src/catalog.ts:88-133` — `getRecord`, `findExecutions`, `findEvaluations`, `findVerifications`, `getRecordLocations`, each `Promise<CatalogPage<…>>` or equivalent); `RetrievalLocationHint` from `@jinn-network/evidence-retrieval` (`contracts.ts:50-54`); `HighWaterMark`, `HighWaterMarkStore`, `SourceIdentity` from `@jinn-network/record-discovery-protocol`; `CorpusAdmission` (Task 5); `withCorpusMirrorStore` (Task 9); `MIRROR_REPOSITORY_ID`, `sourceIdOf` (Tasks 8, 7).
- Produces: `interface CorpusRecordCandidate`; `interface CorpusReadQuery`; `interface CorpusReadPage`; `interface CorpusReadOptions`; `interface MirrorSourceStatus`; `interface CorpusReader`; `createCorpusReader(options: CreateCorpusReaderOptions): CorpusReader`; `producerIdOf(projection: CatalogRecordProjection): string`.

**This is the seam C6 merges and calls.** Three properties are load-bearing and each has its own test:

1. **No sync method, no mirror reference.** `CorpusReader` is structurally incapable of blocking on a sync (cross-plan contract 5). A type test asserts the absence.
2. **Producer admission before anything is returned.** A trust-rejected record never appears in C6's enumeration, so C6 never has to filter (cross-plan contract 1). `excludedByTrust` makes a filtered empty page distinguishable from an honestly empty one.
3. **No ranking.** Items come back in the catalog's own cursor order and are never reordered. `packages/discovery/client/src/query.ts:30` states the protocol rule — *"No ranking -- items are never locally reordered"* — and C5 inherits it; C6 is the layer allowed to rank.

- [ ] **Step 1: Write the failing test**

`src/corpus/read.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
} from "./admission.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createCorpusReader, producerIdOf } from "./read.js";
import { withCorpusMirrorStore } from "./store.js";
import {
  executionProjection,
  seedMirror,
  type SeededMirror,
} from "./testing-fixture.js";

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const ALICE = "https://agents.test/alice";
const MALLORY = "https://agents.test/mallory";

function admitting(...producers: readonly string[]) {
  return composeAdmission(createFollowedSourceAdmission([source]), {
    admitSource: () => ({ status: "admitted" as const }),
    admitProducer: (id: string) =>
      producers.includes(id)
        ? ({ status: "admitted" } as const)
        : ({ status: "rejected", reason: "producer-not-listed" } as const),
  });
}

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string };
let statePath: string;
let seeded: SeededMirror;

function reader(admission = admitting(ALICE)) {
  return createCorpusReader({
    storePaths: paths,
    sources: [source],
    admission,
    highWaterMarks: createFileHighWaterMarkStore({ filePath: statePath }),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-read-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
  };
  statePath = join(directory, "mirror-state.json");
  // Seeds three execution records: two by ALICE, one by MALLORY.
  seeded = await seedMirror(paths, source);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("producer identity", () => {
  test("reads the producer from whichever family the projection is", () => {
    expect(producerIdOf(executionProjection({ executorId: ALICE }))).toBe(ALICE);
  });
});

describe("corpus reader — the C6 seam", () => {
  test("STRUCTURAL: the reader exposes no sync method and holds no mirror", () => {
    const instance = reader();
    // @ts-expect-error — `CorpusReader` deliberately has no `syncOnce`.
    expect(instance.syncOnce).toBeUndefined();
    expect(Object.keys(instance).sort()).toEqual(["describeSources", "getRecord", "listRecords"]);
  });

  test("serves the current mirror while a sync lock is held elsewhere", async () => {
    const held = await tryAcquireSyncLock(join(directory, "mirror-sync.lock"));
    try {
      const started = Date.now();
      const page = await reader().listRecords();
      expect(page.items.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await held!.close();
    }
  });

  test("TRUST: an unadmitted producer's records never appear", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => producerIdOf(item.projection) === ALICE)).toBe(true);
    expect(page.excludedByTrust).toBe(1);
  });

  test("TRUST: a fully denying admission yields an empty page, and work proceeds", async () => {
    const page = await reader(
      composeAdmission(createFollowedSourceAdmission([source]), createDeniedProducerAdmission()),
    ).listRecords({ limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.excludedByTrust).toBe(3);
    // Fail-open on absence: an empty page is a value, not a throw.
  });

  test("distinguishes a filtered empty page from an honestly empty one", async () => {
    await withCorpusMirrorStore(paths, async () => undefined);
    const filtered = await reader(
      composeAdmission(createFollowedSourceAdmission([source]), createDeniedProducerAdmission()),
    ).listRecords({ limit: 10 });
    const honest = await reader(admitting(ALICE)).listRecords({ limit: 10, executorId: "nobody" });
    expect(filtered.excludedByTrust).toBeGreaterThan(0);
    expect(honest.excludedByTrust).toBe(0);
    expect(honest.items).toEqual([]);
  });

  test("NO RANKING: items are returned in catalog order, unreordered", async () => {
    const page = await reader().listRecords({ limit: 10 });
    const catalogOrder = await withCorpusMirrorStore(paths, async (store) =>
      (await store.catalog.findExecutions({ limit: 10, availability: "available" })).items
        .filter((item) => item.executorId === ALICE)
        .map((item) => item.reference.digest),
    );
    expect(page.items.map((item) => item.reference.digest)).toEqual(catalogOrder);
  });

  test("tags every candidate with the public plane", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items.every((item) => item.plane === "public")).toBe(true);
  });

  test("carries location hints derived from the catalog's observed locations", async () => {
    const page = await reader().listRecords({ limit: 10 });
    expect(page.items[0]!.locationHints[0]).toMatchObject({
      sourceId: "https://agents.test/alice/attempts",
      repositoryId: "archive.test/attempts",
    });
  });

  test("pages with an opaque cursor until it is exhausted", async () => {
    const instance = reader();
    const first = await instance.listRecords({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await instance.listRecords({ limit: 1, cursor: first.nextCursor });
    expect(second.items[0]!.reference.digest).not.toBe(first.items[0]!.reference.digest);
  });

  test("getRecord returns null for an unadmitted producer, not the record", async () => {
    expect(await reader().getRecord(seeded.malloryReference)).toBeNull();
    expect(await reader().getRecord(seeded.aliceReferences[0]!)).not.toBeNull();
  });

  test("getRecord returns null for a record that is not mirrored", async () => {
    expect(
      await reader().getRecord({ family: "execution-evidence", digest: `sha256:${"f".repeat(64)}` }),
    ).toBeNull();
  });

  test("describeSources reports the followed archives and their sync position", async () => {
    const marks = createFileHighWaterMarkStore({ filePath: statePath });
    await marks.put(
      { agent: source.agent, name: source.name },
      { sequence: "0000000000000004", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );
    const statuses = await reader().describeSources();
    expect(statuses).toEqual([
      {
        source: { agent: source.agent, name: source.name },
        servingRoot: source.servingRoot,
        repositoryId: source.repositoryId,
        highWaterMark: {
          sequence: "0000000000000004",
          entry: `sha256:${"a".repeat(64)}`,
          issuedAt: "2026-07-30T00:00:00Z",
        },
      },
    ]);
  });

  test("describeSources omits the mark for an archive never synced", async () => {
    const statuses = await reader().describeSources();
    expect(statuses[0]).not.toHaveProperty("highWaterMark");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/read.test.ts`
Expected: FAIL — `Failed to resolve import "./read.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/read.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type {
  CatalogPage,
  CatalogRecordProjection,
  EvidenceRecordLocation,
} from "@jinn-network/evidence-discovery";
import type { EvidenceRecordFamily, EvidenceRecordReference } from "@jinn-network/evidence-repository";
import type { RetrievalLocationHint } from "@jinn-network/evidence-retrieval";
import type {
  HighWaterMark,
  HighWaterMarkStore,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";
import { sourceIdOf } from "./announcements.js";
import { MIRROR_REPOSITORY_ID } from "./repositories.js";
import {
  withCorpusMirrorStore,
  type CorpusMirrorStore,
  type OpenCorpusMirrorStoreOptions,
} from "./store.js";

/**
 * A record from the public plane, already past trust filtering.
 *
 * `plane` is the string literal `"public"`. C6 declares the union
 * (`EvidencePlane = "local" | "public"` in `src/relevance/planes.ts`) and this
 * literal is assignable to it — C5 does not declare the union, because that
 * would put a dependency on the layer that consumes C5.
 */
export interface CorpusRecordCandidate {
  readonly reference: EvidenceRecordReference;
  readonly projection: CatalogRecordProjection;
  readonly plane: "public";
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface CorpusReadQuery {
  readonly family?: EvidenceRecordFamily;
  readonly executorId?: string;
  readonly outcome?: "completed" | "failed" | "abandoned";
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CorpusReadPage {
  readonly items: readonly CorpusRecordCandidate[];
  readonly nextCursor?: string;
  /** How many mirrored records this page's window dropped at the trust gate. */
  readonly excludedByTrust: number;
}

export interface CorpusReadOptions {
  readonly signal?: AbortSignal;
}

export interface MirrorSourceStatus {
  readonly source: SourceIdentity;
  readonly servingRoot: string;
  readonly repositoryId: string;
  readonly highWaterMark?: HighWaterMark;
}

/**
 * The read surface over the public-corpus mirror.
 *
 * It has NO sync method and holds NO reference to `CorpusMirror`. That is
 * cross-plan contract 5 ("mirror sync never blocks pickup") enforced by the
 * type rather than by a convention a caller can forget: a caller of this
 * interface literally cannot await a sync.
 */
export interface CorpusReader {
  listRecords(query?: CorpusReadQuery, options?: CorpusReadOptions): Promise<CorpusReadPage>;
  getRecord(
    reference: EvidenceRecordReference,
    options?: CorpusReadOptions,
  ): Promise<CorpusRecordCandidate | null>;
  describeSources(options?: CorpusReadOptions): Promise<readonly MirrorSourceStatus[]>;
}

export interface CreateCorpusReaderOptions {
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly sources: readonly MirrorSourceConfig[];
  readonly admission: CorpusAdmission;
  readonly highWaterMarks: HighWaterMarkStore;
}

/** The attributable producing agent, per record family. */
export function producerIdOf(projection: CatalogRecordProjection): string {
  switch (projection.family) {
    case "execution-evidence":
      return projection.executorId;
    case "result-evaluation":
      return projection.evaluatorId;
    case "execution-verification":
      return projection.verifierId;
  }
}

export function createCorpusReader(options: CreateCorpusReaderOptions): CorpusReader {
  const sourceIdByRepositoryId = new Map(
    options.sources.map((source) => [source.repositoryId, sourceIdOf(source)] as const),
  );

  function toHints(locations: readonly EvidenceRecordLocation[]): readonly RetrievalLocationHint[] {
    return locations.map((location) => ({
      sourceId: sourceIdByRepositoryId.get(location.repositoryId) ?? MIRROR_REPOSITORY_ID,
      repositoryId: location.repositoryId,
      ...(location.publishedLocation === undefined
        ? {}
        : { publishedLocation: location.publishedLocation }),
    }));
  }

  async function toCandidate(
    store: CorpusMirrorStore,
    projection: CatalogRecordProjection,
    options_?: CorpusReadOptions,
  ): Promise<CorpusRecordCandidate> {
    const locations = await store.catalog.getRecordLocations(projection.reference, options_);
    return {
      reference: projection.reference,
      projection,
      plane: "public",
      locationHints: toHints(locations),
    };
  }

  async function findPage(
    store: CorpusMirrorStore,
    query: CorpusReadQuery,
    options_?: CorpusReadOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    const page = {
      availability: "available" as const,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };

    // One family per call, deliberately: the catalog's cursors are per-query,
    // and inventing a cross-family cursor here would be this application
    // making a protocol decision. `execution-evidence` is the plane's
    // principal family and therefore the default.
    const family = query.family ?? "execution-evidence";
    if (family === "result-evaluation") {
      return store.catalog.findEvaluations(page, options_);
    }
    if (family === "execution-verification") {
      return store.catalog.findVerifications(page, options_);
    }
    return store.catalog.findExecutions(
      {
        ...page,
        ...(query.executorId === undefined ? {} : { executorId: query.executorId }),
        ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      },
      options_,
    );
  }

  return Object.freeze({
    async listRecords(
      query: CorpusReadQuery = {},
      options_?: CorpusReadOptions,
    ): Promise<CorpusReadPage> {
      return withCorpusMirrorStore(options.storePaths, async (store) => {
        const page = await findPage(store, query, options_);

        // TRUST FILTERING, before anything reaches ranking (cross-plan
        // contract 1). Catalog order is preserved exactly — filtering removes,
        // it never reorders. Relevance is C6's job.
        const items: CorpusRecordCandidate[] = [];
        let excludedByTrust = 0;
        for (const projection of page.items) {
          if (options.admission.admitProducer(producerIdOf(projection)).status === "rejected") {
            excludedByTrust += 1;
            continue;
          }
          items.push(await toCandidate(store, projection, options_));
        }

        return {
          items,
          excludedByTrust,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      });
    },

    async getRecord(
      reference: EvidenceRecordReference,
      options_?: CorpusReadOptions,
    ): Promise<CorpusRecordCandidate | null> {
      return withCorpusMirrorStore(options.storePaths, async (store) => {
        const projection = await store.catalog.getRecord(reference, options_);
        if (projection === null) return null;
        if (options.admission.admitProducer(producerIdOf(projection)).status === "rejected") {
          return null;
        }
        return toCandidate(store, projection, options_);
      });
    },

    async describeSources(): Promise<readonly MirrorSourceStatus[]> {
      const statuses: MirrorSourceStatus[] = [];
      for (const source of options.sources) {
        const identity: SourceIdentity = { agent: source.agent, name: source.name };
        const mark = await options.highWaterMarks.get(identity);
        statuses.push({
          source: identity,
          servingRoot: source.servingRoot,
          repositoryId: source.repositoryId,
          ...(mark === undefined ? {} : { highWaterMark: mark }),
        });
      }
      return statuses;
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/read.test.ts && yarn typecheck`
Expected: PASS (14 tests) once Task 14's `seedMirror` helper exists.

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): the corpus read seam with producer admission and no sync path"
```

---

### Task 12: Retrieval — exact bytes, validated, mismatch refused

**Files:**
- Create: `plugin/runtime/src/corpus/retrieve.ts`, `src/corpus/retrieve.test.ts`

**Interfaces:**
- Consumes: `createEvidenceRetrieval` from `@jinn-network/evidence-retrieval` (`packages/evidence/retrieval/src/retrieval.ts:10-12` — `createEvidenceRetrieval(options: CreateEvidenceRetrievalOptions): EvidenceRetrieval`, requiring `{ locator, locationPolicy, repositoryResolver, hardLimits?, telemetry? }`, `contracts.ts:388-394`); `EvidenceRecordLocator` (`contracts.ts:124-130`), `EvidenceLocationPolicy` (`:132-137`), `RetrievalLocationObservation` (`:56-62`), `RetrievalLocationAttempt` (`:64-67`), `ArtifactHydrationRequest` (`:155-157`), `ValidatedEvidenceResult` (`:230-241`), `EvidenceRetrievalFailure` (`:219-228`), `RetrievalHardLimits`, `RetrievalTelemetry`, `createEvidenceRetrievalFailure` (`errors.ts:22-32`); `producerIdOf` (Task 11); `MIRROR_REPOSITORY_ID` (Task 8); `withCorpusMirrorStore` (Task 9).
- Produces: `interface CorpusFetchOptions`; `type CorpusFetchOutcome`; `interface CorpusRetrieval`; `interface CreateCorpusRetrievalOptions`; `createCorpusRetrieval(options): CorpusRetrieval`.

The digest check is the stack's, not C5's: `validateCanonicalRecord` re-hashes fetched bytes and returns `RECORD_DIGEST_MISMATCH` at stage `"record"` (`packages/evidence/retrieval/src/validation.ts:60-68`). C5 adds a *second*, earlier refusal in the mirroring repository (Task 8). Both are tested, because they fire on different threats: the repository check stops a tampering upstream from poisoning the local store; the retrieval check stops a corrupt local store from serving bad bytes to the agent.

- [ ] **Step 1: Write the failing test**

`src/corpus/retrieve.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
} from "./admission.js";
import { createCorpusRetrieval } from "./retrieve.js";
import { seedMirror, type SeededMirror } from "./testing-fixture.js";

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const ALICE = "https://agents.test/alice";

const admitAlice = composeAdmission(createFollowedSourceAdmission([source]), {
  admitSource: () => ({ status: "admitted" as const }),
  admitProducer: (id: string) =>
    id === ALICE
      ? ({ status: "admitted" } as const)
      : ({ status: "rejected", reason: "producer-not-listed" } as const),
});

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string };
let seeded: SeededMirror;

function retrieval(overrides: Partial<Parameters<typeof createCorpusRetrieval>[0]> = {}) {
  return createCorpusRetrieval({
    storePaths: paths,
    sources: [source],
    admission: admitAlice,
    ...overrides,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-fetch-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
  };
  seeded = await seedMirror(paths, source);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("corpus retrieval", () => {
  test("returns the exact mirrored bytes for an admitted producer's record", async () => {
    const outcome = await retrieval().fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("fetched");
    if (outcome.status !== "fetched") throw new Error("unreachable");
    expect(recordDigest(outcome.result.canonicalBytes)).toBe(seeded.aliceReferences[0]!.digest);
    expect(outcome.result.validatedRecord.family).toBe("execution-evidence");
  });

  test("REFUSES a digest mismatch loudly, with the stack's own failure code", async () => {
    const tampering: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        return new TextEncoder().encode("tampered bytes");
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };

    const outcome = await retrieval({
      repositories: { async resolve() { return tampering; } },
    }).fetchRecord(seeded.aliceReferences[0]!);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("RECORD_DIGEST_MISMATCH");
    expect(outcome.failure.stage).toBe("record");
  });

  test("never surfaces mismatched bytes to the caller", async () => {
    const tampering: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        return new TextEncoder().encode("tampered bytes");
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };
    const outcome = await retrieval({
      repositories: { async resolve() { return tampering; } },
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(JSON.stringify(outcome)).not.toContain("tampered");
  });

  test("TRUST: refuses an unadmitted producer before touching any repository", async () => {
    let touched = false;
    const outcome = await retrieval({
      repositories: {
        async resolve() {
          touched = true;
          return null;
        },
      },
    }).fetchRecord(seeded.malloryReference);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("ACCEPTANCE_REJECTED");
    expect(outcome.failure.stage).toBe("acceptance");
    expect(touched).toBe(false);
  });

  test("TRUST: a fully denying admission refuses every record", async () => {
    const outcome = await retrieval({
      admission: composeAdmission(
        createFollowedSourceAdmission([source]),
        createDeniedProducerAdmission(),
      ),
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("failed");
  });

  test("reports a record that is not mirrored as NO_LOCATION rather than throwing", async () => {
    const outcome = await retrieval().fetchRecord({
      family: "execution-evidence",
      digest: `sha256:${"f".repeat(64)}`,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("NO_LOCATION");
  });

  test("prefers the local mirror over an upstream location", async () => {
    let upstreamReads = 0;
    const counting: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        upstreamReads += 1;
        return null;
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };
    const outcome = await retrieval({
      repositories: {
        async resolve(id: string) {
          return id === "jinn:corpus-mirror" ? seeded.localRepository : counting;
        },
      },
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("fetched");
    expect(upstreamReads).toBe(0);
  });

  test("propagates an abort as a failure value, not a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await retrieval().fetchRecord(seeded.aliceReferences[0]!, {
      signal: controller.signal,
    });
    expect(outcome.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/retrieve.test.ts`
Expected: FAIL — `Failed to resolve import "./retrieve.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/retrieve.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";
import {
  createEvidenceRetrieval,
  createEvidenceRetrievalFailure,
  type ArtifactHydrationRequest,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type EvidenceRetrievalFailure,
  type RetrievalHardLimits,
  type RetrievalLocationAttempt,
  type RetrievalLocationObservation,
  type RetrievalTelemetry,
  type ValidatedEvidenceResult,
} from "@jinn-network/evidence-retrieval";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";
import { sourceIdOf } from "./announcements.js";
import { describeError } from "./errors.js";
import { producerIdOf } from "./read.js";
import { MIRROR_REPOSITORY_ID, createCorpusRepositoryResolver } from "./repositories.js";
import { withCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

export interface CorpusFetchOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly artifacts?: ArtifactHydrationRequest;
}

export type CorpusFetchOutcome =
  | { readonly status: "fetched"; readonly result: ValidatedEvidenceResult }
  | { readonly status: "failed"; readonly failure: EvidenceRetrievalFailure };

export interface CorpusRetrieval {
  fetchRecord(
    reference: EvidenceRecordReference,
    options?: CorpusFetchOptions,
  ): Promise<CorpusFetchOutcome>;
}

export interface CreateCorpusRetrievalOptions {
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly sources: readonly MirrorSourceConfig[];
  readonly admission: CorpusAdmission;
  /** Overridable for tests; production builds the allowlist resolver per call. */
  readonly repositories?: EvidenceRepositoryResolver;
  readonly hardLimits?: Partial<RetrievalHardLimits>;
  readonly telemetry?: RetrievalTelemetry;
  readonly transport?: Parameters<typeof createCorpusRepositoryResolver>[0]["transport"];
}

/**
 * Exact-byte fetch over the public-corpus mirror.
 *
 * Order of operations, and why: the catalog projection is read FIRST so the
 * producing agent's identity is known, producer admission runs SECOND so an
 * unadmitted producer's bytes are never fetched at all, and only then does the
 * stack's `EvidenceRetrieval` run — which re-hashes the fetched bytes and
 * refuses `RECORD_DIGEST_MISMATCH` at stage `record`
 * (`packages/evidence/retrieval/src/validation.ts:60-68`).
 *
 * `fetchRecord` never throws for a data problem; every refusal is a value.
 */
export function createCorpusRetrieval(
  options: CreateCorpusRetrievalOptions,
): CorpusRetrieval {
  const sourceIdByRepositoryId = new Map(
    options.sources.map((source) => [source.repositoryId, sourceIdOf(source)] as const),
  );

  // The local mirror ranks first, then each configured archive in the order
  // the operator listed it. An unranked repository sorts last.
  const rank = new Map<string, number>([
    [MIRROR_REPOSITORY_ID, 0],
    ...options.sources.map((source, index) => [source.repositoryId, index + 1] as const),
  ]);

  const locationPolicy: EvidenceLocationPolicy = {
    select(
      _reference: EvidenceRecordReference,
      locations: readonly RetrievalLocationObservation[],
    ): readonly RetrievalLocationAttempt[] {
      return [...locations]
        .filter(
          (observation): observation is RetrievalLocationObservation & { repositoryId: string } =>
            observation.status === "available" && observation.repositoryId !== undefined,
        )
        .sort(
          (left, right) =>
            (rank.get(left.repositoryId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.repositoryId) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((observation) => ({ repositoryId: observation.repositoryId, observation }));
    },
  };

  return Object.freeze({
    async fetchRecord(
      reference: EvidenceRecordReference,
      fetchOptions?: CorpusFetchOptions,
    ): Promise<CorpusFetchOutcome> {
      try {
        return await withCorpusMirrorStore(options.storePaths, async (store) => {
          const catalogOptions =
            fetchOptions?.signal === undefined ? undefined : { signal: fetchOptions.signal };

          const projection = await store.catalog.getRecord(reference, catalogOptions);
          if (projection === null) {
            return {
              status: "failed" as const,
              failure: createEvidenceRetrievalFailure({
                code: "NO_LOCATION",
                stage: "location",
                message: "This record is not in the local mirror; sync the followed archives first.",
                reference,
              }),
            };
          }

          const decision = options.admission.admitProducer(producerIdOf(projection));
          if (decision.status === "rejected") {
            return {
              status: "failed" as const,
              failure: createEvidenceRetrievalFailure({
                code: "ACCEPTANCE_REJECTED",
                stage: "acceptance",
                message: `The producing agent is not admitted by trust policy (${decision.reason}).`,
                reference,
              }),
            };
          }

          const locator: EvidenceRecordLocator = {
            async locate(target, hints, operation) {
              const stored = await store.catalog.getRecordLocations(target, {
                signal: operation.signal,
              });
              const observations: RetrievalLocationObservation[] = [];
              let ordinal = 0;
              for (const location of stored) {
                if (observations.length >= operation.maximumLocations) break;
                observations.push({
                  observationId: `${target.digest}#${String(ordinal)}`,
                  sourceId: sourceIdByRepositoryId.get(location.repositoryId) ?? MIRROR_REPOSITORY_ID,
                  status: "available",
                  repositoryId: location.repositoryId,
                  ...(location.publishedLocation === undefined
                    ? {}
                    : { publishedLocation: location.publishedLocation }),
                });
                ordinal += 1;
              }
              for (const hint of hints) {
                if (observations.length >= operation.maximumLocations) break;
                if (observations.some((seen) => seen.repositoryId === hint.repositoryId)) continue;
                observations.push({
                  observationId: `${target.digest}#hint:${hint.repositoryId}`,
                  sourceId: hint.sourceId,
                  status: "available",
                  repositoryId: hint.repositoryId,
                  ...(hint.publishedLocation === undefined
                    ? {}
                    : { publishedLocation: hint.publishedLocation }),
                });
              }
              // The mirror's own store always holds a mirrored record.
              if (!observations.some((seen) => seen.repositoryId === MIRROR_REPOSITORY_ID)) {
                observations.unshift({
                  observationId: `${target.digest}#mirror`,
                  sourceId: MIRROR_REPOSITORY_ID,
                  status: "available",
                  repositoryId: MIRROR_REPOSITORY_ID,
                });
              }
              return observations;
            },
          };

          const repositoryResolver =
            options.repositories ??
            createCorpusRepositoryResolver({
              sources: options.sources,
              local: store.repository,
              ...(options.transport === undefined
                ? // With no transport the mirror serves only what it already
                  // holds — the always-available local view, offline.
                  { transport: { async fetch() { return { status: 503, bytes: new Uint8Array() }; } } }
                : { transport: options.transport }),
            });

          const retrieval = createEvidenceRetrieval({
            locator,
            locationPolicy,
            repositoryResolver,
            ...(options.hardLimits === undefined ? {} : { hardLimits: options.hardLimits }),
            ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
          });

          const outcome = await retrieval.retrieve(
            {
              reference,
              ...(fetchOptions?.artifacts === undefined
                ? {}
                : { artifacts: fetchOptions.artifacts }),
            },
            {
              ...(fetchOptions?.signal === undefined ? {} : { signal: fetchOptions.signal }),
              ...(fetchOptions?.timeoutMs === undefined ? {} : { timeoutMs: fetchOptions.timeoutMs }),
            },
          );

          return outcome.status === "validated"
            ? { status: "fetched" as const, result: outcome.result }
            : { status: "failed" as const, failure: outcome.failure };
        });
      } catch (error) {
        return {
          status: "failed",
          failure: createEvidenceRetrievalFailure({
            code: "OPERATION_ABORTED",
            stage: "record",
            message: describeError(error),
            reference,
            retryable: true,
          }),
        };
      }
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/retrieve.test.ts && yarn typecheck`
Expected: PASS (8 tests) once Task 14's `seedMirror` helper exists.

- [ ] **Step 5: Commit**

```bash
git add plugin/runtime/src/corpus
git commit -m "feat(plugin-runtime): validated exact-byte corpus retrieval that refuses a digest mismatch"
```

---

### Task 13: The runtime capability, health checks, and the barrel

**Files:**
- Create: `plugin/runtime/src/corpus/capability.ts`, `src/corpus/capability.test.ts`, `src/corpus/index.ts`
- Modify: `plugin/runtime/src/index.ts` (append one export line)

**Interfaces:**
- Consumes: `RuntimeCapability`, `CapabilityContext` from `plugin/runtime/src/capability.ts`; `HealthCheck` from `plugin/runtime/src/health.ts` (shape `{ name, ok, detail, remedy: string | null }`, where `remedy: null` is C3's "not fixable from this machine" state); `RuntimeLogger` from `plugin/runtime/src/logger.ts` — all on branch `plugin/c3-product-tree`; plus every C5 factory.
- Produces: `interface CorpusCapability extends RuntimeCapability { readonly mirror: CorpusMirror; readonly reader: CorpusReader; readonly retrieval: CorpusRetrieval }`; `createCorpusCapability(options: CreateCorpusCapabilityOptions): CorpusCapability`; and the barrel re-exporting every public C5 symbol.

Per C3's correction F-C3-8, `start()` does **cheap, contention-free setup only** — it opens no catalog and takes no lock. The three surfaces it builds are lazy: each opens the store per operation and closes it. `stop()` has nothing to release.

- [ ] **Step 1: Write the failing test**

`src/corpus/capability.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCorpusCapability } from "./capability.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { seedMirror } from "./testing-fixture.js";

let home: string;

const source = () => ({
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
});

const transport = {
  async fetch() {
    return { status: 503, bytes: new Uint8Array() };
  },
};

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function context(file?: unknown) {
  return {
    config: resolveRuntimeConfig({ env: {}, homeDirectory: home, ...(file === undefined ? {} : { file }) }),
    log: log(),
  };
}

function capability(file?: unknown) {
  const built = createCorpusCapability({
    transport,
    dsseVerifier: () => ({ validSignerKeyids: [] }),
    readPolicyVersions: async () => [],
  });
  return { capability: built, context: context(file) };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-cap-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("corpus capability", () => {
  test("is named so the runtime's health report is legible", () => {
    expect(capability().capability.name).toBe("corpus");
  });

  test("start does not open the catalog — no file exists afterwards", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const { access } = await import("node:fs/promises");
    await expect(access(built_context.config.mirrorCatalogPath)).rejects.toBeDefined();
    await built.stop!();
  });

  test("reports an honest green when no archive is configured", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const mirror = (await built.healthChecks!()).find((check) => check.name === "corpus-mirror")!;
    expect(mirror.ok).toBe(true);
    expect(mirror.detail).toContain("no archives");
    // Nothing to do when you deliberately follow none.
    expect(mirror.remedy).toBeNull();
  });

  test("detects a sync position that outlived its catalog, and says how to repair it", async () => {
    // The wedge of Finding F11: the state file survives a catalog that no
    // longer holds the data it describes, so `returningSync` resumes past
    // records that are gone and imports nothing, forever.
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);

    // A position exists; the catalog was never populated.
    await createFileHighWaterMarkStore({
      filePath: built_context.config.mirrorStatePath,
    }).put(
      { agent: source().agent, name: source().name },
      { sequence: "0000000000000009", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );

    const mirror = (await built.healthChecks!()).find((check) => check.name === "corpus-mirror")!;
    expect(mirror.ok).toBe(false);
    expect(mirror.detail).toContain("ahead of the catalog");
    expect(mirror.remedy).toContain(built_context.config.mirrorStatePath);
  });

  test("a fully trust-filtered catalog is NOT misreported as a wedged mirror", async () => {
    // `mirrorHasAnyRecord` reads the catalog raw for exactly this reason: an
    // unadmitted-producer catalog holds data, so it is not wedged, and the
    // trust story belongs to `corpus-trust-policy`.
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    await seedMirror(
      {
        catalogPath: built_context.config.mirrorCatalogPath,
        objectsDirectory: built_context.config.mirrorObjectsDirectory,
      },
      source(),
    );
    await createFileHighWaterMarkStore({
      filePath: built_context.config.mirrorStatePath,
    }).put(
      { agent: source().agent, name: source().name },
      { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );

    const checks = await built.healthChecks!();
    // No trust policy is configured, so the reader admits nobody...
    expect((await built.reader.listRecords()).items).toEqual([]);
    // ...but the mirror itself is healthy, and only the trust row is red.
    expect(checks.find((check) => check.name === "corpus-mirror")!.ok).toBe(true);
    expect(checks.find((check) => check.name === "corpus-trust-policy")!.ok).toBe(false);
  });

  test("NO CHECK IS A RELEASE NOTE: every emitted check can vary by install", async () => {
    // C5's own scan of the rule Finding F9 established. A check whose `ok` is
    // the same on every possible install is a release note; it belongs in
    // `detail` or in the doctor's trailing render, not in the pass/fail set.
    // An earlier draft's `corpus-sources` failed this and was removed.
    const empty = capability();
    await empty.capability.start!(empty.context);
    const withArchives = capability({ corpus: { sources: [source()] } });
    await withArchives.capability.start!(withArchives.context);

    const a = await empty.capability.healthChecks!();
    const b = await withArchives.capability.healthChecks!();

    expect(a.map((check) => check.name).sort()).toEqual([
      "corpus-chain-verification",
      "corpus-mirror",
      "corpus-trust-policy",
    ]);
    // At least one check must disagree between the two installs, and no check
    // may be pinned green-or-red for all of them.
    const differing = a.filter(
      (check) => b.find((other) => other.name === check.name)!.ok !== check.ok,
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  test("reports the trust policy as not fixable from this machine when unresolvable", async () => {
    const built = createCorpusCapability({
      transport,
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => {
        throw new Error("policy directory unreadable");
      },
    });
    const built_context = context({
      corpus: {
        sources: [source()],
        trust: { genesisDigest: `sha256:${"a".repeat(64)}`, policyDirectory: "policy" },
      },
    });
    await built.start!(built_context);
    const checks = await built.healthChecks!();
    const trust = checks.find((check) => check.name === "corpus-trust-policy")!;
    expect(trust.ok).toBe(false);
    expect(trust.remedy).toBeNull();
  });

  test("an acknowledged unverified posture is GREEN and names itself plainly", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()], acknowledgeUnverifiedChain: true },
    });
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    // Green because the install is configured coherently and is doing what
    // the operator asked. The posture is still stated, not hidden.
    expect(chain.ok).toBe(true);
    expect(chain.detail).toContain("not verified");
    expect(chain.remedy).toBeNull();
  });

  test("RED means a real, fixable misconfiguration: archives followed but no posture chosen", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain("will not index");
    expect(chain.remedy).toContain("acknowledgeUnverifiedChain");
  });

  test("green when there is nothing to verify — no archives configured", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(true);
  });

  test("health checks before start throw rather than lying", async () => {
    const { capability: built } = capability();
    await expect(built.healthChecks!()).rejects.toBeDefined();
  });

  test("exposes the three surfaces C6 and C7 consume", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    expect(typeof built.mirror.syncOnce).toBe("function");
    expect(typeof built.reader.listRecords).toBe("function");
    expect(typeof built.retrieval.fetchRecord).toBe("function");
  });

  test("FAIL-CLOSED: with no trust configuration nothing is admitted", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    // Sync is skipped-or-failed, and even a populated mirror would read empty.
    const page = await built.reader.listRecords();
    expect(page.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test src/corpus/capability.test.ts`
Expected: FAIL — `Failed to resolve import "./capability.js"`.

- [ ] **Step 3: Write the implementation**

`src/corpus/capability.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { DsseChainVerifier, Sha256Digest } from "@jinn-network/trust-core";
import type { Transport } from "@jinn-network/record-discovery-client";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { CorpusConfig, RuntimeConfig } from "../config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "../errors.js";
import type { HealthCheck } from "../health.js";
import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
  type CorpusAdmission,
} from "./admission.js";
import {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
  type ChainVerification,
} from "./chain-verification.js";
import { describeError } from "./errors.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { createCorpusMirror, type CorpusMirror } from "./mirror.js";
import { createCorpusReader, type CorpusReader } from "./read.js";
import { createCorpusRetrieval, type CorpusRetrieval } from "./retrieve.js";
import { withCorpusMirrorStore } from "./store.js";

export interface CreateCorpusCapabilityOptions {
  readonly transport: Transport;
  /** Injected per custody law C1/C3 — C5 implements no cryptography. */
  readonly dsseVerifier: DsseChainVerifier;
  /** Host-supplied loader for the trust-policy version chain. */
  readonly readPolicyVersions: (directory: string) => Promise<readonly Uint8Array[]>;
  readonly now?: () => Date;
}

export interface CorpusCapability extends RuntimeCapability {
  readonly mirror: CorpusMirror;
  readonly reader: CorpusReader;
  readonly retrieval: CorpusRetrieval;
}

interface Started {
  readonly config: RuntimeConfig;
  readonly corpus: CorpusConfig;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  readonly policyError?: string;
  readonly policyCount: number;
}

export function createCorpusCapability(
  options: CreateCorpusCapabilityOptions,
): CorpusCapability {
  const now = options.now ?? (() => new Date());
  let started: Started | undefined;

  function require_(): Started {
    if (started === undefined) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.runtimeNotStarted,
        "The corpus capability has not been started.",
      );
    }
    return started;
  }

  return Object.freeze({
    name: "corpus",

    async start(context: CapabilityContext): Promise<void> {
      // Cheap, contention-free setup only (C3 finding F-C3-8): no catalog is
      // opened and no lock is taken here. Every surface below opens the store
      // per operation and closes it.
      const corpus = context.config.corpus;

      let policyVersions: readonly Uint8Array[] = [];
      let policyError: string | undefined;
      if (corpus.trust !== undefined) {
        try {
          policyVersions = await options.readPolicyVersions(corpus.trust.policyDirectory);
        } catch (error) {
          policyError = describeError(error);
        }
      }

      const producerAdmission: CorpusAdmission =
        corpus.trust === undefined || policyError !== undefined
          ? createDeniedProducerAdmission()
          : createTrustPolicyAdmission({
              policyVersions,
              genesisDigest: corpus.trust.genesisDigest as Sha256Digest,
              producerPurpose: corpus.trust.producerPurpose,
              now: () => now().toISOString(),
              dsseVerifier: options.dsseVerifier,
            });

      started = {
        config: context.config,
        corpus,
        admission: composeAdmission(
          createFollowedSourceAdmission(corpus.sources),
          producerAdmission,
        ),
        chainVerification: corpus.acknowledgeUnverifiedChain
          ? createUnverifiedChainVerification(UNVERIFIED_CHAIN_ACKNOWLEDGEMENT)
          : createRejectingChainVerification(),
        ...(policyError === undefined ? {} : { policyError }),
        policyCount: policyVersions.length,
      };

      context.log.info("corpus.capability.started", {
        archives: corpus.sources.length,
        chainVerification: started.chainVerification.mode,
      });
    },

    async stop(): Promise<void> {
      started = undefined;
    },

    async healthChecks(): Promise<readonly HealthCheck[]> {
      const state = require_();
      const reader = buildReader(state);
      const statuses = await reader.describeSources();
      const synced = statuses.filter((status) => status.highWaterMark !== undefined).length;

      // There is deliberately no `corpus-sources` check. An earlier draft had
      // one, and it was a release note wearing a check's clothes: its `ok` was
      // unconditionally `true`, so it could never tell an operator anything,
      // and its remedy ("add entries under `corpus.sources`") was a no-op for
      // anyone who deliberately follows none. Its only real content — the
      // archive count and the honest empty state — is folded into
      // `corpus-mirror`'s detail below, where it sits beside a condition that
      // actually varies. See Finding F9.
      const followed = state.corpus.sources.length;

      // The sync position lives in a file SEPARATE from the catalog
      // (`mirrorStatePath` vs `mirrorCatalogPath`), so it can outlive the data
      // it describes — the mirror image of the bug C6 hit, where a marker
      // derived from live rows died with them. If the catalog is deleted or
      // recreated while the state file survives, `returningSync` resumes from a
      // position whose records are gone, walks nothing new, and the mirror
      // stays permanently empty while reporting a sync position. That wedge is
      // detected here rather than reported as green. See Finding F11.
      const populated = followed === 0 ? true : await mirrorHasAnyRecord(state);
      const wedged = synced > 0 && !populated;

      const checks: HealthCheck[] = [
        {
          name: "corpus-mirror",
          // Green with no archives (nothing to sync) and green once at least
          // one archive has a position AND the catalog actually holds records;
          // red when archives are followed but nothing has synced, and red when
          // a sync position survives a catalog that no longer has the data.
          ok: followed === 0 || (synced > 0 && populated),
          detail:
            followed === 0
              ? "Following no archives — the corpus is empty by configuration."
              : wedged
                ? `${String(synced)} archive(s) report a sync position but the mirror holds no records — ` +
                  "the stored position is ahead of the catalog, so no further sync will import anything."
                : `${String(synced)} of ${String(followed)} followed archive(s) have a sync position.`,
          remedy:
            followed === 0
              ? null
              : wedged
                ? // This one genuinely repairs the state: clearing the position
                  // makes the next sync a cold walk from genesis.
                  `Delete the mirror state file at ${state.config.mirrorStatePath} to re-sync from genesis.`
                : "Run a mirror sync; the runtime also syncs opportunistically at session start.",
        },
        // This check measures whether THIS INSTALL is configured coherently —
        // not whether this VERSION of the software has a verification driver.
        // The latter is a universal, operator-unfixable capability fact (C5
        // Finding F1); reporting it as a per-install failure would make every
        // correct install red with a remedy nobody can act on, which spec §9.3
        // forbids by name ("the doctor reports a known-outage state ... instead
        // of printing a no-op remedy") and which trains operators to ignore red.
        chainVerificationCheck(state),
      ];

      if (state.corpus.trust === undefined) {
        checks.push({
          name: "corpus-trust-policy",
          ok: false,
          detail: "No trust policy is configured, so no producer is admitted.",
          remedy: "Set `corpus.trust.genesisDigest` and `corpus.trust.policyDirectory`.",
        });
      } else if (state.policyError !== undefined) {
        checks.push({
          name: "corpus-trust-policy",
          ok: false,
          detail: `The trust policy could not be read: ${state.policyError}`,
          // C3's "not fixable from this machine" state.
          remedy: null,
        });
      } else {
        checks.push({
          name: "corpus-trust-policy",
          ok: state.policyCount > 0,
          detail: `${String(state.policyCount)} trust-policy version(s) loaded.`,
          remedy:
            state.policyCount > 0
              ? null
              : "Populate the configured trust-policy directory with the signed version chain.",
        });
      }

      return checks;
    },

    get mirror(): CorpusMirror {
      const state = require_();
      return createCorpusMirror({
        sources: state.corpus.sources,
        maxEntriesPerSync: state.corpus.maxEntriesPerSync,
        lockPath: state.config.mirrorLockPath,
        storePaths: storePathsOf(state.config),
        highWaterMarks: createFileHighWaterMarkStore({
          filePath: state.config.mirrorStatePath,
        }),
        admission: state.admission,
        chainVerification: state.chainVerification,
        transport: options.transport,
        log: loggerOf(state),
      });
    },

    get reader(): CorpusReader {
      return buildReader(require_());
    },

    get retrieval(): CorpusRetrieval {
      const state = require_();
      return createCorpusRetrieval({
        storePaths: storePathsOf(state.config),
        sources: state.corpus.sources,
        admission: state.admission,
        transport: options.transport,
      });
    },
  });

  function storePathsOf(config: RuntimeConfig) {
    return {
      catalogPath: config.mirrorCatalogPath,
      objectsDirectory: config.mirrorObjectsDirectory,
      now,
    };
  }

  /**
   * Does the mirror hold any record at all, across all three families?
   *
   * Reads the catalog RAW rather than going through `CorpusReader`: the reader
   * is trust-filtered, so a catalog whose every producer is currently
   * unadmitted would look empty and be misreported as a wedged mirror. The
   * question here is about data presence, not admissibility — the trust
   * question is `corpus-trust-policy`'s row, and conflating the two is exactly
   * the misattribution Finding F10 is about, in miniature.
   */
  async function mirrorHasAnyRecord(state: Started): Promise<boolean> {
    return withCorpusMirrorStore(storePathsOf(state.config), async (store) => {
      const [executions, evaluations, verifications] = await Promise.all([
        store.catalog.findExecutions({ limit: 1, availability: "available" }),
        store.catalog.findEvaluations({ limit: 1, availability: "available" }),
        store.catalog.findVerifications({ limit: 1, availability: "available" }),
      ]);
      return (
        executions.items.length > 0 ||
        evaluations.items.length > 0 ||
        verifications.items.length > 0
      );
    });
  }

  /**
   * Posture-vs-configuration, deliberately — NOT capability presence.
   *
   * Three states, and each carries information a different one does not:
   *  - nothing to verify (no archives followed) → green;
   *  - a driver is wired → green, and the check silently starts reporting a
   *    real verification result the day one exists;
   *  - archives followed with the unverified posture acknowledged → green,
   *    with the posture named in `detail` and `remedy: null`, because the
   *    operator explicitly wrote that flag and there is nothing to do;
   *  - archives followed with NO posture chosen → red, because this install
   *    will silently never index anything, and one config line fixes it.
   *
   * Red therefore means "something here is wrong and you can fix it", which is
   * the only meaning that keeps red worth reading.
   */
  function chainVerificationCheck(state: Started): HealthCheck {
    if (state.chainVerification.mode === "verified") {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail: "Announcement chains are verified before indexing.",
        remedy: null,
      };
    }
    if (state.corpus.sources.length === 0) {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail: "No archives are followed, so there is no announcement chain to verify.",
        remedy: null,
      };
    }
    if (state.corpus.acknowledgeUnverifiedChain) {
      return {
        name: "corpus-chain-verification",
        ok: true,
        detail:
          "Mirroring without announcement-chain verification — signatures on followed archives " +
          "are not verified by this runtime. Record digests and producer admission still apply.",
        remedy: null,
      };
    }
    return {
      name: "corpus-chain-verification",
      ok: false,
      detail:
        `${String(state.corpus.sources.length)} archive(s) are followed but no chain-verification ` +
        "posture was chosen, so the mirror will not index anything from them.",
      remedy:
        "Set `corpus.acknowledgeUnverifiedChain` to true to mirror without chain verification, " +
        "or stop following archives under `corpus.sources`.",
    };
  }

  function buildReader(state: Started): CorpusReader {
    return createCorpusReader({
      storePaths: storePathsOf(state.config),
      sources: state.corpus.sources,
      admission: state.admission,
      highWaterMarks: createFileHighWaterMarkStore({ filePath: state.config.mirrorStatePath }),
    });
  }

  function loggerOf(state: Started) {
    void state;
    return {
      debug(): void {},
      info(): void {},
      warn(): void {},
      error(): void {},
    };
  }
}
```

> `loggerOf` above is a placeholder. Replace it by capturing `context.log` into `Started` in `start()` (add `readonly log: RuntimeLogger` to the `Started` interface, set it from `context.log`, and return `state.log`). The test's `log()` spies are what verify it.

- [ ] **Step 4: Capture the logger as noted, then write the barrel**

`src/corpus/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export {
  DEFAULT_CORPUS_PRODUCER_PURPOSE,
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
  type AdmissionDecision,
  type AdmissionRejectionReason,
  type CorpusAdmission,
  type PolicyChainVerifier,
  type TrustPolicyAdmissionOptions,
} from "./admission.js";
export {
  FAMILY_BY_RECORD_KIND,
  adaptAnnouncementEntry,
  sourceIdOf,
  type AnnouncementAdaptation,
  type ExcludedAnnouncement,
  type ExclusionReason,
} from "./announcements.js";
export {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
  type ChainVerification,
  type ChainVerificationInput,
  type ChainVerificationOutcome,
  type UnverifiedChainAcknowledgement,
} from "./chain-verification.js";
export {
  createCorpusCapability,
  type CorpusCapability,
  type CreateCorpusCapabilityOptions,
} from "./capability.js";
export {
  CORPUS_ERROR_CODES,
  CorpusMirrorError,
  type CorpusErrorCode,
} from "./errors.js";
export {
  HIGH_WATER_MARK_FORMAT,
  createFileHighWaterMarkStore,
} from "./high-water-mark.js";
export {
  CORPUS_SYNC_LOCK_FORMAT,
  tryAcquireSyncLock,
  type CorpusSyncLock,
} from "./lock.js";
export {
  createCorpusMirror,
  type CorpusMirror,
  type CreateCorpusMirrorOptions,
  type MirrorSourceSyncReport,
  type MirrorSyncOutcome,
  type MirrorSyncStatus,
} from "./mirror.js";
export {
  createCorpusReader,
  producerIdOf,
  type CorpusReadOptions,
  type CorpusReadPage,
  type CorpusReadQuery,
  type CorpusReader,
  type CorpusRecordCandidate,
  type CreateCorpusReaderOptions,
  type MirrorSourceStatus,
} from "./read.js";
export {
  MIRROR_REPOSITORY_ID,
  createCorpusRepositoryResolver,
  createMirroringRepository,
  createServingPlaneRepository,
} from "./repositories.js";
export {
  createCorpusRetrieval,
  type CorpusFetchOptions,
  type CorpusFetchOutcome,
  type CorpusRetrieval,
  type CreateCorpusRetrievalOptions,
} from "./retrieve.js";
export {
  CORPUS_PROJECTOR_VERSION,
  openCorpusMirrorStore,
  withCorpusMirrorStore,
  type CorpusMirrorStore,
  type OpenCorpusMirrorStoreOptions,
} from "./store.js";
```

Note the barrel deliberately does **not** export `testing-fixture.js`.

Append to `plugin/runtime/src/index.ts`:

```ts
export * from "./corpus/index.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test src/corpus/capability.test.ts && yarn typecheck`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add plugin/runtime/src plugin/runtime/src/index.ts
git commit -m "feat(plugin-runtime): expose the corpus as a runtime capability with honest health checks"
```

---

### Task 14: Fixtures, the end-to-end proof, and the guards

**Files:**
- Create: `plugin/runtime/fixtures/corpus/execution-evidence.valid.json`, `fixtures/corpus/README.md`
- Modify: `plugin/runtime/src/corpus/testing-fixture.ts` (add `seedMirror`, `executionProjection`)
- Create: `plugin/runtime/src/corpus/corpus.integration.test.ts`

**Interfaces:**
- Consumes: `validateAndProjectEvidenceRecord` from `@jinn-network/evidence-discovery/indexer`; `createEvidenceIndexer`; every C5 surface.
- Produces: `interface SeededMirror { aliceReferences: readonly EvidenceRecordReference[]; malloryReference: EvidenceRecordReference; localRepository: EvidenceRepository }`; `seedMirror(paths, source): Promise<SeededMirror>`; `executionProjection(overrides): ExecutionEvidenceProjection`.

- [ ] **Step 1: Import the golden record fixture rather than authoring one**

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p plugin/runtime/fixtures/corpus
ls packages/evidence/protocol/fixtures/
```

Copy the conforming Execution Evidence golden fixture into
`plugin/runtime/fixtures/corpus/execution-evidence.valid.json`, byte-for-byte. If the file name differs from what `ls` shows, use the actual one — the requirement is that this tree never authors a second copy of the record family's truth.

Write `fixtures/corpus/README.md`:

```markdown
# Corpus test fixtures

`execution-evidence.valid.json` is a byte-for-byte copy of
`packages/evidence/protocol`'s own conforming Execution Evidence golden
fixture. It is copied, never re-authored: the record family's truth lives in
`evidence/protocol`, and a second hand-written copy here would drift.

Regenerate with:

    cp ../../../../packages/evidence/protocol/fixtures/<name>.json \
       execution-evidence.valid.json

These fixtures are test-only and are not in the package's `files` list.
```

- [ ] **Step 2: Verify the fixture validates before building anything on it**

```bash
cd plugin/runtime
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateExecutionEvidence } from '@jinn-network/evidence-protocol';
const bytes = new Uint8Array(readFileSync('fixtures/corpus/execution-evidence.valid.json'));
const report = validateExecutionEvidence(bytes);
console.log(JSON.stringify({ conforms: report.conforms, diagnostics: report.diagnostics }));
"
```
Expected: `{"conforms":true,"diagnostics":[]}`. If it is false, the wrong file was copied — fix before continuing.

- [ ] **Step 3: Extend the fixture helper with `seedMirror`**

Append to `src/corpus/testing-fixture.ts`:

```ts
import { createEvidenceIndexer } from "@jinn-network/evidence-discovery/indexer";
import { recordDigest } from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import type { ExecutionEvidenceProjection } from "@jinn-network/evidence-discovery";

import type { MirrorSourceConfig } from "../config.js";
import { openCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

export interface SeededMirror {
  readonly aliceReferences: readonly EvidenceRecordReference[];
  readonly malloryReference: EvidenceRecordReference;
  readonly localRepository: EvidenceRepository;
}

/**
 * Seeds a mirror with three execution records — two produced by
 * `https://agents.test/alice`, one by `https://agents.test/mallory` — by
 * running the real indexer against an in-memory repository, so the seeded
 * projections are the ones production would write, not hand-built ones.
 *
 * The three records differ only in their `executorId`, so each has a distinct
 * digest and the trust-filtering tests can assert on producer identity alone.
 */
export async function seedMirror(
  paths: OpenCorpusMirrorStoreOptions,
  source: MirrorSourceConfig,
): Promise<SeededMirror> {
  const template = JSON.parse(new TextDecoder().decode(executionEvidenceFixture.bytes)) as Record<
    string,
    unknown
  >;

  const variants = [
    { executorId: "https://agents.test/alice", executionId: "exec-1" },
    { executorId: "https://agents.test/alice", executionId: "exec-2" },
    { executorId: "https://agents.test/mallory", executionId: "exec-3" },
  ];

  const store = await openCorpusMirrorStore(paths);
  try {
    const seeded: { reference: EvidenceRecordReference; executorId: string }[] = [];
    const byDigest = new Map<string, Uint8Array>();

    for (const variant of variants) {
      const bytes = canonicalize({ ...template, ...applyVariant(template, variant) });
      const reference = {
        family: "execution-evidence" as const,
        digest: recordDigest(bytes),
      };
      byDigest.set(reference.digest, bytes);
      seeded.push({ reference, executorId: variant.executorId });
    }

    const indexer = createEvidenceIndexer({
      catalog: store.catalog,
      repositories: {
        async resolve() {
          return {
            capabilities: {},
            async getRecord(reference: EvidenceRecordReference) {
              return byDigest.get(reference.digest) ?? null;
            },
            async getArtifact() {
              return null;
            },
            async putRecord() {
              throw new Error("seed repository is read-only");
            },
            async putArtifact() {
              throw new Error("seed repository is read-only");
            },
          } as EvidenceRepository;
        },
      },
    });

    let ordinal = 0;
    for (const entry of seeded) {
      ordinal += 1;
      await indexer.index({
        kind: "available",
        sourceId: `${source.agent}/${source.name}`,
        announcementId: `ann-${String(ordinal)}`,
        repositoryId: source.repositoryId,
        reference: entry.reference,
      });
      await store.repository.putRecord(
        "execution-evidence",
        byDigest.get(entry.reference.digest)!,
      );
    }

    return {
      aliceReferences: seeded
        .filter((entry) => entry.executorId === "https://agents.test/alice")
        .map((entry) => entry.reference),
      malloryReference: seeded.find(
        (entry) => entry.executorId === "https://agents.test/mallory",
      )!.reference,
      localRepository: store.repository,
    };
  } finally {
    await store.close();
  }
}
```

`applyVariant` and `canonicalize` are two small local helpers: `applyVariant` sets the record's executor and execution identifiers at whatever paths the golden fixture uses (read them from the file in Step 1 and write the exact paths here — do not guess), and `canonicalize` re-serializes with `@jinn-network/evidence-protocol`'s own canonical serializer so the mutated record is still a conforming, sealed document. Write both against the fixture you actually copied, and re-run Step 2's validation over each variant before proceeding:

```bash
cd plugin/runtime && yarn test src/corpus/testing-fixture.test.ts
```

Add `src/corpus/testing-fixture.test.ts` asserting each of the three variants validates via `validateExecutionEvidence` and that all three digests are distinct. That test is the guard against a mutation that silently produces a nonconforming record.

`executionProjection(overrides)` is a thin helper returning a valid `ExecutionEvidenceProjection` for the `producerIdOf` unit test; build it from `validateAndProjectEvidenceRecord` over a seeded variant rather than by hand.

- [ ] **Step 4: Write the end-to-end integration test**

`src/corpus/corpus.integration.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCorpusCapability } from "./capability.js";
import { buildFixtureArchive } from "./testing-fixture.js";

let home: string;

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const TRUST_GENESIS = `sha256:${"c".repeat(64)}`;

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-e2e-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("corpus end to end", () => {
  test("follow → sync → filter → read → fetch, with an admitted producer", async () => {
    const archive = buildFixtureArchive(source, ["https://agents.test/alice"]);

    const capability = createCorpusCapability({
      transport: archive.transport,
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });

    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: TRUST_GENESIS, policyDirectory: "policy" },
        },
      },
    });

    await capability.start!({ config, log: log() });

    // 1. Sync.
    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]!.indexed).toBeGreaterThan(0);

    // 2. Read — trust filtering has already run.
    const page = await capability.reader.listRecords({ limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.plane === "public")).toBe(true);

    // 3. Fetch exact bytes.
    const fetched = await capability.retrieval.fetchRecord(page.items[0]!.reference);
    expect(fetched.status).toBe("fetched");
    if (fetched.status !== "fetched") throw new Error("unreachable");
    expect(recordDigest(fetched.result.canonicalBytes)).toBe(page.items[0]!.reference.digest);

    // 4. Offline: the mirror still serves after the archive goes away.
    const offline = createCorpusCapability({
      transport: {
        async fetch() {
          throw new Error("archive unreachable");
        },
      },
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });
    await offline.start!({ config, log: log() });
    expect((await offline.reader.listRecords({ limit: 10 })).items.length).toBeGreaterThan(0);
    expect((await offline.mirror.syncOnce()).status).toBe("failed");
  });

  test("FAIL-CLOSED: an unadmitted producer is mirrored but never read or fetched", async () => {
    const archive = buildFixtureArchive(source, []); // policy lists nobody

    const capability = createCorpusCapability({
      transport: archive.transport,
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => archive.policyVersions,
      now: () => new Date("2026-07-30T00:00:00Z"),
    });
    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: TRUST_GENESIS, policyDirectory: "policy" },
        },
      },
    });
    await capability.start!({ config, log: log() });

    expect((await capability.mirror.syncOnce()).sources[0]!.indexed).toBeGreaterThan(0);

    const page = await capability.reader.listRecords({ limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.excludedByTrust).toBeGreaterThan(0);

    const fetched = await capability.retrieval.fetchRecord(archive.reference);
    expect(fetched.status).toBe("failed");
  });

  test("FAIL-OPEN on absence: an empty corpus reads empty and work proceeds", async () => {
    const capability = createCorpusCapability({
      transport: { async fetch() { return { status: 404, bytes: new Uint8Array() }; } },
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => [],
    });
    const config = resolveRuntimeConfig({ env: {}, homeDirectory: home });
    await capability.start!({ config, log: log() });

    const page = await capability.reader.listRecords();
    expect(page).toEqual({ items: [], excludedByTrust: 0 });
    // No throw: absence of results is not an error.
  });

  test("CONCURRENCY: two runtimes, one syncs and one skips; both read", async () => {
    const archive = buildFixtureArchive(source, ["https://agents.test/alice"]);
    const config = resolveRuntimeConfig({
      env: {},
      homeDirectory: home,
      file: {
        corpus: {
          sources: [source],
          acknowledgeUnverifiedChain: true,
          trust: { genesisDigest: TRUST_GENESIS, policyDirectory: "policy" },
        },
      },
    });

    const build = () =>
      createCorpusCapability({
        transport: archive.slowTransport,
        dsseVerifier: () => ({ validSignerKeyids: [] }),
        readPolicyVersions: async () => archive.policyVersions,
        now: () => new Date("2026-07-30T00:00:00Z"),
      });

    const first = build();
    const second = build();
    await first.start!({ config, log: log() });
    await second.start!({ config, log: log() });

    const [a, b] = await Promise.all([first.mirror.syncOnce(), second.mirror.syncOnce()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["skipped-locked", "synced"]);

    // Both readers serve the mirror regardless of who won the lock.
    expect((await first.reader.listRecords()).items.length).toBeGreaterThan(0);
    expect((await second.reader.listRecords()).items.length).toBeGreaterThan(0);
  });
});
```

`buildFixtureArchive(source, admittedProducers)` is the last fixture helper: it returns `{ transport, slowTransport, policyVersions, reference }`, where `transport` serves the head, one archive page, and the record bytes for the seeded variants (the shape is already written in Task 10's `buildArchive`; generalize that one and export it), `slowTransport` adds a ~50 ms delay per fetch so the concurrency test has a real window, and `policyVersions` is a one-version trust-policy chain whose genesis digest is `TRUST_GENESIS` and whose `jinn:corpus-producer` purpose lists `admittedProducers`. Build the policy with `sealTrustPolicy` from `@jinn-network/trust-core` against a test signer from `@jinn-network/trust-testing`, and pass a `dsseVerifier` stub — C5 verifies no signatures itself, so the stub is the honest test double.

> If constructing a real signed policy chain proves to cost more than the assertion is worth, use `createTrustPolicyAdmission`'s `verifyChain` seam instead and record the substitution in the test's own comment. Do **not** weaken production code to make the test easier.

- [ ] **Step 5: Run everything**

```bash
cd plugin/runtime && yarn typecheck && yarn test
cd ../.. && node --test .github/scripts/plugin-tree-package-inventory.test.mjs \
  && node --test .github/scripts/plugin-tree-source-boundaries.test.mjs \
  && node --test .github/scripts/plugin-tree-packed-types.test.mjs
```
Expected: all green — 15 C5 suites (config, errors, high-water-mark, lock, admission, chain-verification, announcements, repositories, store, mirror, read, retrieve, capability, testing-fixture, integration) plus all three guards.

- [ ] **Step 6: Run the consumed stack packages' kits**

Per the program's §9.4 rule — the product carries no kit of its own, but it runs the kits of what it composes:

```bash
cd packages/evidence/retrieval && yarn test
cd ../catalog-sqlite && yarn test
cd ../discovery && yarn test
cd ../../discovery/client && yarn test
cd ../../trust/core && yarn test
```
Expected: all green. A red here means C5's usage revealed a defect in a consumed package — file it as a finding against that package, do not work around it.

- [ ] **Step 7: Commit**

```bash
git add plugin/runtime/fixtures plugin/runtime/src/corpus
git commit -m "test(plugin-runtime): end-to-end corpus mirror, trust filtering, and retrieval proof"
```

---

## The seam C6 consumes

C6 merges this branch. These are the exact symbols its indexer and ranker call; all are re-exported from `plugin/runtime/src/corpus/index.ts` and thence from `plugin/runtime/src/index.ts`.

```ts
// Enumeration to index over. Page until `nextCursor` is undefined.
createCorpusReader(options: CreateCorpusReaderOptions): CorpusReader;
interface CorpusReader {
  listRecords(query?: CorpusReadQuery, options?: CorpusReadOptions): Promise<CorpusReadPage>;
  getRecord(reference: EvidenceRecordReference, options?: CorpusReadOptions): Promise<CorpusRecordCandidate | null>;
  describeSources(options?: CorpusReadOptions): Promise<readonly MirrorSourceStatus[]>;
}
interface CorpusRecordCandidate {
  readonly reference: EvidenceRecordReference;
  readonly projection: CatalogRecordProjection;
  readonly plane: "public";
  readonly locationHints: readonly RetrievalLocationHint[];
}
interface CorpusReadPage {
  readonly items: readonly CorpusRecordCandidate[];
  readonly nextCursor?: string;
  readonly excludedByTrust: number;
}

// Content resolution for excerpting.
createCorpusRetrieval(options: CreateCorpusRetrievalOptions): CorpusRetrieval;
interface CorpusRetrieval {
  fetchRecord(reference: EvidenceRecordReference, options?: CorpusFetchOptions): Promise<CorpusFetchOutcome>;
}

// Opportunistic sync. Never throws; returns `skipped-locked` when held.
createCorpusMirror(options: CreateCorpusMirrorOptions): CorpusMirror;
```

Four binding statements for C6:

1. **Trust filtering has already run.** A trust-rejected record never appears in `listRecords` or `getRecord`. C6 does not call the filter and must not bypass the reader by opening the catalog directly — `findExecutions` on a raw catalog handle skips the producer gate.
2. **No ranking has happened.** Items are in the catalog's own cursor order, unreordered (`packages/discovery/client/src/query.ts:30`). All relevance is C6's.
3. **`excludedByTrust` distinguishes filtered-empty from honestly-empty.** Surface it in the empty state; do not re-filter to derive it. **This extends to anything C6 derives from the reader, health checks included.** A trust policy expiring on its own `refreshBy` (`packages/trust/core/src/policy.ts:277-278`) flips every producer to rejected with no operator action, so a populated index can rebuild to empty for a reason that has nothing to do with the index. Any C6 signal that reads "index empty" must consult `excludedByTrust` before proposing a remedy: non-zero means the cause is trust, the remedy belongs to `corpus-trust-policy`, and re-running a rebuild will not fix it. See Finding F10.
4. **`plane` is the literal `"public"`.** C6 declares `EvidencePlane = "local" | "public"` in `src/relevance/planes.ts`; the literal is assignable with no adapter and no reverse dependency. C4 should tag its local candidates `"local"` the same way.

---

## Self-review

**Scope coverage against the assignment.**

| Required deliverable | Where |
| --- | --- |
| 1. Typed, injected source configuration; no ambient env authority | Task 1 — file-only, `RuntimeConfigSource.file`; the env-cannot-redirect test is the proof |
| 2. Mirror loop: discovery sync → local catalog, durable HWM, exclusive lock with skip-if-held, lock behavior proven | Tasks 3, 4, 9, 10 — in-process **and** cross-process skip tests, both asserting elapsed < 1 s |
| 3. Sync never blocks pickup; API makes blocking impossible; tested | Task 11 — `CorpusReader` has no sync method (`@ts-expect-error` + key-set assertion) and reads while a lock is held; Task 14's concurrency test |
| 4. Trust filtering fail-closed before ranking; both directions tested | Tasks 5, 7, 11, 12, 14 — rejection excludes at three levels (chain, source, producer); absence yields an empty page and no throw |
| 5. Exact-byte fetch with validation; mismatch refused loudly; tested | Tasks 8, 12 — two independent refusals, at the mirroring repository and at the stack's `validateCanonicalRecord` |
| 6. The C6 seam stated exactly | "The seam C6 consumes" above, and the reply already sent to plan-c6 |

**Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling". Every code step carries complete code; every command step carries the exact command and its expected output. Three steps deliberately require reading a real file before writing final code — Task 14 Steps 1, 3 (the fixture's actual field paths) and Step 4's `buildFixtureArchive` — and each says explicitly *do not guess*, with a validation command that fails loudly if the guess was wrong. Two steps (Task 6 Step 3, Task 13 Step 3) flag a specific block to simplify before running, with the replacement text given.

**Name and type consistency.** `MirrorSourceConfig` is declared once, in `config.ts`, and imported everywhere. `CorpusAdmission` is the single admission type across announcements, read, retrieve, and capability. `OpenCorpusMirrorStoreOptions` is the single store-path shape passed to mirror, reader, and retrieval. `sourceIdOf` has one definition (`announcements.ts`) and is used by read and retrieve. `producerIdOf` has one definition (`read.ts`) and is used by retrieve. `MIRROR_REPOSITORY_ID` has one definition (`repositories.ts`). Every stack symbol is quoted against its real declaration site with a `file:line` reference.

**Consistency check against sibling messages.** One divergence from what I told plan-c7: I described `MirrorSourceStatus` as carrying `mirroredRecords`. It does not — the catalog exposes no count query, and paging the whole plane to compute one would be an expensive lie in a doctor check. `MirrorSourceStatus` is `{ source, servingRoot, repositoryId, highWaterMark? }`. C7 gets the same signal from the `corpus-mirror` health check's `detail`. Recorded as Finding F7 and sent to plan-c7.

**Where this plan is thinnest, stated rather than hidden.** Chain verification ships as a *required posture* with a rejecting default and an acknowledged-unverified escape, not as a wired verification driver (Finding F1). That is the one place where "trust filtering" is weaker than the spec's ambition. It is not hidden: the mirror indexes **nothing** until an operator explicitly writes `acknowledgeUnverifiedChain: true` in a config file, the acknowledgement inside the code is a literal string argument, and the health check names the posture in its `detail`. The consent surface is the config file and the rejecting default, not a permanently-red doctor check — see Finding F9 for why those are not the same thing.

---

## Findings

Proposed dispositions only; this plan edits neither the spec nor the program plan.

**F1 — the mirror does not verify announcement chains, and this plan does not pretend otherwise.** Spec §6.1's composition table lists trust filtering as source/producer admission, and cross-plan contract 1 requires it before ranking. But `packages/discovery/client/src/sync.ts:16-19` states that `coldSync`/`returningSync` are *data acquisition only* — `verify-driver.ts` verifies. Wiring `createVerifyDriver` requires seven injected ports that no component in this program builds: `BindingResolver` (trust-resolve, which pulls in `viem` — forbidden by C3's boundary allowlist), `AgentKeyCatalog`, `RawSignatureVerifier`, `FactsProfileRegistry`, `FactsRecompute`, `RecordFetcher`, `EntryFetcher`. **Disposition:** C5 ships `ChainVerification` as a *required, no-default* construction argument with three implementations (rejecting — the default; acknowledged-unverified; driver-backed), so the posture is a visible decision. The enforcement lives where it belongs — the mirror indexes nothing until an operator explicitly opts into the unverified posture in a reviewable config file — and **not** in a permanently-red doctor check, for the reasons in F9. A follow-on component wires the driver, and the health check starts reporting a genuine result the day it does.

The `viem` boundary is the real blocker and should be recorded against the program: on-chain binding resolution cannot enter the plugin tree under the current allowlist, so either the allowlist changes for a narrowly-scoped adapter or binding resolution is injected from outside the runtime. Propose the latter. **This finding is program-level, not per-operator** — it needs an owner who can act on it, which no operator running the doctor can.

**F2 — two unreconciled location models.** Record discovery carries a published location as `{ profile: string, locator: string }` (`packages/discovery/protocol/src/item.ts:14-17`); the evidence catalog carries one as `{ bindingProfile: string, locator: Record<string, JsonValue> }` (`packages/evidence/discovery/src/catalog/types.ts:160-163`). C5 bridges them in one function (`announcements.ts` `toPublishedLocation`), lifting an https locator to `{ uri }` and an IPFS locator to `{ cid }`. Those key names are C5's invention. **Disposition:** propose a shared location profile owned by whichever tree publishes locations, with the locator object shape pinned per `bindingProfile`. Until then C5's mapping is the de-facto one and is documented at its single bridging point. Filed against the discovery and evidence tree owners.

**F3 — the record-discovery serving plane defines no artifact path.** `identifiers.ts:55-58` defines `/.well-known/…`, `/records/<digest>`, `/sources/<name>/head`, and `/sources/<name>/entries/<page>` — nothing for artifacts. So `createServingPlaneRepository.getArtifact` returns `null`, and a cross-plane artifact hydration request comes back `unavailable` with `completeness: "artifact-incomplete"`. **Disposition:** propose an artifact path in the discovery serve design. C6 should treat artifact selections against public-plane records as `requirement: "optional"` until it lands; that is stated in the C6 seam contract. C5 does not invent a path — that would be an application making a protocol decision.

**F4 — `evidence/local-runtime` is unusable for a mirror, and that is the right outcome.** Its root lock is exclusive-or-fail (`local-runtime/src/lock.ts:37,46,80`), which would let a mid-write sync starve a concurrent pickup — the exact failure cross-plan contract 5 forbids. C5 therefore composes `catalog-sqlite` + `repository/fs` directly, getting WAL with `busy_timeout = 5000` (`catalog-sqlite/src/database.ts:187-196`). **Disposition:** this corroborates C3's finding F-C3-8 from a second direction and strengthens spec §7.3's retention finding into a broader one: `local-runtime`'s single-process contract is a genuine constraint on any product that reads and writes evidence concurrently. Propose recording it against the local-runtime design as "concurrency mode is a runtime-layer decision, not a repository one". No C5 dependency.

**F5 — producer admission is necessarily a read-time gate, not an acquisition-time one.** An announcement carries the *announcer's* identity, never the *producer's* — that lives inside the record (`executorId` / `evaluatorId` / `verifierId`) and is known only after projection. So admission is two-point: source at acquisition, producer at read. This is better than a single gate, not worse: a trust-policy change takes effect immediately over already-mirrored content instead of requiring a re-sync, and the mirror stays a pure cache. **Disposition:** record it as the resolved reading of spec §6.3's "candidate sources and producers pass through trust-layer policy before ranking" — both do, at the two points where each identity is actually knowable. No spec change needed; the sentence is already satisfied.

**F6 — "fail-closed on rejection, fail-open on absence" needs its reconciliation written down.** The two rules look contradictory when a runtime has no trust policy: every producer is rejected (fail-closed), and every page is empty (fail-open). Both hold simultaneously and that is correct — rejection *excludes records*, absence *does not stop work*. A fresh install therefore admits nothing and proceeds with no corpus context, which is the honest posture for a product that injects third-party content into a session holding tools. **Disposition:** propose adding this one-sentence reconciliation to spec §6.3, since the current text leaves a reader to infer it. C5 implements it either way and tests both directions.

**F7 — divergence from the interface I sent plan-c7.** I told C7 that `MirrorSourceStatus` carries `mirroredRecords: number`. It does not: `EvidenceCatalogReader` exposes no count operation (`catalog/types.ts:225-251`), and paging the plane to compute one would make a doctor check expensive and slow. **Disposition:** `MirrorSourceStatus` is `{ source, servingRoot, repositoryId, highWaterMark? }`; the per-plane volume signal reaches C7 through the `corpus-mirror` health check's `detail` instead. Correction sent to plan-c7. If a count turns out to be genuinely needed, the right fix is a `count` operation on the catalog reader, filed against `evidence/discovery` — not a paging loop in this tree.

**F8 — `.yarnrc.yml` and portal depth.** C5 adds eight portal dependencies from `plugin/runtime/` to `packages/*/*`, a two-level climb (`portal:../../packages/...`). The evidence tree's own portals are one level (`portal:../protocol`). Nothing forbids the deeper form, but the CI job must build all eight from source in dependency order before `yarn install` in `plugin/runtime` can typecheck against their `dist/` (Task 1 Step 8). **Disposition:** noted for C6 and C7, which will add more of the same (`evidence-derivation` for C6, `@modelcontextprotocol/sdk` for C7). If the build step grows past a dozen entries, propose a shared `scripts/build-portal-deps.mjs` in the plugin tree rather than lengthening the inline loop in every workflow. No blocker.

**F9 — a doctor check must measure install state, not software capability (raised by plan-c7 as F-C7-4; resolved here).** C7's gate rehearsal asserts the doctor prints `all checks passed.` on a correct install, and my first draft made `corpus-chain-verification` `ok: false` on *every* install, because no verification driver exists anywhere in this program (F1). C7 is right that this breaks the gate, and right for a deeper reason it did not name: the check as drafted also violated spec §9.3's own rule, since its `remedy` told the operator to "configure a verification driver" that they cannot configure — precisely the no-op remedy §9.3 forbids. A check that is red on every correct install and unfixable by its reader is not a warning, it is noise, and it teaches operators that red is decorative.

But C7's proposed fix — emit `ok: true` unconditionally — replaces an always-red check with an always-green one, which carries exactly as little information and would stay green the day a driver *is* wired.

**Disposition (my call, since it is my check): neither. The check is redefined to measure posture-versus-configuration rather than capability presence.** Green when there is nothing to verify, green when a driver is wired, green when archives are followed and the operator has explicitly acknowledged the unverified posture (with the posture named in `detail` and `remedy: null`), and **red only when archives are followed and no posture was chosen** — an install that will silently never index anything, fixable in one config line. Red now means "something here is wrong and you can fix it", the only meaning that keeps red worth reading; and the check begins reporting a genuine verification result for free the day F1 is closed.

The security posture is not softened by this. The mirror still indexes nothing by default, and reaching the unverified posture still requires an operator to write `acknowledgeUnverifiedChain: true` into a reviewable config file. The consent surface is the rejecting default and that flag — not a permanently-red check. The pressure to actually wire the driver belongs on the program (F1), whose owners can act on it, not on every operator, who cannot.

C7's fallback option 2 (a documented known-degraded set) is not needed and should be dropped: no check is red on a correct install now, so the rehearsal's original `all checks passed.` assertion holds unmodified.

**Generalization, since ratified as a cross-plan contract by the coordinator:** any check whose `ok` is the same on every possible install is not a health check — it is a release note, and it belongs in `detail`, in the doctor's trailing render, or in the changelog. This cuts both ways: an always-red check defeats C7's gate, and an always-green one is equally uninformative, which is why C7's original option 1 was refused. C7 applied the rule to its own list and lost a row (`host-provider`), and guards it with `test_no_check_is_a_release_note`.

**C5's own scan under that rule cost a row too, and it was mine.** `corpus-sources` had `ok: true` unconditionally — it could never tell an operator anything, and its remedy ("add entries under `corpus.sources`") was a no-op for anyone deliberately following none. It was also redundant: its only real content, the archive count and the honest empty state, already belonged beside `corpus-mirror`'s varying condition. **It is removed**; C5 now emits **three** checks, not four — `corpus-mirror`, `corpus-trust-policy`, `corpus-chain-verification` — and Task 13's suite carries `NO CHECK IS A RELEASE NOTE` as the in-tree guard. Promulgating a rule and exempting one's own check would have been the worse outcome; catching it here also spares C7 a red `test_no_check_is_a_release_note` at integration.

**One cross-component invariant this creates, pinned on both sides.** The acknowledged-unverified posture is now reported by a **green** check whose whole content is its `detail` sentence. That is only safe because C7's renderer prints `detail` for green rows (`[ok  ] <name>: <detail>`), which C7 pins with `test_green_checks_render_their_detail_not_just_their_name`. If a future change makes green rows render name-only, this posture goes silent — so the dependency is recorded here as well as there. Do not "simplify" either side without the other.

**F10 — a derived "index empty" signal can misattribute a trust-caused emptiness, and time alone can trigger it.** C6 emits `corpus-index` (via C7) reporting index coherence, red when the index was populated before and is now empty, with `rebuildIndex` as the remedy. That rule is correct in isolation but its input is my reader, which is trust-filtered. A trust policy expiring on its own `refreshBy` — `verifyPolicyChain` returns `policy-expired` when `refreshBy < now` (`packages/trust/core/src/policy.ts:277-278`) — flips every producer to rejected **with no operator action and no config change**. The chain: policy lapses → `listRecords` returns empty with `excludedByTrust > 0` → C6's next rebuild empties a previously-populated index → `corpus-index` goes red proposing `rebuildIndex` → the operator rebuilds → still empty → still red. A remedy that cannot remedy, which is the exact class F9 was about, arriving through a component interaction rather than through any single component's mistake.

Note this is the one failure mode in the merged doctor that **no static review of an install would catch**, because nothing about the install changes — only the wall clock advances past `refreshBy`.

**Disposition:** the disambiguator already exists and is already on the seam — `CorpusReadPage.excludedByTrust`. C6's index signal must consult it before proposing a remedy: non-zero means the cause is trust, the correct red row is `corpus-trust-policy` (which independently reports `policy-expired`), and `corpus-index` should stay green or defer rather than propose a rebuild. Recorded on the C6 seam as an extension of binding statement 3. No change to C5's own surface — `excludedByTrust` was specified for exactly this, and this finding only widens where it must be honored from "the empty state" to "anything derived from the reader". Raised with plan-c7 for relay to C6, since C7 owns the merged doctor.

**F11 — a sync position stored outside the catalog can outlive the data it describes (self-audit, prompted by C6's `lastIndexedAt` bug).** C7 relayed that C6's `lastIndexedAt` was a `max()` over live rows, so evicting the last record took the marker with it and made a red arm unreachable — "a signal derived from live data going quiet exactly when the interesting state occurs". Auditing C5's three checks against that class turned up the **mirror image**, and it is worse.

C5's high-water mark lives in `mirrorStatePath`, a file separate from `mirrorCatalogPath`. It therefore does not die with the data — it *outlives* it. If the catalog is deleted or recreated while the state file survives (disk cleanup, a partial restore, corruption recovery, or simply `rm` of the catalog while the sibling state file remains), the next pass calls `returningSync` from a position whose records are gone, walks nothing new, and the mirror stays **permanently empty**. `openCorpusMirrorStore` silently creates a fresh catalog when the file is absent, so C5's own code reaches this state without complaint. Pre-fix, `corpus-mirror` reported **green** throughout, because a position existed.

Both directions produce a wrong verdict from the same root cause: a marker and the data it describes having independent lifetimes. C6's marker was too tightly coupled to the data; C5's was too loosely coupled.

**Disposition, two parts.**

*Applied here (contained to the check I own):* `corpus-mirror` now consults the catalog as well as the position — red when a sync position exists but the mirror holds no record in any family, with a remedy that genuinely repairs it (delete the state file; the next sync cold-walks from genesis). `mirrorHasAnyRecord` reads the catalog **raw** rather than through `CorpusReader`, because the reader is trust-filtered and a fully-unadmitted catalog would otherwise be misreported as wedged — the F10 misattribution in miniature. Two tests pin both arms.

*Proposed, not built:* the durable fix is to stamp the state file with the catalog's `generation.createdAt` (`CatalogGeneration` already carries it and `SqliteEvidenceCatalog.generation` exposes it), and treat marks written against a different generation as absent — which makes the wedge **self-healing** instead of merely visible, since a fresh catalog would automatically trigger a cold re-sync. That spans Tasks 3, 10, and 13, so it is recorded rather than folded in at the end of a planning session, per the designs-are-law rule. It should land before the C7 gate rehearsal; it is small (a stamp field, a comparison, one test) and strictly better than the detection-only fix, which still requires a human to read a remedy and delete a file.

## 2026-07-31 implementation-time findings (C5-P1, C5-P2)

Surfaced by the C5 sub-coordinator against accepted C3 head `ec57b5a2f` before Task 1. Ratified by the program coordinator; plan text above amended in place.

**C5-P1 — `RuntimeConfigFileSchema` rejects `corpus`.** C3's `z.strictObject({ home, logLevel })` fails any Task 1 test that passes `file: { corpus: … }` before `resolveCorpusConfig` runs. **Disposition (applied in Task 1 Step 3):** add `corpus: z.unknown().optional()` to `RuntimeConfigFileSchema`; keep real validation in `CorpusConfigSchema` / `resolveCorpusConfig` so file-only authority stays there.

**C5-P2 — closed-world exact maps omit C5 deps.** C3 R-C3-63/64 enforce `APPROVED_RUNTIME_DEPENDENCIES` / `DEV_DEPENDENCIES` / `RESOLUTIONS` in `plugin-tree-guard-common.mjs`. Updating only `JINN_DEPENDENCY_GRAPH` leaves Task 1 red on `validateExactDependencySections`, undeclared deps, and portal resolutions. **Disposition (applied in Task 1 Steps 5–6, 9):** extend those three maps with C5's exact versions and portal entries; pin `@types/better-sqlite3` at `7.6.11` (no `^`); include `plugin-tree-guard-common.mjs` in the Task 1 commit and shared-file ownership table. The same gap applies to C4 — amended in the C4 plan in parallel.
