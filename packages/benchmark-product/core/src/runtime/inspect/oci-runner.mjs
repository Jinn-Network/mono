#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createSandboxController } from "./sandbox-controller.mjs";

const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
/**
 * The `docker` CLI runs on the HOST and writes build context and export scratch into its temp
 * directory, so the caller's temp variables have to reach it — an allowlist that names none leaves
 * it on the platform default, outside whatever root the caller was confined to. Duplicated from
 * `child-temp-env.ts` rather than imported: this file is plain JavaScript spawned as its own
 * script and cannot load a TypeScript module. Nothing here reaches the container's own environment,
 * which `docker run` builds from the image and the flags below.
 */
const dockerEnvironment = (() => {
  const environment = { LANG: "C.UTF-8" };
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }
  return environment;
})();

function docker(dockerPath, args, timeout = 15_000) {
  return spawnSync(dockerPath, args, {
    encoding: "utf8",
    env: dockerEnvironment,
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });
}

function dockerInput(dockerPath, args, input, timeout = 15_000) {
  return spawnSync(dockerPath, args, {
    encoding: "utf8",
    env: dockerEnvironment,
    input,
    stdio: ["pipe", "pipe", "ignore"],
    timeout,
  });
}

function requireSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout.trim();
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function removeWorkerContainer(dockerPath, containerName) {
  // Killing `docker run` can race Docker Engine's asynchronous container creation. A single
  // `docker rm` may therefore report the container absent immediately before it appears in the
  // Created state. Require two consecutive absent observations so cancellation cannot orphan it.
  let absentObservations = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    docker(dockerPath, ["rm", "--force", containerName]);
    const inspection = docker(dockerPath, ["container", "inspect", containerName], 5_000);
    if (inspection.status === 0) absentObservations = 0;
    else absentObservations += 1;
    if (absentObservations >= 2) return;
    await delay(50);
  }
}

function mountSource(args, destination) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--mount") continue;
    const fields = Object.fromEntries(args[index + 1].split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator === -1 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    if (fields.dst === destination) return fields.src;
  }
  return undefined;
}

function readConnection(path) {
  if (path === undefined) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("host connection descriptor is invalid");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.schema !== "jinn.network/benchmark-product/host-connection/1") {
    throw new Error("host connection descriptor is invalid");
  }
  const keyPath = value.openAIKeyFile;
  if (typeof keyPath !== "string") throw new Error("host connection descriptor is invalid");
  const keyStat = lstatSync(keyPath);
  if (
    !keyStat.isFile()
    || keyStat.isSymbolicLink()
    || realpathSync(keyPath) !== keyPath
    || (keyStat.mode & 0o400) === 0
    || (keyStat.mode & 0o077) !== 0
    || keyStat.dev !== value.metadata?.dev
    || keyStat.ino !== value.metadata?.ino
    || (keyStat.mode & 0o777) !== value.metadata?.mode
    || keyStat.size !== value.metadata?.size
    || keyStat.uid !== value.metadata?.uid
  ) {
    throw new Error("OpenAI credential metadata drifted after preflight");
  }
  const fixturePath = value.testResponseFixture;
  if (fixturePath !== undefined) {
    if (typeof fixturePath !== "string") throw new Error("host connection descriptor is invalid");
    const fixtureStat = lstatSync(fixturePath);
    if (
      !fixtureStat.isFile()
      || fixtureStat.isSymbolicLink()
      || realpathSync(fixturePath) !== fixturePath
      || fixtureStat.dev !== value.testResponseMetadata?.dev
      || fixtureStat.ino !== value.testResponseMetadata?.ino
      || (fixtureStat.mode & 0o777) !== value.testResponseMetadata?.mode
      || fixtureStat.size !== value.testResponseMetadata?.size
      || fixtureStat.uid !== value.testResponseMetadata?.uid
    ) throw new Error("test response fixture metadata drifted after preflight");
  }
  return { keyPath, fixturePath };
}

