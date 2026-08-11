import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonBytes, prefixedDigest } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import {
  LIVE_CAMPAIGN_AUTHORING_FORMAT_TOKEN,
  compileLiveCampaignInputs,
} from "./live-campaign-inputs.js";
import { captureNextRunPolicySnapshot, sealNextRunPolicySnapshot } from "./next-run-policy-snapshot.js";
import { formPolicyOptimizationSplit, type SplitPoolCandidate } from "./split-manifest.js";
import {
  compilePrepareArguments,
  liveCampaignConfirmationSummary,
  runGuidedJourney,
} from "./host-local/guide.js";

function snapshot() {
  const rows = JSON.parse(readFileSync(
    new URL("../fixtures/adapters/outcomes-golden.json", import.meta.url), "utf8",
  )) as { task: unknown; submission: unknown; profile: { sealedBytes: string; profile: string; requirementKeys: [] } }[];
  const row = rows[0]!;
  const task = canonicalJsonBytes(row.task);
  const submission = canonicalJsonBytes(row.submission);
  const profile = new Uint8Array(Buffer.from(row.profile.sealedBytes, "base64"));
  const loadout = new TextEncoder().encode("notes/public.md\nPublic learner notes.\n");
  return sealNextRunPolicySnapshot(captureNextRunPolicySnapshot({
    configRevisionBefore: "revision-7",
    configRevisionAfter: "revision-7",
    resolutions: [{
      route: { taskProfile: row.profile.profile, route: "nightly" },
      task: { bytes: task, digest: prefixedDigest(task) },
      submission: { bytes: submission, digest: prefixedDigest(submission) },
      profile: {
        bytes: profile, digest: prefixedDigest(profile), profile: row.profile.profile,
        requirementKeys: row.profile.requirementKeys,
      },
      loadout: { bytes: loadout, digest: prefixedDigest(loadout) },
    }],
  }));
}

function candidate(index: number): SplitPoolCandidate {
  const exact = (label: string) => {
    const bytes = new TextEncoder().encode(`${label}-${index}`);
    return { bytes, digest: prefixedDigest(bytes) };
  };
  const task = exact("task");
  const evaluationSpec = exact("evaluation");
  const receipt = exact("receipt");
  return {
    id: `work-${index}`,
    task,
    evaluationSpec,
    admission: {
      receiptBytes: receipt.bytes,
      receiptDigest: receipt.digest,
      verified: true,
      positive: true,
      taskDigest: task.digest,
      evaluationSpecDigest: evaluationSpec.digest,
    },
    repository: `org/repo-${index}`,
    sourceLineage: [`source-${index}`],
    workIdentity: `upstream-${index}`,
    tupleClass: "repository-work/1.0",
    compatible: true,
    previouslyAttempted: false,
    contaminated: false,
    scorable: true,
  };
}

