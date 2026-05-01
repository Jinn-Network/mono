/**
 * Type definitions for the Path 1 plug-in surface (`jinn-plugin.json`).
 *
 * Spec: spec/2026-04-30-plug-in-surface.md §4. Plan:
 * docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md.
 *
 * The shape mirrors `client/schemas/jinn-plugin-v1.json` 1:1.
 */

export type SlotScope = { matchKinds: readonly string[] };

export type PhaseAgentOverrideSlot = {
  type: 'phase-agent-override';
  phase:
    | 'strategize'
    | 'plan'
    | 'execute'
    | 'debrief'
    | 'improve'
    | 'memory-consolidation';
  agent:
    | 'strategist'
    | 'planner'
    | 'step-worker'
    | 'analyst'
    | 'promoter'
    | 'consolidator';
  scope?: SlotScope;
  entry: string;
};

export type TopicExplorerSlot = {
  type: 'topic-explorer';
  phase: 'orient' | 'debrief';
  topic: string;
  scope?: SlotScope;
  entry: string;
};

export type McpToolSlot = {
  type: 'mcp-tool';
  command: string;
  args: readonly string[];
  namespace?: string;
};

export type SkillBundleSlot = {
  type: 'skill-bundle';
  skillsDir: string;
  scope?: SlotScope;
};

export type MemoryBackendSlot = {
  type: 'memory-backend';
  command: string;
  args: readonly string[];
  scope?: SlotScope;
};

export type HookSlot = {
  type: 'hook';
  event: 'session-start' | 'pre-phase' | 'post-phase' | 'session-end';
  phase?:
    | 'orient'
    | 'strategize'
    | 'plan'
    | 'execute'
    | 'debrief'
    | 'improve'
    | 'memory-consolidation';
  entry: string;
  scope?: SlotScope;
};

export type Slot =
  | PhaseAgentOverrideSlot
  | TopicExplorerSlot
  | McpToolSlot
  | SkillBundleSlot
  | MemoryBackendSlot
  | HookSlot;

export interface JinnPlugInManifest {
  schemaVersion: '1.0.0';
  name: string;
  version: string;
  description?: string;
  compatibility: {
    claudeCodeLearner: string;
    supportedKinds?: readonly string[];
  };
  slots: readonly Slot[];
  author?: { name: string; url?: string };
  license?: string;
  homepage?: string;
}

/**
 * One entry in operator config (`config.learnerPlugIns[]`). Points the
 * loader at a package root that contains a `jinn-plugin.json` manifest.
 */
export interface ExternalPlugInEntry {
  /** MUST equal the manifest's `name`. */
  name: string;
  /** Local filesystem path to the plug-in package's root (typically a node_modules path). */
  entry: string;
}
