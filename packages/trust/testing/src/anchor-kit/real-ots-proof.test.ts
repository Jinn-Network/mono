// SPDX-License-Identifier: Apache-2.0

/**
 * The two committed real OpenTimestamps proofs (design §11, §6.2).
 *
 * Every other OpenTimestamps proof in this kit is minted deterministically, and
 * that is the right default -- a builder never drifts out of agreement with
 * itself. But a builder can only ever produce a *self-consistent* proof, and
 * self-consistency is precisely what §11 family 10 says proves nothing: an
 * invented height with a matching path replays perfectly. These two files are
 * what three public calendars and the Bitcoin chain actually did with one digest
 * on 2026-08-17, and they are the only bytes in the kit whose commitment a third
 * party can check against a chain nobody here controls.
 *
 * They are also the §11 family 9 upgraded pair in its production form: the same
 * subject, two records, one pending and one chain-complete. Each is reported on
 * its own bytes, and the complete one governs -- §6.2's append-only upgrade, not
 * the reference tooling's in-place file mutation.
 *
 * `fixtures/anchor-kit-v1/ots-stamp-provenance.md` records where they came from
 * and how to re-derive every value asserted here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  compareCalendarStrictRfc3339Instants,
  createOpenTimestampsProofVerifier,
} from "@jinn-network/trust-core";
import type { OpenTimestampsBlockHeader } from "@jinn-network/trust-core";

import { bytesToHex, hexToBytes } from "./der-encoder.js";
import { KIT_SUBJECT_SHA256, KIT_UNRELATED_SUBJECT_SHA256 } from "./conformance.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/anchor-kit-v1/", import.meta.url));

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}${name}`));
}

const PENDING_PROOF = fixture("real-stamp-v1-pending.ots");
const COMPLETE_PROOF = fixture("real-stamp-v1-complete.ots");

/** When the digest was submitted to the three calendars (the P0 capture
 * record). Not a claim the proof makes -- the anchor is checked against it
 * below, never dated by it. */
const STAMPED_AT = "2026-08-17T20:39:16Z";

/** Bitcoin block 962949, the block the completed proof attests to. */
const BLOCK_HEIGHT = 962_949;
const BLOCK_TIME = "2026-08-17T21:11:34Z";
/**
 * The block's own 80 bytes, transcribed from two independent public explorers
 * that agreed byte-for-byte (see the provenance note for both URLs and the block
 * hash). They live here rather than in `fixtures/` deliberately: chain material
 * is *verifier-side* trust material (§4.3, §8 step 3), so it is this test's
 * configuration, not something the kit publishes. Anyone can re-fetch it and get
 * the same 80 bytes; nobody has to take the kit's word for them.
 */
const BLOCK_HEADER = hexToBytes(
  "0000002e8ec8767a18fbb46739d826e9c066fe2aa433903ffb2200000000000000000000"
  + "b8dcd52d129234b8e73db0dcb9c48e736d053fb3d4c231c1f4112a75411ea5fb"
  + "0679836a3d350217dbdf1042",
);

const CHAIN_VIEW: readonly OpenTimestampsBlockHeader[] = [
  { height: BLOCK_HEIGHT, header: BLOCK_HEADER },
];

const verifier = createOpenTimestampsProofVerifier();

function verify(
  proofBytes: Uint8Array,
  blockHeaders?: readonly OpenTimestampsBlockHeader[],
  subjectSha256 = KIT_SUBJECT_SHA256,
) {
  return verifier.verifyProof({
    subjectSha256,
    proofBytes,
    ...(blockHeaders === undefined ? {} : { trust: { blockHeaders } }),
  });
}

describe("the committed bytes are the ones the provenance note describes", () => {
  test.each([
    ["real-stamp-v1-pending.ots", 530, "32e607d6dc1f32911bf36b559ffc376f9833f054d3e16fe75db3b9d707402694"],
    ["real-stamp-v1-complete.ots", 1496, "948e5dcda5fc5b6824009c865c6e33d96be90de89c0d8a63bdf9b31f2722f806"],
  ])("%s", (name, length, digest) => {
    expect(fixture(name).length).toBe(length);
    expect(bytesToHex(sha256(fixture(name)))).toBe(digest);
  });

  test("the block header is the one both explorers reported", () => {
    expect(BLOCK_HEADER.length).toBe(80);
    expect(bytesToHex(BLOCK_HEADER.subarray(36, 68)))
      .toBe("b8dcd52d129234b8e73db0dcb9c48e736d053fb3d4c231c1f4112a75411ea5fb");
  });
});

