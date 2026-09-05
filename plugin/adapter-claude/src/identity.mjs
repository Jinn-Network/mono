// SPDX-License-Identifier: Apache-2.0

/**
 * Who ran this session, on what, and under which instructions.
 *
 * One boundary governs the module: **no host-controlled string may forge or overwrite the
 * executor, producer, task, result, or trace entities.** The host name is a constant, so the
 * executor IRI is fixed. The model service identity is derived by slugging and refused
 * outright when it would collide with the executor or the producer, because the record
 * builder merges on identity and would otherwise seal the claim that the producer provides
 * some other party's model service.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { CONTROLLED_INPUT_MAX_BYTES, FEED_VERSION, canonicalJson } from "./feed.mjs";

/** Constant, never read from the environment: it is what the executor IRI is derived from. */
export const HOST_NAME = "claude-code";
export const ADAPTER_NAME = "jinn-claude-adapter";

/** Mirrors `plugin/runtime/src/capture/identity.ts`; drift there refuses the feed here. */
export const PRODUCER_IRI = "https://spec.jinn.network/software/plugin-runtime";
export const EXECUTOR_IRI_PREFIX = "https://spec.jinn.network/software/agent-host";
export const MODEL_SERVICE_IRI_PREFIX = "https://spec.jinn.network/services";

/**
 * The producer-controlled inputs this host binds, as one auditable identifier. A verifier
 * reading a sealed record needs to know which rule selected the artifacts it is looking at,
 * and a rule that changes what it binds must change its version rather than its meaning.
 */
export const CONTROLLED_INPUT_SELECTION_RULE = "prompt+config+workflow@1";

export const PROMPT_INPUT_NAME = "initial-user-prompt.md";
export const CONFIG_INPUT_NAME = "effective-capture-config.json";
/** Claude Code loads this file from the session's working directory as a matter of record. */
export const WORKFLOW_INPUT_NAME = "CLAUDE.md";

const SLUG_STRIP = /[^a-z0-9]+/gu;
const SEMVER_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function slug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(SLUG_STRIP, "-")
    .replace(/^-+|-+$/gu, "");
}

export function executorIri(hostName = HOST_NAME) {
  const slugged = slug(hostName);
  return slugged === "" ? "" : `${EXECUTOR_IRI_PREFIX}/${slugged}`;
}

function truthy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function baseUrlHost(env) {
  const base = (env.ANTHROPIC_BASE_URL ?? "").trim();
  if (base === "") return "";
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The host's own version. Claude Code's hook payloads do not carry it, so it is read from the
 * versioned executable path the host exports, and reported as unknown rather than guessed.
 */
export function hostVersion(env = process.env) {
  const declared = (env.CLAUDE_CODE_VERSION ?? "").trim();
  if (SEMVER_SHAPE.test(declared)) return declared;
  const execPath = (env.CLAUDE_CODE_EXECPATH ?? "").trim();
  const candidate = execPath === "" ? "" : basename(execPath);
  return SEMVER_SHAPE.test(candidate) ? candidate : "unknown";
}

/**
 * The hosted model's deployment identity, or `undefined`. An identity that says nothing is
 * worse than an absent one: the record would assert a deployment it cannot name.
 */
export function deriveModelService(provider, modelName, { deployment = "" } = {}) {
  const providerSlug = slug(provider);
  const modelSlug = slug(modelName);
  if (providerSlug === "" || modelSlug === "") return undefined;
  const iri = `${MODEL_SERVICE_IRI_PREFIX}/${providerSlug}/${modelSlug}`;
  // Structurally unreachable through this prefix, and checked anyway: the runtime refuses the
  // whole feed for a service that collides with the executor or the producer, so a future
  // change to either prefix must cost this identity rather than every event in the session.
  if (iri === executorIri() || iri === PRODUCER_IRI) return undefined;
  const service = { iri, name: `${provider} ${modelName}` };
  if (deployment !== "") service.deployment = deployment;
  return service;
}

/**
 * The model this session runs against, read from the host's own model environment.
 *
 * Claude Code's hook payloads carry no model, so this is the only non-guessing source. When
 * the model is not knowable the feed still opens — the runtime requires a name — but the
 * service identity is omitted.
 */
export function modelIdentity(env = process.env) {
  const host = baseUrlHost(env);
  let provider = "anthropic";
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) provider = "bedrock";
  else if (truthy(env.CLAUDE_CODE_USE_VERTEX)) provider = "vertex";
  else if (host !== "" && host !== "api.anthropic.com") provider = host;

  const name = (env.ANTHROPIC_MODEL ?? "").trim();
  if (name === "") return { provider, name: "unknown" };
  const service = deriveModelService(provider, name, { deployment: host });
  return service === undefined ? { provider, name } : { provider, name, service };
}

/**
 * The configuration this capture actually ran under, as deterministic JSON.
 *
 * Assembled field by field from values the adapter itself computed, never copied out of the
 * machine it ran on: no filesystem path, no environment, no credential. The artifact is
 * durable and publicly projectable, so "segregate secrets at the source" is held here by
 * construction rather than left to a later scrub.
 */
export function effectiveCaptureConfig({ model, host, runtimePin }) {
  const document = {
    selectionRule: CONTROLLED_INPUT_SELECTION_RULE,
    adapter: ADAPTER_NAME,
    feedVersion: FEED_VERSION,
    host: { name: host.name, version: host.version },
    model,
    controlledInputBounds: { maxBytes: CONTROLLED_INPUT_MAX_BYTES },
    gitObservationBudgetMs: 2_000,
  };
  if (runtimePin !== undefined) {
    document.runtime = { package: runtimePin.package, version: runtimePin.version };
  }
  return new TextEncoder().encode(canonicalJson(document));
}

/**
 * The project instruction Claude Code loads from the session's working directory.
 *
 * This is a producer-controlled instruction the host documents that it reads, not a guess
 * about one. Absent, oversized, or unreadable, it is dropped — never fabricated, and never
 * truncated, because half an instruction binds to nothing a verifier can check.
 */
export function readWorkflowInstruction(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  const path = join(cwd, WORKFLOW_INPUT_NAME);
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > CONTROLLED_INPUT_MAX_BYTES) {
      return undefined;
    }
    return {
      role: "workflow",
      name: WORKFLOW_INPUT_NAME,
      mediaType: "text/markdown",
      content: new Uint8Array(readFileSync(path)),
    };
  } catch {
    return undefined;
  }
}
