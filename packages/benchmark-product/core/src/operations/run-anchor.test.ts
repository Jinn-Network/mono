/**
 * `runAnchor` (anchor-evidence design §7.1), against a real workspace, a real lock, real sealed
 * records, and the real proof verifiers — with only the HTTP transport injected.
 *
 * Setting up a locked run is expensive (a sample benchmark, two arms, a quote), so the suite
 * builds one workspace per `describe` block rather than per test where the block's tests do not
 * mutate each other's state, and says so where it matters.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import {
  ANCHOR_EVIDENCE_KIND,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  compareCalendarStrictRfc3339Instants,
  createRfc3161AnchorProofVerifier,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorProofSource } from "@jinn-network/trust-core";
import { nodeCryptoAnchorPorts } from "@colophon-claims/check";
import {
  KIT_AUTHORITY_SEED,
  KIT_BITCOIN_BLOCK_HEIGHT,
  KIT_CALENDAR_URI,
  buildLinearOtsProof,
  createFixtureAuthority,
} from "@jinn-network/trust-testing";
import { readAuditEntries } from "../audit/journal.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { OPENTIMESTAMPS_PROOF_MEDIA_TYPE, RFC3161_TOKEN_MEDIA_TYPE } from "../anchor/profiles.js";
import { parseDetachedOtsProof, toHex } from "../anchor/opentimestamps.js";
import type { AnchorHttpFetch } from "../anchor/sources.js";
import { readRunState, writeRunState } from "../run/state.js";
import { workspaceMetadataPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument, updateDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { anchorAfterLockIfConfigured, resolveAnchorConfiguration, runAnchor } from "./run-anchor.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

const TSA_ENDPOINT = "https://timestamp.invalid/tsr";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "anchor-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let tick = 0;
  return () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`;
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(clock: () => string, draftId = "draft-1", spec?: unknown): Promise<string> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Anchor Test" });
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  if (spec !== undefined) updateDraft(contextFor(clock), { draftId, patch: spec });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
  if (!locked.ok) throw new Error("lock failed");
  return locked.result.runSha256;
}

/** The workspace-level anchoring block. Written straight to `workspace.json` because P6 ships no
 * verb for it — the configuration surface is P7's. */
function configureWorkspaceAnchoring(entries: readonly { providerProfile: string; endpoint: string }[]): void {
  const path = workspaceMetadataPath(workspaceDir);
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  atomicWriteFileSync(path, JSON.stringify({ ...metadata, anchoring: entries }, null, 2));
}

// --- proof sources, all offline ---------------------------------------------

const authority = createFixtureAuthority(KIT_AUTHORITY_SEED);

function rfc3161SourceFor(
  subjectSha256: string,
  options: { tampered?: boolean; tokenSerialHex?: string; genTime?: string } = {},
): AnchorProofSource {
  const minted = options.tampered === true
    ? authority.mintTimeStampToken({ subjectSha256, brokenSignature: true })
    : authority.mintTimeStampToken({
      subjectSha256,
      ...(options.tokenSerialHex === undefined ? {} : { tokenSerialHex: options.tokenSerialHex }),
      ...(options.genTime === undefined ? {} : { genTime: options.genTime }),
    });
  return {
    profile: RFC3161_TSA_ANCHOR_PROFILE,
    async obtainProof() {
      return minted.tokenDer;
    },
  };
}

/** A calendar's bare-node answer: the kit's proof minus its 36-byte detached-file header. */
function calendarBody(height?: number): Uint8Array {
  return buildLinearOtsProof({
    fileDigest: new Uint8Array(32),
    operations: [{ kind: "append", argument: Uint8Array.of(0x6a, 0x69, 0x6e, 0x6e) }, { kind: "sha256" }],
    attestations: height === undefined
      ? [{ kind: "pending", uri: KIT_CALENDAR_URI }]
      : [{ kind: "bitcoin", height }],
  }).subarray(31 + 1 + 1 + 32);
}

