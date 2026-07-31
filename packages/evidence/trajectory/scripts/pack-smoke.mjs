// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const trustCoreRoot = join(packagesRoot, "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-trajectory-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const trajectoryArchive = join(temporaryRoot, "evidence-trajectory.tgz");
const rootConsumer = join(temporaryRoot, "root-consumer");
const testingConsumer = join(temporaryRoot, "testing-consumer");

const REQUIRED_ENTRIES = [
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/testing.js",
  "package/dist/testing.d.ts",
  "package/schemas/trajectory.schema.json",
  "package/schemas/trajectory-derivation-statement.schema.json",
  "package/fixtures/trajectory/valid.json",
  "package/fixtures/trajectory/valid.sha256",
  "package/fixtures/adversarial-v1/manifest.json",
  "package/fixtures/derivation/execution-golden-base.json",
  "package/README.md",
  "package/package.json",
];

const PACK_SMOKE_PINNED_CASE_COUNT = 78;
const PACK_SMOKE_PINNED_CASE_DIGEST =
  "d80aec258fec3a3f3b2c20d28d8273e44ab5b364c329eb06eeea3fb006a1b712";
const PACK_SMOKE_PINNED_CASE_IDS = Object.freeze([
  "build-rejects-non-calendar-strict-derived-at",
  "build-rejects-missing-linkage-mode",
  "build-input-getter-not-invoked-during-preflight",
  "malformed-envelope-fails-l1-no-authority",
  "authority-verified-false-fails-l2",
  "bad-execution-digest-fails-l3",
  "missing-forward-link-fails-l3",
  "signed-unfaithful-spans-pass-l1-l3-l4-not-evaluated",
  "sealed-parent-golden-passes-l1-l3",
  "forward-link-on-sealed-parent-fails-l3",
  "valid-attestation-passes-l1-l3-l4-not-evaluated",
  "duplicate-json-key-bytes-fail-l1",
  "decoy-native-trace-file-fails-l3",
  "duplicate-forward-links-fail-l3",
  "correct-and-wrong-forward-links-fail-l3",
  "malformed-forward-link-value-fails-l3",
  "wrong-digest-forward-link-fails-l3",
  "attestation-naming-decoy-digest-fails-l3",
  "primary-native-trace-wrong-type-fails-l3",
  "authority-malformed-string",
  "authority-malformed-number",
  "authority-malformed-array",
  "authority-malformed-verified-string",
  "authority-malformed-verified-false-without-reason",
  "authority-malformed-forged-signer-key-ids",
  "authority-malformed-unknown-key",
  "non-enumerable-authority-field-fails-l2",
  "symbol-authority-key-fails-l2",
  "cyclic-signer-key-ids-fails-l2",
  "authority-callback-throw-fails-l2",
  "pre-aborted-signal-cancellation",
  "abort-during-authority-cancellation",
  "authority-abort-error-cancellation",
  "proxy-authority-result-fails-l2",
  "accessor-authority-result-fails-l2",
  "verify-port-accessor-envelope-bytes",
  "sparse-signer-key-ids-fails-l2",
  "augmented-signer-key-ids-fails-l2",
  "unknown-statement-field-seal-no-signer",
  "alternate-payload-escaping-fails-l1",
  "trajectory-record-schema-hostile-getters",
  "non-callable-verify-authority-fails-port",
  "proxy-throwing-authority-error",
  "genuine-abort-signal-native-cancellation",
  "fake-abort-signal-rejected",
  "preflight-getPrototypeOf-trap-before-instanceof",
  "span-schema-proxy-trap-zero",
  "json-extension-schema-proxy-trap-zero",
  "seal-pre-abort-signer-uncalled",
  "seal-signer-abort-error-cancellation",
  "signer-mutates-callback-bytes-envelope-canonical",
  "authority-mutates-callback-bytes-digest-unchanged",
  "subjectOf-singleton-array-passes",
  "subjectOf-empty-array-fails",
  "subjectOf-multi-distinct-fails",
  "forward-link-missing-propertyvalue-type-fails",
  "forward-link-wrong-type-thing-fails",
  "forward-link-valid-plus-malformed-fails",
  "otlp-uint64-max-boundary-pass",
  "otlp-uint64-overflow-fails",
  "otlp-int64-max-boundary-pass",
  "otlp-int64-overflow-fails",
  "otlp-int64-minus-zero-pass",
  "derivation-statement-schema-ajv-forward-linked",
  "derivation-statement-schema-ajv-sealed-parent",
  "ajv-packed-int64-overflow-fails",
  "ajv-packed-int64-min-boundary-pass",
  "statement-schema-subject-empty-fails",
  "statement-schema-subject-two-fails",
  "statement-schema-derived-at-invalid-fails",
  "statement-schema-derived-at-feb29-non-leap-fails",
  "statement-schema-derived-at-leap-day-pass",
  "preflight-revoked-proxy-typed-invalid",
  "build-port-revoked-proxy-typed-invalid",
  "deriveTraceId-hostile-getter-trap-zero",
  "sha256Hex-prototype-trap-rejects",
  "seal-signer-throws-symbol-typed-signing-error",
  "authority-abort-signal-then-ordinary-throw-cancellation",
]);

