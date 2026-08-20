import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const imageDigest = process.env.JINN_INSPECT_OCI_IMAGE;
const dockerPath = process.env.JINN_DOCKER_PATH ?? "/usr/local/bin/docker";

// This probe exercises the "reasoning-2026-08" judge-model profile (spec §1.1): the model literal
// and the 128-token cap below are that profile's frozen shape, byte-unchanged from before the
// profile widening, not an unwidened leftover. The "dated-snapshot-sampling" profile has its own
// probe below.
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
# A dated-snapshot model is a real, accepted model, but the sealed selection manifest requires one
# generation shape per profile (spec §1.3): a reasoning generation block on it must still refuse.
refused(lambda value: value.update(model="gpt-4o-mini-2024-07-18"), ValueError)

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

// This probe exercises the "dated-snapshot-sampling" judge-model profile (spec §1.1/§1.3),
// parallel to the reasoning-profile probe above, over both broker.py and binary_judge_worker.py:
// a temperature-0/512-token sampling request is accepted; a reasoning-shaped generation block on
// the dated snapshot is refused; and the emitted observation carries the empty limitations tuple
// with matching requested/resolved models (spec §1.4), unlike the reasoning profile's alias tuple.
const datedSnapshotProbe = String.raw`
import copy
import sys
sys.path.insert(0, "/opt/jinn")
import broker
import binary_judge_worker as judge_worker

capability = "capability-for-one-attempt"
request = {
  "operation": "jinn.network/model-broker/1:generateText",
  "correlationId": "cell/attempt/call-1",
  "capability": capability,
  "model": "gpt-4o-mini-2024-07-18",
  "messages": [{"role": "developer", "text": "Return one letter."}, {"role": "user", "text": "C"}],
  "generation": {
    "temperature": 0,
    "maxOutputTokens": 512,
    "store": False,
    "background": False,
    "stream": False,
    "serviceTier": "default",
  },
}
assert broker.validate_request(request, capability) == request

def refused(mutator, error=ValueError):
  candidate = copy.deepcopy(request)
  mutator(candidate)
  try:
    broker.validate_request(candidate, capability)
  except error:
    return
  raise AssertionError("broker accepted an out-of-contract dated-snapshot request")

refused(lambda value: value["generation"].update(maxOutputTokens=128))
# isinstance(True, int) is True in Python: a bare bool must not pass as the literal integer 0.
refused(lambda value: value["generation"].update(temperature=False))
refused(lambda value: value["generation"].update(temperature=0.0))
refused(lambda value: value["generation"].update(temperature=1))
def to_reasoning_shape(value):
  generation = value["generation"]
  del generation["temperature"]
  generation["reasoningEffort"] = "none"
  generation["maxOutputTokens"] = 128
refused(to_reasoning_shape)

semantic_request = {
  "model": "gpt-4o-mini-2024-07-18",
  "messages": [{"role": "developer", "text": "Return one letter."}, {"role": "user", "text": "C"}],
  "generation": {
    "temperature": 0,
    "maxOutputTokens": 512,
    "store": False,
    "background": False,
    "stream": False,
    "serviceTier": "default",
    "tools": [],
    "fallbackModels": [],
    "retries": 0,
    "persistedConversation": False,
    "metadata": None,
    "promptCacheIdentifier": None,
  },
}
assert judge_worker.validate_semantic_request(semantic_request) == semantic_request

def semantic_refused(mutator, error=ValueError):
  candidate = copy.deepcopy(semantic_request)
  mutator(candidate)
  try:
    judge_worker.validate_semantic_request(candidate)
  except error:
    return
  raise AssertionError("worker accepted an out-of-contract dated-snapshot semantic request")

def semantic_to_reasoning_shape(value):
  generation = value["generation"]
  del generation["temperature"]
  generation["reasoningEffort"] = "none"
  generation["maxOutputTokens"] = 128
semantic_refused(semantic_to_reasoning_shape)
semantic_refused(lambda value: value["generation"].update(temperature=False))
semantic_refused(lambda value: value["generation"].update(maxOutputTokens=128))

judge_config = {
  "taskDigest": "sha256:" + "1" * 64,
  "armId": "dated-alpha",
  "replicate": 1,
  "instrumentSha256": "sha256:" + "2" * 64,
  "requestSha256": "sha256:" + "3" * 64,
}
dated_record = {
  "status": "completed",
  "resolvedModel": "gpt-4o-mini-2024-07-18",
  "responseId": "resp_dated_snapshot",
  "eventDigest": "4" * 64,
  "usage": {"input_tokens": 11, "output_tokens": 2, "total_tokens": 13},
}
dated_observation = judge_worker.build_observation(judge_config, b"ACCEPT", dated_record)
assert dated_observation["limitations"] == [], dated_observation
assert dated_observation["provider"]["requestedModel"] == "gpt-4o-mini-2024-07-18"
assert dated_observation["provider"]["resolvedModel"] == "gpt-4o-mini-2024-07-18"

# Parallel reasoning-profile coverage: the alias limitation is still emitted, and is a real claim
# about an undated model id rather than the decorative disclosure it would be on a dated snapshot.
reasoning_record = {**dated_record, "resolvedModel": "gpt-5.6-luna"}
reasoning_observation = judge_worker.build_observation(judge_config, b"ACCEPT", reasoning_record)
assert reasoning_observation["limitations"] == ["mutable-model-alias"], reasoning_observation
assert reasoning_observation["provider"]["requestedModel"] == "gpt-5.6-luna"
assert reasoning_observation["provider"]["resolvedModel"] == "gpt-5.6-luna"

try:
  judge_worker.build_observation(judge_config, b"ACCEPT", {**dated_record, "resolvedModel": "unlisted-model"})
except ValueError:
  pass
else:
  raise AssertionError("worker accepted an unlisted resolvedModel")

print("dated-snapshot-conformance-ok")
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

  test("accepts the dated-snapshot-sampling profile and refuses cross-profile generation blocks", () => {
    const output = execFileSync(dockerPath, [
      "run", "--rm", "--pull=never", "--platform=linux/amd64", "--network=none",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--entrypoint=python", imageDigest!, "-c", datedSnapshotProbe,
    ], { encoding: "utf8" });
    expect(output.trim()).toBe("dated-snapshot-conformance-ok");
  }, 30_000);

  test("runs verifier operations without a broker, credential descriptor, or network", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "jinn-inspect-verify-boundary-")));
    const inputDir = join(root, "input");
    const name = `jinn-inspect-verify-boundary-${process.pid}`;
    mkdirSync(inputDir);
    writeFileSync(join(inputDir, "inspect-verify.json"), "{}", { mode: 0o400 });
    const runner = fileURLToPath(new URL("./oci-runner.mjs", import.meta.url));
    try {
      const result = spawnSync(process.execPath, [
        runner, dockerPath, "run", "--rm", "--pull=never", "--platform=linux/amd64",
        `--name=${name}`, "--network=none", "--read-only", "--cap-drop=ALL",
        "--mount", `type=bind,src=${inputDir},dst=/jinn/input,readonly`,
        "--entrypoint=python", imageDigest!, "-c", "print('verify-boundary-ok')",
        "/jinn/input/inspect-verify.json",
      ], { encoding: "utf8", env: { LANG: "C.UTF-8" } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("verify-boundary-ok");
      const containers = execFileSync(dockerPath, ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
      const networks = execFileSync(dockerPath, ["network", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
      const volumes = execFileSync(dockerPath, ["volume", "ls", "--filter", `name=${name}`, "--format", "{{.Name}}"], { encoding: "utf8" }).trim();
      expect({ containers, networks, volumes }).toEqual({ containers: "", networks: "", volumes: "" });
    } finally {
      spawnSync(dockerPath, ["rm", "--force", name], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
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