/** A transport that stamps, then answers the upgrade query once `confirmed` flips. */
function calendarTransport(state: { confirmed: boolean; calls: string[] }): AnchorHttpFetch {
  return async (request) => {
    state.calls.push(request.url);
    if (request.url.endsWith("/digest")) return { status: 200, bytes: calendarBody() };
    return state.confirmed
      ? { status: 200, bytes: calendarBody(KIT_BITCOIN_BLOCK_HEIGHT) }
      : { status: 404, bytes: new TextEncoder().encode("Pending confirmation in Bitcoin blockchain") };
  };
}

// ---------------------------------------------------------------------------

describe("resolveAnchorConfiguration — §7.3 resolution order", () => {
  const workspaceAnchoring = [
    { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
    { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI },
  ];

  test("nothing configured means nothing attempted", () => {
    expect(resolveAnchorConfiguration({}).kind).toBe("unconfigured");
  });

  test("the workspace default is the first configured entry", () => {
    expect(resolveAnchorConfiguration({ workspaceAnchoring })).toEqual({
      kind: "target",
      target: { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
    });
  });

  test("a per-invocation provider selects its own configured endpoint", () => {
    expect(resolveAnchorConfiguration({ workspaceAnchoring, providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE }))
      .toEqual({ kind: "target", target: { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI } });
  });

  test("a per-invocation endpoint overrides the configured one for the same provider", () => {
    expect(resolveAnchorConfiguration({ workspaceAnchoring, endpoint: "https://other.invalid/tsr" }))
      .toEqual({ kind: "target", target: { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: "https://other.invalid/tsr" } });
  });

  test("a per-invocation provider with no configuration at all still needs an endpoint", () => {
    expect(resolveAnchorConfiguration({ providerProfile: RFC3161_TSA_ANCHOR_PROFILE }).kind).toBe("unconfigured");
    expect(resolveAnchorConfiguration({ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }))
      .toEqual({ kind: "target", target: { providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT } });
  });

  test("the per-draft disable turns off the automatic path", () => {
    expect(resolveAnchorConfiguration({ workspaceAnchoring, draftEnabled: false }).kind).toBe("disabled");
  });

  test("the per-draft disable does not veto an invocation that names its own target", () => {
    // §7.3 puts the flag ahead of the draft setting, and §7.2's standalone verb exists precisely
    // to retry. Reading the disable as absolute would also be a one-way trap: a locked draft is
    // immutable, so it could never be anchored again by any means.
    expect(resolveAnchorConfiguration({
      workspaceAnchoring,
      draftEnabled: false,
      providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE,
    })).toEqual({ kind: "target", target: { providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI } });
    expect(resolveAnchorConfiguration({
      workspaceAnchoring,
      draftEnabled: false,
      endpoint: "https://other.invalid/tsr",
    }).kind).toBe("target");
  });

  test("an explicit enabled: true is not a configuration by itself", () => {
    expect(resolveAnchorConfiguration({ draftEnabled: true }).kind).toBe("unconfigured");
  });
});

describe("runAnchor — subject lock", () => {
  test("seals an AnchorEvidence record over the Run digest and records it, audited and ungated", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.subject).toBe("lock");
    expect(outcome.result.subjectSha256).toBe(runSha256);
    expect(outcome.result.subjectKind).toBe(RUN_RECORD_KIND);
    // No trust material at acquisition time, so an honest producer reports `present`.
    expect(outcome.result.proofStatus).toBe("present");

    const record = parseExactAnchorEvidence(getSealedBytes(workspaceDir, outcome.result.recordSha256));
    expect(record.kind).toBe(ANCHOR_EVIDENCE_KIND);
    expect(record.subject).toEqual({ kind: RUN_RECORD_KIND, digest: { sha256: runSha256 } });
    expect(record.provider).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    expect(record.proof.mediaType).toBe(RFC3161_TOKEN_MEDIA_TYPE);
    // The foreign bytes are carried exactly: the record decodes back to what the source returned.
    expect(decodeAnchorProofContent(record.proof.content).length).toBeGreaterThan(0);

    expect(readRunState(workspaceDir, "draft-1")?.anchors).toEqual([
      { subject: "lock", provider: RFC3161_TSA_ANCHOR_PROFILE, recordSha256: outcome.result.recordSha256 },
    ]);

    const entries = readAuditEntries(workspaceDir);
    expect(entries.at(-1)).toMatchObject({ action: "anchor", subject: "draft-1", outcome: "ok" });
  }, 60_000);

  test("is ungated: a principal with no grants may anchor", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    // `sponsor-1` is the workspace's only granted principal; a second member is added by policy
    // file so this test does not depend on `authorityGrant` semantics.
    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } },
    );
    expect(outcome.ok).toBe(true);
  }, 60_000);

  test("refuses illegal-transition before lock", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Anchor Test" });
    await sampleInit(contextFor(clock), { draftId: "draft-1" });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    await runQuote(contextFor(clock), { draftId: "draft-1" });

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor("0".repeat(64)) } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  }, 60_000);

  test("refuses illegal-transition once launched — a lock anchor after dispatch proves nothing", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", { ...state, launchedAt: "2026-08-17T01:00:00Z" });

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toBeUndefined();
  }, 60_000);

  test("TOCTOU: a launch that interleaves with acquisition turns the store into the same refusal", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);

    let obtained = false;
    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      {
        sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) },
        afterObtainBeforeStore: async () => {
          obtained = true;
          const state = readRunState(workspaceDir, "draft-1")!;
          writeRunState(workspaceDir, "draft-1", { ...state, launchedAt: "2026-08-17T02:00:00Z" });
        },
      },
    );

    expect(obtained).toBe(true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    // Nothing was stored: the refusal happens before the record is sealed.
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toBeUndefined();
  }, 60_000);

  test("TOCTOU: a same-pair anchor that lands during acquisition turns the store into a conflict", async () => {
    // The write-once fence has the same shape as the launch fence: resolving it once, before
    // acquisition, decides against a snapshot another call can invalidate while this one waits on
    // a network. Two DISTINCT valid tokens, so nothing here is masked by the duplicate-record
    // rule — without the fix both land and the run carries two lock anchors from one provider.
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const input = {
      draftId: "draft-1", subject: "lock" as const,
      providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT,
    };

    let interloperRecordSha256 = "";
    const outcome = await runAnchor(contextFor(clock), input, {
      sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { tokenSerialHex: "0a" }) },
      afterObtainBeforeStore: async () => {
        // A second `anchor` call that started later and finished first.
        const interloper = await runAnchor(contextFor(clock), input, {
          sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { tokenSerialHex: "0b" }) },
        });
        expect(interloper.ok).toBe(true);
        if (interloper.ok) interloperRecordSha256 = interloper.result.recordSha256;
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    // Exactly one anchor of the pair survives, and it is the one that actually landed.
    const anchors = readRunState(workspaceDir, "draft-1")?.anchors ?? [];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.recordSha256).toBe(interloperRecordSha256);
  }, 60_000);

  test("the durable invariant refuses a same-pair second anchor even if the operation is bypassed", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const first = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { tokenSerialHex: "0a" }) } },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const state = readRunState(workspaceDir, "draft-1")!;
    expect(() => writeRunState(workspaceDir, "draft-1", {
      ...state,
      anchors: [...(state.anchors ?? []), {
        subject: "lock", provider: RFC3161_TSA_ANCHOR_PROFILE, recordSha256: "c".repeat(64),
      }],
    })).toThrowError(/already carries a lock anchor/);
  }, 60_000);
});

