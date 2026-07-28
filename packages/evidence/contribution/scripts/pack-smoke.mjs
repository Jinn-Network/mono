// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const temporaryRoot = await mkdtemp(
  join(tmpdir(), "jinn-evidence-contribution-"),
);
const archives = {
  protocol: join(temporaryRoot, "evidence-protocol.tgz"),
  repository: join(temporaryRoot, "evidence-repository.tgz"),
  derivation: join(temporaryRoot, "evidence-derivation.tgz"),
  publication: join(temporaryRoot, "evidence-publication.tgz"),
  contribution: join(temporaryRoot, "evidence-contribution.tgz"),
};

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
      ));
    });
  });
}

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/testing.js",
    "package/dist/testing.d.ts",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed evidence-contribution is missing ${entry}`);
    }
  }
  const forbiddenPatterns = [
    /\.test\./u,
    /\.spec\./u,
    /\.map$/u,
    /(?:^|\/)fixtures\//u,
    /(?:^|\/)src\//u,
  ];
  const leaked = entries.filter((entry) =>
    entry.startsWith("package/") &&
    forbiddenPatterns.some((pattern) => pattern.test(entry)));
  if (leaked.length > 0) {
    throw new Error(
      `disallowed content leaked into evidence-contribution tarball: ${leaked.join(", ")}`,
    );
  }
  // Every allowed entry must live in the declared public surface only.
  const allowedRoots = /^package\/(?:README\.md|package\.json|dist\/)/u;
  const outside = entries.filter((entry) => !allowedRoots.test(entry));
  if (outside.length > 0) {
    throw new Error(
      `unexpected top-level content in evidence-contribution tarball: ${outside.join(", ")}`,
    );
  }
}

try {
  await run("yarn", ["pack", "--out", archives.protocol], {
    cwd: join(packagesRoot, "protocol"),
  });
  await run("yarn", ["pack", "--out", archives.repository], {
    cwd: join(packagesRoot, "repository"),
  });
  await run("yarn", ["pack", "--out", archives.derivation], {
    cwd: join(packagesRoot, "derivation"),
  });
  await run("yarn", ["pack", "--out", archives.publication], {
    cwd: join(packagesRoot, "publication"),
  });
  await run("yarn", ["pack", "--out", archives.contribution], {
    cwd: packageRoot,
  });

  const archiveEntries = (await output("tar", ["-tzf", archives.contribution]))
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(archiveEntries);

  const dependencySpecifiers = {
    "@jinn-network/evidence-protocol": `file:${archives.protocol}`,
    "@jinn-network/evidence-repository": `file:${archives.repository}`,
    "@jinn-network/evidence-derivation": `file:${archives.derivation}`,
    "@jinn-network/evidence-publication": `file:${archives.publication}`,
    "@jinn-network/evidence-contribution": `file:${archives.contribution}`,
  };

  // -------------------------------------------------------------------
  // Root consumer -- no Vitest. Proves the public boundary (`.`) never
  // requires the testing toolchain and never exposes an in-memory store,
  // filesystem constructor, service, plugin, marketplace, wallet, or
  // chain symbol.
  // -------------------------------------------------------------------
  const rootConsumer = join(temporaryRoot, "root-consumer");
  await mkdir(rootConsumer);
  await writeFile(
    join(rootConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...dependencySpecifiers,
        typescript: "5.9.3",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: rootConsumer },
  );

  await writeFile(
    join(rootConsumer, "consumer.ts"),
    `
import {
  createContributionRequest,
  prepareContribution,
  authorizeContribution,
  createStandingAuthorizationGrant,
  revokeStandingAuthorizationGrant,
  applyStandingAuthorization,
  resumeContribution,
  retryContributionDestination,
  declineContribution,
  deactivateContribution,
  deactivateContributionDestination,
  inspectContribution,
  readContributionReceipt,
  type ContributionReadModel,
  type ContributionReceipt,
} from "@jinn-network/evidence-contribution";

void createContributionRequest;
void prepareContribution;
void authorizeContribution;
void createStandingAuthorizationGrant;
void revokeStandingAuthorizationGrant;
void applyStandingAuthorization;
void resumeContribution;
void retryContributionDestination;
void declineContribution;
void deactivateContribution;
void deactivateContributionDestination;
void inspectContribution;
void readContributionReceipt;
declare const readModel: ContributionReadModel;
declare const receipt: ContributionReceipt;
void readModel;
void receipt;
`,
  );
  await writeFile(
    join(rootConsumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["consumer.ts"],
    }),
  );
  const rootTypescript = join(
    rootConsumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  await run(rootTypescript, ["--project", "tsconfig.json"], { cwd: rootConsumer });

  const installedRoot = join(
    rootConsumer,
    "node_modules",
    "@jinn-network",
    "evidence-contribution",
  );
  const rootIndexSource = await readFile(join(installedRoot, "dist", "index.js"), "utf8");
  const forbiddenRootSymbols = [
    "InMemoryContributionStore",
    "InMemoryEvidenceContributionDriver",
    "createFilesystem",
    "node:fs",
    "vitest",
    "jinn-plugin",
    "marketplace",
    "wallet",
    "blockchain",
    "viem",
  ];
  for (const forbidden of forbiddenRootSymbols) {
    if (rootIndexSource.includes(forbidden)) {
      throw new Error(`root entrypoint leaked forbidden symbol: ${forbidden}`);
    }
  }
  const installedManifest = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  const jinnRuntimeDependencies = Object.keys(installedManifest.dependencies ?? {})
    .filter((name) => name.startsWith("@jinn-network/"))
    .sort();
  const expectedRuntimeDependencies = [
    "@jinn-network/evidence-derivation",
    "@jinn-network/evidence-protocol",
    "@jinn-network/evidence-publication",
    "@jinn-network/evidence-repository",
  ];
  if (jinnRuntimeDependencies.join(",") !== expectedRuntimeDependencies.join(",")) {
    throw new Error(
      `unexpected Contribution dependency boundary: ${jinnRuntimeDependencies.join(", ")}`,
    );
  }

  // -------------------------------------------------------------------
  // Testing consumer -- with Vitest. Proves `/testing` compiles and
  // `describeEvidenceContributionContract` plus its driver types are
  // importable from the packed archive.
  // -------------------------------------------------------------------
  const testingConsumer = join(temporaryRoot, "testing-consumer");
  await mkdir(testingConsumer);
  await writeFile(
    join(testingConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...dependencySpecifiers,
        typescript: "5.9.3",
        vitest: "4.1.8",
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: testingConsumer },
  );
  await writeFile(
    join(testingConsumer, "consumer.ts"),
    `
import {
  describeEvidenceContributionContract,
  type EvidenceContributionContractDriver,
  type EvidenceContributionContractDriverFactory,
  type EvidenceContributionContractObservation,
  type EvidenceContributionContractScenario,
} from "@jinn-network/evidence-contribution/testing";

void describeEvidenceContributionContract;
declare const driver: EvidenceContributionContractDriver;
declare const factory: EvidenceContributionContractDriverFactory;
declare const observation: EvidenceContributionContractObservation;
declare const scenario: EvidenceContributionContractScenario;
void driver;
void factory;
void observation;
void scenario;
`,
  );
  await writeFile(
    join(testingConsumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      include: ["consumer.ts"],
    }),
  );
  const testingTypescript = join(
    testingConsumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  await run(testingTypescript, ["--project", "tsconfig.json"], { cwd: testingConsumer });

  console.log(
    "Packed Contribution root and testing entrypoints verified: shape, dependency boundary, and no leaked source/test/fixture content.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
