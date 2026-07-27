import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describeEvidenceRepositoryContract } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import {
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  artifactLookupTag,
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  createOrasCliEvidenceRepository,
  recordLookupTag,
} from "./index.js";

const encoder = new TextEncoder();

async function createFakeOras(version = "1.3.2") {
  const root = await mkdtemp(join(tmpdir(), "jinn-fake-oras-"));
  const executable = join(root, "oras");
  const stateDir = join(root, "state");
  await mkdir(join(stateDir, "blobs"), { recursive: true });
  await mkdir(join(stateDir, "manifests"), { recursive: true });
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const stateDir = ${JSON.stringify(stateDir)};
const args = process.argv.slice(2);
const input = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
});
appendFileSync(join(stateDir, "calls.jsonl"), JSON.stringify({ args, input: input.toString("base64") }) + "\\n");
if (args[0] === "version") {
  process.stdout.write("Version:        ${version}\\n");
  process.exit(0);
}
if (existsSync(join(stateDir, "deny"))) {
  process.stderr.write("unauthorized: access denied\\n");
  process.exit(1);
}
if (existsSync(join(stateDir, "unavailable"))) {
  process.stderr.write("dial tcp: connection refused\\n");
  process.exit(1);
}
if (existsSync(join(stateDir, "delay"))) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const command = args.slice(0, 2).join(" ");
const safe = (value) => value.replaceAll(":", "_");
if (command === "blob push") {
  const target = args.at(-2);
  const digest = target.slice(target.lastIndexOf("@") + 1);
  const actual = "sha256:" + createHash("sha256").update(input).digest("hex");
  if (actual !== digest) {
    process.stderr.write("digest mismatch\\n");
    process.exit(1);
  }
  writeFileSync(join(stateDir, "blobs", safe(digest)), input);
  process.exit(0);
}
if (command === "blob fetch") {
  const target = args.at(-1);
  const digest = target.slice(target.lastIndexOf("@") + 1);
  const path = join(stateDir, "blobs", safe(digest));
  if (!existsSync(path)) {
    process.stderr.write("not found\\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(path));
  process.exit(0);
}
if (command === "manifest push") {
  const target = args.at(-2);
  const tag = target.slice(target.lastIndexOf(":") + 1);
  writeFileSync(join(stateDir, "manifests", tag), input);
  process.exit(0);
}
if (command === "manifest fetch") {
  const target = args.at(-1);
  const reference = target.includes("@")
    ? target.slice(target.lastIndexOf("@") + 1)
    : target.slice(target.lastIndexOf(":") + 1);
  let path = join(stateDir, "manifests", reference);
  if (!existsSync(path) && reference.startsWith("sha256:")) {
    const names = (await import("node:fs")).readdirSync(join(stateDir, "manifests"));
    for (const name of names) {
      const candidate = readFileSync(join(stateDir, "manifests", name));
      const digest = "sha256:" + createHash("sha256").update(candidate).digest("hex");
      if (digest === reference) {
        path = join(stateDir, "manifests", name);
        break;
      }
    }
  }
  if (!existsSync(path)) {
    process.stderr.write("manifest unknown: not found\\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(path));
  process.exit(0);
}
process.stderr.write("unsupported fake command: " + command + "\\n");
process.exit(2);
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);

  return {
    executable,
    stateDir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
    async calls() {
      try {
        return (await readFile(join(stateDir, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    manifestPath(tag: string) {
      return join(stateDir, "manifests", tag);
    },
    blobPath(digest: string) {
      return join(stateDir, "blobs", digest.replaceAll(":", "_"));
    },
    sentinel(name: string) {
      return writeFile(join(stateDir, name), "");
    },
  };
}

describeEvidenceRepositoryContract(async () => {
  const fake = await createFakeOras();
  return {
    repository: await createOrasCliEvidenceRepository({
      repository: "registry.example.test/jinn/evidence",
      orasPath: fake.executable,
    }),
    cleanup: () => fake.cleanup(),
  };
});

describe("ORAS CLI evidence repository", () => {
  test("publishes exact blobs and a Jinn-built canonical manifest", async () => {
    const fake = await createFakeOras();
    try {
      const repositoryName = "registry.example.test/jinn/evidence";
      const repository = await createOrasCliEvidenceRepository({
        repository: repositoryName,
        orasPath: fake.executable,
        registryConfigPath: "/private/registry-config.json",
        plainHttp: true,
        insecure: true,
        caFile: "/private/registry-ca.pem",
      });
      const bytes = encoder.encode("exact ORAS record");
      const receipt = await repository.putRecord(
        "execution-evidence",
        bytes,
      );
      const reference = createRecordReference("execution-evidence", bytes);
      const expectedManifest = canonicalizeEvidenceOciManifest(
        buildEvidenceOciManifest(reference, bytes.byteLength),
      );

      expect(receipt.reference).toEqual(reference);
      expect(receipt.lookupTag).toBe(recordLookupTag(reference));
      expect(receipt.canonicalReference).toBe(
        `${repositoryName}@${receipt.manifestDigest}`,
      );
      expect(
        new Uint8Array(
          await readFile(fake.manifestPath(receipt.lookupTag)),
        ),
      ).toEqual(expectedManifest);
      expect(
        new Uint8Array(await readFile(fake.blobPath(reference.digest))),
      ).toEqual(bytes);

      const calls = await fake.calls();
      const argumentsText = JSON.stringify(calls.map(({ args }) => args));
      expect(argumentsText).toContain("--registry-config");
      expect(argumentsText).toContain("/private/registry-config.json");
      expect(argumentsText).toContain("--plain-http");
      expect(argumentsText).toContain("--insecure");
      expect(argumentsText).toContain("--ca-file");
      expect(argumentsText).not.toMatch(/password|token|secret/iu);
      expect(
        calls.some(({ args }) => args[0] === "manifest" && args[1] === "push"),
      ).toBe(true);
      expect(
        calls.some(({ args }) => args[0] === "push"),
      ).toBe(false);
    } finally {
      await fake.cleanup();
    }
  });

  test("refuses a deterministic tag that resolves to another manifest", async () => {
    const fake = await createFakeOras();
    try {
      const repository = await createOrasCliEvidenceRepository({
        repository: "registry.example.test/jinn/evidence",
        orasPath: fake.executable,
      });
      const bytes = encoder.encode("expected content");
      const reference = createArtifactReference(bytes);
      const otherBytes = encoder.encode("substituted content");
      const otherReference = createArtifactReference(otherBytes);
      await writeFile(
        fake.manifestPath(artifactLookupTag(reference)),
        canonicalizeEvidenceOciManifest(
          buildEvidenceOciManifest(otherReference, otherBytes.byteLength),
        ),
      );

      await expect(repository.putArtifact(bytes)).rejects.toMatchObject({
        code: "REFERENCE_CONFLICT",
      });
      await expect(repository.getArtifact(reference)).rejects.toMatchObject({
        code: "CONTENT_CORRUPT",
      });
    } finally {
      await fake.cleanup();
    }
  });

  test("detects missing, truncated, and altered content blobs", async () => {
    const fake = await createFakeOras();
    try {
      const repository = await createOrasCliEvidenceRepository({
        repository: "registry.example.test/jinn/evidence",
        orasPath: fake.executable,
      });
      const bytes = encoder.encode("blob integrity");
      const receipt = await repository.putArtifact(bytes);
      await writeFile(fake.blobPath(receipt.reference.digest), "bad");

      await expect(
        repository.getArtifact(receipt.reference),
      ).rejects.toMatchObject({ code: "CONTENT_CORRUPT" });
    } finally {
      await fake.cleanup();
    }
  });

  test("rejects missing and unsupported ORAS installations", async () => {
    await expect(
      createOrasCliEvidenceRepository({
        repository: "registry.example.test/jinn/evidence",
        orasPath: "/definitely/missing/oras",
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });

    const old = await createFakeOras("1.2.3");
    try {
      await expect(
        createOrasCliEvidenceRepository({
          repository: "registry.example.test/jinn/evidence",
          orasPath: old.executable,
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    } finally {
      await old.cleanup();
    }
  });

  test("maps authorization, availability, and cancellation failures", async () => {
    const fake = await createFakeOras();
    try {
      const repository = await createOrasCliEvidenceRepository({
        repository: "registry.example.test/jinn/evidence",
        orasPath: fake.executable,
      });
      const reference = createArtifactReference(encoder.encode("missing"));

      await fake.sentinel("deny");
      await expect(repository.getArtifact(reference)).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      });
      await rm(join(fake.stateDir, "deny"));

      await fake.sentinel("unavailable");
      await expect(repository.getArtifact(reference)).rejects.toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
      });
      await rm(join(fake.stateDir, "unavailable"));

      await fake.sentinel("delay");
      const controller = new AbortController();
      const pending = repository.getArtifact(reference, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);
      await expect(pending).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
      });
    } finally {
      await fake.cleanup();
    }
  });

  test("rejects repositories containing tags, digests, schemes, or whitespace", async () => {
    for (const repository of [
      "https://registry.example.test/jinn/evidence",
      "registry.example.test/jinn/evidence:latest",
      "registry.example.test/jinn/evidence@sha256:abc",
      "registry.example.test/jinn/evi dence",
      "registry.example.test/jinn/../evidence",
    ]) {
      await expect(
        createOrasCliEvidenceRepository({ repository }),
      ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    }
  });

  test("requests the OCI image manifest media type explicitly", async () => {
    const fake = await createFakeOras();
    try {
      const repository = await createOrasCliEvidenceRepository({
        repository: "registry.example.test/jinn/evidence",
        orasPath: fake.executable,
      });
      await repository.getArtifact(
        createArtifactReference(encoder.encode("absent")),
      );
      const calls = await fake.calls();
      const fetch = calls.find(
        ({ args }) => args[0] === "manifest" && args[1] === "fetch",
      );
      expect(fetch.args).toContain("--media-type");
      expect(fetch.args).toContain(OCI_IMAGE_MANIFEST_MEDIA_TYPE);
    } finally {
      await fake.cleanup();
    }
  });
});
