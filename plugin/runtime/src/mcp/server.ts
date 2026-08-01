// SPDX-License-Identifier: Apache-2.0

import type { LocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CaptureCapability } from "../capture/capability.js";
import type { CorpusMirror, CorpusRetrieval } from "../corpus/index.js";
import { PluginRuntimeError } from "../errors.js";
import type { HealthReport } from "../health.js";
import type { RuntimeLogger } from "../logger.js";
import type { AdmissionFilter } from "../relevance/admission.js";
import type { RelevanceIndex, SensitivityClassifier } from "../relevance/index.js";
import { createTraceSpanSource } from "../relevance/trace-decode-adapter.js";
import { MCP_SERVER_NAME, MCP_SERVER_TITLE, type RuntimeRole, TOOL_NAMES } from "./identifiers.js";
import {
  CAPTURE_ABANDON_DESCRIPTION,
  CAPTURE_OPEN_DESCRIPTION,
  CAPTURE_SEAL_DESCRIPTION,
  captureAbandonInputShape,
  captureOpenInputShape,
  captureSealInputShape,
  handleCaptureAbandon,
  handleCaptureOpen,
  handleCaptureSeal,
} from "./tools/capture.js";
import {
  CORPUS_FETCH_DESCRIPTION,
  corpusFetchInputShape,
  handleCorpusFetch,
} from "./tools/corpus-fetch.js";
import {
  CORPUS_SEARCH_DESCRIPTION,
  corpusSearchInputShape,
  handleCorpusSearch,
} from "./tools/corpus-search.js";
import { HEALTH_DESCRIPTION, handleHealth, healthInputShape } from "./tools/health.js";
import { PICKUP_DESCRIPTION, handlePickup, pickupInputShape } from "./tools/pickup.js";

export class RoleCapabilityMissingError extends PluginRuntimeError {
  constructor(role: RuntimeRole, capability: string) {
    super("mcp-role-capability-missing", `role ${role} requires the ${capability} capability`);
    this.name = "RoleCapabilityMissingError";
  }
}

export interface McpServerDeps {
  readonly role: RuntimeRole;
  readonly version: string;
  readonly index: RelevanceIndex;
  readonly retrieval: CorpusRetrieval;
  /** C6's classifier — the fetch path's enforcement point (Task 5). */
  readonly classifier: SensitivityClassifier;
  readonly admission: AdmissionFilter;
  readonly archiveDirectory: string;
  readonly capture?: CaptureCapability;
  readonly mirror?: CorpusMirror;
  readonly log: RuntimeLogger;
  /** Opens the local evidence archive for post-seal indexing. */
  readonly openLocalRuntime: () => Promise<LocalEvidenceRuntime>;
  health(): Promise<HealthReport>;
}

/**
 * One binary, two surfaces. Role gating is *registration*, not a check inside a
 * handler: a tool the role does not own is never advertised and calling it by
 * name is an unknown-tool error from the SDK itself. That is what makes the
 * host-spawned instance structurally read-only.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    version: deps.version,
  });
  const spanSource = createTraceSpanSource();
  const sessionIndex = {
    index: deps.index,
    spanSource,
    openLocalRuntime: deps.openLocalRuntime,
  };

  server.registerTool(
    TOOL_NAMES.corpusSearch,
    {
      title: "Search Jinn evidence",
      description: CORPUS_SEARCH_DESCRIPTION,
      inputSchema: corpusSearchInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => handleCorpusSearch({ index: deps.index }, args),
  );

  server.registerTool(
    TOOL_NAMES.corpusFetch,
    {
      title: "Fetch a Jinn evidence record",
      description: CORPUS_FETCH_DESCRIPTION,
      inputSchema: corpusFetchInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      handleCorpusFetch({ retrieval: deps.retrieval, classifier: deps.classifier }, args),
  );

  server.registerTool(
    TOOL_NAMES.health,
    {
      title: "Jinn runtime health",
      description: HEALTH_DESCRIPTION,
      inputSchema: healthInputShape,
      annotations: { readOnlyHint: true },
    },
    async () => handleHealth({ health: deps.health }),
  );

  if (deps.role === "tools") return server;

  const capture = deps.capture;
  if (!capture) throw new RoleCapabilityMissingError(deps.role, "capture");

  server.registerTool(
    TOOL_NAMES.pickup,
    {
      title: "First-turn evidence projection",
      description: PICKUP_DESCRIPTION,
      inputSchema: pickupInputShape,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      handlePickup(
        {
          index: deps.index,
          admission: deps.admission,
          log: deps.log,
          ...(deps.mirror ? { mirror: deps.mirror } : {}),
        },
        args,
      ),
  );

  server.registerTool(
    TOOL_NAMES.captureOpen,
    { title: "Open a capture session", description: CAPTURE_OPEN_DESCRIPTION, inputSchema: captureOpenInputShape },
    async (args) => handleCaptureOpen({ capture }, args),
  );

  server.registerTool(
    TOOL_NAMES.captureSeal,
    { title: "Seal a capture session", description: CAPTURE_SEAL_DESCRIPTION, inputSchema: captureSealInputShape },
    async (args) => handleCaptureSeal({ capture, sessionIndex, log: deps.log }, args),
  );

  server.registerTool(
    TOOL_NAMES.captureAbandon,
    { title: "Abandon a capture session", description: CAPTURE_ABANDON_DESCRIPTION, inputSchema: captureAbandonInputShape },
    async (args) => handleCaptureAbandon({ capture }, args),
  );

  return server;
}
