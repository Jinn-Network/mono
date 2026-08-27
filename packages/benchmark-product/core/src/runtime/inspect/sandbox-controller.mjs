import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const SANDBOX_PROTOCOL = "jinn.network/inspect-sandbox-host/1";
export const SANDBOX_POLICY = Object.freeze({
  provider: "jinn-oci",
  platform: "linux/amd64",
  user: "65532:65532",
  readOnlyRoot: true,
  network: "none",
  capabilities: [],
  noNewPrivileges: true,
  cpuCount: 1,
  memoryBytes: 536_870_912,
  pidsLimit: 32,
  scratchBytes: 268_435_456,
  maxEnvironments: 1,
  maxOperations: 64,
  commandTimeoutSeconds: 30,
  totalTimeoutSeconds: 120,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 20 * 1024 * 1024,
  maxReadFileBytes: 100 * 1024 * 1024,
});

export function sandboxPolicySha256() {
  return createHash("sha256").update(JSON.stringify(SANDBOX_POLICY)).digest("hex");
}

function safeName(value) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(value)) throw new Error("invalid sandbox container identity");
  return value;
}

function processError(kind) {
  return { kind };
}

/**
 * The caller's own temp directory, for the `docker` CLI this module drives: it writes build context
 * and export scratch there, and with no temp variable in the allowlist it falls back to the
 * platform default and escapes whatever root the caller was confined to. Duplicated from
 * `child-temp-env.ts` rather than imported because this file is plain JavaScript, spawned as its
 * own script, and cannot load a TypeScript module.
 */
