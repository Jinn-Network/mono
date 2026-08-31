#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { DsseChainVerifier, DsseSigner } from "@jinn-network/trust-core";
import type { Transport, VerifyDriver } from "@jinn-network/record-discovery-client";
import { createEvidenceRetrievalFailure } from "@jinn-network/evidence-retrieval";
import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";

import { createCaptureCapability } from "./capture/capability.js";
import {
  nodeIndexDatabaseIo,
  nodeSensitivityNonceIo,
} from "./bin-node-fs.js";
import type { RuntimeCapability } from "./capability.js";
import { createCorpusCapability, type CorpusCapability } from "./corpus/capability.js";
import type { CorpusAdmission as MirrorCorpusAdmission } from "./corpus/admission.js";
import type { CorpusFilesystem } from "./corpus/fs.js";
import type { CorpusRetrieval } from "./corpus/retrieve.js";
import { resolveRuntimeConfig, ENVIRONMENT_KEYS } from "./config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { createLineLogger } from "./logger.js";
import { createMcpCapability } from "./mcp/capability.js";
import { isRuntimeRole, type RuntimeRole } from "./mcp/identifiers.js";
import { createCorpusAdmissionFilter, type AdmissionFilter } from "./relevance/admission.js";
import {
  createSensitivityClassifier,
  openRelevanceIndex,
  type RelevanceIndex,
} from "./relevance/index.js";
import { createPluginRuntime, type PluginRuntime } from "./runtime.js";
import { describeUnknownError } from "./safe-error.js";
import { RUNTIME_VERSION } from "./version.js";

const USAGE = [
  "usage: jinn-plugin-runtime [serve|health]",
  "",
  "  serve    run the runtime until SIGINT or SIGTERM (default)",
  "  health   print one JSON health report and exit",
  "",
  "  serve [--role tools|session]  MCP surface role (default: tools)",
  "",
  "  --help     print this message",
  "  --version  print the runtime version",
  "",
  "Environment: JINN_PLUGIN_HOME, JINN_PLUGIN_LOG_LEVEL",
].join("\n");

const CONFIG_ENV_KEYS = [ENVIRONMENT_KEYS.home, ENVIRONMENT_KEYS.logLevel] as const;

const FAIL_CLOSED_RETRIEVAL: CorpusRetrieval = {
  fetchRecord: async (reference) => ({
    status: "failed",
    failure: createEvidenceRetrievalFailure({
      code: "NO_LOCATION",
      stage: "location",
      message: "Corpus ports are not configured; retrieval is unavailable.",
      reference,
    }),
  }),
};

const DENY_PUBLIC_ADMISSION = createCorpusAdmissionFilter({
  admitProducer: async () => ({ admitted: false }),
});

function mirrorAdmissionFilter(admission: MirrorCorpusAdmission): AdmissionFilter {
  return createCorpusAdmissionFilter({
    admitProducer: async (producerId) => ({
      admitted: admission.admitProducer(producerId).status === "admitted",
    }),
  });
}

