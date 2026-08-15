// Generates the golden and adversarial state-artifact fixture corpora from the schema.
// Fixtures are derived from the specification and this generator, never captured from a
// product run. Default writes; `--check` detects drift.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesRoot = join(root, "fixtures");

const {
  serializeStateArtifact,
  stateArtifactDigest,
} = await import(join(root, "dist", "artifact.js"));
const {
  buildCoverageArtifacts,
  collectSourceProofs,
} = await import(join(root, "dist", "coverage.js"));
const { createBudgetedArchivePort } = await import(join(root, "dist", "budget.js"));
const {
  buildFakeTrieWorld,
  fakeStateArtifact,
  FAKE_ACTOR,
  FAKE_POOL,
} = await import(join(root, "dist", "testing.js"));

const ANCHOR = {
  blockNumber: 21_000_000,
  blockHash: `0x${"1".repeat(64)}`,
  stateRoot: `0x${"3".repeat(64)}`,
  timestamp: 1_760_000_000,
};
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

const MINIMAL = {
  schemaVersion: "chain-state-artifact.v1",
  anchor: ANCHOR,
  accounts: [
    {
      address: A,
      balance: "0xde0b6b3a7640000",
      nonce: "0x1",
      code: "0x6001",
      storage: [{ slot: SLOT_1, value: `0x${"0".repeat(63)}7` }],
    },
  ],
};

const check = process.argv.includes("--check");
const failures = [];

async function emit(relativePath, contents) {
  const target = join(fixturesRoot, relativePath);
  const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  if (!check) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
    return;
  }
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== text) failures.push(relativePath);
}

const minimalBytes = serializeStateArtifact(MINIMAL);
await emit("artifacts-v1/minimal.json", minimalBytes);
await emit("artifacts-v1/minimal.sha256", `${stateArtifactDigest(minimalBytes)}\n`);

const world = buildFakeTrieWorld();
const convergedArtifact = fakeStateArtifact(world.stateRoot);
const convergedBytes = serializeStateArtifact(convergedArtifact);
await emit("artifacts-v1/converged.json", convergedBytes);
await emit("artifacts-v1/converged.sha256", `${stateArtifactDigest(convergedBytes)}\n`);

const uppercased = JSON.parse(new TextDecoder().decode(minimalBytes));
uppercased.accounts[0].address = A.toUpperCase().replace("0X", "0x");
await emit("adversarial-v1/uppercase-hex.json", `${JSON.stringify(uppercased)}\n`);

const unsorted = JSON.parse(new TextDecoder().decode(minimalBytes));
unsorted.accounts[0].storage = [
  { slot: SLOT_2, value: `0x${"0".repeat(63)}8` },
  { slot: SLOT_1, value: `0x${"0".repeat(63)}7` },
];
await emit("adversarial-v1/unsorted-slots.json", `${JSON.stringify(unsorted)}\n`);

const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
const artifact = fakeStateArtifact(world.stateRoot);
const proofs = await collectSourceProofs(archive, artifact, {
  addresses: [FAKE_POOL],
  stateRoot: world.stateRoot,
});
if (!proofs.ok) {
  throw new Error(`coverage fixture generation failed to collect proofs: ${proofs.detail}`);
}
const built = buildCoverageArtifacts({
  artifact,
  fidelityClass: "anchored-subset",
  bundle: proofs.value,
  declarations: [{ address: FAKE_ACTOR, kind: "account" }],
});
if (!built.ok) {
  throw new Error(`coverage fixture generation failed to build artifacts: ${built.detail}`);
}

await emit("coverage-v1/proof-bundle.json", built.value.bundleBytes);
await emit("coverage-v1/proof-bundle.sha256", `${built.value.bundleDigest}\n`);
await emit("coverage-v1/fixture-coverage.json", built.value.fixtureBytes);
await emit("coverage-v1/fixture-coverage.sha256", `${built.value.fixtureDigest}\n`);

const uncoveredBuilt = buildCoverageArtifacts({
  artifact,
  fidelityClass: "anchored-subset",
  bundle: proofs.value,
  declarations: [],
});
if (uncoveredBuilt.ok) {
  throw new Error("uncovered-entry fixture expected coverage-incomplete failure");
}
const uncoveredEntry = {
  artifact,
  sourceAddresses: [FAKE_POOL],
  declarations: [],
  expectedReason: uncoveredBuilt.reason,
  uncoveredAddress: FAKE_ACTOR,
};
await emit("adversarial-v1/uncovered-entry.json", `${JSON.stringify(uncoveredEntry)}\n`);

if (check && failures.length > 0) {
  console.error(`fixture drift in:\n${failures.map((path) => `  ${path}`).join("\n")}`);
  process.exit(1);
}
console.log(check ? "fixtures up to date" : "fixtures written");
