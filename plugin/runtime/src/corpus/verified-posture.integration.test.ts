// SPDX-License-Identifier: Apache-2.0
/**
 * The `verified` posture, end to end, through the real composition root.
 *
 * Everything on this path is production code: the host-adapter composition in
 * `session-host-corpus.ts`, the HTTP transport from
 * `@jinn-network/record-discovery-transport-http`, `createVerifyDriver` over a
 * real trust adapter, real Ed25519 over the real DSSE pre-auth encoding, the
 * real trust-policy chain read off a real directory, and the mirror's own
 * durable high-water-mark store. The only fake is the socket: an in-memory
 * `fetchLike` serves the archive so the suite acquires no ambient network.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DsseSigner } from "@jinn-network/trust-core";
import type { FetchLike } from "@jinn-network/record-discovery-transport-http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig, type MirrorSourceConfig } from "../config.js";
import { didKeyFromEd25519PublicKey } from "../session-host-crypto.js";
import { createLocalCorpusPorts } from "../session-host-corpus.js";
import { createCorpusCapability } from "./capability.js";
import { buildSignedFixtureArchive } from "./testing-fixture.js";

const NOW = new Date("2026-07-30T00:00:00Z");

const source: MirrorSourceConfig = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
  signingKeys: [],
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-verified-posture-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A real Ed25519 signer whose keyid is the did:key its own public half encodes. */
function archiveSigner(): { readonly didKey: string; readonly signer: DsseSigner } {
  const pair = generateKeyPairSync("ed25519");
  const didKey = didKeyFromEd25519PublicKey(pair.publicKey);
  return {
    didKey,
    signer: async (request) => [
      { signature: new Uint8Array(sign(null, request.preAuthEncoding, pair.privateKey)), keyid: didKey },
    ],
  };
}

function loopback(routes: ReadonlyMap<string, Uint8Array>): FetchLike {
  return async (url) => {
    const bytes = routes.get(url);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Composes the archive, the config, and the capability exactly as a process
 * entry point does — the ports come from `createLocalCorpusPorts`, not from a
 * hand-built double.
 */
async function compose(options: {
  readonly declareSigningKey?: boolean;
  readonly tamper?: "head" | "entry";
} = {}) {
  const { didKey, signer } = archiveSigner();
  const archive = await buildSignedFixtureArchive({
    source,
    admittedProducers: ["https://agents.test/alice"],
    signerKeyid: didKey,
    signer,
    ...(options.tamper === undefined ? {} : { tamper: options.tamper }),
  });

  const policyDirectory = join(home, "policy");
  await mkdir(policyDirectory, { recursive: true });
  await writeFile(join(policyDirectory, "001.dsse"), archive.policyVersions[0]!);

  const config = resolveRuntimeConfig({
    env: {},
    homeDirectory: home,
    file: {
      corpus: {
        sources: [
          {
            ...source,
            signingKeys:
              options.declareSigningKey === false
                ? []
                : [{ keyid: didKey, validFrom: "2026-01-01T00:00:00.000Z" }],
          },
        ],
        chainVerification: "verified",
        trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
      },
    },
  });

  const ports = createLocalCorpusPorts({
    config,
    fetchLike: loopback(archive.routes),
    now: () => NOW,
  });
  const capability = createCorpusCapability({
    transport: ports.corpusTransport,
    fs: ports.corpusFs,
    dsseVerifier: ports.dsseVerifier,
    readPolicyVersions: ports.readPolicyVersions,
    verifyDriver: ports.corpusVerifyDriver,
    now: () => NOW,
  });
  await capability.start!({ config, log: log() });
  return { archive, capability, config };
}

async function chainVerificationCheck(capability: Awaited<ReturnType<typeof compose>>["capability"]) {
  const checks = await capability.healthChecks!();
  return checks.find((check) => check.name === "corpus-chain-verification")!;
}

describe("the verified posture over a genuinely signed archive", () => {
  test("verifies the chain, indexes the records, and reports the live posture", async () => {
    const { archive, capability, config } = await compose();

    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("synced");
    expect(outcome.sources[0]!.indexed).toBeGreaterThanOrEqual(1);

    // Indexed AND readable: readability additionally proves the real
    // did:key DSSE verifier admitted the genuinely signed trust policy.
    const page = await capability.reader.listRecords({ limit: 10 });
    expect(page.items.map((item) => item.reference.digest)).toContain(archive.reference.digest);

    // The high-water mark the DRIVER advanced is the mirror's own file — the
    // linkage that would break on the second sync if they were separate.
    const state = JSON.parse(await readFile(config.mirrorStatePath, "utf8")) as {
      readonly marks: Record<string, { readonly sequence: string }>;
    };
    expect(state.marks[`${source.agent}/${source.name}`]?.sequence).toBe("0000000000000001");

    expect(await chainVerificationCheck(capability)).toMatchObject({
      name: "corpus-chain-verification",
      ok: true,
      detail: "Announcement chains are verified before indexing.",
    });
  });

  test("the driver reads the mark the mirror stored, so a re-presented head is not re-accepted", async () => {
    const { capability } = await compose();
    expect((await capability.mirror.syncOnce()).status).toBe("synced");

    // The archive has published nothing new, so it re-serves a head whose
    // `issuedAt` has not advanced. `verifySourceChain` compares that against
    // the `issuedAt` persisted on the high-water mark — which is only
    // possible because the driver was given the MIRROR'S OWN store — and
    // refuses the regression. Under the `verified` posture a returning sync
    // therefore reports `failed` until the source re-signs its head; nothing
    // is re-indexed either way.
    const second = await capability.mirror.syncOnce();
    expect(second.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "broken-chain",
    });
    expect(second.sources[0]!.indexed).toBe(0);
  });
});

describe("the verified posture fails closed", () => {
  test("refuses a tampered head signature and names the source in health", async () => {
    const { capability } = await compose({ tamper: "head" });

    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "unauthorized-signer",
    });
    expect(outcome.sources[0]!.indexed).toBe(0);

    const check = await chainVerificationCheck(capability);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(`${source.agent}/${source.name} (unauthorized-signer)`);
  });

  test("refuses an archive that has declared no signing key", async () => {
    // Following an archive is not the same act as trusting a key to speak for
    // it: with no declared key the head resolves against no candidate at all.
    const { capability } = await compose({ declareSigningKey: false });

    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure?.message).toBe("unauthorized-signer");
    expect((await chainVerificationCheck(capability)).ok).toBe(false);
  });

  test("refuses a tampered entry signature", async () => {
    const { capability } = await compose({ tamper: "entry" });

    const outcome = await capability.mirror.syncOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "broken-chain",
    });
    expect(outcome.sources[0]!.indexed).toBe(0);
  });
});
