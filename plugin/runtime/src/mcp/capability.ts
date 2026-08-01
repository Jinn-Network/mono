// SPDX-License-Identifier: Apache-2.0

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CapabilityContext, RuntimeCapability } from "../capability.js";
import type { HealthCheck } from "../health.js";
import type { IndexStats } from "../relevance/index.js";
import type { RuntimeRole } from "./identifiers.js";
import { type McpServerDeps, createMcpServer } from "./server.js";

/** Everything the tools need, resolved by the composition root at start time. */
export type McpServerRuntimeDeps = Omit<McpServerDeps, "role" | "version" | "log">;

export interface McpCapabilityOptions {
  readonly role: RuntimeRole;
  readonly version: string;
  /** Called once inside `start()`, after the other capabilities have started. */
  resolve(
    context: CapabilityContext,
  ): McpServerRuntimeDeps | Promise<McpServerRuntimeDeps>;
  /** Test seam. Production binds stdio. */
  readonly transport?: Transport;
}

/**
 * Binds the MCP transport and nothing else. The archive is exclusive
 * (C3 finding F-C3-8), so it is opened per operation inside a tool handler and
 * never held across the capability's lifetime; the relevance index and the
 * corpus reader are separate WAL databases and tolerate concurrent readers.
 */
export function createMcpCapability(options: McpCapabilityOptions): RuntimeCapability {
  let server: McpServer | undefined;
  let resolved: McpServerRuntimeDeps | undefined;

  return {
    name: "mcp",
    async start(context: CapabilityContext): Promise<void> {
      const deps = await options.resolve(context);
      resolved = deps;
      server = createMcpServer({
        ...deps,
        role: options.role,
        version: options.version,
        log: context.log,
      });
      await server.connect(options.transport ?? new StdioServerTransport());
      context.log.info(`mcp server listening (role=${options.role})`);
    },
    async stop(): Promise<void> {
      const current = server;
      server = undefined;
      const index = resolved?.index;
      resolved = undefined;
      if (current) await current.close();
      index?.close();
    },
    async healthChecks(): Promise<readonly HealthCheck[]> {
      // The transport's own health is the fact that this call arrived, so the
      // seam contributes no row. The index does: it has no capability of its
      // own (C6 is a library), and this is the composition point that holds its
      // handle, so its row is emitted here.
      return resolved ? [indexCheck(resolved.index.stats())] : [];
    },
  };
}

/**
 * Coherence, not volume.
 *
 * An empty index on a machine that has never indexed anything is a fresh
 * install behaving correctly, so it is green and says so; failing it would put
 * a red row with a no-op remedy in front of every new user on their first
 * session, which is exactly the always-red failure the release-note rule
 * exists to prevent. An empty index that *has* indexed before is a genuine
 * incoherence, and `rebuildIndex` genuinely repairs it.
 *
 * The counts are in `detail` either way: disambiguating "the index is empty"
 * from "your query matched nothing" is the whole reason this row exists, and
 * that question is asked far more often on a green install than a red one.
 *
 * The red arm depends on `lastIndexedAt` being a persistent marker rather than
 * a `max()` over live rows (C6 finding, fixed there): derived from live rows it
 * would vanish with the last record, collapsing "written before, empty now"
 * into "never written" and reporting green in exactly the state this row
 * exists to catch.
 *
 * Red does not imply corruption. On a small archive a single re-capture whose
 * content is withheld for carrying a credential can evict the last record and
 * take totals to zero — the index really is empty and `rebuildIndex` really is
 * the repair, but nothing is broken. The wording says "empty" and names the
 * repair; it does not diagnose a cause it cannot know.
 *
 * **Green states that records are indexed, never that they are currently
 * trusted.** `excludedByTrust` is a fact about the last public-plane pass, so
 * this row only sees a lapsed policy once something rebuilds under it. If a
 * policy expires and nobody rebuilds, the index keeps serving records that
 * policy would no longer admit, and this row stays green — correctly, because
 * the mirror is a cache and `corpus-trust-policy` is independently red with the
 * real fix. Whether retrieval re-verifies admission per query is a C5 read-seam
 * question (F-C7-10), not something this row may imply an answer to.
 */
function indexCheck(stats: IndexStats): HealthCheck {
  const total = stats.local + stats.public;
  const counts = `${String(stats.local)} local, ${String(stats.public)} public records indexed`;
  if (total > 0) {
    return {
      name: "corpus-index",
      ok: true,
      detail: `${counts} (last ${stats.lastIndexedAt ?? "unknown"})`,
      remedy: null,
    };
  }
  if (stats.lastIndexedAt === undefined) {
    return {
      name: "corpus-index",
      ok: true,
      detail: "nothing indexed yet - sessions index as they complete",
      remedy: null,
    };
  }
  if (stats.excludedByTrust > 0) {
    // Filtered-empty, not honestly-empty. The cause is the trust policy, and
    // `corpus-trust-policy` is independently red carrying the real fix. A
    // rebuild here would repopulate nothing and leave the operator looping on a
    // remedy that cannot remedy, so this row names the cause and defers.
    return {
      name: "corpus-index",
      ok: true,
      detail:
        `${counts} - ${String(stats.excludedByTrust)} record(s) excluded by trust policy; ` +
        "see corpus-trust-policy",
      remedy: null,
    };
  }
  return {
    name: "corpus-index",
    ok: false,
    detail: `${counts}; the index was last written ${stats.lastIndexedAt} and is now empty`,
    remedy: "jinn-plugin-runtime reindex",
  };
}
