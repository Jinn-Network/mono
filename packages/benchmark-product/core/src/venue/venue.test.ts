import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { SAMPLE_REPOSITORY_WORK_LAUNCHER_ID } from "./sample-repository-work.js";
import { createLocalVenue, EVALUATOR_REQUIREMENT_KEY, type LocalVenue } from "./venue.js";
import {
  DEMO1_CLAUDE_MODEL_ID,
  createDemo1ClaudeRuntimeBinding,
  demo1ClaudeArmRequirements,
  generateDemo1InstructionArtifacts,
} from "./demo1-claude.js";

const NOW = (): string => new Date().toISOString();

let workspaceDir: string;
let venue: LocalVenue | undefined;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "bp21-venue-"));
  venue = undefined;
});

afterEach(async () => {
  await venue?.shutdown();
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("createLocalVenue evaluators", () => {
  it("refuses an evaluatorCount that is not an integer >= 1", () => {
    for (const evaluatorCount of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        createLocalVenue({ workspaceDir, now: NOW, evaluatorCount });
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, String(evaluatorCount)).toBeInstanceOf(BenchmarkProductError);
      expect((thrown as BenchmarkProductError).code).toBe("validation");
    }
  });

  it("defaults to one evaluator and keeps verdictKeyId = evaluators[0].keyId", () => {
    venue = createLocalVenue({ workspaceDir, now: NOW });
    expect(venue.evaluators.map((evaluator) => evaluator.id)).toEqual([
      "urn:jinn:benchmark-product:local-venue:evaluator-1",
    ]);
    expect(venue.evaluators[0]!.keyId).toMatch(/^benchmark-product-verdict-[0-9a-f]{16}$/);
    expect(venue.verdictKeyId).toBe(venue.evaluators[0]!.keyId);
  });

  it("mints N ordered evaluator identities with distinct signing keys", () => {
    venue = createLocalVenue({ workspaceDir, now: NOW, evaluatorCount: 3 });
    expect(venue.evaluators.map((evaluator) => evaluator.id)).toEqual([
      "urn:jinn:benchmark-product:local-venue:evaluator-1",
      "urn:jinn:benchmark-product:local-venue:evaluator-2",
      "urn:jinn:benchmark-product:local-venue:evaluator-3",
    ]);
    expect(new Set(venue.evaluators.map((evaluator) => evaluator.keyId)).size).toBe(3);
  });

  it("declares the evaluator requirement key on the backend with the evaluator IRIs as inventory", async () => {
    venue = createLocalVenue({ workspaceDir, now: NOW, evaluatorCount: 2 });
    const capabilities = await venue.backend.capabilities();
    const support = capabilities.runPinning.keys.find((key) => key.key === EVALUATOR_REQUIREMENT_KEY);
    expect(support).toEqual({
      key: EVALUATOR_REQUIREMENT_KEY,
      inventory: [
        "urn:jinn:benchmark-product:local-venue:evaluator-1",
        "urn:jinn:benchmark-product:local-venue:evaluator-2",
      ],
      posture: "enforced",
    });
  });

  it("generates a deployment module carrying one registration per evaluator", async () => {
    venue = createLocalVenue({ workspaceDir, now: NOW, evaluatorCount: 2 });
    const source = await readFile(join(workspaceDir, "venue", "evaluation-deployment.mjs"), "utf8");
    expect(source).toContain("\"prediction-market:evaluator-1\"");
    expect(source).toContain("\"prediction-market:evaluator-2\"");
    expect(source).toContain("\"urn:jinn:benchmark-product:local-venue:evaluator-1\"");
    expect(source).toContain("\"urn:jinn:benchmark-product:local-venue:evaluator-2\"");
    expect(source).toContain("createPredictionEvaluatorRegistration");
    expect(source).toContain("validateEvaluatorRegistrationSet");
    expect(source).toContain("evaluatorAdaptersParserAllowlist");
  });
});

describe("createLocalVenue task-profile admission", () => {
  it("advertises all three served profiles in backend capabilities", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "venue-profiles-"));
    mkdirSync(join(workspaceDir, "venue"), { recursive: true });
    const venue = createLocalVenue({ workspaceDir, now: NOW });
    try {
      const capabilities = await venue.backend.capabilities();
      expect([...capabilities.taskProfiles].sort()).toEqual([
        "https://spec.jinn.network/task-profiles/evaluation-task/1.0",
        "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
        "https://spec.jinn.network/task-profiles/repository-work/1.0",
      ]);
      const harness = capabilities.runPinning.keys.find((key) => key.key === "harness");
      expect(harness?.inventory).toContain(SAMPLE_REPOSITORY_WORK_LAUNCHER_ID);
    } finally {
      await venue.shutdown();
    }
  });

  it("still refuses an unknown task profile, typed", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "venue-profiles-unknown-"));
    mkdirSync(join(workspaceDir, "venue"), { recursive: true });
    const venue = createLocalVenue({ workspaceDir, now: NOW });
    try {
      // The venue's `resolveTaskProfile` is the backend's sole profile resolver; an unserved URI
      // must refuse rather than fall through to a default.
      await expect(
        venue.backend.preflight({ taskProfile: "https://spec.jinn.network/task-profiles/nope/1.0" }),
      ).resolves.toMatchObject({ ready: false });
    } finally {
      await venue.shutdown();
    }
  });
});

