// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";

import type { RepositorySha256Digest } from "./digests.js";
import {
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  type LinkageMode,
} from "./identifiers.js";

type JsonEntity = Record<string, unknown> & { "@id": string; "@type": unknown };

function refId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "@id" in value) {
    const id = (value as { "@id": unknown })["@id"];
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export async function loadExecutionGoldenBase(): Promise<Record<string, unknown>> {
  const fixtureRoot = fileURLToPath(new URL("../fixtures/derivation", import.meta.url));
  return JSON.parse(
    await readFile(join(fixtureRoot, "execution-golden-base.json"), "utf8"),
  ) as Record<string, unknown>;
}

export function patchExecutionGolden(
  base: Record<string, unknown>,
  options: {
    nativeTraceSha256: string;
    trajectoryDigest?: RepositorySha256Digest;
    linkageMode: LinkageMode;
    decoyNativeTraceSha256?: string;
  },
): Record<string, unknown> {
  const document = structuredClone(base) as Record<string, unknown>;
  const graph = document["@graph"] as JsonEntity[];
  const byId = new Map(graph.map((entity) => [entity["@id"], entity]));
  const execution = byId.get("urn:uuid:22222222-2222-4222-8222-222222222222");
  if (!execution) throw new Error("golden execution fixture missing primary Execution");
  const traceId = refId(execution["subjectOf"]);
  if (!traceId) throw new Error("golden execution fixture missing subjectOf trace");
  const trace = byId.get(traceId);
  if (!trace) throw new Error("golden execution fixture missing native trace entity");
  trace["sha256"] = options.nativeTraceSha256;

  delete trace["identifier"];
  if (options.linkageMode === "forward-linked") {
    if (!options.trajectoryDigest) {
      throw new Error("forward-linked execution fixture requires trajectoryDigest");
    }
    trace["identifier"] = {
      "@type": "PropertyValue",
      propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
      value: options.trajectoryDigest,
    };
  }

  if (options.decoyNativeTraceSha256) {
    graph.push({
      "@id": "trace/decoy-native.bin",
      "@type": "File",
      sha256: options.decoyNativeTraceSha256,
      ...(options.linkageMode === "forward-linked" && options.trajectoryDigest
        ? {
            identifier: {
              "@type": "PropertyValue",
              propertyID: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
              value: options.trajectoryDigest,
            },
          }
        : {}),
    });
  }

  return document;
}

export function encodeExecutionDocument(document: Record<string, unknown>): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
  const report = validateExecutionEvidence(bytes);
  if (!report.conforms) {
    throw new Error(
      `patched execution fixture is nonconforming: ${report.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  return bytes;
}
