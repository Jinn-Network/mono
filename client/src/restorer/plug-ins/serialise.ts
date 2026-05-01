/**
 * Serialise the in-memory {@link SlotRegistry} into a JSON-stable shape
 * for the harness hand-off (`workingDir/.coordinator/slots.json`).
 *
 * Phase skills `Read` this file and route plug-in contributions into
 * orient / strategize / plan / execute / debrief / improve /
 * memory-consolidation. Shape is intentionally simple — no types, just
 * JSON objects that markdown skills can grep/jq.
 */

import type { SlotRegistry, RegistrySlot } from './registry.js';
import type {
  Slot,
  PhaseAgentOverrideSlot,
  TopicExplorerSlot,
  McpToolSlot,
  SkillBundleSlot,
  MemoryBackendSlot,
  HookSlot,
} from './types.js';

export interface SerialisedSlot<S extends Slot> {
  plugInName: string;
  packageRoot: string;
  slot: S;
}

export interface SerialisedRegistry {
  /** ISO timestamp of registry construction. */
  builtAt: string;
  /** claude-code-learner version this registry was built against. */
  learnerVersion: string;
  phaseAgentOverrides: ReadonlyArray<SerialisedSlot<PhaseAgentOverrideSlot>>;
  topicExplorers: ReadonlyArray<SerialisedSlot<TopicExplorerSlot>>;
  mcpTools: ReadonlyArray<SerialisedSlot<McpToolSlot>>;
  skillBundles: ReadonlyArray<SerialisedSlot<SkillBundleSlot>>;
  memoryBackends: ReadonlyArray<SerialisedSlot<MemoryBackendSlot>>;
  hooks: ReadonlyArray<SerialisedSlot<HookSlot>>;
}

function projectSlot<S extends Slot>(r: RegistrySlot<S>): SerialisedSlot<S> {
  return {
    plugInName: r.plugInName,
    packageRoot: r.packageRoot,
    slot: r.slot,
  };
}

export function serialiseRegistry(
  registry: SlotRegistry,
  learnerVersion: string,
): SerialisedRegistry {
  return {
    builtAt: new Date().toISOString(),
    learnerVersion,
    phaseAgentOverrides: registry.phaseAgentOverrides.map(projectSlot),
    topicExplorers: registry.topicExplorers.map(projectSlot),
    mcpTools: registry.mcpTools.map(projectSlot),
    skillBundles: registry.skillBundles.map(projectSlot),
    memoryBackends: registry.memoryBackends.map(projectSlot),
    hooks: registry.hooks.map(projectSlot),
  };
}
