import {
  BENCHMARKING_PROTOCOL,
  documentDigest,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { exportEvalLog } from "./evallog.js";

const CELL_KEY = `${"a".repeat(64)}/armA/1`;

function oneCellMatrix(): MatrixRecord {
  return {
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: "b".repeat(64) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [{
      cellKey: CELL_KEY,
      taskDigest: "a".repeat(64),
      armId: "armA",
      replicate: 1,
      dispatches: 1,
      accounted: 1,
      verdicts: [],
      validVerdicts: [],
      outcome: "expired",
      verification: {
        harness: "match",
        model: "match",
        loadout: "match",
        isolation: "match",
        checksFailed: [],
      },
      integrityTier: "attested-only",
    }],
    exclusions: [],
    attrition: {
      perArm: {
        armA: {
          expected: 1,
          judged: 0,
          unjudged: 0,
          unscorable: 0,
          expired: 1,
          invalidated: 0,
          excluded: 0,
          replacements: 0,
        },
      },
      asymmetryFlags: [],
    },
    completeness: {
      expected: 1,
      judged: 0,
      floor: "0",
      runOutcome: "partial",
    },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  } as unknown as MatrixRecord;
}

describe("exportEvalLog evidence resolver", () => {
  test("pins distinctive injected transcript/evidence refs (non-vacuous port use)", async () => {
    const log = await exportEvalLog(oneCellMatrix(), {
      transcriptFor: (cellKey) => `transcript:injected:${cellKey}`,
      evidenceRefFor: (cellKey) => `evidence:injected:${cellKey}`,
    });
    expect(log.samples).toHaveLength(1);
    expect(log.samples[0]!.evidence.transcriptRef).toBe(`transcript:injected:${CELL_KEY}`);
    expect(log.samples[0]!.evidence.evidenceRef).toBe(`evidence:injected:${CELL_KEY}`);
  });

  test("empty resolver falls back to deterministic digests (separate from injected path)", async () => {
    const log = await exportEvalLog(oneCellMatrix(), {});
    expect(log.samples[0]!.evidence.transcriptRef).toBe(
      documentDigest(new TextEncoder().encode(`transcript:${CELL_KEY}`)),
    );
    expect(log.samples[0]!.evidence.evidenceRef).toBe(
      documentDigest(new TextEncoder().encode(`evidence:${CELL_KEY}`)),
    );
  });
});
