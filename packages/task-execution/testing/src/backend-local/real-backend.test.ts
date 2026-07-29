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
import { makeFakeLauncher } from "./fake-launcher.js";

const roots: string[] = [];
const instances: LocalTaskExecutionBackend[] = [];
const profile = buildRepositoryWorkProfile();
const emptyProfileStore: ProfileStore = { get: () => undefined };

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "jinn-real-local-contract-"));
  roots.push(value);
  return value;
}

afterAll(() => {
  for (const instance of instances) instance.close();
  for (const value of roots) rmSync(value, { recursive: true, force: true });
});

const launcher = makeFakeLauncher({
  capabilities: {
    taskProfiles: [profile.profile],
    inputMediaTypes: ["application/json"],
    outputMediaTypes: ["text/x-diff"],
    structuredOutput: false,
    resume: false,
    interruptionBehaviorDefault: "repeatable",
    runPinning: { keys: [] },
  },
  plan: {
    validExitCodes: [0],
    resultContract: { envelopeFormat: "fake" },
    interruptionBehavior: "repeatable",
  },
  onRun: () => ({ exitCode: 0 }),
});

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
    provisioner: () => provisioner,
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
          recorderAvailability: "always",
          evidence: {
            repository,
            catalog: new InMemoryEvidenceCatalog(),
            async awaitIndexed(reference) {
              calls += 1;
              return { status: "not-announced", reference };
            },
          },
          execute: async () => ({ exitCode: 0 }),
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
