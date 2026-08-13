/**
 * Negative coverage for the signature-verifying trust resolver in `buildRunAssemblyPorts`
 * (BP-21 review finding 1): the fail-closed branches of `resolveEvaluatorClaim` are exercised
 * directly through the port these tests build — without them, replacing the Ed25519
 * verification with `return true` would be caught by nothing (every other suite only feeds the
 * resolver honestly-signed verdicts, so forgery ACCEPTANCE was invisible). One positive control
 * proves the fixtures themselves are resolvable, so each negative case fails for the reason it
 * names, not because the fixture is broken.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requirementsDigest, type LocalCellPinningEvidence } from "@jinn-network/benchmarking-local";
import type { RunRecord } from "@jinn-network/benchmarking-records";
import type { AssemblyPorts, InScopeCell } from "@jinn-network/benchmarking-run";
import { dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { loadOrCreateEvaluatorSigningKeys, type VerdictSigningKey } from "../venue/signing.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { buildAssemblyPortsFromFacts, buildRunAssemblyPorts } from "./assembly-ports.js";
import { writeCancelMarker } from "./cancel-marker.js";

const EVALUATOR_1 = "urn:jinn:benchmark-product:local-venue:evaluator-1";
const EVALUATOR_2 = "urn:jinn:benchmark-product:local-venue:evaluator-2";
const OWNER = "urn:uuid:11111111-1111-5111-8111-111111111111";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp21-assembly-ports-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** The trust port only reads `runRecord.policy.submissionBaseline` at construction time, so a
 * minimal cast keeps this a unit test of the resolver, not a full run fixture. */
function buildPorts(draftId = "draft-1"): AssemblyPorts {
  return buildRunAssemblyPorts({
    workspaceDir,
    draftId,
    runRecord: { policy: { submissionBaseline: {} } } as unknown as RunRecord,
    expected: [],
    fold: new Map(),
    owner: OWNER,
    receiptsByTaskDigest: new Map(),
  });
}

/** Seals a stand-in verdict envelope whose one signature is produced by `sign` under `keyid`. */
function sealEnvelopeSignedBy(sign: (preAuthEncoding: Uint8Array) => Uint8Array, keyid: string): string {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ predicate: { standIn: "verdict statement" } }));
  const envelope = sealDsseEnvelope({
    payloadBytes,
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    signatures: [{ signature: sign(dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, payloadBytes)), keyid }],
  });
  return `sha256:${putSealedBytes(workspaceDir, envelope)}`;
}

function resolveEvaluator(ports: AssemblyPorts, claim: string, verdictDigest: string): Promise<string | "unresolved"> {
  return ports.trust.resolveAgent({ cellKey: "cell-1", role: "evaluator", claim, verdictDigest }, new Date());
}

function mintKeys(): { key1: VerdictSigningKey; key2: VerdictSigningKey } {
  const keys = loadOrCreateEvaluatorSigningKeys(workspaceDir, [{ id: EVALUATOR_1 }, { id: EVALUATOR_2 }]);
  return { key1: keys[0]!.key, key2: keys[1]!.key };
}

describe("buildRunAssemblyPorts trust resolver — signature-verified, fail-closed", () => {
  it("positive control: a verdict genuinely signed by the claimed evaluator's registered key resolves; solver resolves to the owner", async () => {
    const { key1 } = mintKeys();
    const ports = buildPorts();
    const verdictDigest = sealEnvelopeSignedBy((preAuth) => key1.sign(preAuth), key1.keyId);

    await expect(resolveEvaluator(ports, EVALUATOR_1, verdictDigest)).resolves.toBe(EVALUATOR_1);
    await expect(ports.trust.resolveAgent({ cellKey: "cell-1", role: "solver" }, new Date())).resolves.toBe(OWNER);
  });

  it("(a) cross-key forgery: an envelope claiming evaluator-2 but signed with evaluator-1's key resolves 'unresolved'", async () => {
    const { key1 } = mintKeys();
    const ports = buildPorts();
    // Signed by evaluator-1's real key — but the claim names evaluator-2, whose registered key
    // did NOT produce this signature. Accepting this claim would let any workspace key
    // impersonate any evaluator identity.
    const verdictDigest = sealEnvelopeSignedBy((preAuth) => key1.sign(preAuth), key1.keyId);

    await expect(resolveEvaluator(ports, EVALUATOR_2, verdictDigest)).resolves.toBe("unresolved");
  });

  it("(b) garbage signature: an envelope whose signature bytes verify against no key resolves 'unresolved'", async () => {
    mintKeys();
    const ports = buildPorts();
    const verdictDigest = sealEnvelopeSignedBy(() => new Uint8Array(64).fill(7), "garbage-key");

    await expect(resolveEvaluator(ports, EVALUATOR_1, verdictDigest)).resolves.toBe("unresolved");
  });

  it("(c) unknown claim: a claim IRI not in the workspace registry resolves 'unresolved' even over a genuinely signed envelope", async () => {
    const { key1 } = mintKeys();
    const ports = buildPorts();
    const verdictDigest = sealEnvelopeSignedBy((preAuth) => key1.sign(preAuth), key1.keyId);

    await expect(resolveEvaluator(ports, "urn:jinn:unknown:party", verdictDigest)).resolves.toBe("unresolved");
  });

  it("(d) missing sealed bytes: a verdictDigest with no stored envelope resolves 'unresolved', never throws", async () => {
    mintKeys();
    const ports = buildPorts();

    await expect(resolveEvaluator(ports, EVALUATOR_1, `sha256:${"e".repeat(64)}`)).resolves.toBe("unresolved");
  });
});

