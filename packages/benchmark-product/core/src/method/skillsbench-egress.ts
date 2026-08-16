import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import type { SkillsBenchUnit } from "./skillsbench-unit.js";

/**
 * The per-unit egress allowlist DR-2026-08-16 Decision 6 mandates.
 *
 * SkillsBench declares only `no-network` or `public`, and 83 of 84 inventoried units declare
 * `public`. Under Demo-1's contamination rule unrestricted public networking is ineligible, because
 * a public-mode agent could fetch its own task's oracle and verifier from GitHub. The policy's own
 * escape hatch is "a separately reviewed mechanism proving that source, oracle, verifier,
 * expected-output, and answer retrieval are impossible" — this module is that mechanism's policy
 * layer.
 *
 * It derives each unit's minimum allowlist from the unit's own bytes, never from a hand-written
 * list, and it refuses any allowlist that could reach answer-bearing material. Enforcement rides
 * the shipped `network: "none" | "broker-only"` seam in `../runtime/inspect/oci.ts`; this module is
 * what decides *what* the broker may pass.
 */
export const SKILLSBENCH_EGRESS_POLICY = "skillsbench-per-unit-allowlist@1" as const;

/**
 * Hosts an agent must never reach, whatever a task claims to need. Every one of these can serve the
 * task's own oracle, verifier, or expected output. The list is a floor: a derived allowlist is
 * refused if it intersects it, and callers may add to it but never remove from it.
 */
export const SKILLSBENCH_DENIED_HOSTS = [
  "api.github.com",
  "benchflow.ai",
  "codeload.github.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "github.com",
  "huggingface.co",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "skillsbench.ai",
  "www.skillsbench.ai",
] as const;

/** Suffixes that catch mirrors and subdomains of the denied hosts. */
const DENIED_SUFFIXES = [
  ".github.com",
  ".githubusercontent.com",
  ".skillsbench.ai",
  ".benchflow.ai",
  ".huggingface.co",
] as const;

const HOST_PATTERN = /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?/gu;
const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

export type SkillsBenchEgressDecision = "offline" | "broker-only" | "ineligible";

export interface SkillsBenchEgressPlan {
  readonly policy: typeof SKILLSBENCH_EGRESS_POLICY;
  readonly taskId: string;
  readonly decision: SkillsBenchEgressDecision;
  readonly network: "none" | "broker-only";
  /** Hosts the agent container may reach. Empty for an offline unit. */
  readonly agentAllowlist: readonly string[];
  /** Hosts the verifier container may reach. Separate from, and never wider than, the agent's. */
  readonly verifierAllowlist: readonly string[];
  readonly deniedHosts: readonly string[];
  readonly ineligibleReasons: readonly string[];
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

/** True when a host is denied outright or is a subdomain of a denied suffix. */
export function isDeniedEgressHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (SKILLSBENCH_DENIED_HOSTS as readonly string[]).includes(normalized)
    || DENIED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Extracts the distinct hosts a text mentions over http(s). */
export function extractEgressHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(HOST_PATTERN)) {
    const host = normalizeHost(match[1]!);
    if (HOST_SHAPE.test(host)) hosts.add(host);
  }
  return [...hosts].sort(compareCodeUnitStrings);
}

export interface SkillsBenchEgressInput {
  readonly unit: SkillsBenchUnit;
  /** Agent-visible text: the task statement plus every instruction body and instruction-bearing resource. */
  readonly agentVisibleText: string;
  /** Verifier-side text: `verifier/*` contents. Its hosts are permitted only to the verifier. */
  readonly verifierText: string;
  /** Environment build text, e.g. the Dockerfile. Build-time hosts are not agent-time hosts. */
  readonly environmentText: string;
}

/**
 * Derives a unit's egress plan from its own bytes.
 *
 * A `no-network` unit runs fully offline. A `public` unit becomes `broker-only` when every host its
 * own source mentions is outside the denied set, and `ineligible` otherwise — there is no path by
 * which a unit that genuinely needs GitHub becomes admissible.
 */
