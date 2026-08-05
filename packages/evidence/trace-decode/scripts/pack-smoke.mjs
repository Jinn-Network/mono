// SPDX-License-Identifier: Apache-2.0
// Packs Protocol, Trace, and Trace Decode, then proves the tarball is what a real
// consumer gets: the kit and fixtures ship, nothing private leaks, a root-only consumer
// installs without vitest, and the packed /testing entrypoint runs under real vitest.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(packageRoot, "..");
const trustCoreRoot = join(packagesRoot, "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-trace-decode-"));
const protocolArchive = join(temporaryRoot, "evidence-protocol.tgz");
const trustCoreArchive = join(temporaryRoot, "trust-core.tgz");
const traceArchive = join(temporaryRoot, "evidence-trace.tgz");
const traceDecodeArchive = join(temporaryRoot, "evidence-trace-decode.tgz");
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

const DEPENDENCIES = {
  "@jinn-network/evidence-protocol": `file:${protocolArchive}`,
  "@jinn-network/evidence-trace": `file:${traceArchive}`,
  "@jinn-network/evidence-trace-decode": `file:${traceDecodeArchive}`,
  "@jinn-network/trust-core": `file:${trustCoreArchive}`,
};

const REQUIRED_ENTRIES = [
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/testing.js",
  "package/dist/testing.d.ts",
  "package/fixtures/claude-code-stream-json/manifest.json",
  "package/fixtures/claude-code-stream-json/cases/tool-loop/input.jsonl",
  "package/fixtures/claude-code-stream-json/cases/tool-loop/expected.json",
  "package/package.json",
];

try {
  await run("corepack", ["yarn@4.13.0", "build"], { cwd: trustCoreRoot });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", trustCoreArchive], {
    cwd: trustCoreRoot,
  });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", protocolArchive], {
    cwd: join(packagesRoot, "protocol"),
  });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", traceArchive], {
    cwd: join(packagesRoot, "trace"),
  });
  await run("corepack", ["yarn@4.13.0", "pack", "--out", traceDecodeArchive], {
    cwd: packageRoot,
  });

  const entries = (await output("tar", ["-tzf", traceDecodeArchive]))
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) {
      throw new Error(`packed trace-decode is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/"),
  );
  if (leaked.length > 0) {
    throw new Error(`test material leaked into the tarball: ${leaked.join(", ")}`);
  }

  await mkdir(rootConsumer);
  await writeFile(
    join(rootConsumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: DEPENDENCIES }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: rootConsumer,
  });
  await writeFile(
    join(rootConsumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { sealTrace, sha256Hex } from "@jinn-network/evidence-trace";
import * as root from "@jinn-network/evidence-trace-decode";

assert.equal(typeof root.createDefaultDecoderRegistry, "function");
assert.equal(typeof root.tryDecodeTrace, "function");
assert.equal("describeTraceDecoderContract" in root, false);
assert.equal("loadClaudeCodeFixtures" in root, false);

const registry = root.createDefaultDecoderRegistry();
const bytes = new TextEncoder().encode(
  '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}\\n',
);
const outcome = root.tryDecodeTrace(
  registry,
  root.CLAUDE_CODE_STREAM_JSON_FORMAT_IRI,
  { bytes, nativeTrace: { digest: { sha256: sha256Hex(bytes) } } },
);
assert.equal(outcome.ok, true);
assert.equal(outcome.document.spans.length, 2);
assert.equal(typeof sealTrace(outcome.document).digest, "string");

const unknown = root.tryDecodeTrace(
  registry,
  "https://spec.jinn.network/formats/hermes-json/v1",
  { bytes, nativeTrace: { digest: { sha256: sha256Hex(bytes) } } },
);
assert.equal(unknown.ok, false);
assert.equal(unknown.reason, "unsupported-format");
`,
  );
  await run(process.execPath, [join(rootConsumer, "smoke.mjs")], { cwd: rootConsumer });
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
        "evidence-trace-decode",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(installedManifest.peerDependencies, { vitest: "^4.1.8" });
  assert.deepEqual(installedManifest.peerDependenciesMeta, {
    vitest: { optional: true },
  });
  assert.deepEqual(Object.keys(installedManifest.dependencies ?? {}), [
    "@jinn-network/evidence-trace",
  ]);

  await mkdir(testingConsumer);
  await writeFile(
    join(testingConsumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        ...DEPENDENCIES,
        typescript: "5.9.3",
        vite: "6.4.3",
        vitest: "4.1.8",
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
      include: ["smoke.test.ts"],
    }),
  );
  await writeFile(
    join(testingConsumer, "smoke.test.ts"),
    `
import { createClaudeCodeStreamJsonDecoder } from "@jinn-network/evidence-trace-decode";
import {
  describeTraceDecoderContract,
  loadClaudeCodeFixtures,
} from "@jinn-network/evidence-trace-decode/testing";
import type { TraceDecoderFixture } from "@jinn-network/evidence-trace-decode/testing";

describeTraceDecoderContract("packed claude-code-stream-json", async () => {
  const fixtures: readonly TraceDecoderFixture[] = await loadClaudeCodeFixtures();
  return { decoder: createClaudeCodeStreamJsonDecoder(), fixtures };
});
`,
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: testingConsumer,
  });
  await run("npm", ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"], {
    cwd: testingConsumer,
  });
  await run("npm", ["exec", "--", "vitest", "run", "smoke.test.ts"], {
    cwd: testingConsumer,
  });

  console.log(
    "Packed trace-decode root isolation, shipped fixture corpus, and /testing kit verified.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