describe("buildAssemblyPortsFromFacts isolation inventory", () => {
  async function isolationStatus(isolationPolicy: string) {
    const cell = {
      cellKey: "cell-1",
      armId: "arm-1",
      replicate: 1,
      taskDigest: "a".repeat(64),
      dispatches: 1,
      verdicts: [],
    };
    const ports = buildAssemblyPortsFromFacts({
      runRecord: {
        policy: { submissionBaseline: { isolationPolicy } },
      } as unknown as RunRecord,
      cells: [cell],
      owner: OWNER,
      runCancelled: false,
      receiptsByTaskDigest: new Map(),
      resolveBytes: () => new Uint8Array(),
      evaluatorKeys: () => new Map(),
    });
    return ports.pinning.observe(undefined, {
      cellKey: cell.cellKey,
      arm: { pinning: {} },
    });
  }

  it("preserves the native venue's singleton vacuous match", async () => {
    await expect(isolationStatus("unrestricted")).resolves.toMatchObject({ isolation: "match" });
  });

  it("makes OCI isolation unverifiable because the configured venue admits two policies", async () => {
    await expect(isolationStatus("oci-container")).resolves.toMatchObject({ isolation: "unverifiable" });
  });
});

describe("buildRunAssemblyPorts — runCancelled derivation (BP-22)", () => {
  it("is absent from inputScope when no cancel marker exists for the draft", () => {
    const ports = buildPorts("draft-1");
    expect(ports.inputScope.runCancelled).toBeUndefined();
  });

  it("is true once a cancel marker exists for the draft", () => {
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    const ports = buildPorts("draft-1");
    expect(ports.inputScope.runCancelled).toBe(true);
  });

  it("does not leak across draftIds — a marker for a different draft leaves this one un-cancelled", () => {
    writeCancelMarker(workspaceDir, "draft-other", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    const ports = buildPorts("draft-1");
    expect(ports.inputScope.runCancelled).toBeUndefined();
  });
});

const PINNING_CELL_KEY = `${"a".repeat(64)}/candidate/1`;
const PINNING = {
  harness: { id: "claude-code", version: "2.1.34" },
  model: { id: "claude-haiku-4-5-20251001" },
  loadout: { kind: "jinn.skill.v1", name: "candidate", digest: "b".repeat(64) },
  isolationPolicy: "unrestricted",
};

function pinningCell(dispatches: number, evidenceRef?: LocalCellPinningEvidence): InScopeCell {
  return {
    cellKey: PINNING_CELL_KEY,
    armId: "candidate",
    replicate: 1,
    taskDigest: "a".repeat(64),
    dispatches,
    verdicts: [],
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
  };
}

function pinningPorts(cells: readonly InScopeCell[]): AssemblyPorts {
  return buildAssemblyPortsFromFacts({
    runRecord: { policy: { submissionBaseline: {} } } as RunRecord,
    cells,
    owner: OWNER,
    runCancelled: false,
    receiptsByTaskDigest: new Map(),
    resolveBytes: () => new Uint8Array(),
    evaluatorKeys: () => new Map(),
  });
}

async function observePinning(cells: readonly InScopeCell[]) {
  return pinningPorts(cells).pinning.observe(undefined, {
    cellKey: PINNING_CELL_KEY,
    arm: { armId: "candidate", pinning: PINNING },
  });
}

describe("product pinning assembly uses only durable real evidence (P2b)", () => {
  it("an exact digest-bound admission proof earns match", async () => {
    await expect(observePinning([pinningCell(1, {
      admission: { ready: true, checkedRequirementsDigest: requirementsDigest(PINNING) },
    })])).resolves.toEqual({
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
    });
  });

  it("missing cell evidence is unverifiable on every axis", async () => {
    await expect(observePinning([])).resolves.toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
    });
  });

  it("affirmative contradictory evidence remains mismatch", async () => {
    const result = await observePinning([pinningCell(1, {
      observations: [{ axis: "model", value: { id: "claude-opus-4-1" }, source: "runtime-observation" }],
    })]);
    expect(result.model).toBe("mismatch");
  });

  it("a dispatched cell without proof never matches an enforced axis", async () => {
    await expect(observePinning([pinningCell(1)])).resolves.toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      // Isolation remains the explicitly disclosed vacuous inventory result; it does not rely
      // on verifyRunPinning and is not an enforced identity axis.
      isolation: "match",
    });
  });
});
