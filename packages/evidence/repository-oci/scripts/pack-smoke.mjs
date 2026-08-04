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
  join(tmpdir(), "jinn-evidence-repository-oci-"),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const contractArchive = join(temporaryRoot, "evidence-repository.tgz");
const ociArchive = join(temporaryRoot, "evidence-repository-oci.tgz");
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

try {
  for (const [directory, archive] of [
    ["protocol", protocolArchive],
    ["repository", contractArchive],
    ["repository-oci", ociArchive],
  ]) {
    await run("yarn", ["pack", "--out", archive], {
      cwd: join(packagesRoot, directory),
    });
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${contractArchive}`,
        "@jinn-network/evidence-repository-oci": `file:${ociArchive}`,
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
    "evidence-repository-oci",
  );
  const typeConsumer = join(consumer, "packed-types.ts");
  const typeConfig = join(consumer, "tsconfig.json");
  await writeFile(
    typeConsumer,
    `
import type {
  EvidenceRepository,
  EvidenceRepositoryErrorCode,
} from "@jinn-network/evidence-repository";
import {
  createOrasCliEvidenceRepository,
} from "@jinn-network/evidence-repository-oci";

type OrasRepository = Awaited<ReturnType<typeof createOrasCliEvidenceRepository>>;
declare const repository: OrasRepository;
const contract: EvidenceRepository = repository;
const limit: number | undefined = repository.capabilities.maxObjectBytes;
const code: EvidenceRepositoryErrorCode = "CONTENT_TOO_LARGE";
void contract;
void limit;
void code;
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
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", typeConfig],
    { cwd: consumer },
  );
  const smokeScript = join(consumer, "smoke.mjs");
  await writeFile(
    smokeScript,
    `
import { readFile } from "node:fs/promises";
import { createArtifactReference } from "@jinn-network/evidence-repository";
import {
  OCI_EVIDENCE_PROFILE_URI,
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  createOrasCliEvidenceRepository,
  validateEvidenceOciManifest,
} from "@jinn-network/evidence-repository-oci";

const bytes = new TextEncoder().encode("packed OCI binding");
const reference = createArtifactReference(bytes);
const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);
const manifestBytes = canonicalizeEvidenceOciManifest(manifest);
if (validateEvidenceOciManifest(manifestBytes, reference).contentSize !== bytes.byteLength) {
  throw new Error("packed manifest mapping failed");
}
if (OCI_EVIDENCE_PROFILE_URI !== "https://spec.jinn.network/profiles/evidence-repository-oci/v1") {
  throw new Error("profile constant missing");
}
await readFile(new URL(import.meta.resolve("@jinn-network/evidence-repository-oci/profiles/evidence-repository-oci/1.0/specification.md")));
await readFile(new URL(import.meta.resolve("@jinn-network/evidence-repository-oci/schemas/evidence-oci-manifest.schema.json")));
await readFile(new URL(import.meta.resolve("@jinn-network/evidence-repository-oci/fixtures/golden-oci-mapping/expected-digests.json")));
await createOrasCliEvidenceRepository({
  repository: "registry.example.test/jinn/evidence",
  orasPath: "/definitely/missing/oras",
}).then(
  () => { throw new Error("missing ORAS unexpectedly initialized"); },
  (error) => {
    if (error.code !== "DEPENDENCY_UNAVAILABLE") throw error;
  },
);
const packageJson = JSON.parse(await readFile(${JSON.stringify(join(installedRoot, "package.json"))}, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/"));
if (jinnDependencies.join(",") !== "@jinn-network/evidence-repository") {
  throw new Error("unexpected Jinn dependency boundary: " + jinnDependencies.join(", "));
}
await readFile(${JSON.stringify(join(installedRoot, "README.md"))});
console.log("Installed OCI repository imports, assets, adapter, and dependency boundary verified.");
`,
  );
  await run(process.execPath, [smokeScript], { cwd: consumer });
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
