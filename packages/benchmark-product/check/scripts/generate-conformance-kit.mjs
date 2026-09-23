#!/usr/bin/env node
// Generates fixtures/public-bundle-conformance-v1/golden (a complete, real
// public bundle) plus keys/ (the test-only venue signing keys that produced it)
// by driving the built product CLI end-to-end on the real local venue — the
// same verb sequence the public quickstart proves. Regeneration replaces the
// golden and keys wholesale; tampered variants are derived afterwards by
// generate-tamper-variants.mjs. The bundle bytes are copied, never re-serialized.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePackageRoot = resolve(here, "..", "..", "core");
const cliBinPath = join(corePackageRoot, "dist", "cli", "bin.js");
const kitDir = resolve(here, "..", "fixtures", "public-bundle-conformance-v1");
const draftId = "conformance-golden";

if (!existsSync(cliBinPath)) {
  console.error(`built product CLI missing at ${cliBinPath} — run \`yarn build\` in packages/benchmark-product/core first`);
  process.exit(2);
}

const workspaceDir = mkdtempSync(join(tmpdir(), "conformance-golden-"));
const common = ["--workspace", workspaceDir, "--principal", "sponsor-1"];
const forDraft = [...common, "--draft", draftId];

function step(label, argv) {
  const outcome = spawnSync(process.execPath, [cliBinPath, ...argv, "--json"], {
    timeout: 180_000,
    encoding: "utf8",
  });
  if (outcome.status !== 0) {
    throw new Error(`${label} failed (exit ${outcome.status}):\n${outcome.stdout}\n${outcome.stderr}`);
  }
  const lines = outcome.stdout.trim().split("\n");
  const parsed = JSON.parse(lines.at(-1));
  return parsed?.result ?? parsed;
}

try {
  step("init", ["init", ...common]);
  step("draft create", [
    "draft", "create", ...common,
    "--id", draftId,
    "--name", "Conformance golden",
    "--description", "Golden public bundle for the external conformance kit",
  ]);
  step("sample init", ["sample", "init", ...forDraft]);
  step("arm add baseline", [
    "arm", "add", ...forDraft,
    "--arm", "baseline",
    "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
  ]);
  step("arm add sample-uniform", [
    "arm", "add", ...forDraft,
    "--arm", "sample-uniform",
    "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
  ]);
  step("quote", ["quote", ...forDraft]);
  step("lock", ["lock", ...forDraft]);
  step("launch", ["launch", ...forDraft]);
  step("resume", ["resume", ...forDraft]);
  step("collect", ["collect", ...forDraft]);
  step("results", ["results", ...forDraft]);
  step("report", ["report", ...forDraft]);
  step("workspace verify", ["verify", ...forDraft]);
  const publish = step("publish", ["publish", ...forDraft]);

  const sourceBundleDir = resolve(workspaceDir, publish.bundleRelativePath);
  rmSync(kitDir, { recursive: true, force: true });
  mkdirSync(join(kitDir, "keys"), { recursive: true });
  cpSync(sourceBundleDir, join(kitDir, "golden"), {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    dereference: false,
  });
  const venueDir = join(workspaceDir, "venue");
  for (const entry of readdirSync(venueDir, { withFileTypes: true })) {
    if (entry.isFile() && /signing-key\.(?:pem|json)$/.test(entry.name)) {
      cpSync(join(venueDir, entry.name), join(kitDir, "keys", entry.name));
    }
  }
  const evaluatorsDir = join(venueDir, "evaluators");
  if (existsSync(evaluatorsDir)) {
    for (const evaluator of readdirSync(evaluatorsDir, { withFileTypes: true })) {
      if (!evaluator.isDirectory()) continue;
      for (const entry of readdirSync(join(evaluatorsDir, evaluator.name), { withFileTypes: true })) {
        if (entry.isFile() && /signing-key\.(?:pem|json)$/.test(entry.name)) {
          mkdirSync(join(kitDir, "keys", "evaluators", evaluator.name), { recursive: true });
          cpSync(
            join(evaluatorsDir, evaluator.name, entry.name),
            join(kitDir, "keys", "evaluators", evaluator.name, entry.name),
          );
        }
      }
    }
  }
  writeFileSync(
    join(kitDir, "keys", "README.md"),
    [
      "# Test-only signing keys",
      "",
      "These private keys sign ONLY this conformance kit's golden fixture. They",
      "identify no real party, anchor no trust, and exist so the kit's re-signed",
      "adversarial variant is reproducible and so implementers can mint variants",
      "of their own. Never reuse them for anything else.",
      "",
    ].join("\n"),
  );
  console.log(`golden bundle: ${publish.bundleIdentity}`);
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}
