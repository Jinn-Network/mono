import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const runnerPath = fileURLToPath(new URL("./oci-runner.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A stand-in for the `docker` CLI. It records every invocation and, for `run`, refuses SIGTERM and
 * stays alive so the runner has to walk its full termination ladder. The runner passes an allowlist
 * environment (`dockerEnvironment`) to every docker call, so both the interpreter and the log path
 * are baked into the script rather than read from variables the runner would strip.
 */
function writeFakeDocker(directory: string): { dockerPath: string; logPath: string } {
  const dockerPath = join(directory, "docker");
  const logPath = join(directory, "calls.log");
  writeFileSync(dockerPath, [
    // An absolute interpreter, not `/usr/bin/env node`: the runner's allowlist environment
    // carries no PATH, so `env` would have nothing to resolve `node` against.
    `#!${process.execPath}`,
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(logPath)}, String(Date.now()) + '\\t' + args.join(' ') + '\\n');`,
    "if (args[0] === 'run') {",
    "  process.on('SIGTERM', () => {});",
    "  setInterval(() => {}, 1000);",
    "} else if (args[0] === 'container' && args[1] === 'inspect') {",
    // Report the container absent so the reap's two-consecutive-absent rule settles promptly.
    "  process.exit(1);",
    "}",
  ].join("\n"), { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  return { dockerPath, logPath };
}

function readCalls(logPath: string): { at: number; argv: string }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "").map((line) => {
    const [at, argv] = line.split("\t");
    return { at: Number(at), argv: argv ?? "" };
  });
}

/**
 * Regression for the orphaned worker container the OCI cancellation integration test observes: the
 * cancellation ladder above this process SIGTERMs the harness group, waits a grace (10s by
 * default), then SIGKILLs it, so a reap that runs only after the runner has waited out its own
 * client-exit ladder (5s, then SIGKILL, then 5s more) can lose that race and leave a `--rm`
 * container with nobody to remove it. The reap must be issued immediately on the termination
 * signal, well inside the grace, and not be gated behind the wait.
 */
test("termination reaps the worker container before waiting out the docker client", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-runner-cancel-"));
  temporaryDirectories.push(directory);
  const { dockerPath, logPath } = writeFakeDocker(directory);
  const containerName = "jinn-inspect-cancel-fixture";
  const runner = spawn(process.execPath, [
    runnerPath,
    dockerPath,
    "run", "--rm", `--name=${containerName}`,
    `sha256:${"a".repeat(64)}`,
    "/jinn/input/inspect-probe.json",
  ], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => { runner.once("exit", () => { resolve(); }); });

  await waitUntil(() => readCalls(logPath).some((call) => call.argv.startsWith("run ")), "the docker client to start");
  const terminatedAt = Date.now();
  runner.kill("SIGTERM");

  await waitUntil(
    () => readCalls(logPath).some((call) => call.argv === `rm --force ${containerName}`),
    "the worker container reap",
  );
  const reapedAt = readCalls(logPath).find((call) => call.argv === `rm --force ${containerName}`)?.at ?? Number.NaN;
  // The runner's own client-exit ladder cannot complete in under 5s, so a reap inside this window
  // proves it was not sequenced behind that ladder.
  expect(reapedAt - terminatedAt).toBeLessThan(2_500);

  await exited;
}, 30_000);

/**
 * A stand-in for the `docker` CLI whose `run` writes one protocol frame to stdout and exits 0
 * without terminating it with a newline -- the shape a stdout truncated on its way through a
 * loaded Docker Engine leaves behind, and the shape the relay used to drop.
 */
function writeUnterminatedFrameDocker(directory: string, frame: string): string {
  const dockerPath = join(directory, "docker");
  writeFileSync(dockerPath, [
    `#!${process.execPath}`,
    "const args = process.argv.slice(2);",
    "if (args[0] === 'run') {",
    `  process.stdout.write(${JSON.stringify(frame)});`,
    "} else if (args[0] === 'container' && args[1] === 'inspect') {",
    // Report the container absent so the reap's two-consecutive-absent rule settles promptly.
    "  process.exit(1);",
    "}",
  ].join("\n"), { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  return dockerPath;
}

/**
 * Regression for #2832's second failure mode (#3720). The sandbox relay emitted a frame only when
 * it saw a newline and settled on the client's `exit` event, so a final chunk the worker did not
 * terminate was dropped and this runner still exited 0 having written nothing. Its caller
 * (`probeInspectOciSelection` / `assertInspectOciHostUndrifted` in `oci.ts`) then parsed an empty
 * stdout, and V8's `Unexpected end of JSON input` reached the operator as `venue-unavailable` at
 * path `venue` with no subject at all -- which is exactly what CI run 33686563879 recorded.
 */
test("the sandbox relay emits a final frame the worker did not newline-terminate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-runner-relay-"));
  temporaryDirectories.push(directory);
  const frame = '{"ok":true,"value":{"runtime":{},"task":{}}}';
  const dockerPath = writeUnterminatedFrameDocker(directory, frame);
  const runner = spawn(process.execPath, [
    runnerPath,
    "sandbox",
    dockerPath,
    `sha256:${"b".repeat(64)}`,
    "run", "--rm", "--name=jinn-inspect-relay-fixture", "--network=none",
    `sha256:${"a".repeat(64)}`,
    "/jinn/input/inspect-probe.json",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  runner.stdout.setEncoding("utf8");
  runner.stdout.on("data", (chunk: string) => { stdout += chunk; });
  const code = await new Promise<number | null>((resolve) => {
    runner.once("exit", (exitCode) => { resolve(exitCode); });
  });

  expect({ code, stdout }).toEqual({ code: 0, stdout: `${frame}\n` });
}, 30_000);

/**
 * The companion to the test above. A trailing chunk that is not a whole frame cannot be relayed,
 * and this runner must not then report the worker's silence as success: exiting 0 with an empty
 * stdout is exactly the state that reached the operator as an unattributed
 * `Unexpected end of JSON input`. The in-flight failure path SIGKILLs the client, which says
 * nothing once the client has already exited, so the final flush needs its own exit code.
 */
test("a final frame the relay cannot parse fails the runner instead of exiting 0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jinn-oci-runner-truncated-"));
  temporaryDirectories.push(directory);
  const truncatedFrame = '{"ok":true,"value":{"runt';
  const dockerPath = writeUnterminatedFrameDocker(directory, truncatedFrame);
  const runner = spawn(process.execPath, [
    runnerPath,
    "sandbox",
    dockerPath,
    `sha256:${"b".repeat(64)}`,
    "run", "--rm", "--name=jinn-inspect-truncated-fixture", "--network=none",
    `sha256:${"a".repeat(64)}`,
    "/jinn/input/inspect-probe.json",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  runner.stdout.setEncoding("utf8");
  runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", (chunk: string) => { stdout += chunk; });
  runner.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => {
    runner.once("exit", (exitCode) => { resolve(exitCode); });
  });

  expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
  expect(stderr).toContain("could not relay a worker protocol frame");
  // The frame is never echoed: only stdout is contractually the bounded machine envelope. Assert
  // on the frame's own bytes rather than a prefix of them -- this runner's other stderr lines say
  // "OCI runtime ...", so a substring of the truncated `"runtime"` key would collide with them and
  // report an unrelated preflight failure as a leaked frame.
  expect(stderr).not.toContain(truncatedFrame);
}, 30_000);
