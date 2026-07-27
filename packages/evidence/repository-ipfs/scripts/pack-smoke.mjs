// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
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
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-repository-ipfs-"),
);
const protocolArchive = join(
  temporaryRoot,
  "jinn-network-evidence-protocol-0.1.0.tgz",
);
const repositoryArchive = join(
  temporaryRoot,
  "jinn-network-evidence-repository-0.1.0.tgz",
);
const ipfsArchive = join(
  temporaryRoot,
  "jinn-network-evidence-repository-ipfs-0.1.0.tgz",
);
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
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

function assertArchiveShape(entries) {
  for (const required of [
    "package/README.md",
    "package/dist/cid.d.ts",
    "package/dist/cid.js",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/profile/v1/specification.md",
    "package/profile/v1/registration.schema.json",
    "package/profile/v1/fixtures/artifact-registration.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`IPFS repository archive is missing ${required}`);
    }
  }
  const leakedTests = entries.filter(
    (entry) =>
      entry.startsWith("package/dist/") &&
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `IPFS repository archive contains tests: ${leakedTests.join(", ")}`,
    );
  }
}

try {
  await run(
    process.execPath,
    [join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p",
      join(packageRoot, "tsconfig.build.json")],
    { cwd: packageRoot },
  );
  for (const directory of [
    "protocol",
    "repository",
    "repository-ipfs",
  ]) {
    await run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ],
      {
      cwd: join(packagesRoot, directory),
      },
    );
  }
  assertArchiveShape(
    (await output("tar", ["-tzf", ipfsArchive]))
      .split(/\r?\n/u)
      .filter(Boolean),
  );

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
        "@jinn-network/evidence-repository-ipfs": `file:${ipfsArchive}`,
        "@types/node": "22.20.1",
        typescript: "5.9.3",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const installedRoot = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "evidence-repository-ipfs",
  );
  const typeConsumer = join(consumer, "packed-types.ts");
  const typeConfig = join(consumer, "tsconfig.json");
  await writeFile(
    typeConsumer,
    `
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  type IpfsBlockReader,
} from "@jinn-network/evidence-repository-ipfs";
import {
  digestToRawCid,
  rawCidToDigest,
} from "@jinn-network/evidence-repository-ipfs/cid";

declare const reader: IpfsBlockReader;
declare const repository: EvidenceRepository;
const limit: number = MAX_STANDARD_IPFS_BLOCK_BYTES;
const digest = rawCidToDigest(digestToRawCid(
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
));
void repository;
void reader;
void limit;
void digest;
`,
  );
  await writeFile(
    typeConfig,
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["packed-types.ts"],
    }),
  );
  await run(
    process.execPath,
    [
      join(consumer, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      typeConfig,
    ],
    { cwd: consumer },
  );

  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import {
  createArtifactReference,
} from "@jinn-network/evidence-repository";
import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  parseRegistrationBytes,
} from "@jinn-network/evidence-repository-ipfs";
import {
  digestToRawCid,
  rawCidToDigest,
} from "@jinn-network/evidence-repository-ipfs/cid";

const emptyDigest = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const emptyCid = "f01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
if (digestToRawCid(emptyDigest) !== emptyCid || rawCidToDigest(emptyCid) !== emptyDigest) {
  throw new Error("packed digest/CID golden vector failed");
}
const fixture = JSON.parse(await readFile(
  new URL(import.meta.resolve(
    "@jinn-network/evidence-repository-ipfs/profile/v1/fixtures/artifact-registration.json",
  )),
  "utf8",
));
const registration = parseRegistrationBytes(
  new TextEncoder().encode(fixture.registrationText),
);
if (
  registration.kind !== "artifact" ||
  registration.reference.digest !== fixture.reference.digest
) {
  throw new Error("packed registration fixture did not parse");
}
if (
  MAX_STANDARD_IPFS_BLOCK_BYTES !== 2 * 1024 * 1024
) {
  throw new Error("packed repository limit is invalid");
}
const reference = createArtifactReference(new Uint8Array());
if (reference.digest !== emptyDigest) {
  throw new Error("packed repository dependency did not resolve");
}
const packageJson = JSON.parse(
  await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"),
);
const jinnDependencies = Object.keys(packageJson.dependencies ?? {})
  .filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/evidence-repository") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed IPFS root and CID subpath, profile assets, limit, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
