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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig, type MirrorSourceConfig } from "../config.js";
import { didKeyFromEd25519PublicKey } from "../session-host-crypto.js";
import { createLocalCorpusPorts } from "../session-host-corpus.js";
import { createCorpusCapability } from "./capability.js";
import { buildSignedFixtureArchive, loopbackFetch } from "./testing-fixture.js";

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

/**
 * A real Ed25519 signer whose keyid is the did:key its own public half encodes.
 *
 * It stays in the test files that use it rather than moving beside
 * `loopbackFetch` in `testing-fixture.js`: that module is scanned as
 * production source, and the custody gate's key-material canary refuses a
 * private key there. Test files are exempt.
 */
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

  // Mutable so one composition can be polled twice at different clocks --
  // the only way to show that an unchanged head is re-checked for freshness
  // rather than remembered as accepted.
  let clock = NOW;
  const ports = createLocalCorpusPorts({
    config,
    fetchLike: loopbackFetch(archive.routes),
    now: () => clock,
  });
  const capability = createCorpusCapability({
    transport: ports.corpusTransport,
    fs: ports.corpusFs,
    dsseVerifier: ports.dsseVerifier,
    readPolicyVersions: ports.readPolicyVersions,
    verifyDriver: ports.corpusVerifyDriver,
    now: () => clock,
  });
  await capability.start!({ config, log: log() });
  return {
    archive,
    capability,
    config,
    advanceTo(instant: Date) {
      clock = instant;
    },
  };
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

  test("a second sync of an unchanged head is a clean no-op, not a broken chain (#3443)", async () => {
    const { capability, config } = await compose();
    expect((await capability.mirror.syncOnce()).status).toBe("synced");
    const markAfterFirst = JSON.parse(await readFile(config.mirrorStatePath, "utf8")) as unknown;

    // The fixture archive is static, so the second sync re-presents the head
    // the first one accepted -- exactly what any real archive polled more
    // often than it re-signs presents. `verifySourceChain` cannot express
    // that: §5.2 requires `issuedAt` to strictly increase, so the head it is
    // handed is a chain regression. The mirror recognizes the position as its
    // own and revalidates the head instead.
    const second = await capability.mirror.syncOnce();

    expect(second.status).toBe("synced");
    expect(second.sources[0]!.failure).toBeUndefined();
    expect(second.sources[0]!.indexed).toBe(0);
    expect(await chainVerificationCheck(capability)).toMatchObject({
      name: "corpus-chain-verification",
      ok: true,
    });

    // Nothing adopted means nothing advanced. The persisted `issuedAt` is the
    // floor the next head that DOES move has to strictly clear, so a
    // revalidated no-op must leave it exactly where it was -- otherwise the
    // no-op path would quietly become a way to launder a replayed head.
    expect(JSON.parse(await readFile(config.mirrorStatePath, "utf8"))).toEqual(markAfterFirst);
  });

  test("a re-signed idle head at the same position is a clean no-op too, and raises the floor (#3468)", async () => {
    const { archive, capability, config, advanceTo } = await compose();
    expect((await capability.mirror.syncOnce()).status).toBe("synced");

    // The idle re-signing §5.2 obliges a live source to perform before
    // `refreshBy` expires (`serve`'s `maintainHead`): same `sequence`, same
    // `entry`, a later `issuedAt` and `refreshBy`, genuinely re-signed by the
    // archive's own key. Before #3468
    // this reached `verifySourceChain`, whose linkage walk is fed no entries
    // above the mark and reported `broken-chain` at `linkage` -- so a healthy
    // archive went red the moment it re-signed.
    // The re-sign happens at the source's own clock, and both consumers now
    // bound the whole freshness window (#3467): `refreshBy` no further than the
    // published-source profile's 24h ceiling ahead of `issuedAt`, and
    // `issuedAt` no further ahead of the consumer's own clock than one window
    // is long. So the poll moves with the re-sign, and the window it carries
    // sits at the same ceiling the fixture's original head does.
    advanceTo(new Date("2026-07-30T12:00:00Z"));
    await archive.serveHead({
      ...archive.head,
      issuedAt: "2026-07-30T12:00:00Z",
      refreshBy: "2026-07-31T12:00:00Z",
    });
    const second = await capability.mirror.syncOnce();

    expect(second.status).toBe("synced");
    expect(second.sources[0]!.failure).toBeUndefined();
    expect(second.sources[0]!.indexed).toBe(0);
    expect((await chainVerificationCheck(capability)).ok).toBe(true);

    // The position did not move -- nothing was adopted -- but the instant did.
    // That advanced floor is what makes the head this re-sign replaced a
    // regression at the next poll rather than a replayable one.
    const state = JSON.parse(await readFile(config.mirrorStatePath, "utf8")) as {
      readonly marks: Record<string, { readonly sequence: string; readonly issuedAt: string }>;
    };
    expect(state.marks[`${source.agent}/${source.name}`]).toMatchObject({
      sequence: "0000000000000001",
      issuedAt: "2026-07-30T12:00:00Z",
    });
  });

  test("the head a re-sign replaced is then refused as a chain regression (#3468)", async () => {
    const { archive, capability, advanceTo } = await compose();
    expect((await capability.mirror.syncOnce()).status).toBe("synced");
    // The same conformant re-sign as the test above: the clock moves with the
    // source, and the window it carries sits at the profile ceiling rather
    // than past it (#3467). All this test needs from it is the raised floor.
    advanceTo(new Date("2026-07-30T12:00:00Z"));
    await archive.serveHead({
      ...archive.head,
      issuedAt: "2026-07-30T12:00:00Z",
      refreshBy: "2026-07-31T12:00:00Z",
    });
    expect((await capability.mirror.syncOnce()).status).toBe("synced");

    // Replaying the original head after the floor moved past it. It is
    // genuinely signed and names a position this consumer holds, and it is
    // still refused -- by §5.2's strict-increase rule on the chain path,
    // which is where a head whose instant went backwards belongs.
    await archive.serveHead(archive.head);
    const replayed = await capability.mirror.syncOnce();

    expect(replayed.status).toBe("failed");
    expect(replayed.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "broken-chain",
    });
  });

  test("the shared mark still governs: the driver resumes from the position the mirror stored", async () => {
    // The linkage that would break if the driver and the mirror kept separate
    // state files: the second sync can only recognize the re-served head as
    // its OWN position because both read the same mark.
    const { capability, config } = await compose();
    await capability.mirror.syncOnce();

    const state = JSON.parse(await readFile(config.mirrorStatePath, "utf8")) as {
      readonly marks: Record<string, { readonly sequence: string; readonly issuedAt: string }>;
    };
    const mark = state.marks[`${source.agent}/${source.name}`];
    expect(mark?.sequence).toBe("0000000000000001");

    const second = await capability.mirror.syncOnce();
    expect(second.sources[0]!.entriesWalked).toBe(0);
    expect(second.sources[0]!.status).toBe("synced");
  });

  test("an unchanged head that has crossed refreshBy is refused, so revalidation is not a cached acceptance", async () => {
    const { capability, advanceTo } = await compose();
    expect((await capability.mirror.syncOnce()).status).toBe("synced");

    // Same bytes, same signature, same chain position -- only the clock moved
    // past the head's own `refreshBy`. A source that stops re-signing stops
    // being followed, exactly as it would on the chain path.
    advanceTo(new Date("2026-09-15T00:00:00Z"));
    const second = await capability.mirror.syncOnce();

    expect(second.status).toBe("failed");
    expect(second.sources[0]!.failure).toEqual({
      code: "chain-verification-rejected",
      message: "stale",
    });
    expect((await chainVerificationCheck(capability)).ok).toBe(false);
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
