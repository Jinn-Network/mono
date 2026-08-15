import { sha256Hex } from "../hashing.js";
import { itemTaskDigest, type BenchmarkRecord } from "./schema.js";

export interface RevealCoverage {
  revealed: number;
  committed: number;
}

/**
 * Named check `reveal-consistency` (§6.4): verifies revealed Task bytes against the Benchmark's
 * committed item digests, and reports reveal coverage (revealed / committed counts) so a
 * partially revealed benchmark is flagged rather than silently accepted. `revealed` maps a
 * committed Task digest to the claimed revealed bytes; an item absent from the map is simply
 * unrevealed (counted in `committed`, not in `revealed`, and never a failure by itself) — only a
 * present-but-mismatching digest is a `reveal-consistency` failure (tampering).
 */
export function checkRevealConsistency(
  rec: BenchmarkRecord,
  revealed: ReadonlyMap<string, Uint8Array>,
): { ok: true; coverage: RevealCoverage } | { ok: false; mismatched: string[]; coverage: RevealCoverage } {
  const committed = rec.items.length;
  const mismatched: string[] = [];
  let revealedCount = 0;
  for (const item of rec.items) {
    const digest = itemTaskDigest(item);
    const bytes = revealed.get(digest);
    if (bytes === undefined) continue;
    if (sha256Hex(bytes) === digest) {
      revealedCount += 1;
    } else {
      mismatched.push(digest);
    }
  }
  const coverage: RevealCoverage = { revealed: revealedCount, committed };
  if (mismatched.length > 0) return { ok: false, mismatched, coverage };
  return { ok: true, coverage };
}
