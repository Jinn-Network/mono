import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const imageDigest = process.env.JINN_INSPECT_OCI_IMAGE;
const dockerPath = process.env.JINN_DOCKER_PATH ?? "/usr/local/bin/docker";

const contractProbe = String.raw`
import copy
import httpx
import sys
import threading
sys.path.insert(0, "/opt/jinn")
import broker
from openai import AuthenticationError, RateLimitError, APITimeoutError, APIConnectionError, APIStatusError

capability = "capability-for-one-attempt"
request = {
  "operation": "jinn.network/model-broker/1:generateText",
  "correlationId": "cell/attempt/call-1",
  "capability": capability,
  "model": "gpt-5.6-luna",
  "messages": [{"role": "developer", "text": "Return one letter."}, {"role": "user", "text": "C"}],
  "generation": {
    "reasoningEffort": "none",
    "maxOutputTokens": 128,
    "store": False,
    "background": False,
    "stream": False,
    "serviceTier": "default",
  },
}
assert broker.validate_request(request, capability) == request

def refused(mutator, error):
  candidate = copy.deepcopy(request)
  mutator(candidate)
  try:
    broker.validate_request(candidate, capability)
  except error:
    return
  raise AssertionError("broker accepted an out-of-contract request")

refused(lambda value: value.update(capability="another-cell"), PermissionError)
refused(lambda value: value.update(model="another-model"), ValueError)
refused(lambda value: value.update(tools=[]), ValueError)
refused(lambda value: value["messages"].append({"role": "assistant", "text": "history"}), ValueError)
refused(lambda value: value["messages"][0].update(text="x" * (broker.MAX_INPUT_BYTES + 1)), ValueError)
refused(lambda value: value["generation"].update(maxOutputTokens=129), ValueError)
refused(lambda value: value["generation"].update(stream=True), ValueError)

class RaisingResponses:
  def __init__(self, error): self.error = error
  def create(self, **_kwargs): raise self.error
class Client:
  def __init__(self, error): self.responses = RaisingResponses(error)

http_request = httpx.Request("POST", "https://api.openai.com/v1/responses")
def status_for(error):
  state = broker.BrokerState.__new__(broker.BrokerState)
  state.lock = threading.Lock()
  state.call_count = 0
  state.fake_response = None
  state.client = Client(error)
  return state.generate(request)["status"]

def response(status): return httpx.Response(status, request=http_request)
assert status_for(AuthenticationError("auth", response=response(401), body=None)) == "authentication-failure"
assert status_for(RateLimitError("rate", response=response(429), body=None)) == "rate-limited"
assert status_for(APITimeoutError(http_request)) == "timeout"
assert status_for(APIConnectionError(request=http_request)) == "broker-loss"
assert status_for(APIStatusError("upstream", response=response(503), body=None)) == "provider-5xx"

state = broker.BrokerState.__new__(broker.BrokerState)
state.lock = threading.Lock()
state.call_count = 0
state.fake_response = {"model": "gpt-5.6-luna", "status": "completed"}
state.client = None
assert state.generate(request)["status"] == "method-conflict"
assert state.generate(request)["status"] == "budget-rejected"
print("broker-v1-conformance-ok")
`;

describe.skipIf(imageDigest === undefined)("trusted broker contract", () => {
  test("rejects capability/config abuse and maps provider failures without network", () => {
    const output = execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--entrypoint=python", imageDigest!, "-c", contractProbe,
    ], { encoding: "utf8" });
    expect(output.trim()).toBe("broker-v1-conformance-ok");
  }, 30_000);

  test("cancellation reaps the worker, broker, private network, and secret volumes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "jinn-broker-cancel-")));
    const keyPath = join(root, "key");
    const descriptorPath = join(root, "connection.json");
    const inputDir = join(root, "input");
    const outputDir = join(root, "output");
    const name = `jinn-inspect-broker-cancel-${process.pid}`;
    mkdirSync(inputDir);
    mkdirSync(outputDir);
    writeFileSync(keyPath, "sk-test-cancel-sentinel", { mode: 0o400 });
    chmodSync(keyPath, 0o400);
    const stat = statSync(keyPath);
    writeFileSync(descriptorPath, JSON.stringify({
      schema: "jinn.network/benchmark-product/host-connection/1",
      openAIKeyFile: keyPath,
      metadata: { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, size: stat.size, uid: stat.uid },
    }), { mode: 0o600 });
    writeFileSync(join(inputDir, "inspect-run.json"), JSON.stringify({ arm: { provider: { surface: "openai-responses" } } }));
    const runner = fileURLToPath(new URL("./oci-runner.mjs", import.meta.url));
    const child = spawn(process.execPath, [
      runner, dockerPath, "run", "--rm", "--pull=never", "--platform=linux/amd64",
      `--name=${name}`, "--network=none",
      "--mount", `type=bind,src=${inputDir},dst=/jinn/input,readonly`,
      "--mount", `type=bind,src=${outputDir},dst=/jinn/output`,
      "--entrypoint=python", imageDigest!, "-c", "import time; time.sleep(120)",
    ], {
      stdio: "ignore",
      env: { LANG: "C.UTF-8", JINN_INSPECT_HOST_CONNECTION_DESCRIPTOR: descriptorPath },
    });
    expect(child.spawnargs.join(" ")).not.toContain(keyPath);
    try {
      let running = false;
      for (let attempt = 0; attempt < 80 && !running; attempt += 1) {
        const names = execFileSync(dockerPath, ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
        running = names.split("\n").includes(name) && names.split("\n").includes(`${name}-broker`);
        if (!running) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(running).toBe(true);
      const metadata = execFileSync(dockerPath, ["inspect", name, `${name}-broker`], { encoding: "utf8" });
      expect(metadata).not.toContain(keyPath);
      const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const containers = execFileSync(dockerPath, ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
      const networks = execFileSync(dockerPath, ["network", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
      const volumes = execFileSync(dockerPath, ["volume", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
      expect({ containers, networks, volumes }).toEqual({ containers: "", networks: "", volumes: "" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      spawnSync(dockerPath, ["rm", "--force", name, `${name}-broker`], { stdio: "ignore" });
      spawnSync(dockerPath, ["network", "rm", `${name}-net`], { stdio: "ignore" });
      spawnSync(dockerPath, ["volume", "rm", "--force", `${name}-credential`, `${name}-capability`], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
