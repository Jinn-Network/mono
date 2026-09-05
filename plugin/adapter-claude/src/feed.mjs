// SPDX-License-Identifier: Apache-2.0

/**
 * Write the session feed the runtime seals.
 *
 * This is the bulk-bytes-by-path half of the host seam: transcript content is appended here
 * and the runtime is handed only a path. Three invariants a reader depends on, held here
 * because only the writer can hold them:
 *
 * * `atUnixNano` never decreases. A trace needs an order, and a wall clock does not provide
 *   one (NTP steps, suspend/resume). Each Claude Code hook is its own process, so the
 *   in-process monotonic source is combined with the last stamp the previous process wrote.
 * * Lines are appended and never reordered or rewritten. A span back-references a feed line
 *   by its zero-based ordinal, so mutating a line rewrites history already sealed elsewhere.
 * * Every event is validated against what the runtime would accept, and dropped rather than
 *   written when it would be refused. The runtime refuses a malformed feed **whole**, so one
 *   bad event would cost every event in the session rather than itself.
 *
 * Nothing here throws into a host hook. A capture problem must never break the session.
 */

import { appendFileSync } from "node:fs";

export const FEED_VERSION = 1;

/**
 * Bounds the runtime enforces on `controlled-input`. Held here too so an oversized input is
 * dropped rather than refusing the whole capture at seal time.
 */
export const CONTROLLED_INPUT_MAX_BYTES = 256 * 1024;
export const CONTROLLED_INPUT_MAX_COUNT = 32;

export const CONTROLLED_INPUT_ROLES = Object.freeze(["workflow", "skill", "prompt", "config"]);

/**
 * Per-field length maxima the runtime enforces, keyed by the schema in `feed.ts` that holds
 * them. Zod counts UTF-16 units, which is what `String.prototype.length` counts, so the two
 * agree without conversion.
 */
export const FIELD_MAX_LENGTHS = Object.freeze({
  SessionOpenSchema: { sessionId: 128 },
  RepositoryStateSchema: { branch: 256, targetBase: 256 },
  ControlledInputSchema: { name: 256, mediaType: 128 },
  ModelServiceSchema: { name: 256, version: 128, deployment: 256 },
});

const GIT_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/** The shape half of the runtime's `isAbsoluteIri`: a scheme, and no whitespace anywhere. */
const ABSOLUTE_IRI_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u;

/**
 * Mirror the runtime's `isAbsoluteIri`, whose third condition is that `new URL()` succeeds.
 * Shape alone diverges: `https://github.com:99999999/o/r` matches the regex and throws there,
 * which would then refuse the whole feed.
 */
