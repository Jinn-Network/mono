// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline";

import type { EvidenceRepository } from "@jinn-network/evidence-repository";

import { createExecutionRecorderBridge } from "./bridge.js";
import { RECORDER_BRIDGE_PROTOCOL, type RecorderBridgeResponse } from "./protocol.js";

function writeWithBackpressure(
  output: NodeJS.WritableStream,
  chunk: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const flushed = output.write(chunk);
    if (flushed) {
      resolvePromise();
      return;
    }
    output.once("drain", resolvePromise);
    output.once("error", reject);
  });
}

/**
 * Reads newline-delimited JSON Recorder Bridge requests from `input` and
 * writes one newline-delimited JSON response per accepted line to `output`.
 * Accepted lines are dispatched concurrently; responses are written in the
 * order their dispatch resolves (which need not match input order), and
 * each write is serialized behind the previous one so two responses never
 * interleave mid-line. Resolves once every accepted line's response has
 * been written.
 */
export async function serveExecutionRecorderBridge(options: {
  readonly repository: EvidenceRepository;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}): Promise<void> {
  const bridge = createExecutionRecorderBridge({
    repository: options.repository,
  });

  let outputTail: Promise<void> = Promise.resolve();
  function enqueueResponse(response: RecorderBridgeResponse): Promise<void> {
    outputTail = outputTail.then(() =>
      writeWithBackpressure(options.output, `${JSON.stringify(response)}\n`),
    );
    return outputTail;
  }

  async function handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await enqueueResponse({
        protocol: RECORDER_BRIDGE_PROTOCOL,
        id: "",
        ok: false,
        error: {
          domain: "bridge",
          code: "PARSE_ERROR",
          message: "Request line is not valid JSON.",
        },
      });
      return;
    }
    const response = await bridge.dispatch(parsed);
    await enqueueResponse(response);
  }

  const reader = createInterface({
    input: options.input,
    crlfDelay: Infinity,
  });

  const pending: Promise<void>[] = [];
  for await (const line of reader) {
    if (line.trim().length === 0) continue;
    pending.push(handleLine(line));
  }

  await Promise.all(pending);
}