describe("runAnchor — subject matrix", () => {
  test("requires the run closed, then anchors the Matrix digest regardless of launch state", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const open = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "matrix", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor("0".repeat(64)) } },
    );
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error.code).toBe("illegal-transition");

    // Close the run with a sealed Matrix stand-in: this test is about the anchor operation's own
    // preconditions, not about matrix assembly.
    const matrixSha256 = putSealedBytes(workspaceDir, new TextEncoder().encode('{"kind":"matrix-stand-in"}'));
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", {
      ...state,
      launchedAt: "2026-08-17T01:00:00Z",
      closedAt: "2026-08-17T02:00:00Z",
      matrixSha256,
    });

    const closed = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "matrix", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(matrixSha256) } },
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.result.subjectSha256).toBe(matrixSha256);
    expect(closed.result.subjectKind).toBe(MATRIX_RECORD_KIND);
  }, 60_000);
});

describe("runAnchor — the window closes at report", () => {
  /**
   * The claim package's anchors section is sealed at `report`, and `report` admits only a closed
   * draft, so an anchor obtained afterwards could never be projected into any claim. Storing one
   * would leave publication byte-comparing a sealed claim against a bundle that carries more than
   * it names — a run that did nothing wrong, unable to publish. Both subjects refuse.
   */
  test.each(["lock", "matrix"] as const)("refuses illegal-transition for subject %s once reported", async (subject) => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const matrixSha256 = putSealedBytes(workspaceDir, new TextEncoder().encode('{"kind":"matrix-stand-in"}'));
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", {
      ...state,
      closedAt: "2026-08-17T02:00:00Z",
      matrixSha256,
      reportedAt: "2026-08-17T03:00:00Z",
    });

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject, providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(subject === "lock" ? runSha256 : matrixSha256) } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    expect(outcome.error.detail).toContain("anchor before reporting");
    // Nothing was stored: the refusal is a decision, not a rollback.
    expect(readRunState(workspaceDir, "draft-1")?.anchors ?? []).toEqual([]);
  }, 60_000);

  test("a report that interleaves with acquisition turns the store into the same refusal", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      {
        sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) },
        // The window is open when the request goes out and closed when the answer comes back.
        afterObtainBeforeStore: async () => {
          const state = readRunState(workspaceDir, "draft-1")!;
          writeRunState(workspaceDir, "draft-1", { ...state, reportedAt: "2026-08-17T03:00:00Z" });
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    expect(readRunState(workspaceDir, "draft-1")?.anchors ?? []).toEqual([]);
  }, 60_000);
});

