// SPDX-License-Identifier: Apache-2.0
// Test-only. Not exported from `src/index.ts`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEvidenceRetrievalFailure } from "@jinn-network/evidence-retrieval";
import type { DsseSigner } from "@jinn-network/trust-core";

import { createCaptureCapability, type CaptureCapability } from "../capture/capability.js";
import { resolveRuntimeConfig } from "../config.js";
import type { CorpusRetrieval } from "../corpus/retrieve.js";
import { createLineLogger } from "../logger.js";
import type { AdmissionFilter } from "../relevance/admission.js";
import type { RelevanceIndex, SensitivityClassifier } from "../relevance/index.js";
import { createPluginRuntime, type PluginRuntime } from "../runtime.js";
import { createMcpServer } from "./server.js";

export interface TestRuntime {
  readonly server: McpServer;
  stop(): Promise<void>;
}

const testSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "test-key" },
];

const emptyIndex = {
  databasePath: ":memory:",
  search: async () => [],
  stats: () => ({ local: 0, public: 0, excludedByTrust: 0 }),
  close: () => {},
} as unknown as RelevanceIndex;

const allowAllClassifier: SensitivityClassifier = {
  classify: async () => ({ excluded: false }),
};

const FAIL_CLOSED_RETRIEVAL: CorpusRetrieval = {
  fetchRecord: async (reference) => ({
    status: "failed",
    failure: createEvidenceRetrievalFailure({
      code: "NO_LOCATION",
      stage: "location",
      message: "Corpus ports are not configured; retrieval is unavailable.",
      reference,
    }),
  }),
};

const allowAllAdmission: AdmissionFilter = {
  admit: async (candidates) => candidates,
};

interface SharedCaptureState {
  readonly capture: CaptureCapability;
  readonly runtime: PluginRuntime;
  users: number;
}

/** One capture backend per home — mirrors a single archive, separate MCP transports. */
const captureByHome = new Map<string, SharedCaptureState>();
const captureInflight = new Map<string, Promise<SharedCaptureState>>();

async function acquireSharedCapture(home: string): Promise<SharedCaptureState> {
  for (;;) {
    const existing = captureByHome.get(home);
    if (existing) {
      existing.users += 1;
      return existing;
    }

    let inflight = captureInflight.get(home);
    if (inflight === undefined) {
      inflight = (async () => {
        const config = resolveRuntimeConfig({ env: {}, homeDirectory: home });
        const log = createLineLogger("silent", () => {});
        const capture = createCaptureCapability({ producerVersion: "0.0.0-test", signer: testSigner });
        const runtime = createPluginRuntime({ config, log, capabilities: [capture] });
        await runtime.start();
        return { capture, runtime, users: 0 };
      })();
      captureInflight.set(home, inflight);
    }

    const created = await inflight;
    captureInflight.delete(home);

    if (captureByHome.get(home) === undefined) {
      captureByHome.set(home, created);
    }
    const state = captureByHome.get(home)!;
    if (state === created || state.runtime === created.runtime) {
      state.users += 1;
      return state;
    }
  }
}

async function releaseSharedCapture(home: string): Promise<void> {
  const state = captureByHome.get(home);
  if (state === undefined) return;
  state.users -= 1;
  if (state.users <= 0) {
    captureByHome.delete(home);
    await state.runtime.stop();
  }
}

async function open(home: string, role: "tools" | "session"): Promise<TestRuntime> {
  const config = resolveRuntimeConfig({ env: {}, homeDirectory: home });
  const log = createLineLogger("silent", () => {});

  const shared = role === "session" ? await acquireSharedCapture(home) : undefined;
  let toolsRuntime: PluginRuntime | undefined;
  if (role === "tools") {
    toolsRuntime = createPluginRuntime({ config, log });
    await toolsRuntime.start();
  }

  const capture = shared?.capture;
  const healthRuntime = shared?.runtime ?? toolsRuntime;

  const server = createMcpServer({
    role,
    version: "0.0.0-test",
    index: emptyIndex,
    retrieval: FAIL_CLOSED_RETRIEVAL,
    classifier: allowAllClassifier,
    admission: allowAllAdmission,
    ...(capture ? { capture } : {}),
    log,
    health: () => healthRuntime!.health(),
  });

  return {
    server,
    async stop() {
      await server.close();
      if (role === "session") {
        await releaseSharedCapture(home);
      } else {
        await toolsRuntime!.stop();
      }
    },
  };
}

export const openSessionRuntimeForTest = (home: string): Promise<TestRuntime> => open(home, "session");
export const openToolsRuntimeForTest = (home: string): Promise<TestRuntime> => open(home, "tools");
