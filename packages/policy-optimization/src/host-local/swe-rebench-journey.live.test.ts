import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sealLocalLoadoutDirectory } from "./loadout-archive.js";
import { prepareSweRebenchJourney } from "./swe-rebench-journey.js";

function liveLoadout(root: string, name: string, text: string) {
  const path = join(root, name);
  mkdirSync(join(path, "notes"), { recursive: true });
  writeFileSync(join(path, "notes", "policy.md"), text);
  return sealLocalLoadoutDirectory(path);
}

test.skipIf(process.env["JINN_POLICY_OPTIMIZATION_REAL_SOURCE"] !== "1")(
  "real public SWE-rebench source yields six sha256-pinned independent groups",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-real-swe-source-"));
    const prepared = await prepareSweRebenchJourney({
      stateRoot: join(root, "state"),
      currentLoadout: liveLoadout(root, "current", "Current public policy.\n"),
      candidateLoadout: liveLoadout(root, "candidate", "Candidate public policy.\n"),
      routeName: "swe-rebench-v2",
      harness: "codex",
      model: "gpt-real-source-probe",
      isolationPolicy: "unrestricted",
      now: () => new Date("2026-08-07T10:00:00Z"),
    });
    expect(prepared.split.manifest.groups).toHaveLength(6);
    expect(new Set(prepared.split.manifest.groups.flatMap((group) => group.repositories)).size).toBe(6);
    expect(prepared.split.manifest.poolSnapshot.entries).toHaveLength(6);
    expect(prepared.campaign.campaign.executionCells.confirmation).toBe(12);
  },
  90_000,
);
