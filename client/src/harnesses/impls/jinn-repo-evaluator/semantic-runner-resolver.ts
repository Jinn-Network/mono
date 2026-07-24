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
  readonly getJoinedSolverNets: () =>
    | Readonly<Record<string, JoinedSolverNetConfig>>
    | undefined;
  readonly getClaudePath: () => string;
  readonly createClaudeRunner?: (
    options: ClaudeSemanticAgentRunnerOptions,
  ) => SemanticAgentRunner;
}): SemanticAgentRunnerResolver {
  const runners = new Map<string, SemanticAgentRunner>();
  return {
    resolve({ manifestCid }) {
      if (manifestCid === undefined) return undefined;
      const joined = options.getJoinedSolverNets()?.[manifestCid];
      if (
        joined === undefined
        || joined.manifestCid !== manifestCid
        || !joined.roles.includes('evaluator')
        || joined.harness !== SEMANTIC_EVALUATOR_HARNESS
      ) {
        return undefined;
      }
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
        ...(joined.model === undefined ? {} : { model: joined.model }),
      };
    },
  };
}
