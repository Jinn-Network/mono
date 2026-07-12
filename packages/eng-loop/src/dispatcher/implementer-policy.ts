import type {
  ReadyIssue,
  DispatcherConfig,
  Implementer,
  ImplementerRule,
} from './types.js';

/**
 * Resolve the implementer CLI agent for an issue by walking the ordered
 * `implementerRules` policy (#887). A rule matches iff every specified
 * predicate holds:
 *
 *   (rule.effort === undefined || rule.effort === issue.effort) &&
 *   (rule.shape  === undefined || rule.shape  === issue.shape)
 *
 * The first matching rule's `implementer` is returned. With no rule matching
 * (including an empty policy) the resolver falls through to
 * `cfg.defaultImplementer` — reproducing today's single-implementer behaviour.
 */
export function resolveImplementer(
  issue: Pick<ReadyIssue, 'shape' | 'effort'>,
  cfg: Pick<DispatcherConfig, 'implementerRules' | 'defaultImplementer'>,
): Implementer {
  const matches = (rule: ImplementerRule): boolean =>
    (rule.effort === undefined || rule.effort === issue.effort) &&
    (rule.shape === undefined || rule.shape === issue.shape);

  const hit = cfg.implementerRules.find(matches);
  return hit ? hit.implementer : cfg.defaultImplementer;
}
