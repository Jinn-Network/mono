import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvaluationSpec } from "@jinn-network/task-execution-profiles";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { runGuidedJourney, runLiveHostCommand } from "./guide.js";
import { sealLocalLoadoutDirectory } from "./loadout-archive.js";
import { prepareSweRebenchJourney, type SweRebenchJourneyPorts } from "./swe-rebench-journey.js";

function loadout(root: string, kind: "current" | "candidate") {
  const path = join(root, kind);
  const publicRoot = kind === "current" ? "notes" : "skills";
  mkdirSync(join(path, publicRoot), { recursive: true });
  writeFileSync(join(path, publicRoot, "policy.md"), `${kind} policy\n`);
  return sealLocalLoadoutDirectory(path);
}

function row(index: number, repo = `owner-${index}/repo-${index}`) {
  return {
    instance_id: `owner-${index}__repo-${index}-${100 + index}`,
    repo,
    base_commit: String(index + 1).padStart(40, "a").slice(0, 40),
    problem_statement: `Repair public issue ${index}`,
    created_at: `2026-02-${String((index % 28) + 1).padStart(2, "0")} 01:02:03`,
    image_name: `registry.example/rebench-${index}:latest`,
    test_patch: `diff --git a/test_${index}.py b/test_${index}.py`,
    patch: "GOLD SOLUTION MUST NEVER ENTER PREPARED BYTES",
    FAIL_TO_PASS: [`test_${index}.py::test_fix`],
    PASS_TO_PASS: [`test_${index}.py::test_existing`],
    install_config: {
      install: [],
      test_cmd: [`python -m pytest test_${index}.py`],
      log_parser: "parse_log_pytest",
    },
  };
}

const ports: SweRebenchJourneyPorts = {
  fetchRows: async () => [
    row(0),
    row(99, "owner-0/repo-0"), // same repository: cannot become another provenance group
    row(1), row(2), row(3), row(4), row(5), row(6),
  ],
  resolveImage: async (image) => {
    const ordinal = Number(/rebench-(\d+)/u.exec(image)?.[1] ?? "0");
    const digest = `sha256:${ordinal.toString(16).padStart(64, "0")}`;
    return { source: image, reference: image.replace(/:latest$/u, `@${digest}`), digest };
  },
  resolveHarness: async (id) => ({
    id,
    executable: "/opt/jinn/bin/codex",
    digest: `sha256:${"f".repeat(64)}`,
    version: "codex-cli 1.2.3",
  }),
};

