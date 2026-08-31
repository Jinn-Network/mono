// SPDX-License-Identifier: Apache-2.0
// Packs trust-core and the offer package, then proves the tarball is what a real consumer
// gets: the kit and fixtures ship, nothing private leaks, a root-only consumer installs
// without vitest, and the packed /testing entrypoint runs under real vitest.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const trustCoreRoot = join(packagesRoot, "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-evidence-offer-"));
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const offerArchive = join(temporaryRoot, "evidence-offer.tgz");
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
  "@jinn-network/evidence-offer": `file:${offerArchive}`,
  "@jinn-network/trust-core": `file:${trustCoreArchive}`,
};

const REQUIRED_ENTRIES = [
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/testing.js",
  "package/dist/testing.d.ts",
  "package/fixtures/offer/free.json",
  "package/fixtures/offer/priced.json",
  "package/fixtures/offer/priced.sha256",
  "package/fixtures/offer/superseding.json",
  "package/fixtures/offer/invalid-zero-amount.json",
  "package/package.json",
];

try {
  await run("corepack", ["yarn@4.13.0", "build"], { cwd: trustCoreRoot });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", trustCoreArchive], { cwd: trustCoreRoot });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", offerArchive], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", offerArchive])).split(/\r?\n/u).filter(Boolean);
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) throw new Error(`packed offer is missing ${required}`);
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
import * as root from "@jinn-network/evidence-offer";

assert.equal(root.OFFER_RECORD_KIND, "https://spec.jinn.network/records/offer/v1");
assert.equal("describeOfferRecordConformance" in root, false);
assert.equal("createFixtureOfferSigner" in root, false);

const signer = async ({ preAuthEncoding }) => [{
  signature: new Uint8Array(createHash("sha256").update(preAuthEncoding).digest()),
  keyid: "did:key:zOfferFixtureSigner",
}];
const sealed = await root.sealOffer({
  offer: {
    kind: root.OFFER_RECORD_KIND,
    subject: "sha256:" + "a".repeat(64),
    rails: [],
    gate: { uri: "https://gate.example/offers" },
  },
  signer,
});
assert.equal(root.isFreeOffer(sealed.offer), true);
assert.equal(root.parseOfferEnvelope(sealed.envelopeBytes).digest, sealed.digest);
assert.deepEqual(root.resolveLiveOffers([{ ...sealed, holder: "urn:uuid:x" }]).live.length, 1);
`,
  );
  await run(process.execPath, [join(rootConsumer, "smoke.mjs")], { cwd: rootConsumer });
  await assert.rejects(
    access(join(rootConsumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );

  const installedManifest = JSON.parse(
    await readFile(
      join(rootConsumer, "node_modules", "@jinn-network", "evidence-offer", "package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.peerDependencies, { vitest: "^4.1.8" });
  assert.deepEqual(installedManifest.peerDependenciesMeta, { vitest: { optional: true } });
  assert.deepEqual(Object.keys(installedManifest.dependencies ?? {}).sort(), [
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
import { describeOfferRecordConformance } from "@jinn-network/evidence-offer/testing";

describeOfferRecordConformance();
`,
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: testingConsumer });
  await run("npm", ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: testingConsumer });
  await run("npm", ["exec", "--", "vitest", "run", "smoke.test.ts"], { cwd: testingConsumer });

  console.log("Packed offer root isolation, shipped fixture corpus, and /testing kit verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
