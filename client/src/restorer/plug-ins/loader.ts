/**
 * Load installed Path 1 plug-ins from operator config and assemble a
 * normalised slot registry. Per-plug-in failures are recorded but never
 * abort the load — daemon boot continues with the surviving registry.
 *
 * Collision policy (phase-agent-override): first-installed-wins on the
 * `(phase, agent, scope.matchKinds)` key. A collision is recorded as an
 * error and the second plug-in is DROPPED. The operator must explicitly
 * remove the existing plug-in before installing the new one.
 * See plan §"Cross-task conventions / Slot routing rule".
 */

import { resolve } from 'node:path';
import semver from 'semver';
import type {
  ExternalPlugInEntry,
  JinnPlugInManifest,
  Slot,
  PhaseAgentOverrideSlot,
  TopicExplorerSlot,
  McpToolSlot,
  SkillBundleSlot,
  MemoryBackendSlot,
  HookSlot,
} from './types.js';
import { loadPlugInManifest } from './manifest.js';
import type { RegistrySlot, SlotRegistry } from './registry.js';

export interface LoadPlugInsArgs {
  entries: readonly ExternalPlugInEntry[];
  /** Version of the bundled claude-code-learner package. Used for compat checks. */
  learnerVersion: string;
}

export interface LoadPlugInsResult {
  registry: SlotRegistry;
  errors: ReadonlyArray<{ plugInName: string; reason: string }>;
  warnings: ReadonlyArray<string>;
}

export async function loadPlugIns({
  entries,
  learnerVersion,
}: LoadPlugInsArgs): Promise<LoadPlugInsResult> {
  const errors: { plugInName: string; reason: string }[] = [];
  const warnings: string[] = [];
  const topicExplorers: RegistrySlot<TopicExplorerSlot>[] = [];
  const mcpTools: RegistrySlot<McpToolSlot>[] = [];
  const skillBundles: RegistrySlot<SkillBundleSlot>[] = [];
  const memoryBackends: RegistrySlot<MemoryBackendSlot>[] = [];
  const hooks: RegistrySlot<HookSlot>[] = [];

  // Track first-installed-wins collisions for phase-agent overrides.
  const phaseAgentKeyed = new Map<
    string,
    RegistrySlot<PhaseAgentOverrideSlot>
  >();

  for (const entry of entries) {
    let manifest: JinnPlugInManifest;
    try {
      manifest = await loadPlugInManifest(entry.entry);
    } catch (err) {
      errors.push({ plugInName: entry.name, reason: (err as Error).message });
      continue;
    }
    if (manifest.name !== entry.name) {
      errors.push({
        plugInName: entry.name,
        reason: `manifest name "${manifest.name}" mismatches config entry "${entry.name}"`,
      });
      continue;
    }
    const range = manifest.compatibility.claudeCodeLearner;
    if (!semver.satisfies(learnerVersion, range)) {
      warnings.push(
        `plug-in ${manifest.name}@${manifest.version} compatibility ${range} out-of-range for claude-code-learner@${learnerVersion}; loading anyway, expected to break`,
      );
    }
    const packageRoot = resolve(entry.entry);
    for (const slot of manifest.slots as readonly Slot[]) {
      const provenance = {
        plugInName: manifest.name,
        plugInVersion: manifest.version,
        packageRoot,
      };
      switch (slot.type) {
        case 'phase-agent-override': {
          const key = `${slot.phase}|${slot.agent}|${(slot.scope?.matchKinds ?? ['*']).join(',')}`;
          if (phaseAgentKeyed.has(key)) {
            const first = phaseAgentKeyed.get(key)!.plugInName;
            errors.push({
              plugInName: manifest.name,
              reason: `phase-agent-override collision on "${key}": slot already registered by "${first}". Remove "${first}" before installing "${manifest.name}".`,
            });
            // Do not register the second plug-in — first-installed-wins.
            break;
          }
          phaseAgentKeyed.set(key, { ...provenance, slot });
          break;
        }
        case 'topic-explorer':
          topicExplorers.push({ ...provenance, slot });
          break;
        case 'mcp-tool':
          mcpTools.push({ ...provenance, slot });
          break;
        case 'skill-bundle':
          skillBundles.push({ ...provenance, slot });
          break;
        case 'memory-backend':
          memoryBackends.push({ ...provenance, slot });
          break;
        case 'hook':
          hooks.push({ ...provenance, slot });
          break;
      }
    }
  }

  const phaseAgentOverrides: RegistrySlot<PhaseAgentOverrideSlot>[] = [
    ...phaseAgentKeyed.values(),
  ];

  return {
    registry: {
      phaseAgentOverrides,
      topicExplorers,
      mcpTools,
      skillBundles,
      memoryBackends,
      hooks,
    },
    errors,
    warnings,
  };
}
