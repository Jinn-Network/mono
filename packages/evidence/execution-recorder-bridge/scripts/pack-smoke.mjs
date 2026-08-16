// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const protocolRoot = join(packagesRoot, "protocol");
const repositoryRoot = join(packagesRoot, "repository");
const builderRoot = join(packagesRoot, "execution-evidence-builder");
const recorderRoot = join(packagesRoot, "execution-recorder");
// The Recorder rejects a workspace path with a symlinked ancestor directory
// as UNSAFE_PATH; macOS's tmpdir() has one (/var -> /private/var), so this
// must be resolved to its real path before it backs a Recorder workspace.
const temporaryRoot = await realpath(
  await mkdtemp(join(tmpdir(), "jinn-execution-recorder-bridge-")),
);
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const repositoryArchive = join(temporaryRoot, "evidence-repository.tgz");
const builderArchive = join(temporaryRoot, "execution-evidence-builder.tgz");
const recorderArchive = join(temporaryRoot, "execution-recorder.tgz");
const bridgeArchive = join(temporaryRoot, "execution-recorder-bridge.tgz");
const consumer = join(temporaryRoot, "consumer");
const repositoryStateRoot = join(temporaryRoot, "repository-state");

const TASK_TEXT = "packed bridge smoke task";
const RUNTIME_SPEC_TEXT = '{"name":"packed-bridge-smoke-runtime","version":"1.0.0"}';
const RUNNER_TEXT = "export const runner = true;\n";
const TRACE_TEXT = '{"event":"packed-bridge-smoke-trace"}\n';
const RESULT_TEXT = "packed bridge smoke result";
const WORKSPACE_DIR_NAME = "recording";

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
      reject(
        new Error(
          `${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

function assertArchiveShape(entries) {
  const required = [
    "package/README.md",
    "package/dist/bin.js",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      throw new Error(`packed execution recorder bridge is missing ${entry}`);
    }
  }
  const leakedTests = entries.filter((entry) =>
    /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry),
  );
  if (leakedTests.length > 0) {
    throw new Error(
      `test files leaked into execution recorder bridge tarball: ${leakedTests.join(", ")}`,
    );
  }
}

/** Runs the installed binary against `repositoryStateRoot`, sending one
 * start/attachNativeTrace/finalize sequence over stdin, and returns its
 * collected stdout and stderr. */
function runBridgeBinary(binaryPath, executionId) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [binaryPath, "--repository-root", repositoryStateRoot],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    const bytesSource = (text, mediaType) => ({
      kind: "bytes",
      base64: Buffer.from(text).toString("base64"),
      mediaType,
    });
    const file = (entityId, text, mediaType) => ({
      kind: "file",
      entityId,
      source: bytesSource(text, mediaType),
      origin: { kind: "producer-observed", observer: "https://producer.example/pack-smoke" },
    });
    const workspaceDir = join(temporaryRoot, WORKSPACE_DIR_NAME);
    const requestLine = (id, method, params) =>
      `${JSON.stringify({
        protocol: "jinn.execution-recorder.bridge/v1",
        id,
        method,
        params,
      })}\n`;

    child.stdin.write(
      requestLine("start", "start", {
        workspaceDir,
        executionId,
        startedAt: "2026-07-28T00:00:00Z",
        record: {
          name: "Packed bridge smoke",
          description: "Packed distribution round trip.",
          license: "https://creativecommons.org/publicdomain/zero/1.0/",
        },
        task: {
          entityId: "task.md",
          name: "Packed bridge smoke task",
          source: bytesSource(TASK_TEXT, "text/markdown"),
          origin: { kind: "producer-observed", observer: "https://producer.example/pack-smoke" },
        },
        executor: {
          entityId: "https://executor.example/pack-smoke",
          kind: "software",
          name: "Packed bridge smoke executor",
          origin: { kind: "producer-observed", observer: "https://producer.example/pack-smoke" },
        },
        runtime: {
          entityId: "runtime.json",
          specification: bytesSource(RUNTIME_SPEC_TEXT, "application/json"),
          name: "Packed bridge smoke runtime",
          origin: { kind: "producer-observed", observer: "https://producer.example/pack-smoke" },
          components: [
            {
              kind: "controlled",
              artifact: file("runner.mjs", RUNNER_TEXT, "text/javascript"),
            },
          ],
        },
        producer: {
          entityId: "https://producer.example/pack-smoke",
          kind: "software",
          name: "Packed bridge smoke producer",
          origin: { kind: "producer-observed", observer: "https://producer.example/pack-smoke" },
        },
      }),
    );
    const target = { workspaceDir, executionId };
    child.stdin.write(
      requestLine("attach-trace", "attachNativeTrace", {
        target,
        trace: {
          artifact: file("trace.jsonl", TRACE_TEXT, "application/x-ndjson"),
          format: { entityId: "https://example.test/formats/pack-smoke" },
        },
      }),
    );
    child.stdin.write(
      requestLine("finalize", "finalize", {
        target,
        outcome: "completed",
        endedAt: "2026-07-28T00:00:01Z",
        results: [file("result.txt", RESULT_TEXT, "text/plain")],
      }),
    );
    child.stdin.end();
  });
}

try {
  await run("yarn", ["pack", "--out", protocolArchive], { cwd: protocolRoot });
  await run("yarn", ["pack", "--out", repositoryArchive], { cwd: repositoryRoot });
  await run("yarn", ["pack", "--out", builderArchive], { cwd: builderRoot });
  await run("yarn", ["pack", "--out", recorderArchive], { cwd: recorderRoot });
  await run("yarn", ["pack", "--out", bridgeArchive], { cwd: packageRoot });

  const bridgeEntries = (await output("tar", ["-tzf", bridgeArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  assertArchiveShape(bridgeEntries);

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
        "@jinn-network/evidence-repository": `file:${repositoryArchive}`,
        "@jinn-network/execution-evidence-builder": `file:${builderArchive}`,
        "@jinn-network/execution-recorder": `file:${recorderArchive}`,
        "@jinn-network/execution-recorder-bridge": `file:${bridgeArchive}`,
      },
    }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer },
  );

  const binaryPath = join(
    consumer,
    "node_modules",
    "@jinn-network",
    "execution-recorder-bridge",
    "dist",
    "bin.js",
  );
  const executionId = "urn:uuid:99999999-9999-4999-8999-999999999999";
  const { code, stdout, stderr } = await runBridgeBinary(
    binaryPath,
    executionId,
  );
  if (code !== 0) {
    throw new Error(
      `packed execution-recorder-bridge exited with ${code}: ${stderr}`,
    );
  }

  const responseLines = stdout.split("\n").filter((line) => line.length > 0);
  if (responseLines.length !== 3) {
    throw new Error(
      `expected 3 protocol responses, received ${responseLines.length}: ${stdout}`,
    );
  }
  const responses = responseLines.map((line) => JSON.parse(line));
  for (const response of responses) {
    if (response.protocol !== "jinn.execution-recorder.bridge/v1") {
      throw new Error(`non-protocol line on standard output: ${JSON.stringify(response)}`);
    }
    if (response.ok !== true) {
      throw new Error(`packed bridge request failed: ${JSON.stringify(response)}`);
    }
  }
  const finalizeResponse = responses.find((response) => response.id === "finalize");
  if (!finalizeResponse?.result?.finalized) {
    throw new Error(
      `packed bridge finalize did not complete: ${JSON.stringify(finalizeResponse)}`,
    );
  }

  for (const secret of [TASK_TEXT, TRACE_TEXT, RESULT_TEXT, repositoryStateRoot, temporaryRoot]) {
    if (stderr.includes(secret)) {
      throw new Error(
        `standard error leaked private content or a local path: ${JSON.stringify(secret)}`,
      );
    }
  }
  if (stderr.length > 0) {
    throw new Error(`expected empty standard error, received: ${stderr}`);
  }

  const { createFilesystemEvidenceRepository } = await import(
    join(
      consumer,
      "node_modules",
      "@jinn-network",
      "evidence-repository",
      "dist",
      "fs",
      "index.js",
    )
  );
  const repository = await createFilesystemEvidenceRepository({
    rootDir: repositoryStateRoot,
  });
  const receipt = finalizeResponse.result.receipt;
  const record = await repository.getRecord(receipt.record);
  if (record === null) {
    throw new Error("packed bridge finalize receipt record was not stored");
  }
  const artifactBytes = await Promise.all(
    receipt.artifacts.map((reference) => repository.getArtifact(reference)),
  );
  const traceBytes = Buffer.from(TRACE_TEXT);
  const resultBytes = Buffer.from(RESULT_TEXT);
  const storedTrace = artifactBytes.find(
    (bytes) => bytes !== null && Buffer.from(bytes).equals(traceBytes),
  );
  const storedResult = artifactBytes.find(
    (bytes) => bytes !== null && Buffer.from(bytes).equals(resultBytes),
  );
  if (storedTrace === undefined) {
    throw new Error("finalized receipt does not reference the exact trace bytes");
  }
  if (storedResult === undefined) {
    throw new Error("finalized receipt does not reference the exact result bytes");
  }

  console.log(
    "Packed protocol/binary child-process round trip, archive shape, and privacy-sensitive output verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