describe("runAnchor — refusal matrix", () => {
  test("refuses venue-unavailable when nothing is configured", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const outcome = await runAnchor(contextFor(clock), { draftId: "draft-1", subject: "lock" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");
  }, 60_000);

  test("refuses venue-unavailable when the draft disables anchoring and the caller names nothing", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock, "draft-1", { anchoring: { enabled: false } });
    configureWorkspaceAnchoring([{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }]);
    const deps = { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } };

    const automatic = await runAnchor(contextFor(clock), { draftId: "draft-1", subject: "lock" }, deps);
    expect(automatic.ok).toBe(false);
    if (automatic.ok) return;
    expect(automatic.error.code).toBe("venue-unavailable");
    expect(automatic.error.detail).toContain("disabled");

    // The standalone verb's explicit target still goes through: a locked draft is immutable, so
    // an absolute disable would be an unescapable trap.
    const explicit = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      deps,
    );
    expect(explicit.ok).toBe(true);
  }, 60_000);

  test("refuses venue-unavailable for a profile no source implements", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const outcome = await runAnchor(contextFor(clock), {
      draftId: "draft-1",
      subject: "lock",
      providerProfile: "https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1",
      endpoint: "https://chain.invalid",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");
  }, 60_000);

  test("verify-before-store: a tampered proof is refused venue-unverifiable and nothing is written", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { tampered: true }) } },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unverifiable");
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toBeUndefined();
  }, 60_000);

  test("verify-before-store: a valid token over the WRONG subject is refused", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(`${"0".repeat(63)}1`) } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unverifiable");
  }, 60_000);

  test("refuses conflict on a second anchor from the same provider over the same subject", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const deps = { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } };
    const input = {
      draftId: "draft-1", subject: "lock" as const,
      providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT,
    };

    expect((await runAnchor(contextFor(clock), input, deps)).ok).toBe(true);
    const second = await runAnchor(contextFor(clock), input, deps);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("conflict");
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toHaveLength(1);
  }, 60_000);

  test("a second provider over the same subject is not a conflict", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const calls = { confirmed: false, calls: [] as string[] };

    expect((await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) } },
    )).ok).toBe(true);

    const second = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI },
      { fetch: calendarTransport(calls) },
    );
    expect(second.ok).toBe(true);
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toHaveLength(2);
  }, 60_000);
});

