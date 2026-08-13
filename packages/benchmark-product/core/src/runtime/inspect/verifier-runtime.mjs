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
  evaluateVerdictRule,
  parserAllowlistKey,
} from "@jinn-network/task-execution-profiles";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024;
const INSPECT_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval";

function operational(code, detail, cause) {
  return new EvaluationOperationalError({
    canonicalCode: code,
    reason: "invalid-evaluator-output",
    recoveryAdvice: code === "CANCELLED" ? "resume-attempt" : "do-not-retry",
    safeDetail: detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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

function comparableSummary(summary) {
  const common = {
    terminal: summary.terminal,
    inspectStatus: summary.inspectStatus,
    expectedSamples: summary.expectedSamples,
    observedSamples: summary.observedSamples,
    erroredSamples: summary.erroredSamples,
    invalidated: summary.invalidated,
    nativeLogSha256: summary.nativeLogSha256,
    nativeLogBytes: summary.nativeLogBytes,
  };
  return summary.schema.endsWith("/1")
    ? {
      summarySchema: summary.schema,
      ...common,
      missingScoreSamples: summary.missingScoreSamples,
      scorer: summary.scorer,
      measurement: summary.measurement,
    }
    : {
      summarySchema: summary.schema,
      ...common,
      scorers: summary.scorers,
      measurements: summary.measurements,
    };
}

function projectObservation(manifest, summary, observation) {
  if (
    observation?.schema !== "jinn.network/benchmark-product/inspect-log-observation/1"
    || observation.summarySchema !== summary.schema
  ) throw operational("DATA_LOSS", "Inspect verifier returned an invalid observation");
  const observedComparable = { ...observation };
  delete observedComparable.schema;
  if (!equalJson(comparableSummary(summary), observedComparable)) {
    throw operational("DATA_LOSS", "Inspect execution summary differs from the independently read native log");
  }
  if (observation.terminal !== "scored") {
    throw operational("FAILED_PRECONDITION", "Inspect native log is unscorable");
  }
  if (observation.summarySchema.endsWith("/1")) {
    if (manifest.scoring !== undefined || typeof observation.measurement !== "boolean") {
      throw operational("DATA_LOSS", "Inspect legacy score projection is invalid");
    }
    const measurements = [{ name: "inspect-score-pass", value: observation.measurement }];
    const verdict = evaluateVerdictRule(
      { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } },
      { "inspect-score-pass": observation.measurement },
    ).verdict;
    if (summary.verdict !== verdict) throw operational("DATA_LOSS", "Inspect summary verdict is inconsistent");
    return { verdict, measurements };
  }
  if (!Array.isArray(observation.measurements) || observation.measurements.length !== manifest.scoring?.projections.length) {
    throw operational("DATA_LOSS", "Inspect multi-scorer projection is incomplete");
  }
  const values = {};
  const measurements = observation.measurements.map((measurement, index) => {
    const projection = manifest.scoring.projections[index];
    if (
      measurement.measurementName !== projection.measurementName
      || measurement.scorerName !== projection.scorerName
      || measurement.subScoreKey !== projection.subScoreKey
      || measurement.missingSamples !== 0
      || measurement.invalidValueSamples !== 0
      || typeof measurement.value !== "boolean"
    ) throw operational("DATA_LOSS", "Inspect multi-scorer projection differs from the sealed method");
    values[measurement.measurementName] = measurement.value;
    return { name: measurement.measurementName, value: measurement.value };
  });
  const verdict = evaluateVerdictRule(manifest.scoring.verdictRule, values).verdict;
  if (summary.verdict !== verdict) throw operational("DATA_LOSS", "Inspect summary verdict is inconsistent");
  return { verdict, measurements };
}

async function spawnBounded(executable, args, env, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const stdout = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_WORKER_OUTPUT_BYTES) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", (cause) => {
      reject(signal.aborted
        ? operational("CANCELLED", "Inspect log verification was cancelled", cause)
        : operational("UNAVAILABLE", "Inspect log verifier could not start", cause));
    });
    child.once("exit", (code, exitSignal) => {
      if (signal.aborted) {
        reject(operational("CANCELLED", "Inspect log verification was cancelled"));
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
        const summary = parseSummary(summaryMaterial.bytes);
        const observation = await readObservation(options, nativeLog, attempt, deadlineSignal);
        const projected = projectObservation(options.manifest, summary, observation);
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