export function absoluteIri(value) {
  if (typeof value !== "string" || !ABSOLUTE_IRI_SHAPE.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

function blank(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

function tooLong(value, schema, field) {
  return value.length > FIELD_MAX_LENGTHS[schema][field];
}

/**
 * Deterministic JSON: keys sorted in code-unit order, no whitespace. Two structurally equal
 * events must produce identical bytes, because a digest that drifts with key order binds
 * nothing.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    // `JSON.stringify(undefined)` is the value `undefined`, which would interpolate as the
    // bare word and make the line unparseable. `JSON.stringify` drops such a key; so does this.
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

/** Pre-stringify a structured value, per the feed contract. */
export function stringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

const WALL_BASE_NANO = BigInt(Date.now()) * 1_000_000n;
const HR_BASE = process.hrtime.bigint();

/**
 * Nanosecond wall-clock time that does not step backwards inside this process. `Date.now()`
 * has millisecond resolution, which would give a burst of events one indistinguishable stamp;
 * the high-resolution delta separates them without pretending to be a second clock.
 */
function nowNano() {
  return WALL_BASE_NANO + (process.hrtime.bigint() - HR_BASE);
}

/** An append-only NDJSON writer for one capture session. */
export class SessionFeed {
  /**
   * @param {string} path the feed path the runtime minted; never a host-supplied value.
   * @param {bigint|string|number} [lastNano] the last stamp a previous hook process wrote.
   */
  constructor(path, lastNano = 0n) {
    this.path = path;
    this.lineCount = 0;
    this.controlledInputs = 0;
    this.repositoryStateWritten = false;
    try {
      this.lastNano = BigInt(lastNano ?? 0);
    } catch {
      this.lastNano = 0n;
    }
  }

  openSession({ sessionId, hostName, hostVersion, modelProvider, modelName, modelService }) {
    if (blank(sessionId) || tooLong(sessionId, "SessionOpenSchema", "sessionId")) return false;
    if (blank(hostName) || blank(hostVersion)) return false;
    if (blank(modelProvider) || blank(modelName)) return false;
    const model = { provider: modelProvider, name: modelName };
    const service = this.#serviceOrNothing(modelService);
    if (service !== undefined) model.service = service;
    return this.#append({
      type: "session-open",
      v: FEED_VERSION,
      sessionId,
      startedAt: new Date().toISOString(),
      host: { name: hostName, version: hostVersion },
      model,
    });
  }

  /**
   * The hosted model's deployment identity, or nothing. A malformed or self-referential
   * identity would make the runtime refuse the whole feed, so it costs itself instead.
   */
  #serviceOrNothing(candidate) {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const service = {};
    for (const key of ["iri", "name", "version", "deployment", "providerIri"]) {
      const value = candidate[key];
      if (!blank(value)) service[key] = value.trim();
    }
    // Descriptive fields are bounded and optional, so an over-long one costs itself rather
    // than the identity it describes — and never the whole feed.
    for (const field of ["name", "version", "deployment"]) {
      if (field in service && tooLong(service[field], "ModelServiceSchema", field)) {
        delete service[field];
      }
    }
    if (!absoluteIri(service.iri)) return undefined;
    if ("providerIri" in service && !absoluteIri(service.providerIri)) return undefined;
    if (service.providerIri === service.iri) return undefined;
    return service;
  }

  /**
   * The base repository state this session starts from. The commit and tree object names are
   * the content binding a verifier resolves; branch and target base are context and may be
   * unknown, so their absence must not cost the binding.
   */
  repositoryState({ repository, baseCommit, baseTree, branch = "", targetBase = "" }) {
    if (this.repositoryStateWritten) return false;
    if (!absoluteIri(repository)) return false;
    for (const value of [baseCommit, baseTree]) {
      if (typeof value !== "string" || !GIT_OBJECT_NAME.test(value)) return false;
    }
    const event = { type: "repository-state", repository, baseCommit, baseTree };
    // A detached head reports the branch as "HEAD", which names nothing; omit it instead.
    for (const [key, raw] of [
      ["branch", branch],
      ["targetBase", targetBase],
    ]) {
      if (blank(raw)) continue;
      const value = raw.trim();
      if (key === "branch" && value === "HEAD") continue;
      if (tooLong(value, "RepositoryStateSchema", key)) continue;
      event[key] = value;
    }
    this.repositoryStateWritten = true;
    return this.#append(event);
  }

  /**
   * Bind the exact bytes of one producer-controlled input. Bytes travel inline rather than by
   * path, matching the runtime's contract: a path here would make the parser an
   * arbitrary-file-read primitive driven by host-written data.
   */
  controlledInput({ role, name, mediaType, content }) {
    if (!CONTROLLED_INPUT_ROLES.includes(role)) return false;
    if (blank(name) || blank(mediaType)) return false;
    if (
      tooLong(name, "ControlledInputSchema", "name") ||
      tooLong(mediaType, "ControlledInputSchema", "mediaType")
    ) {
      return false;
    }
    if (!(content instanceof Uint8Array)) return false;
    // Size first, so an oversized input is refused for the length it has rather than after
    // allocating a third again as much to encode it.
    if (content.byteLength === 0 || content.byteLength > CONTROLLED_INPUT_MAX_BYTES) return false;
    if (this.controlledInputs >= CONTROLLED_INPUT_MAX_COUNT) return false;
    this.controlledInputs += 1;
    return this.#append({
      type: "controlled-input",
      role,
      name,
      mediaType,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  }

  environment({ tools = [], skills = [] } = {}) {
    const clean = (values) =>
      Array.isArray(values) ? values.filter((value) => !blank(value)).map(String) : [];
    return this.#append({
      type: "environment",
      tools: clean(tools),
      skills: clean(skills),
    });
  }

  userTurn(text) {
    return this.#append({ type: "user-turn", text: typeof text === "string" ? text : "" });
  }

  toolCall({ toolName, toolCallId, args, result, status = "ok", errorMessage }) {
    if (blank(toolName) || blank(toolCallId)) return false;
    const event = {
      type: "tool-call",
      toolName,
      toolCallId,
      status: status === "error" ? "error" : "ok",
      arguments: stringify(args),
      result: stringify(result),
    };
    if (!blank(errorMessage)) event.errorMessage = errorMessage;
    return this.#append(event, true);
  }

  closeSession({ outcome, summary = "" }) {
    const known = ["completed", "failed", "abandoned"];
    return this.#append({
      type: "session-close",
      endedAt: new Date().toISOString(),
      outcome: known.includes(outcome) ? outcome : "failed",
      summary: typeof summary === "string" ? summary : "",
    });
  }

  #append(event, isToolCall = false) {
    const now = nowNano();
    const stamp = now > this.lastNano ? now : this.lastNano;
    this.lastNano = stamp;
    const line = { ...event, atUnixNano: stamp.toString() };
    // A tool call the host reported without a start is stamped as instantaneous rather than
    // guessed: `startedAtUnixNano > atUnixNano` refuses the whole feed.
    if (isToolCall) line.startedAtUnixNano = stamp.toString();
    try {
      // One `write(2)` in append mode per line: the kernel keeps a single append-mode write
      // atomic, so concurrent hook processes never tear a line.
      appendFileSync(this.path, `${canonicalJson(line)}\n`, { encoding: "utf8" });
    } catch {
      return false;
    }
    this.lineCount += 1;
    return true;
  }
}