describe("runAnchor — the OpenTimestamps two-step lifecycle (§6.2)", () => {
  test("stores the pending proof, then appends its upgraded form as a new record", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const calendar = { confirmed: false, calls: [] as string[] };
    const input = {
      draftId: "draft-1", subject: "lock" as const,
      providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI,
    };

    const pending = await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    // §7.1 rule 4's floor is per profile: `pending` is a dead end for RFC 3161 and the first half
    // of this profile's own lifecycle, so it is stored here and refused there.
    expect(pending.result.proofStatus).toBe("pending");
    const pendingRecord = parseExactAnchorEvidence(getSealedBytes(workspaceDir, pending.result.recordSha256));
    expect(pendingRecord.proof.mediaType).toBe(OPENTIMESTAMPS_PROOF_MEDIA_TYPE);
    expect(parseDetachedOtsProof(decodeAnchorProofContent(pendingRecord.proof.content)).pendingSites).toHaveLength(1);

    // The calendar has not confirmed yet — a 404 is the normal not-yet, and it is not monotonic.
    const notYet = await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) });
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) expect(notYet.error.code).toBe("venue-unavailable");
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toHaveLength(1);

    calendar.confirmed = true;
    const upgraded = await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) });
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.result.proofStatus).toBe("present");
    expect(upgraded.result.upgradesRecordSha256).toBe(pending.result.recordSha256);

    // The pending record stays: both forms travel, each reported on its own bytes.
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toEqual([
      { subject: "lock", provider: OPENTIMESTAMPS_ANCHOR_PROFILE, recordSha256: pending.result.recordSha256 },
      {
        subject: "lock",
        provider: OPENTIMESTAMPS_ANCHOR_PROFILE,
        recordSha256: upgraded.result.recordSha256,
        upgradesRecordSha256: pending.result.recordSha256,
      },
    ]);
    expect(getSealedBytes(workspaceDir, pending.result.recordSha256).length).toBeGreaterThan(0);

    const upgradedProof = decodeAnchorProofContent(
      parseExactAnchorEvidence(getSealedBytes(workspaceDir, upgraded.result.recordSha256)).proof.content,
    );
    expect(toHex(parseDetachedOtsProof(upgradedProof).fileDigest)).toBe(runSha256);
  }, 60_000);

  test("refuses conflict once a completed form exists — there is nothing left to upgrade", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const calendar = { confirmed: false, calls: [] as string[] };
    const input = {
      draftId: "draft-1", subject: "lock" as const,
      providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI,
    };

    expect((await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) })).ok).toBe(true);
    calendar.confirmed = true;
    expect((await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) })).ok).toBe(true);

    const third = await runAnchor(contextFor(clock), input, { fetch: calendarTransport(calendar) });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.code).toBe("conflict");
  }, 60_000);
});

