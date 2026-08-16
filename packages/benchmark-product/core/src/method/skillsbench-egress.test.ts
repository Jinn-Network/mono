import { describe, expect, it } from "vitest";
import {
  SKILLSBENCH_DENIED_HOSTS,
  SKILLSBENCH_EGRESS_POLICY,
  deriveSkillsBenchEgressPlan,
  extractEgressHosts,
  isDeniedEgressHost,
  verifySkillsBenchEgressPlan,
  type SkillsBenchEgressInput,
} from "./skillsbench-egress.js";
import { buildSkillsBenchUnit, type SkillsBenchUnitBuildInput } from "./skillsbench-unit.js";

const SKILL_MD = `---\nname: citation\ndescription: Check citations.\n---\n\nQuery https://api.crossref.org/works for each DOI.\n`;

function unitInput(networkMode = "public"): SkillsBenchUnitBuildInput {
  return {
    task: { name: "citation-check", treeSha: "a".repeat(40), packageDigest: "b".repeat(64) },
    statement: {
      path: "task.md",
      gitBlob: "c".repeat(40),
      bytes: 50,
      frontmatter: { networkMode, verifierType: "test-script", agentTimeoutSec: 900, verifierTimeoutSec: 900 },
      body: "Identify the fake citations.",
    },
    entries: [
      { path: "task.md", mode: "100644", gitBlob: "c".repeat(40), bytes: 50 },
      { path: "environment/Dockerfile", mode: "100644", gitBlob: "d".repeat(40), bytes: 200 },
      { path: "environment/skills/citation/SKILL.md", mode: "100644", gitBlob: "e".repeat(40), bytes: SKILL_MD.length },
      { path: "oracle/solve.sh", mode: "100755", gitBlob: "f".repeat(40), bytes: 10 },
      { path: "verifier/test.sh", mode: "100755", gitBlob: "1".repeat(40), bytes: 10 },
    ],
    skills: [{ folder: "citation", skillMd: SKILL_MD }],
    rootLicenseSpdxId: "Apache-2.0",
  };
}

function input(overrides: Partial<SkillsBenchEgressInput> = {}, networkMode = "public"): SkillsBenchEgressInput {
  return {
    unit: buildSkillsBenchUnit(unitInput(networkMode)),
    agentVisibleText: "Query https://api.crossref.org/works and https://api.semanticscholar.org/graph.",
    verifierText: "curl -LsSf https://astral.sh/uv/0.9.7/install.sh | sh",
    environmentText: "FROM ubuntu:24.04\nRUN pip3 install requests",
    ...overrides,
  };
}

