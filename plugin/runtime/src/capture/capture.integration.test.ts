import { Buffer } from "node:buffer";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { parseTrace } from "@jinn-network/evidence-trace";
import type { DsseSigner } from "@jinn-network/trust-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCaptureCapability } from "./capability.js";
import {
  BASE_COMMIT_PROPERTY,
  BASE_TREE_PROPERTY,
  BRANCH_PROPERTY,
  CONTROLLED_INPUT_ROLE_PROPERTY,
  MODEL_SERVICE_ENTITY_ID,
  REPOSITORY_STATE_ENTITY_ID,
  SESSION_FEED_FORMAT_IRI,
  TARGET_BASE_PROPERTY,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
} from "./identity.js";
import {
  derivationLinkPath,
  loadTraceDerivationAttestation,
  loadTraceRecord,
  readTraceDerivationAttestationLink,
  traceReferenceFromRecordBytes,
} from "./link.js";
import { resolveCapturePaths } from "./paths.js";
import { SEAL_MARKER_FILENAME, listStrandedSessionIds } from "./retention.js";

const homes: string[] = [];

const testSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

async function newHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "jinn-capture-e2e-"));
  homes.push(home);
  return home;
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function startCapture(home: string, env: Record<string, string> = {}) {
  const config = resolveRuntimeConfig({ env, homeDirectory: home });
  const capture = createCaptureCapability({ producerVersion: "0.1.0", signer: testSigner });
  await capture.start!({ config, log: log() });
  return { capture, config, paths: resolveCapturePaths(config) };
}

function feedLines(sessionId: string, baseNano: bigint): string {
  const line = (value: unknown): string => JSON.stringify(value);
  return (
    [
      line({
        type: "session-open",
        v: 1,
        sessionId,
        startedAt: "2026-07-30T09:00:00Z",
        atUnixNano: String(baseNano),
        host: { name: "Hermes", version: "0.9.1" },
        model: { provider: "anthropic", name: "claude-opus-4.6" },
        conversationId: sessionId,
      }),
      line({
        type: "environment",
        atUnixNano: String(baseNano + 1n),
        tools: ["read_file"],
        skills: [],
      }),
      line({ type: "user-turn", atUnixNano: String(baseNano + 2n), text: "Where is the budget?" }),
      line({
        type: "tool-call",
        startedAtUnixNano: String(baseNano + 3n),
        atUnixNano: String(baseNano + 4n),
        toolName: "read_file",
        toolCallId: "call-1",
        status: "ok",
        arguments: '{"path":"src/retry.ts"}',
        result: "export const RETRY_BUDGET = 3;",
      }),
      line({
        type: "assistant-turn",
        atUnixNano: String(baseNano + 5n),
        text: "RETRY_BUDGET in src/retry.ts.",
      }),
      line({
        type: "tokens",
        atUnixNano: String(baseNano + 6n),
        inputTokens: 1024,
        outputTokens: 256,
      }),
      line({
        type: "session-close",
        atUnixNano: String(baseNano + 7n),
        endedAt: "2026-07-30T09:00:06Z",
        outcome: "completed",
        summary: "Locate the retry budget",
      }),
    ].join("\n") + "\n"
  );
}

const BASE_COMMIT = "4f0e2b7c1a9d8e3f5b6a7c8d9e0f1a2b3c4d5e6f";
const BASE_TREE = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const MODEL_SERVICE = {
  iri: "https://spec.jinn.network/services/anthropic/claude-opus-5",
  name: "Anthropic Messages API",
  version: "claude-opus-5-20260514",
  deployment: "api.anthropic.com",
  providerIri: "https://spec.jinn.network/organizations/anthropic",
} as const;

/**
 * An Autopilot-shaped feed: the same session events as above plus the two fact classes the
 * `autopilot-issue-1697` protocol fixture found missing.
 */
