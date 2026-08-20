# External Verification Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make published Colophon public bundles verifiable by external tools — signatures, digests, sealed bytes, cross-references — with no Jinn code installed, via a published profile, JSON Schemas, a golden/tamper conformance kit, and an executable off-the-shelf walkthrough (issue [#2796](https://github.com/Jinn-Network/mono/issues/2796)).

**Architecture:** Three stacked layers. (A) The platform-neutral benchmarking record schemas gain canonical `$id`s under the spec origin so the sealed top-level records have stable schema URLs served by the existing profile-root pipeline. (B) A product-owned conformance kit — one real golden `benchmark-product-public-bundle/2` bundle generated through the shipped CLI, plus named tampered variants with machine-readable expected outcomes — becomes the regression suite and the external implementer's self-test. (C) Tier-4 JSON Schemas for the bundle document formats, an external-verification profile document with the honest three-way check split, and a dependency-free walkthrough script, all proven by tests that execute the documented path.

**Tech Stack:** Node 22 + `node --test` (verify package convention), vitest (core), Ajv 2020-12 (dev-only, precedent: `packages/environments/record`), Python 3 stdlib + OpenSSL 3 for the external path, the shipped `dist/cli/bin.js` for bundle generation.

## Global Constraints

- **Sealed once, forever** (`docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5): the external view is the exact sealed bytes; nothing re-canonicalizes; any export carries original bytes + digests, never a re-emission. No task may parse-and-re-emit a sealed document as the same document.
- **Tier separation** (self-serve spec `spec/2026-08-13-colophon-self-serve.md` §6.2): platform packages never name Colophon; the tier-4 bundle format/vectors are visibly separate, non-normative for the platform, and may name Colophon. Platform-neutral schemas stay owned by stack packages.
- **Origin disclosure** (DR-2026-08-17-c, `log/decisions/2026-08-17-colophon-first-cut-canary-pin.md`): every new public document that names a `https://spec.jinn.network/...` identifier states that the origin is not hosted yet and a fetch will not retrieve it. No GitHub Pages / preview stand-in.
- **Vendor-free copy:** no neighbour names, no "receipts" / "self-verifying" / "verification level" / "assurance level" as field names; audience is "any external verifier" / "third-party implementers".
- **Honesty text preserved:** external verifiability never upgrades a claim tier. The self-run venue limits (`LOCAL_VENUE_LIMITS`, `packages/benchmark-product/verify/src/profile/run-results.ts`) appear in the profile unmodified; the what-it-proves table sits at the TOP of the profile.
- **No emoji; American English; no em dashes in PR/issue bodies; frontends untouched** (no UI in scope).
- **Design-is-law divergence, recorded:** the kickoff asked for claim-package schemas under `spec.jinn.network/v1`. The accepted self-serve spec separates tier-4 product formats from the platform origin. Disposition (this plan): platform record schemas get spec-origin `$id`s (Task 1); tier-4 bundle schemas ship inside `@colophon-claims/verify` (`schemas/` in the npm tarball) with identity = the existing format literals (`benchmark-product.claim-package/2` etc.) + file digests, and no invented URL origin. The profile documents where each lives and why.
- **PR shaping:** PR-A = Task 1 (independent, platform). PR-B = Tasks 2–4 (product kit). PR-C = Tasks 5–7, stacked on PR-B. All target `next`. PR-C body carries `Closes #2796` and the fresh-environment verification evidence (Task 8).

---

### Task 1: Canonical `$id`s for the benchmarking record schemas (PR-A)

**Files:**
- Modify: `packages/benchmarking/records/schemas/benchmark.schema.json`, `run.schema.json`, `matrix.schema.json`, `report.schema.json`, `benchmark-accounting.schema.json`, `observation-archive.schema.json` (add one `$id` member each)
- Create: `packages/benchmarking/records/src/schema-identifiers.test.ts`
- Test: same file

**Interfaces:**
- Produces: each schema file gains `"$id": "https://spec.jinn.network/protocols/benchmarking/v1/schemas/<basename>"` (basename includes `.schema.json`), mirroring the shipped execution-evidence precedent (`packages/evidence/protocol/profiles/execution-evidence/v1/schemas/*.schema.json`). The profile document (Task 6) cites these URLs.

- [ ] **Step 1: Write the failing test**

`packages/benchmarking/records/src/schema-identifiers.test.ts` (vitest, match the package's existing test style — check a sibling `*.test.ts` for import form):

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEMA_DIR = join(__dirname, "..", "schemas");
const ORIGIN = "https://spec.jinn.network/protocols/benchmarking/v1/schemas/";

describe("record schema identifiers", () => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort();

  it("covers the six published schemas", () => {
    expect(files).toEqual([
      "benchmark-accounting.schema.json",
      "benchmark.schema.json",
      "matrix.schema.json",
      "observation-archive.schema.json",
      "report.schema.json",
      "run.schema.json",
    ]);
  });

  it.each(files)("%s declares its canonical $id and draft 2020-12 dialect", (file) => {
    const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    expect(doc.$id).toBe(`${ORIGIN}${file}`);
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("declares no duplicate identifiers", () => {
    const ids = files.map((f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")).$id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

If any schema lacks `$schema: .../2020-12/schema` today, read the file first and assert whatever dialect it actually declares — do not change dialects in this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/benchmarking/records && yarn vitest run src/schema-identifiers.test.ts`
Expected: FAIL — `$id` undefined.

- [ ] **Step 3: Add the `$id` members**

In each of the six schema files add, as the first member (before `$schema` or matching neighbour ordering — inspect one execution-evidence schema and copy its member order convention):

```json
"$id": "https://spec.jinn.network/protocols/benchmarking/v1/schemas/benchmark.schema.json",
```

(one per file, basename matching the file).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/benchmarking/records && yarn vitest run src/schema-identifiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the public-surface pipeline gates**

The `$id` members are identity claims the profile-root builder maps to served paths; they must satisfy `jinnIdentifierServedPath` and collide with nothing.

Run: `cd <repo-root> && node --test .github/scripts/*.test.mjs 2>/dev/null || true` — instead run the targeted workflow tests named in `.github/workflows/platform-architecture-control.yml` lines ~113-121 (read the workflow, run exactly the commands it runs for the profile-root/bundle/live-host tests). Also run the package's full suite: `cd packages/benchmarking/records && yarn test`.
Expected: all green; the built profile root now serves the six schemas at their claimed paths.

- [ ] **Step 6: Commit**

```bash
git add packages/benchmarking/records
git commit -m "feat(benchmarking-records): declare canonical spec-origin \$ids on the record schemas (#2796)"
```

---

### Task 2: Conformance-kit golden bundle generator (PR-B)

**Files:**
- Create: `packages/benchmark-product/verify/scripts/generate-conformance-kit.mjs`
- Create (generated, checked in): `packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1/golden/` (a complete bundle directory), `.../keys/report-signing-key.pem`, `.../keys/verdict-signing-key.pem`, `.../keys/README.md`

**Interfaces:**
- Consumes: the built product CLI `packages/benchmark-product/core/dist/cli/bin.js` with the verb sequence proven by `core/quickstart/sample-lifecycle.mjs:180-262`: `init`, `draft create`, `sample init`, `arm add` (×2: `prediction-v1-baseline`, `sample-uniform`), `quote`, `lock`, `launch`, `resume`, `collect`, `results`, `report`, `verify`, `publish` — all with `--workspace <dir> --principal sponsor-1` and `--draft conformance-golden`, each with `--json`.
- Produces: `golden/` = the exact published bundle directory (byte-copied from `<workspace>/artifacts/conformance-golden/public-bundles/<identity>/`, `cpSync` with `preserveTimestamps`, never re-serialized); `keys/` = the workspace's venue private keys copied out before workspace deletion (report key at `<workspace>/venue/report-signing-key.pem`; find the verdict key path by reading `core/src/venue/signing.ts` before writing the copy). Task 3 consumes `keys/` to build the re-signed tamper variant.

- [ ] **Step 1: Write the generator script**

`generate-conformance-kit.mjs` essentials (mirror `sample-lifecycle.mjs` mechanics — spawnSync of `process.execPath` + built CLI, 180s step timeout, `--json` parsing, fail-loud on nonzero exit):

```js
#!/usr/bin/env node
// Generates fixtures/public-bundle-conformance-v1/golden + keys by driving the
// built product CLI end-to-end on the real local venue. Regeneration replaces
// the kit wholesale; tamper variants are derived by generate-tamper-variants.mjs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePkg = resolve(here, "..", "..", "core");
const cliBin = join(corePkg, "dist", "cli", "bin.js");
const kitDir = resolve(here, "..", "fixtures", "public-bundle-conformance-v1");
const workspace = mkdtempSync(join(tmpdir(), "conformance-golden-"));
const draft = "conformance-golden";
const common = ["--workspace", workspace, "--principal", "sponsor-1"];
const forDraft = [...common, "--draft", draft];

function step(label, argv) {
  const r = spawnSync(process.execPath, [cliBin, ...argv, "--json"], {
    timeout: 180_000, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`${label} failed (${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

step("init", ["init", ...common]);
step("draft create", ["draft", "create", ...common, "--id", draft,
  "--name", "Conformance golden", "--description", "Golden bundle for the public conformance kit"]);
step("sample init", ["sample", "init", ...forDraft]);
step("arm add baseline", ["arm", "add", ...forDraft, "--arm", "baseline",
  "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } })]);
step("arm add sample-uniform", ["arm", "add", ...forDraft, "--arm", "sample-uniform",
  "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } })]);
step("quote", ["quote", ...forDraft]);
step("lock", ["lock", ...forDraft]);
step("launch", ["launch", ...forDraft]);
step("resume", ["resume", ...forDraft]);
step("collect", ["collect", ...forDraft]);
step("results", ["results", ...forDraft]);
step("report", ["report", ...forDraft]);
step("verify", ["verify", ...forDraft]);
const publish = step("publish", ["publish", ...forDraft]);

rmSync(kitDir, { recursive: true, force: true });
mkdirSync(join(kitDir, "keys"), { recursive: true });
cpSync(resolve(workspace, publish.bundleRelativePath), join(kitDir, "golden"),
  { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false });
cpSync(join(workspace, "venue", "report-signing-key.pem"), join(kitDir, "keys", "report-signing-key.pem"));
// verdict key: read core/src/venue/signing.ts for the on-disk name, copy it the same way.
writeFileSync(join(kitDir, "keys", "README.md"),
  "# Test-only signing keys\n\nThese private keys sign ONLY this conformance kit's golden fixture. They identify no real party, anchor no trust, and exist so the kit's re-signed adversarial variant is reproducible. Never reuse them.\n");
rmSync(workspace, { recursive: true, force: true });
console.log(`golden bundle: ${publish.bundleIdentity}`);
```

Before running: `cd packages/benchmark-product/core && yarn build` (the CLI must exist at `dist/cli/bin.js`). Read `core/src/venue/signing.ts` first and fix the verdict-key filename in the script.

- [ ] **Step 2: Run the generator**

Run: `cd packages/benchmark-product/verify && node scripts/generate-conformance-kit.mjs`
Expected: prints `golden bundle: <64-hex>`; `fixtures/public-bundle-conformance-v1/golden/` contains `bundle.json`, `claim-package.json`, `report-envelope.json`, `trust/public-keys.json`, `records/*.bin`, etc.

- [ ] **Step 3: Prove the golden verifies**

Run: `cd packages/benchmark-product/verify && yarn build && node dist/bin.js fixtures/public-bundle-conformance-v1/golden --json`
Expected: exit 0, `"ok": true`, six checks.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/verify/scripts/generate-conformance-kit.mjs packages/benchmark-product/verify/fixtures
git commit -m "feat(benchmark-product): conformance-kit golden bundle + test-only keys (#2796)"
```

---

### Task 3: Tamper-variant generator + kit manifest (PR-B)

**Files:**
- Create: `packages/benchmark-product/verify/scripts/generate-tamper-variants.mjs`
- Create (generated, checked in): `packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1/tampered/<case-id>/` (one full bundle directory per case) and `packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1/manifest.json`

**Interfaces:**
- Consumes: `golden/` and `keys/` from Task 2.
- Produces: `manifest.json` shape (extends the `adversarial-v1` precedent, `packages/environments/record/fixtures/adversarial-v1/manifest.json`):

```json
{
  "format": "benchmark-product-conformance-kit/1",
  "golden": { "path": "golden", "expectedDisposition": "valid", "expectedChecks": ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"] },
  "fixtures": [
    { "id": "<case-id>", "path": "tampered/<case-id>", "description": "...", "expectedDisposition": "invalid", "expectedFailingCheck": "<one of the six>", "externallyDetectable": true }
  ]
}
```

- [ ] **Step 1: Write the tamper generator**

Discipline: every variant starts as a byte-copy of `golden/`; each mutation is surgical; when a case is meant to isolate a *later* check, earlier checks are repaired (re-hash edited files into `bundle.json`) so exactly the target check fails. Digest helpers use `node:crypto` over exact bytes. The manifest is written last from the case table. Case table (id → mutation → expected failing check → externally detectable):

```js
// Sketch of the case table the script iterates; each `apply` edits a copied bundle dir.
const CASES = [
  { id: "file-truncated", check: "manifest", external: true,
    apply: (d) => rmSync(join(d, "verdicts.json")) },                       // manifest closure fails
  { id: "manifest-digest-mismatch", check: "manifest", external: true,
    apply: (d) => appendByte(join(d, "share.txt")) },                       // listed digest stale
  { id: "record-digest-mismatch", check: "evidence-closure", external: true,
    apply: (d) => { flipJsonSpace(firstRecord(d)); refreshManifest(d); } }, // CAS name != bytes; manifest repaired
  { id: "record-substituted", check: "evidence-closure", external: true,
    apply: (d) => { swapTwoVerdictRecords(d); refreshManifest(d); } },      // self-consistent CAS, broken cross-refs
  { id: "report-payload-edited", check: "report-verification", external: true,
    apply: (d) => { editReportJsonAndEnvelopePayloadTogether(d); refreshManifest(d); } }, // sig now invalid
  { id: "report-signature-grafted", check: "report-verification", external: true,
    apply: (d) => { graftVerdictSigOntoReportEnvelope(d); refreshManifest(d); } },
  { id: "trust-key-swapped", check: "trust", external: true,
    apply: (d) => { replaceReportSpkiWithFreshKey(d); refreshManifest(d); } }, // did:key/keyId derivation breaks
  { id: "verdict-signature-grafted", check: "evidence-closure", external: true,
    apply: (d) => { swapSigBetweenTwoVerdictEnvelopes(d); refreshManifest(d); } },
  { id: "recanonicalized-report-bytes", check: "report-verification", external: true,
    apply: (d) => { prettyPrintReportJsonOnly(d); refreshManifest(d); } },   // sealed-bytes law: payload != file bytes
  { id: "claim-mirror-tampered", check: "claim-consistency", external: false,
    apply: (d) => { bumpClaimHeadlinePassRate(d); refreshManifest(d); } },   // needs buildClaimPackage recompute... 
  { id: "results-miscomputed-resigned", check: "report-verification", external: false,
    apply: (d) => { widenWilsonIntervalInReport(d); resealAndResignReport(d, keys); refreshManifest(d); } },
];
```

Two cases need care:
- `claim-mirror-tampered`: mutate a `claim-package.json` field that is NOT mirrored in the signed report (e.g. a `verification.checks` string) so signature+digest checks still pass and only `claim-consistency` fails. If every claim field turns out to be cross-checked externally (mirror fields are), pick the field by reading `verify/src/profile/claim-consistency.ts` and choosing one only `buildClaimPackage` recomputation catches; set `externallyDetectable` accordingly after observing behavior.
- `results-miscomputed-resigned`: the boundary exhibit. Edit `report.json`'s `results` (e.g. Wilson `low` off by one digit), re-canonicalize THAT NEW DOCUMENT (this is authoring a new record, lawful — it is a different document, not a re-emission of the sealed one), re-sign with `keys/report-signing-key.pem` via `node:crypto` `sign(null, pae, key)`, rebuild `report-envelope.json` with the same member order (`payload`, `payloadType`, `signatures` — copy the golden's JSON member order exactly), update `claim-package.json` mirror digests the same way a dishonest producer would, refresh `bundle.json`. External tools MUST accept it; `colophon-verify` MUST reject it at `report-verification` (method recompute).

For envelope/JSON mutations that must remain canonical, operate on parsed values then re-serialize with the SAME canonical serializer the bundle used — import nothing from workspace packages; instead do byte-level splices where possible, and for the resign case reimplement compact JCS locally in the script (keys are ASCII in these documents; document this assumption in a comment) or byte-splice the changed digit. Prefer byte-splice everywhere it suffices.

- [ ] **Step 2: Run the generator**

Run: `cd packages/benchmark-product/verify && node scripts/generate-tamper-variants.mjs`
Expected: `tampered/` holds one directory per case id; `manifest.json` lists all cases sorted by id.

- [ ] **Step 3: Spot-check two variants by hand**

Run: `node dist/bin.js fixtures/public-bundle-conformance-v1/tampered/file-truncated --json; echo exit=$?`
Expected: exit 1, `"code": "record-integrity"`.
Run the same for `results-miscomputed-resigned`. Expected: exit 1.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/verify/scripts/generate-tamper-variants.mjs packages/benchmark-product/verify/fixtures
git commit -m "feat(benchmark-product): tamper-matrix variants + machine-readable kit manifest (#2796)"
```

---

### Task 4: Kit conformance test + fixture digest manifest (PR-B)

**Files:**
- Create: `packages/benchmark-product/verify/test/conformance-kit.test.mjs`
- Create (generated): `packages/benchmark-product/verify/fixtures/manifest.sha256.json`
- Modify: `packages/benchmark-product/verify/package.json` (test script already runs `node --test test/`; confirm and leave if so)

**Interfaces:**
- Consumes: the kit from Tasks 2–3; the CLI contract from `verify/src/cli.ts` (exit 0/1/2, `--json` shape with `ok`, `code`, `checks`).
- Produces: the regression suite named in issue #2796's acceptance criteria; `manifest.sha256.json` in the repo-wide fixture drift-guard format (`.github/scripts/fixture-manifest.mjs`).

- [ ] **Step 1: Write the failing test first** (TDD note: written after generation in this ordering because the kit is data; the test is still the specification — write it strictly from `manifest.json`, never from the observed verifier output)

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const kit = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1", import.meta.url));
const manifest = JSON.parse(readFileSync(join(kit, "manifest.json"), "utf8"));

async function verify(dir) {
  try { const r = await exec(process.execPath, [bin, dir, "--json"]); return { code: 0, out: JSON.parse(r.stdout) }; }
  catch (e) { return { code: e.code, out: JSON.parse(e.stdout) }; }
}

test("kit manifest is complete and sorted", () => {
  const ids = manifest.fixtures.map((f) => f.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(new Set(readdirSync(join(kit, "tampered"))), new Set(ids));
});

test("golden bundle verifies with all six checks", async () => {
  const { code, out } = await verify(join(kit, manifest.golden.path));
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.deepEqual(out.checks, manifest.golden.expectedChecks);
});

for (const fixture of JSON.parse(readFileSync(join(kit, "manifest.json"), "utf8")).fixtures) {
  test(`tampered variant ${fixture.id} must fail`, async () => {
    const { code, out } = await verify(join(kit, fixture.path));
    assert.equal(code, 1, `${fixture.id} must exit 1`);
    assert.equal(out.ok, false);
    assert.equal(out.code, "record-integrity");
    assert.match(out.message, new RegExp(fixture.expectedFailingCheck === "manifest" ? "" : ""), "");
  });
}
```

Refine the failing-check assertion after reading how `verify.ts` surfaces the failing check in the error message/issues (the explorer report says failures carry `{path, message}` issues; assert on whichever field names the check deterministically — read `verify/src/profile/errors.ts` first and assert exactly).

- [ ] **Step 2: Run the suite**

Run: `cd packages/benchmark-product/verify && yarn build && node --test test/conformance-kit.test.mjs`
Expected: PASS (kit exists from Tasks 2–3). If any variant fails the wrong check, fix the *generator* (Task 3), regenerate, rerun.

- [ ] **Step 3: Generate the fixture digest manifest**

Run: `cd <repo-root> && node .github/scripts/fixture-manifest.mjs --write packages/benchmark-product/verify` — read the script's usage header first; if it only accepts catalog packages (benchmark-product is not in `architecture/platform-packages.v1.json`), instead write `fixtures/manifest.sha256.json` in the same `{version, entries:[{id, sha256}], errata:[]}` shape from a small inline step in `conformance-kit.test.mjs` ("manifest.sha256.json is current" test that recomputes and compares, with the missing-pin paste-instructions ergonomics from `packages/trust/testing`).
Expected: `fixtures/manifest.sha256.json` exists and a drift test guards it.

- [ ] **Step 4: Run the whole package suite + typecheck**

Run: `cd packages/benchmark-product/verify && yarn typecheck && yarn test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmark-product/verify
git commit -m "test(benchmark-product): conformance-kit regression suite + fixture digest manifest (#2796)"
```

---

### Task 5: Tier-4 JSON Schemas for the bundle document formats (PR-C)

**Files:**
- Create: `packages/benchmark-product/verify/schemas/bundle-manifest.schema.json`, `evidence-catalog.schema.json`, `verdict-catalog.schema.json`, `public-trust.schema.json`, `claim-package.schema.json`, `assembly-row.schema.json`, `dsse-envelope.schema.json`
- Create: `packages/benchmark-product/verify/test/schema-conformance.test.mjs`
- Modify: `packages/benchmark-product/verify/package.json` — add `"schemas/"` to `files`; add dev-dependency `ajv` (same version as `packages/environments/record` uses; check its `package.json` and mirror)

**Interfaces:**
- Consumes: the Zod definitions in `verify/src/schema.ts` and `verify/src/profile/claim.ts` as the source of truth; the golden + tampered kit documents as validation corpus.
- Produces: draft 2020-12 schemas, each with NO `$id` (per Global Constraints), a top-level `description` naming the format literal it describes (e.g. `"Describes benchmark-product-public-trust/2 documents..."`), and `"x-format"` custom keyword? — no: do not invent keywords; put the format literal in `description` and constrain the in-document discriminator (`format` / `claimSchema`) with `const`.

- [ ] **Step 1: Write the failing conformance test**

```js
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const schemasDir = fileURLToPath(new URL("../schemas", import.meta.url));
const kit = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1", import.meta.url));
const golden = join(kit, "golden");
const ajv = new Ajv2020({ strict: true, allErrors: true });

const PAIRS = [
  ["bundle-manifest.schema.json", "bundle.json"],
  ["evidence-catalog.schema.json", "evidence.json"],
  ["verdict-catalog.schema.json", "verdicts.json"],
  ["public-trust.schema.json", "trust/public-keys.json"],
  ["claim-package.schema.json", "claim-package.json"],
  ["dsse-envelope.schema.json", "report-envelope.json"],
];

for (const [schemaFile, docFile] of PAIRS) {
  test(`${docFile} validates against ${schemaFile}`, () => {
    const validate = ajv.compile(JSON.parse(readFileSync(join(schemasDir, schemaFile), "utf8")));
    const ok = validate(JSON.parse(readFileSync(join(golden, docFile), "utf8")));
    assert.equal(ok, true, JSON.stringify(validate.errors, null, 1));
  });
}

test("every assembly row validates against assembly-row.schema.json", () => {
  const validate = ajv.compile(JSON.parse(readFileSync(join(schemasDir, "assembly-row.schema.json"), "utf8")));
  const rows = readFileSync(join(golden, "verification", "assembly.jsonl"), "utf8").trimEnd().split("\n");
  for (const row of rows) assert.equal(validate(JSON.parse(row)), true, JSON.stringify(validate.errors, null, 1));
});

test("schemas pin the format discriminators the code enforces", async () => {
  const claim = JSON.parse(readFileSync(join(schemasDir, "claim-package.schema.json"), "utf8"));
  assert.equal(claim.properties.claimSchema.const, "benchmark-product.claim-package/2");
  const trust = JSON.parse(readFileSync(join(schemasDir, "public-trust.schema.json"), "utf8"));
  assert.equal(trust.properties.format.const, "benchmark-product-public-trust/2");
  // ...one assertion per discriminator; source the literals by importing the built package
  // (export the constants from verify/src if not already exported) so drift breaks the test.
});
```

Anti-drift wiring: export the format literals from `verify/src/index.ts` (e.g. `export const PUBLIC_BUNDLE_FORMAT_LITERALS = {...}` derived from the Zod literals) and assert schema `const`s against the *built import*, not string copies. NOTE (golden is format /2): the golden claim-package's `claimSchema` is whatever the current pipeline emits — read the golden first; if it emits `/2`, the pairs above hold; if the schema union spans v1/v2, constrain the schema to what the current writer emits and say so in `description`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/benchmark-product/verify && node --test test/schema-conformance.test.mjs`
Expected: FAIL — schemas dir missing.

- [ ] **Step 3: Author the seven schemas**

Derive each from the corresponding Zod schema by hand-transcription with these rules: every object `additionalProperties: false` ONLY where the Zod schema is `.strict()` (check each; the verifier's strictness is the law — do not tighten beyond it); digest fields as `{"type": "string", "pattern": "^[0-9a-f]{64}$"}` or `^sha256:[0-9a-f]{64}$` matching the actual field spelling; base64 fields `{"type": "string", "contentEncoding": "base64"}` plus pattern; `required` mirrors Zod non-optional members. Each schema gets `"$comment"` pointing at the Zod source path so future editors know the master.

- [ ] **Step 4: Run to verify it passes; negative-check two tampered docs**

Run: `node --test test/schema-conformance.test.mjs`
Expected: PASS. Add one negative test: `trust-key-swapped`'s `trust/public-keys.json` STILL validates structurally (schema validity ≠ verification — state this in the test name: "schema validity does not imply verification"), proving the schemas do not overclaim.

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
cd packages/benchmark-product/verify && yarn typecheck && yarn test
git add packages/benchmark-product/verify
git commit -m "feat(benchmark-product): tier-4 JSON Schemas for the public-bundle document formats (#2796)"
```

---

### Task 6: External verification profile + dependency-free walkthrough script (PR-C)

**Files:**
- Create: `packages/benchmark-product/EXTERNAL-VERIFICATION.md`
- Create: `packages/benchmark-product/verify/scripts/external-verify.py`
- Modify: `packages/benchmark-product/verify/package.json` — add `"scripts/external-verify.py"` and `"schemas/"` to `files` (schemas done in Task 5; confirm both)

**Interfaces:**
- Consumes: the check inventory (research, from `verify/src/verify.ts`), the kit, the schemas.
- Produces: `external-verify.py` exit contract — `0` all external checks pass, `1` any check fails, `2` usage/environment failure; one `CHECK <name>: ok|FAIL <detail>` line per check on stdout. Task 7's walkthrough test executes this exact contract.

- [ ] **Step 1: Write `external-verify.py`**

Python 3.10+ stdlib + `openssl` subprocess (OpenSSL 3+ for `pkeyutl -rawin` Ed25519; the script probes `openssl version` and exits 2 with a clear message if unusable). Checks, in order (≈1 page of code, plus the openssl probe):

1. `manifest-files`: every `bundle.json` entry's bytes + SHA-256 match; tree closure both directions (ignoring `bundle.json` itself).
2. `cas-records`: every `records/<hex>.bin` re-hashes to its name; every `evidence.json` entry resolves.
3. `sealed-bytes`: `report.json` bytes == base64-decoded `report-envelope.json` payload; digests of `benchmark.json` / `run.json` / `matrix.json` / `report.json` / `report-envelope.json` equal `claim-package.json` `records.*Sha256`.
4. `report-signature`: DSSE PAE (`DSSEv1 <len> <payloadType> <len> <payload>`) verified with `openssl pkeyutl -verify -pubin -keyform DER -rawin` against `trust/public-keys.json` `report.spkiDerBase64`; keyid must equal `report.keyId`.
5. `report-pins-matrix`: `report.json` `subjects[].digest.sha256` includes the SHA-256 of `matrix.json`.
6. `verdict-signatures`: every `verdicts.json` entry's record is a DSSE envelope whose signature verifies against the evaluator key with matching `keyId`; `payloadType == "application/vnd.in-toto+json"`.
7. `matrix-verdict-closure`: every matrix cell's `verdicts`/`validVerdicts` digests exist in `records/` and appear in `verdicts.json` for that cell.
8. `key-derivations`: report `did:key` == multicodec `0xed01` + base58btc of the raw Ed25519 key from SPKI (base58 alphabet inline, ~10 lines); evaluator `keyId` == `benchmark-product-verdict-` + first 16 hex of SHA-256(SPKI DER).

Final stdout block prints the honest boundary verbatim:

```
These checks prove internal consistency and that the bundle is signed by the
keys the bundle itself names. They do NOT re-derive the matrix, recompute the
statistical method, or rebuild the claim package (the reference verifier does),
and no tool can prove the producing venue was honest.
```

- [ ] **Step 2: Prove it against the kit by hand**

Run: `python3 packages/benchmark-product/verify/scripts/external-verify.py packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1/golden; echo exit=$?`
Expected: all `CHECK ...: ok`, exit 0.
Run against `tampered/report-signature-grafted`. Expected: `CHECK report-signature: FAIL ...`, exit 1.
Run against `tampered/results-miscomputed-resigned`. Expected: exit 0 (this is the boundary case; the script's closing block explains why).

- [ ] **Step 3: Write `EXTERNAL-VERIFICATION.md`**

Structure (order is load-bearing):

1. **What verification proves / does not prove** — the table, FIRST. Three columns of claims: provable with your own tools; provable only with the reference verifier (`npx @colophon-claims/verify@2 <bundle-dir>`: matrix re-derivation, method recompute, claim-package recomputation, presentation-asset re-derivation, derived-task/nonce/idempotency recomputation); provable by no tool (venue honesty — the five `LOCAL_VENUE_LIMITS` reproduced verbatim; party independence; isolation strength; cost figures; host integrity after verification).
2. **The record family** — bundle layout table (every file, its format literal, its schema file under `schemas/` in the `@colophon-claims/verify` package); digest rules (SHA-256 over exact bytes; `sha256:<hex>` in record bodies vs bare hex in file names/catalogs; sealed-once: canonicalization happened at sealing, verifiers hash received bytes, NOTHING re-canonicalizes).
3. **DSSE envelopes** — layout, PAE formula, payloadType literals (`application/vnd.jinn.benchmarking.report.v1+json`, `application/vnd.in-toto+json`), Ed25519 SPKI DER keys, signature base64; cite the DSSE v1 and in-toto Statement v1 specs by URL.
4. **Key discovery** — `trust/public-keys.json` walkthrough, `did:key` and `keyId` derivations, and the trust boundary: keys are bundle-carried and workspace-minted; `selfRun.partyIndependence: "not-established"` is part of the format.
5. **The 30-minute walkthrough** — exact commands (shasum/python3 one-liners, openssl invocations, then `external-verify.py`) with expected output blocks, and the reference-verifier equivalents with exit codes.
6. **The conformance kit** — where it lives, `manifest.json` semantics, the instruction: "an implementation that accepts `golden` and rejects every `tampered/*` for the stated reason, including accepting `results-miscomputed-resigned` only if it does not claim method recomputation, conforms to the external profile."
7. **Identifier note** — the platform record schemas' `$id`s under `https://spec.jinn.network/...`, with the DR-2026-08-17-c disclosure sentence that the origin is not hosted yet and identifiers are names first; retrieval today is the source repository and the npm tarballs.

Voice: `BRAND.md` (plain speech; this is a money/safety-adjacent surface — no metaphor). No neighbour vocabulary. No emoji.

- [ ] **Step 4: Commit**

```bash
git add packages/benchmark-product/EXTERNAL-VERIFICATION.md packages/benchmark-product/verify
git commit -m "docs(benchmark-product): external verification profile + dependency-free walkthrough script (#2796)"
```

---

### Task 7: Executable walkthrough test + surface wiring (PR-C)

**Files:**
- Create: `packages/benchmark-product/verify/test/external-walkthrough.test.mjs`
- Modify: `packages/benchmark-product/README.md` (add EXTERNAL-VERIFICATION.md to the index), `packages/benchmark-product/verify/README.md` (one paragraph: verify with your own tools, link profile + kit), `packages/benchmark-product/PUBLIC-BUNDLE.md` (§Portable verification: add the external path beside the reference CLI)

**Interfaces:**
- Consumes: `external-verify.py` exit contract from Task 6; kit `manifest.json` `externallyDetectable` flags from Task 3.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/external-verify.py", import.meta.url));
const kit = fileURLToPath(new URL("../fixtures/public-bundle-conformance-v1", import.meta.url));
const manifest = JSON.parse(readFileSync(join(kit, "manifest.json"), "utf8"));

async function externalVerify(dir) {
  try { const r = await exec("python3", [script, dir]); return { code: 0, stdout: r.stdout }; }
  catch (e) { return { code: e.code, stdout: e.stdout ?? "" }; }
}

const probe = await externalVerify(join(kit, "golden"));
const environmentReady = probe.code !== 2;

test("external walkthrough accepts the golden bundle", { skip: !environmentReady && "python3/openssl unavailable" }, async () => {
  assert.equal(probe.code, 0, probe.stdout);
  assert.match(probe.stdout, /CHECK report-signature: ok/);
});

for (const fixture of manifest.fixtures) {
  test(`external walkthrough on ${fixture.id}`, { skip: !environmentReady && "python3/openssl unavailable" }, async () => {
    const { code } = await externalVerify(join(kit, fixture.path));
    if (fixture.externallyDetectable) assert.equal(code, 1, `${fixture.id} must fail externally`);
    else assert.equal(code, 0, `${fixture.id} is the documented external blind spot and must pass externally`);
  });
}
```

Skip semantics: loud skip (node --test `skip` reason string) only when python3/openssl are genuinely absent; CI (ubuntu-latest) has both, so CI always exercises it.

- [ ] **Step 2: Run to verify it fails** (script or kit flag mismatches surface here)

Run: `cd packages/benchmark-product/verify && node --test test/external-walkthrough.test.mjs`
Expected: PASS if Tasks 3+6 landed exactly; treat any failure as a defect in the tamper generator's `externallyDetectable` flags or the script — fix there, never weaken the test.

- [ ] **Step 3: Wire the docs**

- `PUBLIC-BUNDLE.md` §Portable verification gains: "Verification with your own tools: see `EXTERNAL-VERIFICATION.md` for the profile, the JSON Schemas shipped under `schemas/`, and the conformance kit under `fixtures/public-bundle-conformance-v1/` whose tampered variants your verifier must reject."
- READMEs: one short link paragraph each; show, don't narrate.

- [ ] **Step 4: Full package verification + commit**

```bash
cd packages/benchmark-product/verify && yarn typecheck && yarn test
cd ../core && yarn typecheck && yarn test
git add packages/benchmark-product
git commit -m "test(benchmark-product): executable external walkthrough + doc wiring (#2796)"
```

---

### Task 8: Fresh-environment verification evidence + PRs

**Files:**
- Create (scratch, not committed): a temp dir outside the repo with only the kit + profile copied in
- PR bodies on GitHub

- [ ] **Step 1: Fresh-environment run (the issue's definition of done, executed literally)**

```bash
FRESH=$(mktemp -d)
cp -R packages/benchmark-product/verify/fixtures/public-bundle-conformance-v1 "$FRESH/kit"
cp packages/benchmark-product/verify/scripts/external-verify.py "$FRESH/"
cp packages/benchmark-product/EXTERNAL-VERIFICATION.md "$FRESH/"
cd "$FRESH" && python3 external-verify.py kit/golden; echo "golden exit=$?"
for d in kit/tampered/*/; do python3 external-verify.py "$d" >/dev/null 2>&1; echo "$(basename "$d") exit=$?"; done
```

Expected: golden exit 0; every variant exit 1 except `results-miscomputed-resigned` (exit 0, the documented external blind spot — quote the profile line that names it). No Jinn checkout, no node_modules, no network. Capture the full transcript.

- [ ] **Step 2: Open the PRs**

PR-A from Task 1's branch; PR-B from Tasks 2–4; PR-C stacked on PR-B from Tasks 5–7. All target `next` (PR-C's base is PR-B's branch until B merges). Bodies: problem link (#2796; `Closes #2796` on PR-C only), what changed, verification evidence (test output; PR-C additionally carries the Step 1 transcript). No em dashes; paragraphs unwrapped. Follow `superpowers:requesting-code-review` before marking ready.

- [ ] **Step 3: Verification-before-completion checklist**

Run and paste into the session notes: `yarn typecheck` + `yarn test` in `packages/benchmarking/records`, `packages/benchmark-product/verify`, `packages/benchmark-product/core`; the platform-architecture-control gate commands from Task 1 Step 5; the conformance suite; the walkthrough suite.

---

## Self-Review

- Spec coverage: kickoff deliverable 1 (profile) → Task 6; deliverable 2 (schemas at stable URLs) → Tasks 1 + 5 with the divergence disposition recorded in Global Constraints; deliverable 3 (fixture kit + tamper matrix) → Tasks 2–4; deliverable 4 (30-minute path) → Tasks 6–8; deliverable 5 (emit-path additions) → confirmed not needed by the session dry-run (openssl verified the shipped DSSE envelope as-is); acceptance criteria of #2796 → Task 8 Step 1 is the literal execution.
- Placeholders: none — every step names exact files, commands, and expected outcomes; two deliberately observation-dependent points (verdict-key filename, failing-check assertion field) instruct the implementer to read the named source file first, which is investigation, not deferral.
- Type consistency: the six check ids, format literals, exit contracts, and kit manifest fields are spelled identically across Tasks 3, 4, 5, 6, 7.