describe("per-unit egress policy", () => {
  it("runs a no-network unit fully offline", () => {
    const plan = deriveSkillsBenchEgressPlan(input({}, "no-network"));
    expect(plan.decision).toBe("offline");
    expect(plan.network).toBe("none");
    expect(plan.agentAllowlist).toEqual([]);
    expect(() => verifySkillsBenchEgressPlan(plan)).not.toThrow();
  });

  it("derives a broker-only allowlist from the unit's own bytes", () => {
    const plan = deriveSkillsBenchEgressPlan(input());
    expect(plan.policy).toBe(SKILLSBENCH_EGRESS_POLICY);
    expect(plan.decision).toBe("broker-only");
    expect(plan.network).toBe("broker-only");
    expect(plan.agentAllowlist).toEqual(["api.crossref.org", "api.semanticscholar.org"]);
    expect(() => verifySkillsBenchEgressPlan(plan)).not.toThrow();
  });

  it("gives the verifier its own hosts on top of the agent's, never the reverse", () => {
    const plan = deriveSkillsBenchEgressPlan(input());
    expect(plan.verifierAllowlist).toContain("astral.sh");
    expect(plan.verifierAllowlist).toContain("api.crossref.org");
    // A verifier-only dependency must not widen what the agent can reach.
    expect(plan.agentAllowlist).not.toContain("astral.sh");
  });

  describe("answer-bearing hosts", () => {
    it.each([...SKILLSBENCH_DENIED_HOSTS])("denies %s", (host) => {
      expect(isDeniedEgressHost(host)).toBe(true);
    });

    it.each([
      "gist.github.com",
      "raw.githubusercontent.com",
      "mirror.skillsbench.ai",
      "cdn.benchflow.ai",
      "datasets.huggingface.co",
    ])("denies the mirror or subdomain %s", (host) => {
      expect(isDeniedEgressHost(host)).toBe(true);
    });

    it("makes a unit ineligible when the agent needs a denied host", () => {
      // This is the case the whole policy exists for: the agent could fetch its own task's oracle.
      const plan = deriveSkillsBenchEgressPlan(input({
        agentVisibleText: "Clone https://github.com/benchflow-ai/skillsbench for reference data.",
      }));
      expect(plan.decision).toBe("ineligible");
      expect(plan.network).toBe("none");
      expect(plan.agentAllowlist).toEqual([]);
      expect(plan.ineligibleReasons).toContain("agent-requires-denied-host:github.com");
    });

    it("does not reject a unit for a denied host the VERIFIER reaches", () => {
      // Different moment. The verifier runs after the solve is sealed, so it cannot hand the agent
      // an answer. It just never inherits that host in its own allowlist.
      const plan = deriveSkillsBenchEgressPlan(input({
        verifierText: "curl https://raw.githubusercontent.com/x/y/main/expected.json",
      }));
      expect(plan.decision).toBe("broker-only");
      expect(plan.verifierAllowlist).not.toContain("raw.githubusercontent.com");
    });

    it("does not reject a unit for a denied host the IMAGE BUILD reaches", () => {
      // Also a different moment: the build finishes before the agent exists and its result is
      // frozen into a digest-pinned image, so nothing it fetched is reachable at solve time.
      const plan = deriveSkillsBenchEgressPlan(input({
        environmentText: "RUN git clone https://github.com/benchflow-ai/skillsbench /opt/src",
      }));
      expect(plan.decision).toBe("broker-only");
      expect(plan.agentAllowlist).not.toContain("github.com");
    });
  });

  it("runs a public unit with no agent-time network when it names no host", () => {
    // Fail-safe, not a guess. If the task really needs egress to be solvable, its oracle fails
    // offline in the dynamic control and the unit is rejected on evidence instead of assumption.
    const plan = deriveSkillsBenchEgressPlan(input({ agentVisibleText: "Solve the task offline." }));
    expect(plan.decision).toBe("offline");
    expect(plan.network).toBe("none");
    expect(plan.agentAllowlist).toEqual([]);
  });

  it("gives every unit the fixed build-time infrastructure allowlist", () => {
    // Package indexes serve versioned third-party software, never a task's oracle or expected
    // output. The list is fixed and content-independent — it does not grow to rescue a unit.
    for (const mode of ["public", "no-network"]) {
      const plan = deriveSkillsBenchEgressPlan(input({}, mode));
      expect(plan.buildAllowlist).toContain("pypi.org");
      expect(plan.buildAllowlist).toContain("archive.ubuntu.com");
      for (const host of plan.buildAllowlist) expect(isDeniedEgressHost(host)).toBe(false);
    }
  });

  it("is deterministic and order-independent in its allowlist", () => {
    const a = deriveSkillsBenchEgressPlan(input());
    const b = deriveSkillsBenchEgressPlan(input({
      agentVisibleText: "Query https://api.semanticscholar.org/graph and https://api.crossref.org/works.",
    }));
    expect(a.agentAllowlist).toEqual(b.agentAllowlist);
  });

  describe("host extraction", () => {
    it("finds distinct http(s) hosts and normalizes case and trailing dots", () => {
      expect(extractEgressHosts("see HTTPS://API.Crossref.ORG/works and http://api.crossref.org/x"))
        .toEqual(["api.crossref.org"]);
    });

    it("ignores bare words that are not hosts", () => {
      expect(extractEgressHosts("use the references directory and the assets folder")).toEqual([]);
    });

    it("keeps the port off the host", () => {
      expect(extractEgressHosts("http://example.com:8080/x")).toEqual(["example.com"]);
    });
  });

  describe("plan verification", () => {
    it("refuses a plan that dropped a denied host from its floor", () => {
      const plan = deriveSkillsBenchEgressPlan(input());
      const weakened = { ...plan, deniedHosts: plan.deniedHosts.filter((h) => h !== "github.com") };
      expect(() => verifySkillsBenchEgressPlan(weakened)).toThrow(/dropped denied host/u);
    });

    it("refuses a plan whose allowlist was hand-edited to include a denied host", () => {
      const plan = deriveSkillsBenchEgressPlan(input());
      const forged = { ...plan, agentAllowlist: [...plan.agentAllowlist, "github.com"], verifierAllowlist: [...plan.verifierAllowlist, "github.com"] };
      expect(() => verifySkillsBenchEgressPlan(forged)).toThrow(/reaches denied host/u);
    });

    it("refuses a plan where the agent may reach what the verifier may not", () => {
      const plan = deriveSkillsBenchEgressPlan(input());
      const forged = { ...plan, agentAllowlist: [...plan.agentAllowlist, "example.com"] };
      expect(() => verifySkillsBenchEgressPlan(forged)).toThrow(/but the verifier may not/u);
    });

    it("refuses an offline plan that smuggled in an allowlist", () => {
      const plan = deriveSkillsBenchEgressPlan(input({}, "no-network"));
      const forged = { ...plan, agentAllowlist: ["example.com"], verifierAllowlist: ["example.com"] };
      expect(() => verifySkillsBenchEgressPlan(forged)).toThrow(/must carry no egress/u);
    });

    it("refuses a broker-only plan with an empty allowlist", () => {
      const plan = deriveSkillsBenchEgressPlan(input());
      const forged = { ...plan, agentAllowlist: [], verifierAllowlist: [] };
      expect(() => verifySkillsBenchEgressPlan(forged)).toThrow(/must name at least one permitted host/u);
    });
  });
});