describe("real SWE-rebench journey preparation", () => {
  test("forms six fresh groups, pins images, and writes only after confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-swe-journey-"));
    const stateRoot = join(root, "state");
    const prepared = await prepareSweRebenchJourney({
      stateRoot,
      currentLoadout: loadout(root, "current"),
      candidateLoadout: loadout(root, "candidate"),
      routeName: "swe-rebench-v2",
      harness: "codex",
      model: "gpt-test",
      isolationPolicy: "unrestricted",
      now: () => new Date("2026-08-07T10:00:00Z"),
      ports,
    });

    expect(prepared.campaign.campaign.journey).toBe("confirm-only");
    expect(prepared.campaign.campaign.evidenceAccess.confirmationGroups).toHaveLength(6);
    expect(prepared.split.manifest.groups).toHaveLength(6);
    expect(prepared.split.manifest.assignments.training).toEqual([]);
    expect(prepared.split.manifest.assignments.development).toEqual([]);
    expect(prepared.candidatePayload.highest).toBe("skill");
    expect(existsSync(join(stateRoot, "prepared"))).toBe(false);

    const paths = prepared.persist();
    expect(existsSync(paths.campaign)).toBe(true);
    const unconfirmedRun = await runLiveHostCommand([
      "campaign", "run", "--prepared", paths.root,
    ], root);
    expect(unconfirmedRun?.exitCode).toBe(1);
    expect(unconfirmedRun?.stderr).toContain("Explicit spend confirmation");
    expect(existsSync(join(paths.root, "run"))).toBe(false);
    const runPlan = JSON.parse(readFileSync(paths.runPlan, "utf8")) as {
      candidate: { treeDigest: string };
      campaignDigest: string;
      policyTuples: { candidate: string; current: string };
      promotionBenchmarkDigest: string;
      route: { harness: { digest: string; version: string } };
    };
    expect(runPlan.campaignDigest).toBe(prepared.campaign.digest);
    expect(runPlan.candidate.treeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(runPlan.route.harness).toEqual(expect.objectContaining({
      digest: `sha256:${"f".repeat(64)}`,
      version: "codex-cli 1.2.3",
    }));
    expect(runPlan.policyTuples.current).toBe(prepared.snapshot.snapshot.seed.digest);
    expect(runPlan.policyTuples.candidate).not.toBe(runPlan.policyTuples.current);
    expect(runPlan.promotionBenchmarkDigest).toBe(prepared.promotionBenchmark.digest);
    const benchmark = parseBenchmark(new Uint8Array(readFileSync(paths.promotionBenchmark)));
    expect(benchmark.items).toHaveLength(6);
    expect(benchmark.reveal.policy).toBe("after-run");
    for (const groupId of prepared.split.manifest.assignments.promotion) {
      expect(existsSync(join(
        stateRoot,
        "consumed-confirmation",
        groupId.slice("sha256:".length),
        "consumption.json",
      ))).toBe(true);
    }
    const poolTasks = prepared.split.manifest.poolSnapshot.entries.map((entry) =>
      join(paths.root, "pool", entry.taskDigest.slice("sha256:".length), "task.json"));
    const taskText = poolTasks.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(taskText).toContain('"timestamp":"2026-02-01T01:02:03Z"');
    expect(taskText).not.toContain("GOLD SOLUTION");

    for (const entry of prepared.split.manifest.poolSnapshot.entries) {
      const specPath = join(paths.root, "pool", entry.taskDigest.slice("sha256:".length), "evaluation-spec.json");
      const spec = parseEvaluationSpec(new Uint8Array(readFileSync(specPath)));
      const block = spec.familyBlock as {
        image: { uri?: string; digest?: { sha256?: string } };
        "network.jinn.policy-optimization.requires-public-network"?: unknown;
      };
      const image = block.image;
      expect(image.uri).toMatch(/^docker:\/\/registry\.example\/rebench-\d+@sha256:[a-f0-9]{64}$/u);
      expect(image.digest?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(block["network.jinn.policy-optimization.requires-public-network"]).toBe(true);
    }

    writeFileSync(join(root, "candidate", "skills", "policy.md"), "another candidate policy\n");
    const reused = await prepareSweRebenchJourney({
      stateRoot,
      currentLoadout: loadout(root, "current"),
      candidateLoadout: sealLocalLoadoutDirectory(join(root, "candidate")),
      routeName: "swe-rebench-v2",
      harness: "codex",
      model: "gpt-test",
      isolationPolicy: "unrestricted",
      now: () => new Date("2026-08-07T11:00:00Z"),
      source: { config: "default", split: "2026_02", fetchLimit: 8, confirmationGroups: 1 },
      ports,
    });
    expect(reused.split.manifest.groups).toHaveLength(1);
    expect(reused.split.manifest.groups[0]?.members).toEqual(["owner-6__repo-6-106"]);
    expect(reused.split.manifest.exclusions.length).toBeGreaterThanOrEqual(6);
    expect(reused.split.manifest.exclusions.every((entry) =>
      entry.reason === "previously-attempted")).toBe(true);
  });

  test("bare guided mode reaches the same real preparation without an authored document", async () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-swe-guide-"));
    loadout(root, "current");
    loadout(root, "candidate");
    const answers = [
      "1", "", "current", "candidate", "", "gpt-test", "", "state", "yes",
    ];
    let output = "";
    const result = await runGuidedJourney({
      cwd: root,
      now: () => new Date("2026-08-07T10:00:00Z"),
      prepareJourney: (input) => prepareSweRebenchJourney({ ...input, ports }),
      io: {
        question: async () => answers.shift() ?? "",
        write: (text) => { output += text; },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Test a change");
    expect(output).toContain("6 confirm groups");
    expect(output).toContain("no executable loadout roots detected");
    expect(result.stdout).toContain("No solver was dispatched");
    expect(existsSync(join(root, "state", "prepared"))).toBe(true);
  });
});
