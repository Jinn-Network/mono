// SPDX-License-Identifier: Apache-2.0

/**
 * The attribute vocabulary this profile admits.
 *
 * Derived from the OpenTelemetry GenAI semantic conventions, which moved out of
 * `open-telemetry/semantic-conventions` at core release v1.42.0 into a dedicated
 * repository that has published no release, no tag, and no schema URL, and whose
 * attributes are all at `stability: development`. There is therefore nothing upstream to
 * pin, and this profile — not upstream — is the interpretation contract consumers rely on.
 * Upstream is tracked, not depended upon.
 */
export const VOCABULARY_UPSTREAM = Object.freeze({
  repository: "https://github.com/open-telemetry/semantic-conventions-genai",
  /** Exact `main` commit from `git ls-remote` at profile revision time. */
  commit: "c739977ae690961f36e435504e5c1febaef1f7f3",
  snapshotDate: "2026-07-31",
  upstreamStability: "development",
} as const);

/**
 * Upstream keys admitted by this profile. `gen_ai.system` was renamed
 * `gen_ai.provider.name` upstream and is deliberately absent.
 */
export const GEN_AI_ATTRIBUTES = Object.freeze({
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
} as const);

/**
 * Jinn extensions. Message content is never inlined: a span points at the region of the
 * digest-bound source it was derived from, and consumers resolve content there.
 */
export const JINN_ATTRIBUTES = Object.freeze({
  turnRole: "jinn.trajectory.turn.role",
  sourceOrdinal: "jinn.trajectory.source.ordinal",
  outcome: "jinn.trajectory.outcome",
} as const);

/** `gen_ai.operation.name` values this profile emits. */
export const OPERATION_NAMES = Object.freeze({
  chat: "chat",
  executeTool: "execute_tool",
  invokeAgent: "invoke_agent",
} as const);

export type GenAiAttributeKey = (typeof GEN_AI_ATTRIBUTES)[keyof typeof GEN_AI_ATTRIBUTES];
export type JinnAttributeKey = (typeof JINN_ATTRIBUTES)[keyof typeof JINN_ATTRIBUTES];

const ADMITTED_ATTRIBUTE_KEYS = new Set<string>([
  ...Object.values(GEN_AI_ATTRIBUTES),
  ...Object.values(JINN_ATTRIBUTES),
]);

/** Attribute keys rejected even if they resemble admitted vocabulary. */
const REJECTED_ATTRIBUTE_KEYS = new Set([
  "message.content",
  "tool.args",
  "tool.result",
  "gen_ai.system",
]);

export function isAdmittedAttributeKey(key: string): boolean {
  if (REJECTED_ATTRIBUTE_KEYS.has(key)) return false;
  return ADMITTED_ATTRIBUTE_KEYS.has(key);
}