describe("createLocalVenue Demo-1 Claude deployment", () => {
  function demo1Runtime() {
    const artifacts = generateDemo1InstructionArtifacts(new TextEncoder().encode("frozen body\n"), {
      name: "demo1",
      description: "Use for repository tasks.",
    });
    return createDemo1ClaudeRuntimeBinding({
      executablePath: process.execPath,
      harnessVersion: process.version,
      artifacts,
      command: async (_path, args) => args[0] === "auth"
        ? { stdout: '{"loggedIn":true}' }
        : { stdout: `${process.version} (Claude Code)\n` },
    });
  }

  it("advertises exact enforced model/effort inventory and dynamically verifies exact pins", async () => {
    const runtime = demo1Runtime();
    venue = createLocalVenue({ workspaceDir, now: NOW, demo1ClaudeRuntime: runtime });
    const capabilities = await venue.backend.capabilities();
    expect(capabilities.runPinning.keys.find((entry) => entry.key === "model"))
      .toEqual({ key: "model", inventory: [DEMO1_CLAUDE_MODEL_ID], posture: "enforced" });
    expect(capabilities.runPinning.keys.find((entry) => entry.key === "effort")?.inventory)
      .toEqual(["high"]);

    const pinned = demo1ClaudeArmRequirements(runtime, "skill");
    await expect(venue.backend.preflight({
      taskProfile: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      requirements: pinned,
    })).resolves.toMatchObject({ ready: true });
    await expect(venue.backend.preflight({
      taskProfile: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      requirements: { ...pinned, model: { id: "claude-other" } },
    })).resolves.toMatchObject({ ready: false });
    await expect(venue.backend.preflight({
      taskProfile: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      requirements: {
        ...pinned,
        loadout: { ...runtime.artifacts.skill, digest: { sha256: "0".repeat(64) } },
      },
    })).resolves.toMatchObject({ ready: false });
  });

  it("admits true no-file C without adding a loadout pin", async () => {
    const runtime = demo1Runtime();
    venue = createLocalVenue({ workspaceDir, now: NOW, demo1ClaudeRuntime: runtime });
    const requirements = demo1ClaudeArmRequirements(runtime, "no-file");
    expect(requirements).not.toHaveProperty("loadout");
    await expect(venue.backend.preflight({
      taskProfile: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      requirements,
    })).resolves.toMatchObject({ ready: true });
  });
});