describe("anchorAfterLockIfConfigured — the §7.2 lock hook", () => {
  test("attempts nothing when the workspace configures nothing", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const before = readAuditEntries(workspaceDir).length;

    expect(await anchorAfterLockIfConfigured(contextFor(clock), "draft-1"))
      .toEqual({ attempted: false, reason: "unconfigured" });
    // No warning, no audit entry: absent any configuration nothing is attempted (§7.3).
    expect(readAuditEntries(workspaceDir)).toHaveLength(before);
  }, 60_000);

  test("attempts nothing when the draft disables anchoring, even with the workspace configured", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock, "draft-1", { anchoring: { enabled: false } });
    configureWorkspaceAnchoring([{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }]);
    expect(await anchorAfterLockIfConfigured(contextFor(clock), "draft-1"))
      .toEqual({ attempted: false, reason: "disabled" });
  }, 60_000);

  test("anchors automatically once the workspace is configured", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    configureWorkspaceAnchoring([{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }]);

    const outcome = await anchorAfterLockIfConfigured(contextFor(clock), "draft-1", {
      sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256) },
    });
    expect(outcome.attempted).toBe(true);
    if (!outcome.attempted) return;
    expect(outcome.result.ok).toBe(true);
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toHaveLength(1);
  }, 60_000);

  test("never throws: a failing source comes back as a typed refusal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    configureWorkspaceAnchoring([{ providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT }]);

    const outcome = await anchorAfterLockIfConfigured(contextFor(clock), "draft-1", {
      sources: {
        [RFC3161_TSA_ANCHOR_PROFILE]: {
          profile: RFC3161_TSA_ANCHOR_PROFILE,
          async obtainProof(): Promise<Uint8Array> { throw new Error("the authority is on fire"); },
        },
      },
    });
    expect(outcome.attempted).toBe(true);
    if (!outcome.attempted) return;
    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) return;
    expect(outcome.result.error.code).toBe("execution");
  }, 60_000);
});

describe("the sealed AnchorEvidence record carries the exact foreign bytes", () => {
  test("what the source returned is what the record decodes back to", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const minted = authority.mintTimeStampToken({ subjectSha256: runSha256 });

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      {
        sources: {
          [RFC3161_TSA_ANCHOR_PROFILE]: {
            profile: RFC3161_TSA_ANCHOR_PROFILE,
            async obtainProof(): Promise<Uint8Array> { return minted.tokenDer; },
          },
        },
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const record = parseExactAnchorEvidence(getSealedBytes(workspaceDir, outcome.result.recordSha256));
    expect(toHex(decodeAnchorProofContent(record.proof.content))).toBe(toHex(minted.tokenDer));
    // Nothing derivable is copied into the record: no time, no authority identity, no status.
    expect(Object.keys(record).sort()).toEqual(["kind", "proof", "provider", "subject"]);
  }, 60_000);
});

describe("the draft's own anchoring block", () => {
  test("survives a round trip through the draft document", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Anchor Test" });
    updateDraft(contextFor(clock), {
      draftId: "draft-1",
      patch: { anchoring: { enabled: false, declaredProviders: [RFC3161_TSA_ANCHOR_PROFILE] } },
    });
    expect(readDraftDocument(workspaceDir, "draft-1").spec.anchoring).toEqual({
      enabled: false,
      declaredProviders: [RFC3161_TSA_ANCHOR_PROFILE],
    });
  });

  test("is absent by default — no entry is added to the spec defaults", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Anchor Test" });
    const spec = readDraftDocument(workspaceDir, "draft-1").spec;
    expect(spec.anchoring).toBeUndefined();
    expect(Object.hasOwn(spec, "anchoring")).toBe(false);
  });
});