function autopilotFeedLines(sessionId: string, baseNano: bigint): string {
  const line = (value: unknown): string => JSON.stringify(value);
  return (
    [
      line({
        type: "session-open",
        v: 1,
        sessionId,
        startedAt: "2026-07-30T09:00:00Z",
        atUnixNano: String(baseNano),
        host: { name: "Claude Code", version: "2.1.197" },
        model: { provider: "anthropic", name: "claude-opus-5", service: MODEL_SERVICE },
        conversationId: sessionId,
      }),
      line({
        type: "repository-state",
        atUnixNano: String(baseNano + 1n),
        repository: "https://github.com/Jinn-Network/mono",
        branch: "autopilot/3223",
        targetBase: "next",
        baseCommit: BASE_COMMIT,
        baseTree: BASE_TREE,
      }),
      line({
        type: "controlled-input",
        atUnixNano: String(baseNano + 2n),
        role: "workflow",
        name: ".claude/skills/implement-issue/SKILL.md",
        mediaType: "text/markdown",
        contentBase64: Buffer.from("# implement-issue\n").toString("base64"),
      }),
      line({
        type: "controlled-input",
        atUnixNano: String(baseNano + 3n),
        role: "config",
        name: "effective-config.json",
        mediaType: "application/json",
        contentBase64: Buffer.from('{"runtime":"claude","effort":"high"}').toString("base64"),
      }),
      line({ type: "user-turn", atUnixNano: String(baseNano + 4n), text: "Implement issue #3223." }),
      line({
        type: "assistant-turn",
        atUnixNano: String(baseNano + 5n),
        text: "Done.",
      }),
      line({
        type: "session-close",
        atUnixNano: String(baseNano + 6n),
        endedAt: "2026-07-30T09:10:00Z",
        outcome: "completed",
        summary: "Implement issue #3223",
      }),
    ].join("\n") + "\n"
  );
}

beforeEach(() => {
  homes.length = 0;
});
afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

