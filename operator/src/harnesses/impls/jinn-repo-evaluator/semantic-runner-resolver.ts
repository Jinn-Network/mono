import type { ExecutionWiringConfigEntry } from '../../../config/shape-v2.js';
import { digestMatchesCid } from '../../../config/participation.js';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerResolver,
} from './autopilot-semantic.js';
import {
  ClaudeSemanticAgentRunner,
  type ClaudeSemanticAgentRunnerOptions,
} from './claude-semantic-agent.js';

const SEMANTIC_EVALUATOR_HARNESS = 'jinn-repo-evaluator';

export function makeConfiguredSemanticEvaluatorRunnerResolver(options: {
  readonly getExecutionWiring: () => readonly ExecutionWiringConfigEntry[] | undefined;
  readonly getClaudePath: () => string;
  readonly createClaudeRunner?: (
    options: ClaudeSemanticAgentRunnerOptions,
  ) => SemanticAgentRunner;
}): SemanticAgentRunnerResolver {
  const runners = new Map<string, SemanticAgentRunner>();
  return {
    resolve({ manifestCid }) {
      if (manifestCid === undefined) return undefined;
      const entry = (options.getExecutionWiring() ?? []).find(
        (candidate) =>
          candidate.harness === SEMANTIC_EVALUATOR_HARNESS
          && (
            candidate.workKind === manifestCid
            || digestMatchesCid(candidate.legacyManifestDigest, manifestCid)
          ),
      );
      if (entry === undefined) return undefined;
      const claudePath = options.getClaudePath();
      let runner = runners.get(claudePath);
      runner ??= (options.createClaudeRunner ?? (
        (runnerOptions) => new ClaudeSemanticAgentRunner(runnerOptions)
      ))({
        claudePath,
      });
      runners.set(claudePath, runner);
      return {
        provider: 'anthropic',
        runner,
        ...(entry.model === undefined ? {} : { model: entry.model }),
      };
    },
  };
}
