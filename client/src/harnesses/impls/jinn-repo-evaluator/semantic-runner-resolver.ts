import {
  CODEX_SEMANTIC_MODEL,
  type JoinedSolverNetConfig,
} from '../../../solver-nets/registry.js';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerResolver,
} from './autopilot-semantic.js';
import {
  ClaudeSemanticAgentRunner,
  type ClaudeSemanticAgentRunnerOptions,
} from './claude-semantic-agent.js';
import {
  CodexSemanticAgentRunner,
  type CodexSemanticAgentRunnerOptions,
} from './codex-semantic-agent.js';

const SEMANTIC_EVALUATOR_HARNESS = 'jinn-repo-evaluator';
const CODEX_HARNESS = 'codex';
const AUTOPILOT_CODEX_CANARY_MANIFEST_CID =
  'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa';

export interface ConfiguredSemanticEvaluatorRunnerResolverOptions {
  readonly getJoinedSolverNets: () =>
    | Readonly<Record<string, JoinedSolverNetConfig>>
    | undefined;
  readonly getClaudePath: () => string;
  readonly getCodexPath: () => string;
  readonly createClaudeRunner?: (
    options: ClaudeSemanticAgentRunnerOptions,
  ) => SemanticAgentRunner;
  readonly createCodexRunner?: (
    options: CodexSemanticAgentRunnerOptions,
  ) => SemanticAgentRunner;
}

function isExactCodexSemanticProfile(
  manifestCid: string,
  joined: JoinedSolverNetConfig,
): boolean {
  const profile = joined.semanticEvaluator;
  return (
    manifestCid === AUTOPILOT_CODEX_CANARY_MANIFEST_CID
    && joined.manifestCid === manifestCid
    && joined.contract?.id === 'jinn-repo'
    && joined.contract.version === 'v1'
    && joined.roles.includes('solver')
    && joined.roles.includes('evaluator')
    && joined.harness === CODEX_HARNESS
    && joined.model === CODEX_SEMANTIC_MODEL
    && joined.provider === undefined
    && profile?.runtime === 'codex'
    && profile.model === CODEX_SEMANTIC_MODEL
    && profile.auth === 'chatgpt-oauth-only'
  );
}

export function makeConfiguredSemanticEvaluatorRunnerResolver(
  options: ConfiguredSemanticEvaluatorRunnerResolverOptions,
): SemanticAgentRunnerResolver {
  const claudeRunners = new Map<string, SemanticAgentRunner>();
  const codexRunners = new Map<string, SemanticAgentRunner>();
  return {
    resolve({ manifestCid }) {
      if (manifestCid === undefined) return undefined;
      const joined = options.getJoinedSolverNets()?.[manifestCid];
      if (joined === undefined || joined.manifestCid !== manifestCid) {
        return undefined;
      }

      if (joined.semanticEvaluator !== undefined) {
        if (!isExactCodexSemanticProfile(manifestCid, joined)) return undefined;
        const codexPath = options.getCodexPath();
        let runner = codexRunners.get(codexPath);
        runner ??= (options.createCodexRunner ?? (
          (runnerOptions) => new CodexSemanticAgentRunner(runnerOptions)
        ))({
          codexPath,
        });
        codexRunners.set(codexPath, runner);
        return {
          provider: 'openai-codex',
          runner,
          model: CODEX_SEMANTIC_MODEL,
        };
      }

      if (
        !joined.roles.includes('evaluator')
        || joined.harness !== SEMANTIC_EVALUATOR_HARNESS
      ) {
        return undefined;
      }
      const claudePath = options.getClaudePath();
      let runner = claudeRunners.get(claudePath);
      runner ??= (options.createClaudeRunner ?? (
        (runnerOptions) => new ClaudeSemanticAgentRunner(runnerOptions)
      ))({
        claudePath,
      });
      claudeRunners.set(claudePath, runner);
      return {
        provider: 'anthropic',
        runner,
        ...(joined.model === undefined ? {} : { model: joined.model }),
      };
    },
  };
}
