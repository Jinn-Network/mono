// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import {
  makeLocalTaskExecutionBackend,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import type {
  LauncherCapabilities,
  LauncherContract,
} from "@jinn-network/task-execution-launchers";
import {
  buildRepositoryWorkProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import type { ProvisionerContract } from "@jinn-network/task-execution-workspace";
import { afterAll } from "vitest";
import {
  describeLocalBackendContract,
  type LocalBackendContractFactory,
  type LocalBackendConformanceSubject,
} from "./backend-contract.js";
const roots: string[] = [];
const instances: LocalTaskExecutionBackend[] = [];
const profile = buildRepositoryWorkProfile();
const emptyProfileStore: ProfileStore = { get: () => undefined };

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "jinn-real-local-contract-"));
  roots.push(value);
  return value;
}

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.drain()));
  for (const instance of instances) instance.close();
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});

const launcherCapabilities: LauncherCapabilities = {
    taskProfiles: [profile.profile],
    inputMediaTypes: ["application/json"],
    outputMediaTypes: ["text/x-diff"],
    structuredOutput: false,
    resume: false,
    interruptionBehaviorDefault: "repeatable",
    secretForwards: [],
    runPinning: { keys: [] },
};

/**
 * The real-backend suite must cross the actual supervisor/shim boundary. This launcher remains
 * a pure contract implementation: its plan is closed data and it never calls the fake
 * launcher's `onRun` simulation hook. A short delay keeps generic drive-based scenarios pending
 * until their synthetic observations are appended; evidence scenarios select immediate exit.
 */
function makeNodeProcessLauncher(delayMs: number): LauncherContract {
  return {
    id: "real-node-fixture",
    capabilities: () => launcherCapabilities,
    plan(_view, paths) {
      return {
        argv: [
          process.execPath,
          "-e",
          `setTimeout(() => process.exit(0), ${delayMs})`,
        ],
        env: {},
        cwd: paths.work,
        validExitCodes: [0],
        resultContract: { envelopeFormat: "fixture" },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}

const launcher = makeNodeProcessLauncher(500);

const provisioner: ProvisionerContract = {
  workspaceKind: () => "dir",
  async setup(_view, paths) {
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  },
  executionEnv: ({ env }) => ({ ...env }),
  async harvest() {
    return { manifest: [], omissions: ["patch"], integrityViolations: [] };
  },
};

function baseConfig(stateRoot: string): LocalTaskExecutionBackendConfig {
  return {
    stateRoot,
    source: `urn:jinn:backend-local:conformance:${stateRoot.split("/").at(-1)}`,
    executor: "https://jinn.network/software/fake-launcher",
    profileStore: emptyProfileStore,
    // The unchanged core kit carries a historical placeholder digest for which no sealed
    // profile document exists. The downstream host injects the intended immutable profile
    // semantics; assembly component tests separately exercise strict digest-pinned resolveProfile.
    resolveTaskProfile: () => profile,
    launchers: [launcher],
    provisioner: () => ({ id: "fixture", contract: provisioner }),
    provisionerCapabilities: {
      taskProfiles: [profile.profile],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json"],
      outputMediaTypes: ["text/x-diff"],
      isolation: ["process"],
    },
    maxConcurrentAttempts: 8,
  };
}

function create(
  stateRoot = root(),
  overrides: Partial<LocalTaskExecutionBackendConfig> = {},
): LocalBackendConformanceSubject {
  const instance = makeLocalTaskExecutionBackend({
    ...baseConfig(stateRoot),
    ...overrides,
  });
  instances.push(instance);
  return instance;
}

const factory = Object.assign(
  () => create(),
  {
    lockedPair() {
      const stateRoot = root();
      return { first: create(stateRoot), second: create(stateRoot) };
    },
    evidenceScenario(mode: "success" | "finalization-failure") {
      const backing = new InMemoryEvidenceRepository();
      const repository: EvidenceRepository = mode === "success"
        ? backing
        : {
            capabilities: backing.capabilities,
            putArtifact: backing.putArtifact.bind(backing),
            getArtifact: backing.getArtifact.bind(backing),
            getRecord: backing.getRecord.bind(backing),
            async putRecord() {
              throw new EvidenceRepositoryError(
                "IO_FAILURE",
                "injected recorder finalization failure",
              );
            },
          };
      let calls = 0;
      return {
        backend: create(root(), {
          launchers: [makeNodeProcessLauncher(0)],
          recorderAvailability: "always",
          evidence: {
            repository,
            catalog: new InMemoryEvidenceCatalog(),
            async awaitIndexed(reference) {
              calls += 1;
              return { status: "not-announced", reference };
            },
          },
        }),
        indexingCalls: () => calls,
      };
    },
    sealOnceScenario() {
      const stateRoot = root();
      return {
        backend: create(stateRoot, {
          faults: {
            afterDeliveryCheckpoint() {
              throw new Error("scripted crash after checkpoint");
            },
          },
        }),
        restart: () => create(stateRoot),
      };
    },
  },
) satisfies LocalBackendContractFactory;

describeLocalBackendContract(factory);