describe("capture end to end", () => {
  test("seals a session into a record that conforms to the execution evidence protocol", async () => {
    const home = await newHome();
    const { capture } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-e2e" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));

    const result = await capture.sealSession({ sessionId });
    expect(result.sealed, JSON.stringify(result)).toBe(true);
    if (!result.sealed) return;

    const report = validateExecutionEvidence(result.capture.recordBytes);
    expect(report.conforms, JSON.stringify(report.diagnostics)).toBe(true);
    expect(result.capture.record.family).toBe("execution-evidence");
    expect(result.capture.executionId).toMatch(/^urn:uuid:/u);
    expect(result.capture.derivationAttestation.envelopeBytes.byteLength).toBeGreaterThan(0);
    expect(result.capture.derivationAttestation.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  }, 60_000);

  test("the sealed record binds the feed with its format identity and links the trace", async () => {
    const home = await newHome();
    const { capture } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-link" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const document = JSON.parse(new TextDecoder().decode(result.capture.recordBytes)) as {
      "@graph": readonly Record<string, unknown>[];
    };
    const trace = document["@graph"].find((entity) => entity["@id"] === "trace/feed.ndjson");
    expect(trace?.conformsTo).toEqual({ "@id": SESSION_FEED_FORMAT_IRI });
    expect(trace?.encodingFormat).toBe("application/x-ndjson");
    expect(trace?.sha256).toBe(result.capture.nativeTrace.reference.digest.slice("sha256:".length));
    expect(
      document["@graph"].some((entity) => entity["@id"] === SESSION_FEED_FORMAT_IRI),
    ).toBe(true);

    const identifiers = Array.isArray(trace?.identifier) ? trace.identifier : [trace?.identifier];
    expect(identifiers).toContainEqual({
      "@type": "PropertyValue",
      propertyID: TRACE_RECORD_IDENTIFIER_PROPERTY,
      value: result.capture.trace.digest,
    });
  }, 60_000);

  test("the derivation attestation artifact and durable link are coherent", async () => {
    const home = await newHome();
    const { capture, config, paths } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-attest" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const { capture: sealed } = result;
    const linkPath = derivationLinkPath(paths, sealed.record.digest);
    expect(linkPath).toBe(
      join(paths.derivationLinksDirectory, sealed.record.digest.slice("sha256:".length) + ".json"),
    );
    expect((await stat(linkPath)).isFile()).toBe(true);

    const link = await readTraceDerivationAttestationLink(paths, sealed.record.digest);
    expect(link).toEqual({
      version: 1,
      executionDigest: sealed.record.digest,
      traceDigest: sealed.trace.digest,
      attestationDigest: sealed.derivationAttestation.digest,
      nativeTraceDigest: sealed.nativeTrace.reference.digest,
      derivedAt: "2026-07-30T09:00:06Z",
    });

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const loaded = await loadTraceDerivationAttestation(runtime.repository, link!);
      expect(loaded.envelopeBytes).toEqual(sealed.derivationAttestation.envelopeBytes);
      expect(`sha256:${loaded.statement.subject[0]!.digest.sha256}`).toBe(
        sealed.trace.digest,
      );
      expect(`sha256:${loaded.statement.predicate.execution.digest.sha256}`).toBe(
        sealed.record.digest,
      );
      expect(loaded.statement.predicate.derivedAt).toBe("2026-07-30T09:00:06Z");
      expect(loaded.statement.predicate.linkageMode).toBe("forward-linked");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  test("the trace record is retrievable through the link and carries no message content", async () => {
    const home = await newHome();
    const { capture, config } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-traj" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    const reference = traceReferenceFromRecordBytes(result.capture.recordBytes);
    expect(reference).toEqual({ digest: result.capture.trace.digest });

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const record = await loadTraceRecord(runtime.repository, reference!);
      expect(record.traceId).toBe(result.capture.trace.traceId);
      expect(record.source.formatIri).toBe(SESSION_FEED_FORMAT_IRI);
      expect(record.source).not.toHaveProperty("execution");
      expect(record.spans.map((span) => span.name)).toEqual([
        "invoke_agent Hermes",
        "execute_tool read_file",
        "chat claude-opus-4.6",
      ]);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("Where is the budget?");
      expect(serialized).not.toContain("RETRY_BUDGET");
    } finally {
      await runtime.close();
    }
    // Sealing bytes and stored bytes are the same bytes.
    expect(parseTrace(result.capture.trace.bytes).traceId).toBe(
      result.capture.trace.traceId,
    );
  }, 60_000);

  test("the capture is indexed into the catalog and findable by execution", async () => {
    const home = await newHome();
    const { capture, config } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-index" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;
    expect(result.capture.indexed.status).toBe("indexed");

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const page = await runtime.catalog.findExecutions({
        executionId: result.capture.executionId,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.outcome).toBe("completed");
      expect(page.items[0]?.nativeTrace.digest).toBe(result.capture.nativeTrace.reference.digest);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  test.skipIf(process.platform === "win32")(
    "every file the capture path creates is owner-only",
    async () => {
      const home = await newHome();
      const { capture, config, paths } = await startCapture(home);
      const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-perms" });
      await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
      const result = await capture.sealSession({ sessionId });
      expect(result.sealed).toBe(true);

      const offenders: string[] = [];
      async function walk(path: string): Promise<void> {
        const entry = await stat(path);
        const mode = entry.mode & 0o777;
        if (entry.isDirectory()) {
          if ((mode & 0o077) !== 0) offenders.push(`${path} ${mode.toString(8)}`);
          for (const child of await readdir(path)) await walk(join(path, child));
          return;
        }
        if ((mode & 0o077) !== 0) offenders.push(`${path} ${mode.toString(8)}`);
      }
      await walk(paths.captureDirectory);
      await walk(config.archiveDirectory);
      expect(offenders).toEqual([]);
    },
    60_000,
  );

  test("the seal writes a marker and runs an observable retention sweep", async () => {
    const home = await newHome();
    const { capture, paths } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-retain" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;

    expect(
      (await stat(join(paths.sessionsDirectory, sessionId, SEAL_MARKER_FILENAME))).isFile(),
    ).toBe(true);
    expect(result.capture.retention.cutoff).not.toBe("");
    expect(result.capture.retention.retainedSessions).toBe(1);
    expect(result.capture.retention.droppedUnsealedSessions).toBe(0);
    expect(result.capture.retention.droppedRecoverableSessions).toBe(0);
    expect((await stat(paths.retentionWatermarkPath)).isFile()).toBe(true);
  }, 60_000);
});

describe("fleet safety (cross-plan contract 5)", () => {
  test("concurrent sessions in separate per-home archives do not contend", async () => {
    const first = await startCapture(await newHome());
    const second = await startCapture(await newHome());
    expect(first.config.archiveDirectory).not.toBe(second.config.archiveDirectory);

    const opened = await Promise.all([
      first.capture.openSession({ sessionId: "s-worker-a" }),
      second.capture.openSession({ sessionId: "s-worker-b" }),
    ]);
    await Promise.all(
      opened.map(async (session, index) =>
        writeFile(
          session.feedPath,
          feedLines(session.sessionId, 1_785_488_400_000_000_000n + BigInt(index)),
        ),
      ),
    );

    const started = Date.now();
    const results = await Promise.all([
      first.capture.sealSession({ sessionId: "s-worker-a" }),
      second.capture.sealSession({ sessionId: "s-worker-b" }),
    ]);
    // Neither seal spent time in busy-wait backoff, because neither ever saw the other's lock.
    expect(Date.now() - started).toBeLessThan(30_000);
    for (const result of results) expect(result.sealed).toBe(true);
    expect(results[0]!.sealed && results[1]!.sealed).toBe(true);
    if (results[0]!.sealed && results[1]!.sealed) {
      expect(results[0]!.capture.record.digest).not.toBe(results[1]!.capture.record.digest);
    }
  }, 120_000);

  test("concurrent seals against ONE archive serialize rather than fail", async () => {
    const { capture } = await startCapture(await newHome());
    const opened = await Promise.all([
      capture.openSession({ sessionId: "s-one" }),
      capture.openSession({ sessionId: "s-two" }),
    ]);
    await Promise.all(
      opened.map(async (session, index) =>
        writeFile(
          session.feedPath,
          feedLines(session.sessionId, 1_785_488_400_000_000_000n + BigInt(index)),
        ),
      ),
    );
    const results = await Promise.all([
      capture.sealSession({ sessionId: "s-one" }),
      capture.sealSession({ sessionId: "s-two" }),
    ]);
    for (const result of results) expect(result.sealed).toBe(true);
  }, 120_000);

  test("an archive held by another process surfaces capture-archive-busy, not a hang", async () => {
    const home = await newHome();
    const config = resolveRuntimeConfig({
      env: { JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS: "500" },
      homeDirectory: home,
    });
    const capture = createCaptureCapability({ producerVersion: "0.1.0", signer: testSigner });
    await capture.start!({ config, log: log() });
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-busy" });
    await writeFile(feedPath, feedLines(sessionId, 1_785_488_400_000_000_000n));

    const holder = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      await expect(capture.sealSession({ sessionId })).rejects.toMatchObject({
        code: "capture-archive-busy",
      });
    } finally {
      await holder.close();
    }

    // Once the holder releases, the same session seals without any change of state.
    const result = await capture.sealSession({ sessionId });
    expect(result.sealed).toBe(true);
  }, 120_000);

  test("a feed stranded by a busy archive is recovered at the next session open", async () => {
    const home = await newHome();
    const { capture, paths, config } = await startCapture(home);

    // A session whose seal never ran: its feed is complete, but nothing owns it.
    const stranded = await capture.openSession({ sessionId: "s-stranded" });
    await writeFile(stranded.feedPath, feedLines("s-stranded", 1_785_488_400_000_000_000n));
    expect(await listStrandedSessionIds(paths)).toEqual(["s-stranded"]);

    // Opening the next session recovers it — before the operator's first turn, not after it.
    await capture.openSession({ sessionId: "s-next" });
    expect(await listStrandedSessionIds(paths, ["s-next"])).toEqual([]);

    const runtime = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const page = await runtime.catalog.findExecutions({ outcome: "completed" });
      expect(page.items).toHaveLength(1);
    } finally {
      await runtime.close();
    }
    expect(
      (await stat(join(paths.sessionsDirectory, "s-stranded", SEAL_MARKER_FILENAME))).isFile(),
    ).toBe(true);
  }, 120_000);

  test("recovery at open is skipped, not failed, while another process holds the archive", async () => {
    const home = await newHome();
    const { capture, paths, config } = await startCapture(home);
    const stranded = await capture.openSession({ sessionId: "s-stranded" });
    await writeFile(stranded.feedPath, feedLines("s-stranded", 1_785_488_400_000_000_000n));

    const holder = await openLocalEvidenceRuntime({ rootDir: config.archiveDirectory });
    try {
      const startedAt = Date.now();
      // The open must succeed regardless, and must not wait on the sibling for long.
      await expect(capture.openSession({ sessionId: "s-next" })).resolves.toMatchObject({
        sessionId: "s-next",
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await listStrandedSessionIds(paths, ["s-next"])).toEqual(["s-stranded"]);
    } finally {
      await holder.close();
    }

    // Left staged, so the following open picks it up.
    await capture.openSession({ sessionId: "s-later" });
    expect(await listStrandedSessionIds(paths, ["s-later", "s-next"])).toEqual([]);
  }, 120_000);
});

describe("Autopilot-driven capture (issue #3223)", () => {
  test("seals a conformant record that closes both capture gaps and reaches the local journal", async () => {
    const home = await newHome();
    const { capture } = await startCapture(home);
    const { sessionId, feedPath } = await capture.openSession({ sessionId: "s-autopilot" });
    await writeFile(feedPath, autopilotFeedLines(sessionId, 1_785_488_400_000_000_000n));

    const result = await capture.sealSession({ sessionId });
    expect(result.sealed, JSON.stringify(result)).toBe(true);
    if (!result.sealed) return;

    const report = validateExecutionEvidence(result.capture.recordBytes);
    expect(report.conforms, JSON.stringify(report.diagnostics)).toBe(true);

    const document = JSON.parse(new TextDecoder().decode(result.capture.recordBytes)) as {
      "@graph": readonly Record<string, unknown>[];
    };
    const entity = (id: string) => document["@graph"].find((value) => value["@id"] === id);
    const identifiersOf = (value: Record<string, unknown> | undefined): unknown[] => {
      const raw = value?.identifier;
      return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    };
    const property = (propertyID: string, value: string) => ({
      "@type": "PropertyValue",
      propertyID,
      value,
    });

    // Gap 1: the base repository state is a content-bound input, not an unrecorded fact.
    const repository = entity(REPOSITORY_STATE_ENTITY_ID);
    expect(repository).toBeDefined();
    expect(repository?.codeRepository).toBe("https://github.com/Jinn-Network/mono");
    // The recorder canonicalizes identifier order, so membership is the contract, not sequence.
    expect(identifiersOf(repository)).toHaveLength(4);
    expect(identifiersOf(repository)).toEqual(
      expect.arrayContaining([
        property(BASE_COMMIT_PROPERTY, BASE_COMMIT),
        property(BASE_TREE_PROPERTY, BASE_TREE),
        property(BRANCH_PROPERTY, "autopilot/3223"),
        property(TARGET_BASE_PROPERTY, "next"),
      ]),
    );

    // Gap 2a: producer-controlled inputs are digest-bound artifacts, not labels.
    const controlled = document["@graph"].filter((value) =>
      String(value["@id"]).startsWith("inputs/controlled/"),
    );
    expect(controlled).toHaveLength(2);
    expect(controlled.map((value) => value.sha256)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    ]);
    expect(controlled.flatMap(identifiersOf)).toEqual(
      expect.arrayContaining([
        property(CONTROLLED_INPUT_ROLE_PROPERTY, "workflow"),
        property(CONTROLLED_INPUT_ROLE_PROPERTY, "config"),
      ]),
    );

    // Gap 2b: the hosted model carries a full service identity rather than a bare label.
    expect(entity(MODEL_SERVICE_ENTITY_ID)).toBeDefined();
    expect(entity(MODEL_SERVICE.iri)).toMatchObject({
      name: MODEL_SERVICE.name,
      softwareVersion: MODEL_SERVICE.version,
    });

    // The record is in the local journal, which is what makes it retrievable and projectable.
    expect(result.capture.indexed.status).toBe("indexed");
  }, 60_000);
});
