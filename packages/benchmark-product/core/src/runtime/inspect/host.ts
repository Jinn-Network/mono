import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "../../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../../fs/atomic.js";
import { runtimeHostPath } from "../../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../../workspace/sealed-store.js";
import {
  INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
  INSPECT_SELECTION_SCHEMA,
  InspectScoringRequestSchema,
  InspectSelectionManifestSchema,
  isInspectMultiScorerSelection,
  type InspectArmConfiguration,
  type InspectRunOptions,
  type InspectScoringSelectionRequest,
  type InspectSelectionManifest,
} from "./manifest.js";
import {
  InspectOciHostBindingSchema,
  assertInspectOciHostUndrifted,
  probeInspectOciSelection,
} from "./oci.js";

const WorkerEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const InspectLocalHostBindingSchema = z.object({
  kind: z.literal("local-python").optional(),
  pythonPath: z.string().min(1),
  projectDir: z.string().min(1),
}).strict();
export const InspectHostBindingSchema = z.union([InspectLocalHostBindingSchema, InspectOciHostBindingSchema]);
export type InspectHostBinding = z.infer<typeof InspectHostBindingSchema>;

export type ProbeInspectSelectionInput = InspectScoringSelectionRequest & {
  readonly pythonPath: string;
  readonly projectDir: string;
  readonly taskReference: string;
  readonly taskArgs?: Readonly<Record<string, unknown>>;
  readonly arms: readonly InspectArmConfiguration[];
  readonly runOptions?: InspectRunOptions;
};

export function inspectWorkerPath(): string {
  return fileURLToPath(new URL("./worker.py", import.meta.url));
}

export function inspectWorkerSha256(): string {
  return sha256Hex(new Uint8Array(readFileSync(inspectWorkerPath())));
}

async function callWorker(
  pythonPath: string,
  operation: "probe" | "run",
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [inspectWorkerPath(), operation], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      // No ambient credential variables cross this boundary. The optional OCI provider path uses
      // the runtime host's broker port; local-Python never inherits web/server credentials.
      env: {
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONUTF8: "1",
        LANG: "C.UTF-8",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      const text = Buffer.concat(stdout).toString("utf8").trim();
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        reject(new Error(`Inspect worker exited ${String(code ?? exitSignal)} without a valid response`));
        return;
      }
      const envelope = WorkerEnvelopeSchema.safeParse(decoded);
      if (!envelope.success) {
        reject(new Error("Inspect worker returned an invalid response envelope"));
      } else if (!envelope.data.ok) {
        reject(new Error(envelope.data.error));
      } else if (code !== 0) {
        reject(new Error(`Inspect worker exited ${String(code ?? exitSignal)}`));
      } else {
        resolve(envelope.data.value);
      }
      void stderr; // deliberately never echo child stderr; it may contain provider payloads.
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function probeInspectSelection(input: ProbeInspectSelectionInput): Promise<InspectSelectionManifest> {
  const scoring = input.scoring === undefined ? undefined : InspectScoringRequestSchema.parse(input.scoring);
  if ((input.scorer === undefined) === (scoring === undefined)) throw new TypeError("select exactly one of scorer or scoring");
  const probed = await callWorker(input.pythonPath, "probe", {
    projectDir: input.projectDir,
    taskReference: input.taskReference,
    taskArgs: input.taskArgs ?? {},
    ...(scoring === undefined ? { scorerName: input.scorer!.name } : { scorerNames: scoring.projections.map((projection) => projection.scorerName) }),
    runOptions: input.runOptions ?? {},
  }) as { runtime?: unknown; task?: unknown; scorer?: unknown; scorers?: unknown; inspectMetrics?: unknown; inspectEpochReducers?: unknown };
  const manifest = InspectSelectionManifestSchema.safeParse({
    schema: scoring === undefined ? INSPECT_SELECTION_SCHEMA : INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
    runtime: {
      ...(probed.runtime as Record<string, unknown>),
      adapterVersion: "1",
      workerSha256: inspectWorkerSha256(),
    },
    task: probed.task,
    arms: input.arms,
    ...(scoring === undefined
      ? { scorer: { ...input.scorer, definition: probed.scorer } }
      : {
        scorers: Array.isArray(probed.scorers)
          ? probed.scorers.map((definition) => ({
            name: (definition as { readonly name?: unknown }).name,
            definition,
          }))
          : probed.scorers,
        scoring: {
          ...scoring,
          inspectMetrics: probed.inspectMetrics ?? null,
          inspectEpochReducers: probed.inspectEpochReducers ?? null,
        },
      }),
    runOptions: input.runOptions ?? {},
  });
  if (!manifest.success) {
    const paths = manifest.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(", ");
    refuse(
      "venue-unavailable",
      "inspect.selection",
      `Inspect worker resolved a selection that does not satisfy the pinned adapter schema at ${paths}`,
    );
  }
  return manifest.data;
}

export function writeInspectHostBinding(
  workspaceDir: string,
  selectionManifestSha256: string,
  binding: InspectHostBinding,
): void {
  const parsed = InspectHostBindingSchema.parse(binding);
  atomicWriteFileSync(runtimeHostPath(workspaceDir, selectionManifestSha256), JSON.stringify(parsed, null, 2));
}

export function readInspectHostBinding(workspaceDir: string, selectionManifestSha256: string): InspectHostBinding {
  const path = runtimeHostPath(workspaceDir, selectionManifestSha256);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) refuse("venue-unavailable", path, "the private Inspect worker binding is missing");
  try {
    return InspectHostBindingSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  } catch {
    return refuse("venue-unavailable", path, "the private Inspect worker binding is invalid");
  }
}

