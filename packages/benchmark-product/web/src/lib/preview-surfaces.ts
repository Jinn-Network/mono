export const PREVIEW_SURFACES = ["reports", "task-sets", "entrants", "evaluators", "runs", "agents", "billing", "docs", "pricing"] as const;
export type PreviewSurface = typeof PREVIEW_SURFACES[number];

export interface PreviewSurfaceDefinition {
  readonly title: string;
  readonly description: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export const PREVIEW_SURFACE_CATALOG: Readonly<Record<PreviewSurface, PreviewSurfaceDefinition>> = {
  reports: { title: "Published reports", description: "A future hosted index of reports that readers can inspect, cite, clone, rerun, or challenge.", columns: ["Report", "Accounting", "Status"], rows: [["Harness loadouts · 500 tasks", "1,500 expected", "Complete"], ["Cancelled comparison · 6 tasks", "6 terminal", "Incomplete retained"], ["Evaluator panel study", "24 conflicted", "Disagreement retained"]] },
  "task-sets": { title: "Task sets", description: "Reusable, versioned work shared across benchmark drafts.", columns: ["Task set", "Items", "Use"], rows: [["SWE-bench Verified", "500", "Coding agents"], ["Sample fixture", "3", "Local rehearsal"], ["Private acceptance set", "120", "Future hosted workspace"]] },
  entrants: { title: "Entrant configurations", description: "Pinned agent, harness, model, and loadout configurations with exact identities.", columns: ["Configuration", "Reference", "Pinned axes"], rows: [["baseline", "Yes", "model · harness · loadout"], ["candidate-policy", "No", "loadout differs"], ["candidate-model", "No", "model differs"]] },
  evaluators: { title: "Evaluators", description: "Future reusable evaluator panels and assurance presets.", columns: ["Evaluator", "Role", "Custody"], rows: [["direct-check", "Deterministic", "Workspace"], ["panel-alpha", "Majority panel", "Self-run preview"], ["external-attestor", "Attested", "Not connected"]] },
  runs: { title: "Runs", description: "A future cross-workspace index of durable run generations and terminal accounting.", columns: ["Run", "Lifecycle", "Expected"], rows: [["hb-2026-08", "Running", "1,500"], ["sample-complete", "Published", "6"], ["sample-cancelled", "Published · cancelled", "6"]] },
  agents: { title: "Agents", description: "Future delegated operators with explicit authority and spend boundaries.", columns: ["Principal", "Role", "Authority"], rows: [["bench-agent", "Delegated operator", "launch · status · collect"], ["sponsor", "Sponsor", "lock · cancel · report · publish"]] },
  billing: { title: "Billing", description: "A future hosted-service surface for usage and plan administration. No billing service is connected.", columns: ["Period", "Usage", "Amount"], rows: [["August 2026", "Preview only", "Not billed"], ["July 2026", "Preview only", "Not billed"]] },
  docs: { title: "Documentation", description: "A future hosted reading surface for CLI, operations, report, and verification guidance.", columns: ["Guide", "Audience", "Availability"], rows: [["Run a benchmark", "Sponsor", "Local docs available"], ["Operate through the CLI", "Agent", "Local docs available"], ["Check a public bundle", "Skeptic", "Local docs available"]] },
  pricing: { title: "Plans and pricing", description: "An illustrative preview of the eventual hosted service. Plans, amounts, and availability are not offered yet.", columns: ["Plan", "Illustrative shape", "Current availability"], rows: [["Open", "Local workspaces and portable reports", "Available locally"], ["Studio", "Hosted runs and report library", "Future preview"], ["Institution", "Teams, policy, and retained evidence", "Future preview"]] },
};

export function isPreviewSurface(value: string): value is PreviewSurface {
  return (PREVIEW_SURFACES as readonly string[]).includes(value);
}
