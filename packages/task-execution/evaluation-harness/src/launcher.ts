// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import type {
  InterruptionBehavior,
  LauncherCapabilities,
  LauncherContract,
  LaunchPlan,
  ProbeResult,
} from "@jinn-network/task-execution-launchers";
import { EVALUATION_TASK_PROFILE_URI } from "@jinn-network/task-execution-profiles";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  EVALUATION_HARNESS_EXIT_CONFIGURATION,
  EVALUATION_HARNESS_EXIT_INVALID_INPUT,
  EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE,
  type EvaluationHarnessDeployment,
} from "./runtime.js";
import {
  type EvaluatorRegistration,
  validateEvaluatorRegistrationSet,
} from "./registration.js";

export const EVALUATION_LAUNCHER_ID = "evaluation-harness";

/**
 * The default launcher module is deliberately adapter-empty. Concrete evaluator registrations
 * are deployment code and are supplied through `makeEvaluationLauncher({ deploymentModule })`.
 */
export const evaluationHarnessDeployment: EvaluationHarnessDeployment =
  Object.freeze({
    registrations: Object.freeze([]),
    parserAllowlist: new Set<string>(),
    maxClaimEvidenceBytes: 1,
    evidenceWriter: {
      async putClaimEvidence() {
        throw new TypeError("evaluation deployment must configure an evidence repository writer");
      },
    },
  });

