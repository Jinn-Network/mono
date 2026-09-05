// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CONTROLLED_INPUT_MAX_BYTES } from "../src/feed.mjs";
import {
  CONTROLLED_INPUT_SELECTION_RULE,
  EXECUTOR_IRI_PREFIX,
  HOST_NAME,
  PRODUCER_IRI,
  deriveModelService,
  effectiveCaptureConfig,
  executorIri,
  hostVersion,
  modelIdentity,
  readWorkflowInstruction,
} from "../src/identity.mjs";
import { temp } from "./helpers.mjs";

test("the executor identity is a constant, so no host string can move it", () => {
  assert.equal(executorIri(), `${EXECUTOR_IRI_PREFIX}/claude-code`);
  assert.equal(HOST_NAME, "claude-code");
});

test("the host version is read from the versioned executable or reported unknown", () => {
  assert.equal(hostVersion({ CLAUDE_CODE_EXECPATH: "/a/versions/2.1.258" }), "2.1.258");
  assert.equal(hostVersion({ CLAUDE_CODE_VERSION: "3.0.0-rc.1" }), "3.0.0-rc.1");
  assert.equal(hostVersion({ CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude" }), "unknown");
  assert.equal(hostVersion({}), "unknown");
});

test("the model is read from the host's own model environment", () => {
  assert.deepEqual(modelIdentity({ ANTHROPIC_MODEL: "claude-opus-5" }), {
    provider: "anthropic",
    name: "claude-opus-5",
    service: {
      iri: "https://spec.jinn.network/services/anthropic/claude-opus-5",
      name: "anthropic claude-opus-5",
    },
  });
  assert.equal(
    modelIdentity({ ANTHROPIC_MODEL: "opus", CLAUDE_CODE_USE_BEDROCK: "1" }).provider,
    "bedrock",
  );
  assert.equal(
    modelIdentity({ ANTHROPIC_MODEL: "opus", CLAUDE_CODE_USE_VERTEX: "true" }).provider,
    "vertex",
  );
  assert.equal(
    modelIdentity({ ANTHROPIC_MODEL: "opus", CLAUDE_CODE_USE_BEDROCK: "0" }).provider,
    "anthropic",
  );
});

test("a gateway base URL names the provider, and the anthropic default does not", () => {
  assert.equal(
    modelIdentity({ ANTHROPIC_MODEL: "opus", ANTHROPIC_BASE_URL: "https://gw.example.test" })
      .provider,
    "gw.example.test",
  );
  const direct = modelIdentity({
    ANTHROPIC_MODEL: "opus",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  });
  assert.equal(direct.provider, "anthropic");
  assert.equal(direct.service.deployment, "api.anthropic.com");
  assert.equal(
    modelIdentity({ ANTHROPIC_MODEL: "opus", ANTHROPIC_BASE_URL: "not a url" }).provider,
    "anthropic",
  );
});

test("an unknowable model still opens the session but names no deployment", () => {
  const identity = modelIdentity({});
  assert.equal(identity.name, "unknown");
  assert.equal(identity.service, undefined);
});

test("a service identity that would collide with the executor or the producer is refused", () => {
  assert.equal(deriveModelService("", "opus"), undefined);
  assert.equal(deriveModelService("anthropic", "  "), undefined);
  // Structurally unreachable through the services prefix; held so a prefix change costs the
  // identity rather than every event in the session.
  assert.notEqual(deriveModelService("anthropic", "opus").iri, executorIri());
  assert.notEqual(deriveModelService("anthropic", "opus").iri, PRODUCER_IRI);
});

test("the effective configuration is deterministic and names its selection rule", () => {
  const argument = {
    model: { provider: "anthropic", name: "opus" },
    host: { name: "claude-code", version: "2.1.258" },
    runtimePin: { package: "@jinn-network/plugin-runtime", version: "0.1.0" },
  };
  const first = new TextDecoder().decode(effectiveCaptureConfig(argument));
  const second = new TextDecoder().decode(effectiveCaptureConfig(argument));
  assert.equal(first, second);
  const document = JSON.parse(first);
  assert.equal(document.selectionRule, CONTROLLED_INPUT_SELECTION_RULE);
  assert.deepEqual(document.runtime, argument.runtimePin);
});

test("the effective configuration carries no path and no environment", () => {
  const raw = new TextDecoder().decode(
    effectiveCaptureConfig({
      model: { provider: "anthropic", name: "opus" },
      host: { name: "claude-code", version: "2.1.258" },
    }),
  );
  assert.equal(JSON.parse(raw).runtime, undefined);
  assert.equal(raw.replace("@jinn-network/plugin-runtime", "").includes("/"), false);
});

test("the project instruction is bound when the host really loads one", () => {
  const cwd = temp();
  writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\n");
  const bound = readWorkflowInstruction(cwd);
  assert.equal(bound.role, "workflow");
  assert.equal(bound.name, "CLAUDE.md");
  assert.equal(bound.mediaType, "text/markdown");
  assert.equal(new TextDecoder().decode(bound.content), "# Rules\n");
});

test("an absent, empty, oversized, or non-file instruction is dropped, never fabricated", () => {
  assert.equal(readWorkflowInstruction(temp()), undefined);
  assert.equal(readWorkflowInstruction(""), undefined);
  assert.equal(readWorkflowInstruction(undefined), undefined);

  const empty = temp();
  writeFileSync(join(empty, "CLAUDE.md"), "");
  assert.equal(readWorkflowInstruction(empty), undefined);

  const oversized = temp();
  writeFileSync(join(oversized, "CLAUDE.md"), "x".repeat(CONTROLLED_INPUT_MAX_BYTES + 1));
  assert.equal(readWorkflowInstruction(oversized), undefined);

  const directory = temp();
  mkdirSync(join(directory, "CLAUDE.md"));
  assert.equal(readWorkflowInstruction(directory), undefined);
});