function populateVolume(dockerPath, imageDigest, volume, filename, input, mode, label) {
  requireSuccess(dockerInput(dockerPath, [
    "run", "--rm", "--interactive", "--pull=never", "--platform=linux/amd64", "--network=none",
    "--mount", `type=volume,src=${volume},dst=/jinn-secret`,
    "--entrypoint=python", imageDigest, "-c",
    "import os,sys; p='/jinn-secret/'+sys.argv[1]; open(p,'wb').write(sys.stdin.buffer.read()); os.chmod(p,int(sys.argv[2],8))",
    filename, mode,
  ], input), label);
}

function setupBroker(dockerPath, dockerArgs, containerName, imageDigest, connection, probeOnly = false) {
  if (!probeOnly) {
    // Probe and verifier workers never call a model. In particular, the verifier input is an
    // EvalLog rather than inspect-run.json, and must not acquire a broker, credential volume, or
    // network merely because it shares this cancellation-safe OCI supervisor.
    if ([
      "/jinn/input/inspect-probe.json",
      "/jinn/input/inspect-verify.json",
    ].includes(dockerArgs.at(-1))) return undefined;
    const inputDir = mountSource(dockerArgs, "/jinn/input");
    if (inputDir === undefined) throw new Error("credentialed worker input mount is missing");
    const runInput = JSON.parse(readFileSync(join(inputDir, "inspect-run.json"), "utf8"));
    if (runInput?.arm?.provider === undefined) return undefined;
  }
  if (connection === undefined) throw new Error("OpenAI host connection is not configured");

  const networkName = `${containerName}-net`;
  const brokerName = `${containerName}-broker`;
  const credentialVolume = `${containerName}-credential`;
  const capabilityVolume = `${containerName}-capability`;
  if (![networkName, brokerName, credentialVolume, capabilityVolume].every((name) => SAFE_NAME.test(name))) {
    throw new Error("derived broker identity is invalid");
  }
  const key = readFileSync(connection.keyPath);
  const capability = randomBytes(32).toString("hex");
  const fixture = connection.fixturePath === undefined ? undefined : readFileSync(connection.fixturePath);

  try {
    requireSuccess(docker(dockerPath, ["network", "create", "--internal", "--driver=bridge", networkName]), "broker network creation");
    requireSuccess(docker(dockerPath, ["volume", "create", credentialVolume]), "credential volume creation");
    requireSuccess(docker(dockerPath, ["volume", "create", capabilityVolume]), "capability volume creation");
    populateVolume(dockerPath, imageDigest, credentialVolume, "openai-api-key", key, "400", "credential volume population");
    // The capability is random and scoped to this one cell. It is readable by the unprivileged
    // worker UID, while the credential remains broker-only in a separate volume.
    populateVolume(dockerPath, imageDigest, capabilityVolume, "broker-capability", capability, "444", "capability volume population");
    if (fixture !== undefined) {
      populateVolume(dockerPath, imageDigest, credentialVolume, "fake-response.json", fixture, "400", "test response volume population");
    }
    requireSuccess(docker(dockerPath, [
      "run", "--detach", "--pull=never", "--platform=linux/amd64",
      `--name=${brokerName}`, `--hostname=${brokerName}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--network=bridge", "--pids-limit=32", "--memory=268435456", "--cpus=1",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864",
      "--mount", `type=volume,src=${credentialVolume},dst=/run/secrets,readonly`,
      "--mount", `type=volume,src=${capabilityVolume},dst=/run/jinn,readonly`,
      ...(fixture === undefined ? [] : ["--env=JINN_BROKER_FAKE_RESPONSE_PATH=/run/secrets/fake-response.json"]),
      "--entrypoint=python", imageDigest, "/opt/jinn/broker.py",
    ], 30_000), "broker start");
    requireSuccess(docker(dockerPath, ["network", "connect", "--alias=jinn-model-broker", networkName, brokerName]), "broker network attachment");

    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
      const result = docker(dockerPath, [
        "exec", brokerName, "python", "-c",
        "from urllib.request import urlopen; import json; assert json.load(urlopen('http://127.0.0.1:8765/health', timeout=2))['ok']",
      ], 5_000);
      ready = result.status === 0;
      if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!ready) {
      const stateResult = docker(dockerPath, ["inspect", "--format", "{{json .State}}", brokerName]);
      let state = "unavailable";
      if (stateResult.status === 0) {
        const decoded = JSON.parse(stateResult.stdout);
        state = `${String(decoded?.Status ?? "unknown")}/${String(decoded?.ExitCode ?? "unknown")}`;
      }
      const logsResult = spawnSync(dockerPath, ["logs", brokerName], {
        encoding: "utf8",
        env: dockerEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      });
      const startupCode = `${logsResult.stdout}${logsResult.stderr}`.trim().match(/^broker-startup:[A-Za-z-]+$/u)?.[0];
      throw new Error(`broker readiness failed (${state}${startupCode === undefined ? "" : `/${startupCode}`})`);
    }
    const networks = JSON.parse(requireSuccess(docker(
      dockerPath,
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", brokerName],
    ), "broker network inspection"));
    const privateNetwork = networks?.[networkName];
    if (!Array.isArray(privateNetwork?.Aliases) || !privateNetwork.Aliases.includes("jinn-model-broker")) {
      throw new Error("broker private-network alias is absent");
    }

    if (!probeOnly) {
      const imageIndex = dockerArgs.lastIndexOf(imageDigest);
      if (imageIndex < 1) throw new Error("worker image identity is missing");
      const networkIndex = dockerArgs.findIndex((argument) => argument.startsWith("--network="));
      if (networkIndex < 0) throw new Error("worker network policy is missing");
      dockerArgs[networkIndex] = `--network=${networkName}`;
      dockerArgs.splice(
        imageIndex,
        0,
        "--mount", `type=volume,src=${capabilityVolume},dst=/run/jinn,readonly`,
      );
    }
    key.fill(0);
    fixture?.fill(0);
    return { networkName, brokerName, credentialVolume, capabilityVolume };
  } catch (cause) {
    key.fill(0);
    fixture?.fill(0);
    docker(dockerPath, ["rm", "--force", brokerName]);
    docker(dockerPath, ["network", "rm", networkName]);
    docker(dockerPath, ["volume", "rm", "--force", credentialVolume]);
    docker(dockerPath, ["volume", "rm", "--force", capabilityVolume]);
    throw cause;
  }
}

function cleanupBroker(dockerPath, broker) {
  docker(dockerPath, ["rm", "--force", broker.brokerName]);
  docker(dockerPath, ["network", "rm", broker.networkName]);
  docker(dockerPath, ["volume", "rm", "--force", broker.credentialVolume]);
  docker(dockerPath, ["volume", "rm", "--force", broker.capabilityVolume]);
}

const command = process.argv[2];
if (command === "probe-broker") {
  const [, , , dockerPath, imageDigest, containerName] = process.argv;
  try {
    if (
      dockerPath === undefined
      || imageDigest === undefined
      || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest)
      || containerName === undefined
      || !SAFE_NAME.test(containerName)
    ) throw new Error("invalid broker probe input");
    const connection = readConnection(process.env.JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR);
    const broker = setupBroker(dockerPath, [], containerName, imageDigest, connection, true);
    if (broker === undefined) throw new Error("broker probe did not start");
    cleanupBroker(dockerPath, broker);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    process.stderr.write(`OCI credential broker preflight failed: ${detail}\n`);
    process.exitCode = 1;
  }
} else {
  async function runWorker() {
    const sandboxMode = command === "sandbox";
    const runtimeArgs = process.argv.slice(sandboxMode ? 3 : 2);
    const [dockerPath, maybeSandboxImage, ...remainingArgs] = runtimeArgs;
    const sandboxImageDigest = sandboxMode ? maybeSandboxImage : undefined;
    const dockerArgs = sandboxMode ? remainingArgs : [maybeSandboxImage, ...remainingArgs];
    if (
      dockerPath === undefined
      || dockerArgs[0] !== "run"
      || (sandboxMode && (sandboxImageDigest === undefined || !/^sha256:[a-f0-9]{64}$/u.test(sandboxImageDigest)))
    ) {
      process.stderr.write("usage: oci-runner.mjs [sandbox] <docker> [sandbox-image] run <args...>\n");
      process.exitCode = 2;
      return;
    }
    const nameArg = dockerArgs.find((argument) => argument.startsWith("--name="));
    const containerName = nameArg?.slice("--name=".length);
    const imageDigest = dockerArgs.find((argument) => /^sha256:[a-f0-9]{64}$/u.test(argument));
    if (containerName === undefined || !SAFE_NAME.test(containerName) || imageDigest === undefined) {
      process.stderr.write("OCI runner requires exact container and image identities\n");
      process.exitCode = 2;
      return;
    }

    const terminationSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
    let terminating = false;
    let settled = false;
    let terminationSignal;
    let broker;
    let sandboxController;
    let child;
    let cleanupChain = Promise.resolve();
    let terminationPromise;
    let settleChild;
    const childSettled = new Promise((resolvePromise) => {
      settleChild = resolvePromise;
    });

    const cleanup = () => {
      cleanupChain = cleanupChain.then(async () => {
        await removeWorkerContainer(dockerPath, containerName);
        if (broker !== undefined) cleanupBroker(dockerPath, broker);
        await sandboxController?.cleanup();
      });
      return cleanupChain;
    };
    const finishTermination = () => {
      terminationPromise ??= (async () => {
        if (child !== undefined && !settled) {
          await Promise.race([childSettled, delay(5_000)]);
          if (!settled) {
            child.kill("SIGKILL");
            await Promise.race([childSettled, delay(5_000)]);
          }
        }
        await cleanup();
        for (const signal of terminationSignals) process.removeAllListeners(signal);
        process.kill(process.pid, terminationSignal ?? "SIGTERM");
      })();
      return terminationPromise;
    };
    const terminate = (signal) => {
      if (terminating || settled) return;
      terminating = true;
      terminationSignal = signal;
      child?.kill(signal);
      void finishTermination();
    };

    for (const signal of terminationSignals) process.on(signal, () => terminate(signal));

    try {
      const connection = readConnection(process.env.JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR);
      broker = setupBroker(dockerPath, dockerArgs, containerName, imageDigest, connection);
      if (sandboxMode) {
        sandboxController = createSandboxController({
          dockerPath,
          imageDigest: sandboxImageDigest,
          containerPrefix: containerName,
        });
        const imageIndex = dockerArgs.lastIndexOf(imageDigest);
        if (imageIndex < 1) throw new Error("worker image identity is missing");
        dockerArgs.splice(imageIndex, 0, "--env=JINN_INSPECT_SANDBOX_PROTOCOL=1");
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "unknown failure";
      process.stderr.write(`OCI runtime preflight failed: ${detail}\n`);
      await cleanup();
      for (const signal of terminationSignals) process.removeAllListeners(signal);
      process.exitCode = 1;
      return;
    }

    child = spawn(dockerPath, dockerArgs, {
      stdio: sandboxMode ? ["pipe", "pipe", "inherit"] : "inherit",
      env: dockerEnvironment,
    });
    let frameBuffer = "";
    let frameChain = Promise.resolve();
    if (sandboxMode) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        frameBuffer += chunk;
        if (Buffer.byteLength(frameBuffer) > 24 * 1024 * 1024) child.kill("SIGKILL");
        while (frameBuffer.includes("\n")) {
          const newline = frameBuffer.indexOf("\n");
          const line = frameBuffer.slice(0, newline);
          frameBuffer = frameBuffer.slice(newline + 1);
          frameChain = frameChain.then(async () => {
            const frame = JSON.parse(line);
            if (frame?.channel === "sandbox") {
              const response = await sandboxController.handle(frame);
              child.stdin.write(`${JSON.stringify(response)}\n`);
            } else if (typeof frame?.ok === "boolean") {
              process.stdout.write(`${JSON.stringify(frame)}\n`);
            } else {
              throw new Error("worker emitted an unknown protocol frame");
            }
          }).catch(() => child.kill("SIGKILL"));
        }
      });
    }
    child.once("error", (error) => {
      settled = true;
      settleChild();
      void cleanup();
      if (terminating) {
        void finishTermination();
        return;
      }
      for (const signal of terminationSignals) process.removeAllListeners(signal);
      process.stderr.write(`OCI runtime could not start: ${error instanceof Error ? error.name : "unknown error"}\n`);
      process.exitCode = 1;
    });
    child.once("exit", async (code, signal) => {
      settled = true;
      settleChild();
      await frameChain;
      await cleanup();
      if (terminating) {
        await finishTermination();
        return;
      }
      for (const terminationSignalName of terminationSignals) process.removeAllListeners(terminationSignalName);
      if (signal !== null) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }
  await runWorker();
}