describe("the pending proof", () => {
  test("is pending on authority-time, and says what it is waiting for", () => {
    const result = verify(PENDING_PROOF);
    expect(result.status).toBe("pending");
    expect(result.status === "pending" && result.timeBasis).toBe("authority-time");
    expect(result.status === "pending" && result.reason).toContain("3 calendar promises");
  });

  test("stays pending with a chain view supplied", () => {
    // A calendar promise is not checkable even in principle, and no verifier may
    // reach for the network to upgrade one mid-check (§4.3).
    expect(verify(PENDING_PROOF, CHAIN_VIEW).status).toBe("pending");
  });

  test("is invalid over any other subject digest", () => {
    expect(verify(PENDING_PROOF, undefined, KIT_UNRELATED_SUBJECT_SHA256).status).toBe("invalid");
  });
});

describe("the chain-complete proof", () => {
  test("replays to its attested height with no chain view supplied", () => {
    const result = verify(COMPLETE_PROOF);
    expect(result.status).toBe("present");
    expect(result.status === "present" && result.timeBasis).toBe("chain-time");
    expect(result.status === "present" && result.facts).toEqual({ blockHeight: BLOCK_HEIGHT });
    // Replay self-consistency is not chain evaluation: no evaluated time here.
    expect("time" in result).toBe(false);
  });

  test("is verified against the real block header, and reports that block's time", () => {
    const result = verify(COMPLETE_PROOF, CHAIN_VIEW);
    expect(result.status).toBe("verified");
    expect(result.status === "verified" && result.facts).toEqual({ blockHeight: BLOCK_HEIGHT });
    expect(result.status === "verified" && result.time).toBe(BLOCK_TIME);
  });

  test("is invalid against a header at that height carrying another merkle root", () => {
    // §11 family 10 on production bytes: the header is what catches a
    // commitment the chain never made.
    const altered = BLOCK_HEADER.slice();
    altered[40] = (altered[40]! ^ 0xff) & 0xff;
    expect(verify(COMPLETE_PROOF, [{ height: BLOCK_HEIGHT, header: altered }]).status).toBe("invalid");
  });

  test("is present, not invalid, when the chain view holds other heights only", () => {
    const elsewhere = [{ height: BLOCK_HEIGHT + 1, header: BLOCK_HEADER }];
    expect(verify(COMPLETE_PROOF, elsewhere).status).toBe("present");
  });

  test("is invalid over any other subject digest", () => {
    expect(verify(COMPLETE_PROOF, CHAIN_VIEW, KIT_UNRELATED_SUBJECT_SHA256).status).toBe("invalid");
  });

  test("anchors no earlier than the instant the digest was submitted", () => {
    // The honest ordering check: an anchor is evidence that the digest existed
    // by its block time, and this block came 32 minutes after the stamp. A proof
    // that "verified" to an instant before its own submission would be evidence
    // of a broken replay, not of a better anchor.
    expect(compareCalendarStrictRfc3339Instants(STAMPED_AT, BLOCK_TIME)).toBe(-1);
  });
});

describe("the two records are one upgraded pair", () => {
  test("both bind the same subject, and the complete one governs", () => {
    expect(verify(PENDING_PROOF, CHAIN_VIEW).status).toBe("pending");
    expect(verify(COMPLETE_PROOF, CHAIN_VIEW).status).toBe("verified");
    // The pending bytes are not rewritten by the upgrade -- they are still a
    // record, still reported on their own bytes (§5 rule 6, §6.2).
    expect(bytesToHex(PENDING_PROOF)).not.toBe(bytesToHex(COMPLETE_PROOF));
  });

  test("the upgraded proof keeps the earlier calendar branches byte-for-byte", () => {
    // Both files were assembled from the same three calendar responses over the
    // same digest, so the upgrade adds to one branch rather than re-stamping.
    // The two agree byte-for-byte as far as the point where the alice branch's
    // Bitcoin path is spliced, and diverge from there -- so the pending file is
    // *not* a byte prefix of the completed one, and the completed one is an
    // addition beside it rather than a replacement for it (§5 rule 6, §6.2).
    let shared = 0;
    while (
      shared < Math.min(PENDING_PROOF.length, COMPLETE_PROOF.length)
      && PENDING_PROOF[shared] === COMPLETE_PROOF[shared]
    ) shared += 1;
    expect(shared).toBe(339);
    expect(shared).toBeLessThan(PENDING_PROOF.length);
    expect(COMPLETE_PROOF.length).toBeGreaterThan(PENDING_PROOF.length);
    expect(verify(PENDING_PROOF).status).not.toBe("invalid");
  });
});