export function readInspectSelectionManifest(workspaceDir: string, digest: string): InspectSelectionManifest {
  const bytes = getSealedBytes(workspaceDir, digest);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch {
    return refuse("record-integrity", "inspect.selection", "the sealed Inspect selection manifest is not valid UTF-8 JSON");
  }
  const parsed = InspectSelectionManifestSchema.safeParse(decoded);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    return refuse("record-integrity", "inspect.selection", `the sealed Inspect selection manifest is invalid at ${paths}`);
  }
  return parsed.data;
}

export async function assertInspectSelectionUndrifted(
  workspaceDir: string,
  selectionManifestSha256: string,
): Promise<void> {
  const expected = readInspectSelectionManifest(workspaceDir, selectionManifestSha256);
  const host = readInspectHostBinding(workspaceDir, selectionManifestSha256);
  const scoringRequest = isInspectMultiScorerSelection(expected)
    ? { scoring: { projections: expected.scoring.projections, verdictRule: expected.scoring.verdictRule } }
    : { scorer: { name: expected.scorer.name, passValue: expected.scorer.passValue } };
  const actual = host.kind === "oci"
    ? (await probeInspectOciSelection({
      dockerPath: host.dockerPath,
      imageDigest: host.imageDigest,
      projectDir: host.projectDir,
      datasetCacheDir: host.datasetCacheDir,
      sandboxExecution: host.sandboxExecution,
      taskReference: expected.task.reference,
      taskArgs: expected.task.args as Readonly<Record<string, unknown>>,
      arms: expected.arms,
      ...scoringRequest,
      runOptions: expected.runOptions as InspectRunOptions & { sampleId: string | number },
    })).manifest
    : await probeInspectSelection({
      pythonPath: host.pythonPath,
      projectDir: host.projectDir,
      taskReference: expected.task.reference,
      taskArgs: expected.task.args as Readonly<Record<string, unknown>>,
      arms: expected.arms,
      ...scoringRequest,
      runOptions: expected.runOptions,
    });
  if (host.kind === "oci") await assertInspectOciHostUndrifted(host, expected);
  if (sha256Hex(canonicalJsonBytes(actual as never)) !== selectionManifestSha256) {
    refuse("conflict", "inspect.selection", "Inspect task, source, Python, runtime, or material configuration drifted after selection/lock");
  }
}

export async function invokeInspectRun(
  pythonPath: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return callWorker(pythonPath, "run", input, signal);
}