function manifestDigest(ids) {
  return createHash("sha256").update(ids.join("\n"), "utf8").digest("hex");
}

function assertIndependentManifestPin(ids, context) {
  if (ids.length !== PACK_SMOKE_PINNED_CASE_COUNT) {
    throw new Error(
      `${context}: expected ${String(PACK_SMOKE_PINNED_CASE_COUNT)} case ids, got ${String(ids.length)}`,
    );
  }
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`${context}: duplicate conformance case id ${id}`);
    }
    seen.add(id);
  }
  if (manifestDigest(ids) !== PACK_SMOKE_PINNED_CASE_DIGEST) {
    throw new Error(`${context}: ordered manifest digest does not match independent pin`);
  }
  for (let index = 0; index < PACK_SMOKE_PINNED_CASE_IDS.length; index += 1) {
    if (ids[index] !== PACK_SMOKE_PINNED_CASE_IDS[index]) {
      throw new Error(
        `${context}: case id mismatch at index ${String(index)} (${ids[index]} vs ${PACK_SMOKE_PINNED_CASE_IDS[index]})`,
      );
    }
  }
}

function runManifestPinMutationSelfTests() {
  const base = [...PACK_SMOKE_PINNED_CASE_IDS];
  const expectPinFailure = (mutant, label) => {
    try {
      assertIndependentManifestPin(mutant, label);
      throw new Error(`mutation self-test expected failure: ${label}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("mutation self-test")) {
        throw error;
      }
    }
  };
  expectPinFailure(base.slice(0, -1), "delete case");
  expectPinFailure([...base.slice(0, 10), "renamed-case-id", ...base.slice(11)], "rename case");
  expectPinFailure([...base, "extra-case-id"], "extra case");
  expectPinFailure([base[1], base[0], ...base.slice(2)], "reorder cases");
  expectPinFailure([...base.slice(0, 5), base[5], ...base.slice(5)], "duplicate case");
  expectPinFailure(base.filter((_, index) => index !== 12), "skip case");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

try {
  runManifestPinMutationSelfTests();

  await run("corepack", ["yarn@4.13.0", "build"], { cwd: trustCoreRoot });
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", trustCoreArchive],
    { cwd: trustCoreRoot },
  );
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", protocolArchive],
    { cwd: join(packagesRoot, "protocol") },
  );
  await run(
    "corepack",
    ["yarn@4.13.0", "pack", "--out", trajectoryArchive],
    { cwd: packageRoot },
  );

  const entries = (await output("tar", ["-tzf", trajectoryArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) {
      throw new Error(`packed trajectory is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("local-corpus"),
  );
  if (leaked.length > 0) {
    throw new Error(
      `private/test implementation material leaked into tarball: ${leaked.join(", ")}`,
    );
  }

  const manifestEntry = entries.find((entry) =>
    entry.endsWith("fixtures/adversarial-v1/manifest.json"),
  );
  assert.ok(manifestEntry, "packed adversarial manifest must be present");
  const manifest = JSON.parse(
    await output("tar", ["-xOf", trajectoryArchive, manifestEntry]),
  );
  assert.equal(
    manifest.fixtures.length,
    8,
    "packed adversarial manifest must ship exactly eight fixtures",
  );

  await mkdir(rootConsumer);
  await writeFile(
    join(rootConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-trajectory": `file:${trajectoryArchive}`,
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: rootConsumer },
  );

  const { TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS: packedCaseIds } = await import(
    join(
      rootConsumer,
      "node_modules",
      "@jinn-network",
      "evidence-trajectory",
      "dist",
      "conformance-case-manifest.js",
    ),
  );
  assertIndependentManifestPin([...packedCaseIds], "packed export");

  await writeFile(
    join(rootConsumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as root from "@jinn-network/evidence-trajectory";

assert.equal(typeof root.sealTrajectory, "function");
assert.equal(typeof root.parseTrajectory, "function");
assert.equal(typeof root.verifyTrajectoryDerivationAttestation, "function");
assert.equal(typeof root.TrajectoryDerivationStatementSchema, "object");
assert.equal(root.TRAJECTORY_RECORD_KIND, "https://jinn.network/records/trajectory/1.0");
assert.equal("canonicalJsonBytes" in root, false);
assert.equal("sha256Digest" in root, false);
`,
  );
  await run(process.execPath, [join(rootConsumer, "smoke.mjs")], {
    cwd: rootConsumer,
  });
  await assert.rejects(
    access(join(rootConsumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );
  const installedManifest = JSON.parse(
    await readFile(
      join(
        rootConsumer,
        "node_modules",
        "@jinn-network",
        "evidence-trajectory",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.peerDependencies, {
    vitest: "^4.1.8",
  });
  assert.deepEqual(installedManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  const forbiddenDependencies = [
    "@jinn-network/attestation-issuer",
    "@huggingface/transformers",
    "@lmoe/gliner-onnx",
    "better-sqlite3",
    "viem",
  ];
  for (const dependency of forbiddenDependencies) {
    if (
      dependency in (installedManifest.dependencies ?? {}) ||
      dependency in (installedManifest.optionalDependencies ?? {})
    ) {
      throw new Error(`packed trajectory includes forbidden ${dependency}`);
    }
  }
  assert.ok(
    "@jinn-network/trust-core" in (installedManifest.dependencies ?? {}),
    "packed trajectory must depend on @jinn-network/trust-core",
  );

  await mkdir(testingConsumer);
  await writeFile(
    join(testingConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-trajectory": `file:${trajectoryArchive}`,
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        typescript: "5.9.3",
        vite: "6.4.3",
        vitest: "4.1.8",
        ajv: "8.17.1",
      },
    }),
  );
  await writeFile(
    join(testingConsumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        types: ["vitest/globals"],
      },
      include: ["conformance.test.ts"],
    }),
  );
  await writeFile(
    join(testingConsumer, "conformance.test.ts"),
    `
import { describeTrajectoryDerivationAttestationConformance, describeTrajectoryRecordConformance, TRAJECTORY_DERIVATION_CONFORMANCE_CASE_COUNT, TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS } from "@jinn-network/evidence-trajectory/testing";
import { expect, test } from "vitest";

const PINNED_CASE_COUNT = ${PACK_SMOKE_PINNED_CASE_COUNT};
const PINNED_CASE_IDS = ${JSON.stringify([...PACK_SMOKE_PINNED_CASE_IDS])};

test("packed testing export exposes the pinned conformance case manifest", () => {
  expect(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_COUNT).toBe(PINNED_CASE_COUNT);
  expect([...TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS]).toEqual(PINNED_CASE_IDS);
});

describeTrajectoryRecordConformance();
describeTrajectoryDerivationAttestationConformance();
`,
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: testingConsumer },
  );
  await run(
    "npm",
    ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"],
    { cwd: testingConsumer },
  );
  await run(
    "npm",
    ["exec", "--", "vitest", "run", "conformance.test.ts"],
    { cwd: testingConsumer },
  );
  console.log(
    "Packed trajectory root isolation, packed conformance kit, and archive boundary verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
