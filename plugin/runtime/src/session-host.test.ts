import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { main } from "./bin.js";
import {
  CAPTURE_SIGNER_DIRECTORY,
  loadOrCreateLocalCaptureSigner,
  LOCAL_CAPTURE_KEYID,
} from "./session-host-signer.js";

async function writableHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jinn-session-host-"));
}

describe("session-host composition", () => {
  test("loadOrCreateLocalCaptureSigner is durable across calls", async () => {
    const home = await writableHome();
    const first = await loadOrCreateLocalCaptureSigner(home);
    const second = await loadOrCreateLocalCaptureSigner(home);
    const request = {
      payloadType: "application/vnd.jinn.test",
      payloadBytes: new Uint8Array([1, 2, 3]),
      preAuthEncoding: new Uint8Array([4, 5, 6]),
    };
    const firstSig = await first(request);
    const secondSig = await second(request);
    expect(firstSig[0]?.keyid).toBe(LOCAL_CAPTURE_KEYID);
    expect(secondSig[0]?.keyid).toBe(LOCAL_CAPTURE_KEYID);
    expect(firstSig[0]?.signature).toEqual(secondSig[0]?.signature);
  });

  test("main serve --role session succeeds when captureSigner is injected", async () => {
    const home = await writableHome();
    const out: string[] = [];
    const err: string[] = [];
    const captureSigner = await loadOrCreateLocalCaptureSigner(home);
    const code = await main(["serve", "--role", "session"], {}, {
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      homeDirectory: home,
      untilShutdown: async () => {},
      captureSigner,
    });
    expect(code).toBe(0);
    expect(err.join("")).toContain("role=session");
    expect(join(home, CAPTURE_SIGNER_DIRECTORY)).toBeTruthy();
  });
});
