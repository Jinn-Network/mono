/**
 * Colophon-owned, machine-local descriptions of the two supported coding harnesses.
 * These documents are deliberately separate from a workspace and contain no credential
 * selection or value.  A host executable path is a locator only; the observed digest is
 * the reviewable identity that can enter a draft arm.
 */

import { z } from "zod";

export const AGENT_PROFILE_FORMAT = "colophon-agent/1" as const;
export const AGENT_ADAPTERS = ["claude-code", "codex"] as const;
export const AgentAdapterSchema = z.enum(AGENT_ADAPTERS);
export type AgentAdapter = z.infer<typeof AgentAdapterSchema>;
export const AgentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, "must match [A-Za-z0-9_-]{1,64}");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase sha256 hex digest");
const AbsolutePathSchema = z.string().refine((value) => value.startsWith("/"), "must be an absolute path");

export const AgentProfileSchema = z.object({
  format: z.literal(AGENT_PROFILE_FORMAT),
  agentId: AgentIdSchema,
  adapter: AgentAdapterSchema,
  executable: z.object({
    path: AbsolutePathSchema,
    sha256: Sha256Schema,
    version: z.string().min(1).max(256),
  }).strict(),
  model: z.string().min(1).max(256),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  network: z.literal("provider-required"),
}).strict();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Compiles to the platform's existing harness/model/effort vocabulary only. */
export function profileArmPinning(profile: AgentProfile): Record<string, unknown> {
  return {
    harness: {
      id: profile.adapter,
      version: profile.executable.version,
      digest: profile.executable.sha256,
    },
    model: { id: profile.model },
    effort: profile.effort,
  };
}

export function profileMatchesArmPinning(profile: AgentProfile, pinning: unknown): boolean {
  if (typeof pinning !== "object" || pinning === null || Array.isArray(pinning)) return false;
  const requirements = pinning as Record<string, unknown>;
  const harness = requirements.harness;
  const model = requirements.model;
  return typeof harness === "object" && harness !== null
    && (harness as Record<string, unknown>).id === profile.adapter
    && (harness as Record<string, unknown>).version === profile.executable.version
    && (harness as Record<string, unknown>).digest === profile.executable.sha256
    && typeof model === "object" && model !== null
    && (model as Record<string, unknown>).id === profile.model
    && requirements.effort === profile.effort;
}
