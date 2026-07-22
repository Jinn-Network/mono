import { ScrubPipeline } from './pipeline.js';
import type { KeyPolicy } from './key-policy.js';
import { DEFAULT_KEY_POLICY, sharedDetectorInventory } from './build.js';
import { DEFAULT_POLICY } from './policy.js';

/**
 * Layer-2 / check-mode preset (#1969 / design §6.5).
 *
 * Same owned detector inventory as the seed preset (no openredaction); checkMode
 * maps any non-pass disposition to reject — one mapping line, not a second
 * pipeline. Entropy fallback stays ON (stricter net; a false positive costs one
 * re-distill, never defaces published content).
 *
 * @deprecated Compatibility preset over the one inventory + policy table.
 */
export function buildLayer2ScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline {
  return new ScrubPipeline(
    sharedDetectorInventory(policy, { openredaction: false, entropyFallback: true }),
    { policy: DEFAULT_POLICY, checkMode: true },
  );
}