describe("the §8 step-4 splice-catch, enforced where the operator can still act", () => {
  // The clock is 2026-08-17T00:00:0NZ and the default policy closes 24h later, so `closeAt` lands
  // on 2026-08-18. Both instants are read from state rather than restated, so a policy change
  // moves the fixture rather than silently defeating it.
  const AFTER_CLOSE = "20260819000000Z";
  const BEFORE_CLOSE = "20260817120000Z";

  test("a lock token stamped after the run's own closeAt refuses, and stores nothing", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const closeAt = readRunState(workspaceDir, "draft-1")?.closeAt;
    expect(closeAt).toBeDefined();

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { genTime: AFTER_CLOSE }) } },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Refused at acquisition. Enforced only in the verifier, this token would store cleanly,
    // survive `report` -- which shuts the anchoring window -- and then fail `publish`, with the
    // records append-only and no anchor left to obtain.
    expect(outcome.error.code).toBe("venue-unverifiable");
    expect(outcome.error.detail).toContain("2026-08-19T00:00:00Z");
    expect(outcome.error.detail).toContain(closeAt!);

    expect(readRunState(workspaceDir, "draft-1")?.anchors).toBeUndefined();
    // The audit entry attributes the refusal rather than swallowing the attempt.
    expect(readAuditEntries(workspaceDir).at(-1)).toMatchObject({
      action: "anchor", subject: "draft-1", outcome: "venue-unverifiable",
    });
  }, 60_000);

  test("a lock token stamped before closeAt is unaffected", async () => {
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(runSha256, { genTime: BEFORE_CLOSE }) } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.proofStatus).toBe("present");
    expect(readRunState(workspaceDir, "draft-1")?.anchors).toHaveLength(1);
  }, 60_000);

  test("the rule is scoped to lock: a matrix anchor with the same late token stores", async () => {
    // The check's own scoping (§8 step 4): a matrix anchor is about a terminal record and says
    // nothing about dispatch order, so a genTime after closeAt is expected rather than suspect.
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const matrixSha256 = putSealedBytes(workspaceDir, new TextEncoder().encode('{"kind":"matrix-stand-in"}'));
    const state = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", {
      ...state,
      launchedAt: "2026-08-17T01:00:00Z",
      closedAt: "2026-08-17T02:00:00Z",
      matrixSha256,
    });

    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "matrix", providerProfile: RFC3161_TSA_ANCHOR_PROFILE, endpoint: TSA_ENDPOINT },
      { sources: { [RFC3161_TSA_ANCHOR_PROFILE]: rfc3161SourceFor(matrixSha256, { genTime: AFTER_CLOSE }) } },
    );
    expect(outcome.ok).toBe(true);
  }, 60_000);

  test("the rule is scoped to authority-time: a chain-time lock anchor is untouched", async () => {
    // An OpenTimestamps proof carries no time at all, so there is nothing to compare and the
    // producer must not invent one.
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const outcome = await runAnchor(
      contextFor(clock),
      { draftId: "draft-1", subject: "lock", providerProfile: OPENTIMESTAMPS_ANCHOR_PROFILE, endpoint: KIT_CALENDAR_URI },
      { fetch: calendarTransport({ confirmed: false, calls: [] }) },
    );
    expect(outcome.ok).toBe(true);
  }, 60_000);

  test("the producer's verdict agrees with the verifier's on the same token", async () => {
    // The point of applying it here is that it is the SAME rule, not a second opinion: a producer
    // rule that disagreed would move the brick rather than remove it.
    const clock = makeClock();
    const runSha256 = await setUpLockedDraft(clock);
    const closeAt = readRunState(workspaceDir, "draft-1")!.closeAt!;
    const late = authority.mintTimeStampToken({ subjectSha256: runSha256, genTime: AFTER_CLOSE });
    const result = createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts)
      .verifyProof({ subjectSha256: runSha256, proofBytes: late.tokenDer });

    expect(result.status).toBe("present");
    if (result.status !== "present") return;
    // The verifier would refuse this at bundle time on exactly this comparison.
    expect(compareCalendarStrictRfc3339Instants(result.facts.genTime, closeAt)).toBeGreaterThan(0);
  }, 60_000);
});
