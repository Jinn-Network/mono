/**
 * In-memory normalised view of all installed Path 1 plug-ins, keyed by
 * slot type. Built once at daemon boot from `config.learnerPlugIns[]`
 * via {@link loadPlugIns}; serialised to JSON and threaded into the
 * harness via `JINN_SLOT_REGISTRY_JSON` (see `serialise.ts`).
 */

import type {
  PhaseAgentOverrideSlot,
  TopicExplorerSlot,
  McpToolSlot,
  SkillBundleSlot,
  MemoryBackendSlot,
  HookSlot,
} from './types.js';

/** A slot as stored in the registry — original slot data plus provenance. */
export interface RegistrySlot<S> {
  plugInName: string;
  plugInVersion: string;
  /** Absolute path to the plug-in package root. */
  packageRoot: string;
  slot: S;
}

export interface SlotRegistry {
  phaseAgentOverrides: ReadonlyArray<RegistrySlot<PhaseAgentOverrideSlot>>;
  topicExplorers: ReadonlyArray<RegistrySlot<TopicExplorerSlot>>;
  mcpTools: ReadonlyArray<RegistrySlot<McpToolSlot>>;
  skillBundles: ReadonlyArray<RegistrySlot<SkillBundleSlot>>;
  memoryBackends: ReadonlyArray<RegistrySlot<MemoryBackendSlot>>;
  hooks: ReadonlyArray<RegistrySlot<HookSlot>>;
}

export function emptyRegistry(): SlotRegistry {
  return {
    phaseAgentOverrides: [],
    topicExplorers: [],
    mcpTools: [],
    skillBundles: [],
    memoryBackends: [],
    hooks: [],
  };
}
