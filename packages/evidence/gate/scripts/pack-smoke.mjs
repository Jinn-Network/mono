// SPDX-License-Identifier: Apache-2.0
// Packs the gate and its portal dependencies, then proves the tarball is what a real
// consumer gets: the kit ships, nothing private leaks, a root-only consumer installs and
// serves a free offer without vitest, and the packed /testing entrypoint runs under real
// vitest.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const trustCoreRoot = join(packagesRoot, "..", "trust", "core");
const protocolRoot = join(packagesRoot, "protocol");
const repositoryRoot = join(packagesRoot, "repository");
const offerRoot = join(packagesRoot, "offer");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-gate-"));
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const offerArchive = join(temporaryRoot, "evidence-offer.tgz");
const gateArchive = join(temporaryRoot, "evidence-gate.tgz");
const rootConsumer = join(temporaryRoot, "root-consumer");
const testingConsumer = join(temporaryRoot, "testing-consumer");

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
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

const DEPENDENCIES = {
  "@jinn-network/evidence-gate": `file:${gateArchive}`,
  "@jinn-network/evidence-offer": `file:${offerArchive}`,
  "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
  "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
  "@jinn-network/trust-core": `file:${trustCoreArchive}`,
};

const REQUIRED_ENTRIES = [
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/testing.js",
  "package/dist/testing.d.ts",
  "package/package.json",
];

try {
  for (const [root, archive] of [
    [trustCoreRoot, trustCoreArchive],
    [protocolRoot, protocolArchive],
    [repositoryRoot, repositoryArchive],
    [offerRoot, offerArchive],
  ]) {
    await run("corepack", ["yarn@4.13.0", "build"], { cwd: root });
    await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: root });
  }
  await run("corepack", ["yarn@4.13.0", "pack", "--out", gateArchive], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", gateArchive])).split(/\r?\n/u).filter(Boolean);
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) throw new Error(`packed gate is missing ${required}`);
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry)
      || entry.endsWith(".map")
      || entry.includes("/src/"),
  );
  if (leaked.length > 0) {
    throw new Error(`test material leaked into the tarball: ${leaked.join(", ")}`);
  }

  await mkdir(rootConsumer);
  await writeFile(
    join(rootConsumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: DEPENDENCIES }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: rootConsumer });
  await writeFile(
    join(rootConsumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OFFER_RECORD_KIND, sealOffer } from "@jinn-network/evidence-offer";
import { recordDigest } from "@jinn-network/trust-core";
import * as root from "@jinn-network/evidence-gate";

assert.equal(
  root.DELIVERY_STATEMENT_RECORD_KIND,
  "https://spec.jinn.network/records/delivery-statement/v1",
);
assert.equal("describeRailAdapterConformance" in root, false);
assert.equal("createTestRailAdapter" in root, false);
assert.equal("createFixtureSigner" in root, false);

const signer = async ({ preAuthEncoding }) => [{
  signature: new Uint8Array(createHash("sha256").update(preAuthEncoding).digest()),
  keyid: "did:key:zGateSmokeSigner",
}];

const goods = new TextEncoder().encode("bytes a stranger may have for free");
const subject = recordDigest(goods);
const sealed = await sealOffer({
  offer: {
    kind: OFFER_RECORD_KIND,
    subject,
    rails: [],
    gate: { uri: "https://gate.example/v1" },
  },
  signer,
});

const gate = root.createRetrievalGate({
  offers: root.createInMemoryOfferSource([sealed.envelopeBytes]),
  subjects: root.createInMemorySubjectSource([goods]),
  deliveryStatements: { signer },
});

const outcome = await gate.request({ offer: sealed.digest });
assert.equal(outcome.status, "delivered");
assert.equal(recordDigest(outcome.bytes), subject);
assert.equal(
  root.parseDeliveryStatementEnvelope(outcome.statement.envelopeBytes).statement.subject,
  subject,
);

const missing = await gate.request({ offer: "sha256:" + "0".repeat(64) });
assert.equal(missing.status, "refused");
assert.equal(missing.code, "unknown-offer");
`,
  );
  await run(process.execPath, [join(rootConsumer, "smoke.mjs")], { cwd: rootConsumer });
  await assert.rejects(
    access(join(rootConsumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );

  const installedManifest = JSON.parse(
    await readFile(
      join(rootConsumer, "node_modules", "@jinn-network", "evidence-gate", "package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.peerDependencies, { vitest: "^4.1.8" });
  assert.deepEqual(installedManifest.peerDependenciesMeta, { vitest: { optional: true } });
  assert.deepEqual(Object.keys(installedManifest.dependencies ?? {}).sort(), [
    "@jinn-network/evidence-offer",
    "@jinn-network/evidence-repository",
    "@jinn-network/trust-core",
    "zod",
  ]);

  await mkdir(testingConsumer);
  await writeFile(
    join(testingConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { ...DEPENDENCIES, typescript: "5.9.3", vite: "6.4.3", vitest: "4.1.8" },
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
      include: ["smoke.test.ts"],
    }),
  );
  await writeFile(
    join(testingConsumer, "smoke.test.ts"),
    `
import { recordDigest } from "@jinn-network/trust-core";
import {
  createTestRailAdapter,
  describeRailAdapterConformance,
} from "@jinn-network/evidence-gate/testing";

const RAIL = "https://rails.test.example/v1";
const TO = "acct:holder@rails.test.example";
const OFFER = recordDigest(new TextEncoder().encode("the offer these payments reference"));

describeRailAdapterConformance({
  name: "the packed in-memory test rail",
  create: () => ({
    adapter: createTestRailAdapter({
      rail: RAIL,
      settlement: "explicit-claim",
      payments: [{ reference: "tx-1", offerDigest: OFFER, to: TO, amount: "1200" }],
    }),
    offerDigest: OFFER,
    entry: { rail: RAIL, to: TO, amount: "1200" },
    reference: "tx-1",
  }),
});
`,
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: testingConsumer });
  await run("npm", ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: testingConsumer });
  await run("npm", ["exec", "--", "vitest", "run", "smoke.test.ts"], { cwd: testingConsumer });

  console.log("Packed gate root isolation, free-path delivery, and /testing kit verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