/** Reads only config keys from the live process environment into an owned snapshot. */
export function readConfigEnvFromProcess(): Readonly<Record<string, string | undefined>> {
  const snapshot = Object.create(null) as Record<string, string | undefined>;
  for (const key of CONFIG_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

/** Owned null-prototype snapshot of only the config keys resolveRuntimeConfig reads. */
export function buildOwnedEnvSnapshot(
  rawEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const snapshot = Object.create(null) as Record<string, string | undefined>;
  for (const key of CONFIG_ENV_KEYS) {
    const value = rawEnv[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

/**
 * Everything the entry point is allowed to touch, injected so tests drive it without a
 * real process, real streams, or real signals.
 */
export interface BinIo {
  /** Reserved for protocol output. Diagnostics never go here. */
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
  /** The default home directory when neither the file nor the environment names one. */
  readonly homeDirectory: string;
  /** Resolves when the process should shut down. */
  readonly untilShutdown: () => Promise<void>;
  /**
   * Injected by the composition root (C7 host adapter). Capture registers only when a signer
   * is supplied — the runtime never acquires key material itself (F-C4-T13-2).
   */
  readonly captureSigner?: DsseSigner;
  /** Optional corpus composition ports — absent means fail-closed retrieval with no mirror. */
  readonly corpusTransport?: Transport;
  readonly corpusFs?: CorpusFilesystem;
  readonly dsseVerifier?: DsseChainVerifier;
  readonly readPolicyVersions?: (directory: string) => Promise<readonly Uint8Array[]>;
  /**
   * Announcement-chain verification driver. Optional like the rest of the
   * corpus ports, and for the same reason: this runtime resolves no keys and
   * implements no cryptography. Absent, the `verified` posture cannot be
   * honored and the corpus capability fails closed — see its
   * `corpus-chain-verification` health check.
   */
  readonly corpusVerifyDriver?: VerifyDriver;
}

/** `serve [--role tools|session]`. Default `tools`: read-only MCP without capture signer. */
export function parseRole(argv: readonly string[]): RuntimeRole {
  const index = argv.indexOf("--role");
  if (index === -1) return "tools";
  const value = argv[index + 1];
  if (!isRuntimeRole(value)) {
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      `--role must be one of tools, session (received: ${String(value)})`,
    );
  }
  return value;
}

function buildHealthCapabilities(captureSigner: DsseSigner | undefined): readonly RuntimeCapability[] {
  if (captureSigner === undefined) {
    return [];
  }
  return [createCaptureCapability({ producerVersion: RUNTIME_VERSION, signer: captureSigner })];
}

function hasCorpusPorts(io: BinIo): boolean {
  return (
    io.corpusTransport !== undefined &&
    io.corpusFs !== undefined &&
    io.dsseVerifier !== undefined &&
    io.readPolicyVersions !== undefined
  );
}

function buildServeCapabilities(
  role: RuntimeRole,
  io: BinIo,
  runtimeHealth: () => ReturnType<ReturnType<typeof createPluginRuntime>["health"]>,
): readonly RuntimeCapability[] {
  if (role === "session" && io.captureSigner === undefined) {
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      "role session requires BinIo.captureSigner (F-C4-T13-2): the runtime never acquires key material itself",
    );
  }

  const capabilities: RuntimeCapability[] = [];
  let corpusCapability: CorpusCapability | undefined;
  let corpusResidualLogged = false;

  if (hasCorpusPorts(io)) {
    corpusCapability = createCorpusCapability({
      transport: io.corpusTransport!,
      fs: io.corpusFs!,
      dsseVerifier: io.dsseVerifier!,
      readPolicyVersions: io.readPolicyVersions!,
      ...(io.corpusVerifyDriver === undefined ? {} : { verifyDriver: io.corpusVerifyDriver }),
    });
    capabilities.push(corpusCapability);
  }

  const capture =
    role === "session" && io.captureSigner !== undefined
      ? createCaptureCapability({ producerVersion: RUNTIME_VERSION, signer: io.captureSigner })
      : undefined;
  if (capture !== undefined) {
    capabilities.push(capture);
  }

  const mcp = createMcpCapability({
    role,
    version: RUNTIME_VERSION,
    resolve: async (context) => {
      if (!hasCorpusPorts(io) && !corpusResidualLogged) {
        corpusResidualLogged = true;
        context.log.warn(
          "corpus ports not injected on BinIo — retrieval is fail-closed (NO_LOCATION) and mirror is unavailable",
        );
      }

      const classifier = await createSensitivityClassifier({
        noncePath: context.config.sensitivity.noncePath,
        knownIdentities: context.config.sensitivity.knownIdentities,
        nonceIo: nodeSensitivityNonceIo,
      });

      const index: RelevanceIndex = await openRelevanceIndex({
        databasePath: context.config.indexPath,
        classifier,
        indexIo: nodeIndexDatabaseIo,
      });

      const retrieval = corpusCapability?.retrieval ?? FAIL_CLOSED_RETRIEVAL;
      const mirror = corpusCapability?.mirror;
      const admission = corpusCapability
        ? mirrorAdmissionFilter(corpusCapability.admission)
        : DENY_PUBLIC_ADMISSION;

      return {
        index,
        retrieval,
        classifier,
        admission,
        archiveDirectory: context.config.archiveDirectory,
        openLocalRuntime: () =>
          openLocalEvidenceRuntime({ rootDir: context.config.archiveDirectory }),
        ...(mirror === undefined ? {} : { mirror }),
        ...(capture === undefined ? {} : { capture }),
        health: runtimeHealth,
      };
    },
  });

  capabilities.push(mcp);
  return capabilities;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: BinIo,
): Promise<number> {
  const [command = "serve"] = argv;

  if (command === "--help" || command === "-h") {
    io.writeErr(USAGE);
    return 0;
  }
  if (command === "--version") {
    io.writeOut(RUNTIME_VERSION);
    return 0;
  }
  if (command !== "serve" && command !== "health") {
    io.writeErr(`unknown command: ${command}`);
    io.writeErr(USAGE);
    return 2;
  }

  let config;
  try {
    config = resolveRuntimeConfig({ env, homeDirectory: io.homeDirectory });
  } catch (error) {
    io.writeErr(`configuration failed: ${describeUnknownError(error)}`);
    return 2;
  }

  const log = createLineLogger(config.logLevel, io.writeErr);
  log.info("configuration resolved", {
    home: config.homeDirectory,
    archive: config.archiveDirectory,
  });

  let role: RuntimeRole | undefined;
  if (command === "serve") {
    try {
      role = parseRole(argv);
    } catch (error) {
      io.writeErr(`configuration failed: ${describeUnknownError(error)}`);
      return 1;
    }
  }

  let runtime: PluginRuntime;
  try {
    runtime = createPluginRuntime({
      config,
      log,
      capabilities:
        command === "health"
          ? buildHealthCapabilities(io.captureSigner)
          : buildServeCapabilities(role!, io, () => runtime.health()),
    });
  } catch (error) {
    io.writeErr(`configuration failed: ${describeUnknownError(error)}`);
    return 1;
  }

  // Register signal handlers before the first await so the process stays alive under
  // top-level await while serve waits for shutdown.
  const shutdown = command === "serve" ? io.untilShutdown() : null;

  if (command === "health") {
    await runtime.start();
    const report = await runtime.health();
    await runtime.stop();
    io.writeOut(JSON.stringify(report));
    return report.ok ? 0 : 1;
  }

  await runtime.start();
  await shutdown!;
  await runtime.stop();
  return 0;
}

/** True when this module is the process entry point rather than an imported module. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isProcessEntry()) {
  const untilShutdown = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const finish = (): void => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        clearInterval(keepAlive);
        resolve();
      };
      const keepAlive = setInterval(() => {}, 2 ** 30);
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });

  process.exitCode = await main(process.argv.slice(2), readConfigEnvFromProcess(), {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
    homeDirectory: process.env.JINN_PLUGIN_HOME ?? join(homedir(), ".jinn-plugin"),
    untilShutdown,
  });
}