export interface EvaluationLauncherOptions {
  /** Host-owned ESM module exporting `evaluationHarnessDeployment` (never Task/spec-selected). */
  readonly deploymentModule?: string;
  /** Test/embedding override; production defaults to this package's compiled `bin.js`. */
  readonly entrypoint?: string;
  /** Test/embedding override; production defaults to the current absolute Node executable. */
  readonly nodeExecutable?: string;
  /** Host-owned validated registrations; no Task or launcher option may invent one. */
  readonly registrations?: readonly EvaluatorRegistration[];
  /** Resolves one configured registration from the already-resolved Task view. */
  readonly selectRegistration?: (view: TaskView) => EvaluatorRegistration;
  readonly probe?: () => Promise<ProbeResult>;
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must be non-empty`);
  return value;
}

function methodDigest(registration: EvaluatorRegistration): `sha256:${string}` {
  const value = registration.evaluationMethod.digest?.sha256;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("evaluation launcher registration requires a canonical evaluation method sha256 digest");
  }
  return `sha256:${value}`;
}

/** Forward Yarn PnP bootstrap when the launcher itself runs under PnP (CI/dev). */
function nodeBootstrapEnv(): Record<string, string> {
  const nodeOptions = process.env["NODE_OPTIONS"];
  return nodeOptions === undefined || nodeOptions.length === 0
    ? {}
    : { NODE_OPTIONS: nodeOptions };
}

function launcherCapabilities(
  interruptionBehavior: InterruptionBehavior,
  configured: boolean,
): LauncherCapabilities {
  return {
    taskProfiles: configured ? [EVALUATION_TASK_PROFILE_URI] : [],
    inputMediaTypes: [
      "application/json",
      "application/vnd.jinn.task-execution.evaluation-spec.v1+json",
      "text/plain",
      "text/x-diff",
    ],
    outputMediaTypes: ["application/vnd.in-toto+json"],
    structuredOutput: false,
    resume: interruptionBehavior === "recoverable",
    interruptionBehaviorDefault: interruptionBehavior,
    secretForwards: [],
    hostSecretForwards: [],
    runPinning: {
      keys: [{
        key: "harness",
        inventory: [EVALUATION_LAUNCHER_ID],
        posture: "enforced",
      }],
    },
  };
}

function launchPlan(
  deploymentModule: string,
  entrypoint: string,
  nodeExecutable: string,
  registration: EvaluatorRegistration,
  view: TaskView,
  paths: WorkspacePaths,
  _attempt: AttemptIdentity,
): LaunchPlan {
  if (view.profile.profile !== EVALUATION_TASK_PROFILE_URI) {
    throw new TypeError(
      "evaluationLauncher only plans evaluation-task/1.0 Tasks",
    );
  }
  return {
    argv: [nodeExecutable, entrypoint],
    env: {
      JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE: deploymentModule,
      JINN_ATTEMPT_EVALUATOR_REGISTRATION: registration.registrationId,
      JINN_ATTEMPT_ROOT: paths.root,
      JINN_ATTEMPT_INPUT: paths.input,
      JINN_ATTEMPT_WORK: paths.work,
      JINN_ATTEMPT_OUT: paths.out,
      JINN_ATTEMPT_LOGS: paths.logs,
      JINN_ATTEMPT_HARNESS_STATE: paths.harnessState,
      JINN_ATTEMPT_SECRETS: paths.secrets,
      JINN_ATTEMPT_META: paths.meta,
      TMPDIR: paths.tmp,
      ...nodeBootstrapEnv(),
    },
    cwd: paths.work,
    validExitCodes: [0],
    blameExitCodes: [
      {
        match: { exitCode: EVALUATION_HARNESS_EXIT_INVALID_INPUT },
        blame: "task",
        reasonCode: "invalid-evaluation-input",
      },
      {
        match: { exitCode: EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE },
        blame: "infrastructure",
        reasonCode: "evaluation-operational-failure",
      },
      {
        match: { exitCode: EVALUATION_HARNESS_EXIT_CONFIGURATION },
        blame: "infrastructure",
        reasonCode: "evaluation-harness-configuration",
      },
    ],
    resultContract: {
      envelopeFormat: "jinn-result-evaluation-statement-v1",
      structuredOutputArtifact: "out/verdict",
    },
    interruptionBehavior: registration.interruptionBehavior,
  };
}

export function makeEvaluationLauncher(
  options: EvaluationLauncherOptions = {},
): LauncherContract {
  const deploymentModule = nonEmpty(
    options.deploymentModule ??
      new URL("./launcher.js", import.meta.url).href,
    "deploymentModule",
  );
  const entrypoint = nonEmpty(
    options.entrypoint ??
      fileURLToPath(new URL("./bin.js", import.meta.url)),
    "entrypoint",
  );
  const nodeExecutable = nonEmpty(
    options.nodeExecutable ?? process.execPath,
    "nodeExecutable",
  );
  const registrations = validateEvaluatorRegistrationSet(options.registrations ?? []);
  const interruptionBehaviors = new Set(registrations.map((registration) => registration.interruptionBehavior));
  if (interruptionBehaviors.size > 1) {
    throw new TypeError("evaluation launcher registrations have ambiguous interruption behavior");
  }
  const selectedRegistration = (view: TaskView): EvaluatorRegistration => {
    if (options.selectRegistration === undefined) {
      throw new TypeError("evaluation launcher requires a registration selector");
    }
    const selected = options.selectRegistration(view);
    const registration = registrations.find((candidate) => candidate.registrationId === selected.registrationId);
    if (registration === undefined) {
      throw new TypeError("evaluation launcher selected an unconfigured registration");
    }
    return registration;
  };

  return Object.freeze({
    id: EVALUATION_LAUNCHER_ID,
    capabilities: () => launcherCapabilities(
      registrations[0]?.interruptionBehavior ?? "repeatable",
      registrations.length > 0,
    ),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    plan(
      view: TaskView,
      paths: WorkspacePaths,
    attempt: AttemptIdentity,
    ) {
      const registration = selectedRegistration(view);
      return launchPlan(
        deploymentModule,
        entrypoint,
        nodeExecutable,
        registration,
        view,
        paths,
        attempt,
      );
    },
  });
}

/** Adapter-empty reference launcher; hosts normally register a factory-created configured copy. */
export const evaluationLauncher: LauncherContract = makeEvaluationLauncher();
