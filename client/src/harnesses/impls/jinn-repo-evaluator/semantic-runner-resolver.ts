import type { JoinedSolverNetConfig } from '../../../solver-nets/registry.js';
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
  readonly joinedSolverNets:
    | Readonly<Record<string, JoinedSolverNetConfig>>
    | undefined;
  readonly claudePath: string;
  readonly createClaudeRunner?: (
    options: ClaudeSemanticAgentRunnerOptions,
  ) => SemanticAgentRunner;
}): SemanticAgentRunnerResolver {
  let runner: SemanticAgentRunner | undefined;
  return {
    resolve({ manifestCid }) {
      if (manifestCid === undefined) return undefined;
      const joined = options.joinedSolverNets?.[manifestCid];
      if (
        joined === undefined
        || joined.manifestCid !== manifestCid
        || !joined.roles.includes('evaluator')
        || joined.harness !== SEMANTIC_EVALUATOR_HARNESS
      ) {
        return undefined;
      }
      runner ??= (options.createClaudeRunner ?? (
        (runnerOptions) => new ClaudeSemanticAgentRunner(runnerOptions)
      ))({
        claudePath: options.claudePath,
      });
      return { provider: 'anthropic', runner };
    },
  };
}
