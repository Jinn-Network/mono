import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvaluationOperationalError,
  defineEvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  parserAllowlistKey,
} from "@jinn-network/task-execution-profiles";
import { verifyInspectLogProjectionRuntime } from "./projection-runtime.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024;
const INSPECT_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval";
const INSPECT_SUMMARY_MEDIA_TYPE = "application/vnd.jinn.inspect-summary+json";

function operational(code, detail, cause) {
  return new EvaluationOperationalError({
    canonicalCode: code,
    reason: "invalid-evaluator-output",
    recoveryAdvice: code === "CANCELLED" ? "resume-attempt" : "do-not-retry",
    safeDetail: detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireResult(results, name) {
  const result = results.find((candidate) => candidate.descriptor.name === name);
  if (result === undefined) throw operational("NOT_FOUND", `Inspect evaluation is missing ${name}`);
  return result;
}

function parseSummary(bytes) {
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw operational("DATA_LOSS", "Inspect execution summary is invalid", cause);
  }
  if (
    value === null
    || typeof value !== "object"
    || ![
      "jinn.network/benchmark-product/inspect-cell-summary/1",
      "jinn.network/benchmark-product/inspect-cell-summary/2",
    ].includes(value.schema)
  ) throw operational("DATA_LOSS", "Inspect execution summary is invalid");
  return value;
}

/** Product-private process boundary. Exported only so cancellation/reaping remains directly
 * regression-testable without requiring a Python or OCI runtime. */
export async function spawnBounded(executable, args, env, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let bytes = 0;
    let spawnError;
    let outputExceeded = false;
    let killTimer;
    const cancel = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
      killTimer.unref();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_WORKER_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", (cause) => {
      spawnError = cause;
    });
    child.once("close", (code, exitSignal) => {
      signal.removeEventListener("abort", cancel);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (signal.aborted) {
        reject(operational("CANCELLED", "Inspect log verification was cancelled", spawnError));
        return;
      }
      if (spawnError !== undefined) {
        reject(operational("UNAVAILABLE", "Inspect log verifier could not start", spawnError));
        return;
      }
      if (outputExceeded) {
        reject(operational("RESOURCE_EXHAUSTED", "Inspect log verifier exceeded its output limit"));
        return;
      }
      if (code !== 0) {
        reject(operational("DATA_LOSS", `Inspect log verifier exited ${String(code ?? exitSignal)}`));
        return;
      }
      try {
        const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (envelope?.ok !== true || envelope.value === undefined) {
          throw new TypeError("invalid worker envelope");
        }
        resolve(envelope.value);
      } catch (cause) {
        reject(operational("DATA_LOSS", "Inspect log verifier returned an invalid response", cause));
      }
    });
  });
}

function mount(source, destination, readonly = false) {
  if (!source.startsWith("/") || /[\n\r,]/u.test(source)) {
    throw operational("INVALID_ARGUMENT", "Inspect verifier mount path is invalid");
  }
  return `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`;
}

function ociArgs(host, attempt, inputDir) {
  const suffix = createHash("sha256").update(attempt.attemptUri).digest("hex").slice(0, 24);
  return [
    "run", "--rm", "--interactive", "--pull=never",
    `--platform=${host.platform}`,
    `--name=jinn-inspect-verify-${suffix}`,
    `--hostname=jinn-inspect-verify-${suffix}`,
    `--user=${host.user}`,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--network=none", "--pids-limit=32", "--memory=536870912", "--cpus=1",
    "--ulimit=nofile=512:512", "--ipc=none",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--workdir=/tmp", "--env=PYTHONDONTWRITEBYTECODE=1", "--env=PYTHONNOUSERSITE=1",
    "--env=PYTHONUTF8=1", "--env=LANG=C.UTF-8", "--env=HOME=/tmp/home",
    "--mount", mount(inputDir, "/jinn/input", true),
    host.imageDigest, "verify", "/jinn/input/inspect-verify.json",
  ];
}