function inheritedTempEnv() {
  const inherited = {};
  for (const name of ["TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) inherited[name] = value;
  }
  return inherited;
}

function boundedProcess(executable, args, options = {}) {
  const { input, timeout = 30_000, maxBytes = SANDBOX_POLICY.maxOutputBytes, children } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...inheritedTempEnv(), LANG: "C.UTF-8" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    children?.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) child.kill("SIGKILL");
      else stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      children?.delete(child);
      resolve({
        code: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        overflow: stdoutBytes > maxBytes || stderrBytes > maxBytes,
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function text(buffer) {
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw processError("validation");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw processError("validation");
  return decoded;
}

export function createSandboxController({ dockerPath, imageDigest, containerPrefix, runProcess = boundedProcess }) {
  const children = new Set();
  let containerName;
  let environmentId;
  let environments = 0;
  let operations = 0;
  let startedAt;
  let closed = false;

  async function docker(args, options = {}) {
    return runProcess(dockerPath, args, { ...options, children });
  }

  function assertLive(params) {
    if (closed || containerName === undefined || params.environmentId !== environmentId) {
      throw processError("not-found");
    }
    operations += 1;
    if (operations > SANDBOX_POLICY.maxOperations) throw processError("budget");
    if (Date.now() - startedAt > SANDBOX_POLICY.totalTimeoutSeconds * 1000) throw processError("timeout");
  }

  async function removeContainer() {
    if (containerName === undefined) return;
    const name = containerName;
    containerName = undefined;
    environmentId = undefined;
    await docker(["rm", "--force", name], { timeout: 15_000, maxBytes: 1_000_000 });
  }

  async function startSample(params) {
    if (closed || containerName !== undefined || environments >= SANDBOX_POLICY.maxEnvironments) throw processError("budget");
    const config = params.config;
    if (
      config?.schema !== "jinn.network/benchmark-product/inspect-sandbox/1"
      || config?.imageDigest !== imageDigest
      || config?.platform !== SANDBOX_POLICY.platform
      || config?.policySha256 !== sandboxPolicySha256()
    ) throw processError("conflict");
    const suffix = createHash("sha256")
      .update(`${String(params.taskName)}\0${String(params.sampleId)}`)
      .digest("hex")
      .slice(0, 18);
    containerName = safeName(`${containerPrefix}-sandbox-${suffix}`);
    environmentId = createHash("sha256").update(`${containerName}\0${Date.now()}`).digest("hex");
    environments += 1;
    startedAt = Date.now();
    const result = await docker([
      "run", "--detach", "--pull=never", `--platform=${SANDBOX_POLICY.platform}`,
      `--name=${containerName}`, `--hostname=${containerName}`,
      `--user=${SANDBOX_POLICY.user}`, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--network=none", "--ipc=none",
      `--pids-limit=${SANDBOX_POLICY.pidsLimit}`, `--memory=${SANDBOX_POLICY.memoryBytes}`,
      `--cpus=${SANDBOX_POLICY.cpuCount}`, "--ulimit=nofile=1024:1024",
      `--tmpfs=/tmp:rw,nosuid,nodev,size=${SANDBOX_POLICY.scratchBytes}`,
      `--tmpfs=/workspace:rw,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=${SANDBOX_POLICY.scratchBytes}`,
      "--workdir=/workspace", "--env=HOME=/tmp/home", "--env=LANG=C.UTF-8",
      "--entrypoint=python", imageDigest, "-c", "import time; time.sleep(86400)",
    ], { timeout: 30_000, maxBytes: 1_000_000 });
    if (result.code !== 0) {
      await removeContainer();
      throw processError("unavailable");
    }
    return { environmentId, workingDir: "/workspace" };
  }

  async function exec(params) {
    assertLive(params);
    if (!Array.isArray(params.cmd) || params.cmd.length === 0 || params.cmd.some((value) => typeof value !== "string" || value.length === 0)) {
      throw processError("validation");
    }
    if (params.user !== null && params.user !== undefined && params.user !== SANDBOX_POLICY.user && params.user !== "65532") {
      throw processError("permission");
    }
    const timeoutSeconds = params.timeoutSeconds === null || params.timeoutSeconds === undefined
      ? SANDBOX_POLICY.commandTimeoutSeconds
      : Number(params.timeoutSeconds);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > SANDBOX_POLICY.commandTimeoutSeconds) {
      throw processError("budget");
    }
    const input = params.inputBase64 === null || params.inputBase64 === undefined
      ? undefined
      : decodeBase64(params.inputBase64);
    if (input !== undefined && input.length > SANDBOX_POLICY.maxInputBytes) throw processError("budget");
    const args = ["exec", "--workdir", typeof params.cwd === "string" ? params.cwd : "/workspace"];
    const env = params.env ?? {};
    if (typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 64) throw processError("validation");
    for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.length > 16_384) throw processError("validation");
      args.push("--env", `${key}=${value}`);
    }
    if (input !== undefined) args.push("--interactive");
    args.push(containerName, ...params.cmd);
    const result = await docker(args, {
      input,
      timeout: timeoutSeconds * 1000,
      maxBytes: SANDBOX_POLICY.maxOutputBytes,
    });
    if (result.timedOut) {
      await removeContainer();
      throw processError("timeout");
    }
    if (result.overflow) {
      await removeContainer();
      throw processError("budget");
    }
    return { returncode: result.code, stdout: text(result.stdout), stderr: text(result.stderr) };
  }

  async function writeFile(params) {
    assertLive(params);
    if (typeof params.path !== "string" || params.path.length === 0 || typeof params.contentsBase64 !== "string") {
      throw processError("validation");
    }
    const contents = decodeBase64(params.contentsBase64);
    if (contents.length > SANDBOX_POLICY.maxInputBytes) throw processError("budget");
    const script = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())";
    const result = await docker([
      "exec", "--interactive", "--workdir", "/workspace", containerName,
      "python", "-c", script, params.path,
    ], { input: contents, timeout: 30_000, maxBytes: 1_000_000 });
    if (result.code !== 0) throw processError("permission");
    return {};
  }

  async function readFile(params) {
    assertLive(params);
    if (typeof params.path !== "string" || params.path.length === 0) throw processError("validation");
    const script = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); sys.exit(3) if p.is_dir() else sys.stdout.buffer.write(p.read_bytes())";
    const result = await docker([
      "exec", "--workdir", "/workspace", containerName, "python", "-c", script, params.path,
    ], { timeout: 30_000, maxBytes: SANDBOX_POLICY.maxReadFileBytes });
    if (result.overflow) throw processError("budget");
    if (result.code === 3) throw processError("is-directory");
    if (result.code !== 0) throw processError("not-found");
    return { contentsBase64: result.stdout.toString("base64") };
  }

  async function finishSample(params) {
    assertLive(params);
    await removeContainer();
    return {};
  }

  return {
    async handle(frame) {
      if (
        frame?.channel !== "sandbox"
        || frame?.protocol !== SANDBOX_PROTOCOL
        || typeof frame?.id !== "string"
        || typeof frame?.operation !== "string"
        || frame?.params === null
        || typeof frame?.params !== "object"
        || Array.isArray(frame?.params)
      ) throw new Error("invalid sandbox protocol frame");
      try {
        let value;
        if (frame.operation === "startSample") value = await startSample(frame.params);
        else if (frame.operation === "exec") value = await exec(frame.params);
        else if (frame.operation === "writeFile") value = await writeFile(frame.params);
        else if (frame.operation === "readFile") value = await readFile(frame.params);
        else if (frame.operation === "finishSample") value = await finishSample(frame.params);
        else throw processError("unsupported");
        return { channel: "sandbox-response", protocol: SANDBOX_PROTOCOL, id: frame.id, ok: true, value };
      } catch (cause) {
        const kind = typeof cause?.kind === "string" ? cause.kind : "unavailable";
        return { channel: "sandbox-response", protocol: SANDBOX_PROTOCOL, id: frame.id, ok: false, error: { kind } };
      }
    },
    async cleanup() {
      closed = true;
      for (const child of children) child.kill("SIGKILL");
      await removeContainer();
    },
  };
}