describe("live campaign input compilation", () => {
  test("guided, flagged, and authored-document modes seal byte-identical campaign inputs", async () => {
    const captured = snapshot();
    const split = formPolicyOptimizationSplit({
      candidates: Array.from({ length: 13 }, (_, index) => candidate(index)),
      tupleClass: "repository-work/1.0",
      seed: { tupleDigest: captured.snapshot.seed.digest, snapshotDigest: captured.digest },
    });
    const common = {
      snapshotBytes: captured.bytes,
      splitManifestBytes: split.bytes,
      objectivePreset: "more-tasks-succeed@1" as const,
      baselineArm: "current",
      candidateArm: "challenger",
      replicates: 1,
      candidatePayloadRisks: ["hook", "prompt", "hook"],
    };
    const direct = compileLiveCampaignInputs(common);
    const root = mkdtempSync(join(tmpdir(), "jinn-campaign-modes-"));
    writeFileSync(join(root, "snapshot.json"), captured.bytes);
    writeFileSync(join(root, "split.json"), split.bytes);
    const authoringBytes = canonicalJsonBytes({
      formatToken: LIVE_CAMPAIGN_AUTHORING_FORMAT_TOKEN,
      snapshotBase64: Buffer.from(captured.bytes).toString("base64"),
      splitManifestBase64: Buffer.from(split.bytes).toString("base64"),
      objectivePreset: common.objectivePreset,
      baselineArm: common.baselineArm,
      candidateArm: common.candidateArm,
      replicates: common.replicates,
      candidatePayloadRisks: common.candidatePayloadRisks,
    });
    writeFileSync(join(root, "authoring.json"), authoringBytes);
    const flagged = compilePrepareArguments([
      "campaign", "prepare",
      "--snapshot", "snapshot.json",
      "--split", "split.json",
      "--objective", common.objectivePreset,
      "--baseline-arm", common.baselineArm,
      "--candidate-arm", common.candidateArm,
      "--replicates", String(common.replicates),
      "--payload-risk", "hook", "--payload-risk", "prompt", "--payload-risk", "hook",
    ], root).sealed;
    const authored = compilePrepareArguments([
      "campaign", "prepare", "--document", "authoring.json",
    ], root).sealed;
    const answers = ["3", "authoring.json", "state", "yes"];
    const guidedResult = await runGuidedJourney({
      cwd: root,
      io: { question: async () => answers.shift() ?? "", write: () => undefined },
    });
    expect(guidedResult.exitCode).toBe(0);
    function findCampaignInputs(directory: string): Uint8Array | undefined {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const found = findCampaignInputs(path);
          if (found !== undefined) return found;
        } else if (entry.name === "campaign-inputs.json") return new Uint8Array(readFileSync(path));
      }
      return undefined;
    }
    const guidedBytes = findCampaignInputs(join(root, "state"));
    expect(guidedBytes).toEqual(direct.bytes);
    expect(flagged.bytes).toEqual(direct.bytes);
    expect(authored.bytes).toEqual(direct.bytes);
    expect(direct.campaign.journey).toBe("explore-confirm");
    expect(direct.campaign.allocationPreset).toBe("balanced-3-3-6@1");
    expect(direct.campaign.evidenceAccess.exploration.proposerGroups).toHaveLength(3);
    expect(direct.campaign.evidenceAccess.exploration.selectionGroups).toHaveLength(3);
    expect(direct.campaign.evidenceAccess.confirmationGroups).toHaveLength(7);
    expect(direct.campaign.evidenceAccess.challengerSource).toBe("selected-from-exploration");
    expect(direct.campaign.candidatePayloadRisks).toEqual(["hook", "prompt"]);
  });

  test("compiles a preselected challenger straight into fresh confirmation", () => {
    const captured = snapshot();
    const split = formPolicyOptimizationSplit({
      candidates: Array.from({ length: 5 }, (_, index) => candidate(index)),
      tupleClass: "repository-work/1.0",
      seed: { tupleDigest: captured.snapshot.seed.digest, snapshotDigest: captured.digest },
      allocation: { preset: "test-this-change@1" },
    });
    const sealed = compileLiveCampaignInputs({
      snapshotBytes: captured.bytes,
      splitManifestBytes: split.bytes,
      objectivePreset: "more-tasks-succeed@1",
      baselineArm: "current",
      candidateArm: "operator-change",
      replicates: 1,
      candidatePayloadRisks: [],
    });
    expect(sealed.campaign.journey).toBe("confirm-only");
    expect(sealed.campaign.evidenceAccess.exploration).toEqual({
      proposerGroups: [], selectionGroups: [],
    });
    expect(sealed.campaign.evidenceAccess.confirmationGroups).toHaveLength(5);
    expect(sealed.campaign.evidenceAccess.challengerSource).toBe("operator-supplied");
    expect(sealed.campaign.executionCells).toEqual({
      replicates: 1, selection: 0, confirmation: 10, total: 10,
    });
    expect(liveCampaignConfirmationSummary(sealed)).toContain("cannot reach proven");
  });
});