export function deriveSkillsBenchEgressPlan(input: SkillsBenchEgressInput): SkillsBenchEgressPlan {
  const taskId = input.unit.task.name;
  const base = {
    policy: SKILLSBENCH_EGRESS_POLICY,
    taskId,
    deniedHosts: [...SKILLSBENCH_DENIED_HOSTS],
  } as const;

  if (input.unit.statement.frontmatter.networkMode === "no-network") {
    return {
      ...base,
      decision: "offline",
      network: "none",
      agentAllowlist: [],
      verifierAllowlist: [],
      ineligibleReasons: [],
    };
  }

  const agentHosts = extractEgressHosts(input.agentVisibleText);
  const verifierHosts = extractEgressHosts(input.verifierText);
  const environmentHosts = extractEgressHosts(input.environmentText);

  const ineligibleReasons: string[] = [];
  for (const [label, hosts] of [["agent", agentHosts], ["verifier", verifierHosts], ["environment", environmentHosts]] as const) {
    for (const host of hosts) {
      if (isDeniedEgressHost(host)) ineligibleReasons.push(`${label}-requires-denied-host:${host}`);
    }
  }

  // An agent that mentions no host at all still declared `public`. Refuse to guess: a unit whose
  // requirement cannot be derived from its own bytes is unverifiable, not silently offline.
  if (agentHosts.length === 0 && ineligibleReasons.length === 0) {
    ineligibleReasons.push("public-mode-unit-declares-no-derivable-host");
  }

  if (ineligibleReasons.length > 0) {
    return {
      ...base,
      decision: "ineligible",
      network: "none",
      agentAllowlist: [],
      verifierAllowlist: [],
      ineligibleReasons: [...new Set(ineligibleReasons)].sort(compareCodeUnitStrings),
    };
  }

  return {
    ...base,
    decision: "broker-only",
    network: "broker-only",
    agentAllowlist: agentHosts,
    // The verifier gets its own hosts plus the agent's; it never gets less, and the agent never
    // gets the verifier's, so a verifier-only dependency cannot widen the agent's reach.
    verifierAllowlist: [...new Set([...verifierHosts, ...agentHosts])].sort(compareCodeUnitStrings),
    ineligibleReasons: [],
  };
}

/**
 * Independent check on a plan, for the sealed artifact. Rebuilds nothing — it asserts the
 * properties a reader needs: no denied host anywhere, the agent never wider than the verifier, and
 * an offline plan carrying no allowlist at all.
 */
export function verifySkillsBenchEgressPlan(plan: SkillsBenchEgressPlan): void {
  if (plan.policy !== SKILLSBENCH_EGRESS_POLICY) throw new TypeError("egress policy mismatch");
  for (const host of SKILLSBENCH_DENIED_HOSTS) {
    if (!plan.deniedHosts.includes(host)) throw new TypeError(`egress plan dropped denied host "${host}"`);
  }
  for (const host of [...plan.agentAllowlist, ...plan.verifierAllowlist]) {
    if (isDeniedEgressHost(host)) throw new TypeError(`egress allowlist reaches denied host "${host}"`);
  }
  const verifier = new Set(plan.verifierAllowlist);
  for (const host of plan.agentAllowlist) {
    if (!verifier.has(host)) throw new TypeError(`agent may reach "${host}" but the verifier may not`);
  }
  if (plan.decision === "offline" || plan.decision === "ineligible") {
    if (plan.network !== "none" || plan.agentAllowlist.length > 0 || plan.verifierAllowlist.length > 0) {
      throw new TypeError(`a ${plan.decision} unit must carry no egress`);
    }
  }
  if (plan.decision === "broker-only") {
    if (plan.network !== "broker-only") throw new TypeError("a broker-only unit must request broker-only networking");
    if (plan.agentAllowlist.length === 0) throw new TypeError("a broker-only unit must name at least one permitted host");
    if (plan.ineligibleReasons.length > 0) throw new TypeError("a broker-only unit cannot carry ineligible reasons");
  }
  if (plan.decision === "ineligible" && plan.ineligibleReasons.length === 0) {
    throw new TypeError("an ineligible unit must name its reasons");
  }
}
