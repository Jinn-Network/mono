// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { runExecutionRecorderBridgeCli } from "./cli.js";
import { RECORDER_BRIDGE_PROTOCOL } from "./protocol.js";

function collecting(): { writable: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { writable, chunks };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(path);
  return path;
}

describe("runExecutionRecorderBridgeCli", () => {
  test("exits 2 when --repository-root is missing", async () => {
    const output = collecting();
    const error = collecting();
    const exitCode = await runExecutionRecorderBridgeCli({
      args: [],
      input: Readable.from([]),
      output: output.writable,
      error: error.writable,
    });
    expect(exitCode).toBe(2);
    expect(error.chunks.join("")).toBe(
      "Usage: jinn-execution-recorder-bridge --repository-root <path>\n",
    );
    expect(output.chunks).toHaveLength(0);
  });

  test("exits 2 on a duplicate --repository-root", async () => {
    const root = await temporaryDirectory("jinn-bridge-cli-dup-");
    const error = collecting();
    const exitCode = await runExecutionRecorderBridgeCli({
      args: ["--repository-root", root, "--repository-root", root],
      input: Readable.from([]),
      output: collecting().writable,
      error: error.writable,
    });
    expect(exitCode).toBe(2);
    expect(error.chunks.join("")).toBe(
      "Usage: jinn-execution-recorder-bridge --repository-root <path>\n",
    );
  });

  test("exits 2 on an unknown argument", async () => {
    const root = await temporaryDirectory("jinn-bridge-cli-unknown-");
    const error = collecting();
    const exitCode = await runExecutionRecorderBridgeCli({
      args: ["--repository-root", root, "--verbose"],
      input: Readable.from([]),
      output: collecting().writable,
      error: error.writable,
    });
    expect(exitCode).toBe(2);
    expect(error.chunks.join("")).toBe(
      "Usage: jinn-execution-recorder-bridge --repository-root <path>\n",
    );
  });

  test("exits 1 with one sanitized standard-error line on invalid repository startup", async () => {
    const parent = await temporaryDirectory("jinn-bridge-cli-invalid-");
    const notADirectory = join(parent, "repository-root-is-a-file");
    await writeFile(notADirectory, "not a directory");

    const error = collecting();
    const exitCode = await runExecutionRecorderBridgeCli({
      args: ["--repository-root", notADirectory],
      input: Readable.from([]),
      output: collecting().writable,
      error: error.writable,
    });

    expect(exitCode).toBe(1);
    expect(error.chunks).toHaveLength(1);
    expect(error.chunks[0]?.endsWith("\n")).toBe(true);
    expect(error.chunks[0]).not.toContain(notADirectory);
    expect(error.chunks[0]).not.toContain(parent);
  });

  test("serves a hello request against a real filesystem Repository", async () => {
    const root = await temporaryDirectory("jinn-bridge-cli-hello-");
    const output = collecting();
    const error = collecting();
    const request = `${JSON.stringify({
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "cli-hello",
      method: "hello",
      params: {},
    })}\n`;

    const exitCode = await runExecutionRecorderBridgeCli({
      args: ["--repository-root", root],
      input: Readable.from([request]),
      output: output.writable,
      error: error.writable,
    });

    expect(exitCode).toBe(0);
    expect(error.chunks).toHaveLength(0);
    const responseLines = output.chunks
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(responseLines).toHaveLength(1);
    expect(JSON.parse(responseLines[0]!)).toEqual({
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "cli-hello",
      ok: true,
      result: expect.objectContaining({ protocol: RECORDER_BRIDGE_PROTOCOL }),
    });
  });
});