async function readObservation(options, nativeLog, attempt, signal) {
  const directory = await mkdtemp(join(tmpdir(), "jinn-inspect-verify-"));
  try {
    if (options.host.kind === "oci") await chmod(directory, 0o755);
    const nativeLogPath = join(directory, "inspect.eval");
    await writeFile(nativeLogPath, nativeLog.bytes, { mode: options.host.kind === "oci" ? 0o444 : 0o400 });
    const insideLogPath = options.host.kind === "oci" ? "/jinn/input/inspect.eval" : nativeLogPath;
    const config = {
      manifest: options.manifest,
      selectionManifestSha256: options.selectionManifestSha256,
      nativeLogPath: insideLogPath,
    };
    const configPath = join(directory, "inspect-verify.json");
    await writeFile(configPath, encoder.encode(JSON.stringify(config)), { mode: options.host.kind === "oci" ? 0o444 : 0o400 });
    if (options.host.kind === "oci") {
      return await spawnBounded(
        process.execPath,
        [options.ociRunnerPath, options.host.dockerPath, ...ociArgs(options.host, attempt, directory)],
        { LANG: "C.UTF-8" },
        signal,
      );
    }
    return await spawnBounded(
      options.host.pythonPath,
      [options.workerPath, "verify", configPath],
      {
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONUTF8: "1",
        LANG: "C.UTF-8",
        TMPDIR: directory,
      },
      signal,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function inspectLogVerifierParser(manifest) {
  return {
    id: "benchmark-product-inspect-score-projection",
    version: manifest.runtime.adapterVersion,
    digest: `sha256:${manifest.runtime.workerSha256}`,
  };
}

export function createInspectLogVerifierRegistration(options) {
  const expectedParser = parserAllowlistKey(inspectLogVerifierParser(options.manifest));
  return defineEvaluatorRegistration({
    registrationId: options.registrationId,
    adapter: {
      async evaluate(_task, results, specification, _context, attempt, deadlineSignal) {
        if (deadlineSignal.aborted) throw operational("CANCELLED", "Inspect log verification was cancelled");
        if (results.length !== 2) {
          throw operational("INVALID_ARGUMENT", "Inspect log verification requires exactly the native log and summary");
        }
        const nativeLog = requireResult(results, "inspect-log");
        const summaryMaterial = requireResult(results, "inspect-summary");
        if (
          nativeLog.descriptor.mediaType !== INSPECT_LOG_MEDIA_TYPE
          || nativeLog.descriptor.digest?.sha256 !== sha256(nativeLog.bytes)
        ) throw operational("DATA_LOSS", "Inspect native log descriptor is inconsistent");
        if (
          summaryMaterial.descriptor.mediaType !== INSPECT_SUMMARY_MEDIA_TYPE
          || summaryMaterial.descriptor.digest?.sha256 !== sha256(summaryMaterial.bytes)
        ) throw operational("DATA_LOSS", "Inspect summary descriptor is inconsistent");
        const summary = parseSummary(summaryMaterial.bytes);
        const observation = await readObservation(options, nativeLog, attempt, deadlineSignal);
        if (observation?.schema !== "jinn.network/benchmark-product/inspect-log-observation/1") {
          throw operational("DATA_LOSS", "Inspect verifier returned an invalid observation");
        }
        let projected;
        try {
          projected = verifyInspectLogProjectionRuntime(summary, observation, options.manifest);
        } catch (cause) {
          throw operational("DATA_LOSS", "Inspect native-log projection does not match the sealed execution summary", cause);
        }
        if (projected.verdict === null) {
          throw operational("FAILED_PRECONDITION", "Inspect native log is unscorable");
        }
        return {
          detailedOutcome: {
            relationship: "separate-log-verifier",
            scoreSource: "same-execution-scorer",
            observation,
          },
          verdict: projected.verdict,
          evaluatedAt: new Date().toISOString(),
          measurements: projected.measurements,
          explanation: "A separate process read the genuine Inspect log and recomputed the locked Jinn projection; it did not rerun the Inspect scorers.",
          limitations: [
            "score-source:same-execution-scorer",
            "verification-process:separate",
            "self-run-operator-custody",
            "not-independent-rescoring",
            "not-separate-real-world-party",
            "not-method-diversity",
          ],
          claimEvidence: [{
            kind: "descriptor",
            descriptor: {
              name: "inspect-native-log",
              digest: { sha256: nativeLog.descriptor.digest.sha256 },
              mediaType: INSPECT_LOG_MEDIA_TYPE,
            },
          }],
        };
      },
    },
    evaluationMethod: options.evaluationMethod,
    specificationCompatibility: (specification) => {
      if (specification.family !== "deterministic-process") return false;
      return parserAllowlistKey(specification.familyBlock.parser) === expectedParser;
    },
    evaluatorIdentity: { id: options.evaluatorId },
    signer: { handle: options.signerHandle },
    outcomeValidator: (evaluation) => evaluation,
    interruptionBehavior: "repeatable",
  });
}
