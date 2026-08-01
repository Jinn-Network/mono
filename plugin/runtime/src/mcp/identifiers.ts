// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP server identity the host sees. Hosts namespace tool names by server
 * name, so this is user-visible in the model's tool list; it is stable forever.
 */
export const MCP_SERVER_NAME = "jinn" as const;
export const MCP_SERVER_TITLE = "Jinn corpus" as const;

/** Tool names. Snake_case per MCP convention; the two read tools are named by the design (spec 6.2). */
export const TOOL_NAMES = Object.freeze({
  corpusSearch: "corpus_search",
  corpusFetch: "corpus_fetch",
  health: "health",
  pickup: "pickup",
  captureOpen: "capture_open",
  captureSeal: "capture_seal",
  captureAbandon: "capture_abandon",
} as const);

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/**
 * One binary, two roles.
 *
 * `tools` is the host-spawned instance the model loop reaches. It is read-only
 * and stateless: it never opens the archive, never holds a capture session, and
 * cannot be made to write by any argument.
 *
 * `session` is the adapter-spawned instance the plugin's hook code drives. It is
 * the sole capture writer for its session.
 */
export const RUNTIME_ROLES = ["tools", "session"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export function isRuntimeRole(value: unknown): value is RuntimeRole {
  return typeof value === "string" && (RUNTIME_ROLES as readonly string[]).includes(value);
}

const READ_TOOLS = [
  TOOL_NAMES.corpusSearch,
  TOOL_NAMES.corpusFetch,
  TOOL_NAMES.health,
] as const;

export const TOOLS_BY_ROLE: Readonly<Record<RuntimeRole, readonly ToolName[]>> = Object.freeze({
  tools: READ_TOOLS,
  session: [
    ...READ_TOOLS,
    TOOL_NAMES.pickup,
    TOOL_NAMES.captureOpen,
    TOOL_NAMES.captureSeal,
    TOOL_NAMES.captureAbandon,
  ],
});
