import type { Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { OFFER_RECORD_KIND } from "./identifiers.js";
import type { OfferRecord } from "./schema.js";
import { resolveLiveOffers, type OfferEntry } from "./supersession.js";

const HOLDER = "urn:uuid:11111111-1111-5111-8111-111111111111";
const RIVAL = "urn:uuid:22222222-2222-5222-8222-222222222222";
const SUBJECT = `sha256:${"a".repeat(64)}` as Sha256Digest;
const OTHER_SUBJECT = `sha256:${"b".repeat(64)}` as Sha256Digest;
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

const digest = (marker: string): Sha256Digest =>
  `sha256:${marker.repeat(64).slice(0, 64)}` as Sha256Digest;

function entry(
  marker: string,
  overrides: {
    readonly amount?: string;
    readonly subject?: Sha256Digest;
    readonly supersedes?: Sha256Digest;
    readonly holder?: string;
  } = {},
): OfferEntry {
  const offer = {
    kind: OFFER_RECORD_KIND,
    subject: overrides.subject ?? SUBJECT,
    rails: [{ rail: USDC, to: "0xdeadbeef", amount: overrides.amount ?? "1500000" }],
    gate: { uri: "https://gate.example/offers" },
    ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
  } as OfferRecord;
  return { digest: digest(marker), offer, holder: overrides.holder ?? HOLDER };
}

const codes = (report: ReturnType<typeof resolveLiveOffers>) =>
  report.diagnostics.map((diagnostic) => diagnostic.code);

describe("resolveLiveOffers", () => {
  test("an unsuperseded offer is live", () => {
    const report = resolveLiveOffers([entry("1")]);
    expect(report.live.map((live) => live.digest)).toEqual([digest("1")]);
    expect(report.diagnostics).toEqual([]);
  });

  test("an empty set has no live offers — silence is not free", () => {
    expect(resolveLiveOffers([]).live).toEqual([]);
  });

  test("a repricing retires its predecessor and stays live", () => {
    const original = entry("1");
    const reprice = entry("2", { amount: "900000", supersedes: original.digest });
    const report = resolveLiveOffers([original, reprice]);
    expect(report.live.map((live) => live.digest)).toEqual([reprice.digest]);
    expect(report.superseded.map((old) => old.digest)).toEqual([original.digest]);
    expect(report.diagnostics).toEqual([]);
  });

  test("a chain of repricings leaves only the newest live", () => {
    const first = entry("1");
    const second = entry("2", { supersedes: first.digest });
    const third = entry("3", { supersedes: second.digest });
    const report = resolveLiveOffers([first, second, third]);
    expect(report.live.map((live) => live.digest)).toEqual([third.digest]);
  });

  test("input order is preserved, so chain order does not depend on argument order", () => {
    const first = entry("1");
    const second = entry("2", { supersedes: first.digest });
    const third = entry("3", { supersedes: second.digest });
    expect(resolveLiveOffers([third, first, second]).live.map((live) => live.digest))
      .toEqual([third.digest]);
  });

  test("supersession across subjects is refused — one offer prices one subject", () => {
    const other = entry("1", { subject: OTHER_SUBJECT });
    const successor = entry("2", { supersedes: other.digest });
    const report = resolveLiveOffers([other, successor]);
    expect(codes(report)).toEqual(["SUBJECT_MISMATCH"]);
    expect(report.live.map((live) => live.digest)).toEqual([other.digest, successor.digest]);
  });

  test("supersession by a different holder is refused — only the holder retires an offer", () => {
    const mine = entry("1");
    const theirs = entry("2", { holder: RIVAL, supersedes: mine.digest });
    const report = resolveLiveOffers([mine, theirs]);
    expect(codes(report)).toEqual(["FOREIGN_SUPERSESSION"]);
    expect(report.live.map((live) => live.digest)).toEqual([mine.digest, theirs.digest]);
  });

  test("superseding an offer outside the set leaves the successor live, and says so", () => {
    const successor = entry("2", { supersedes: digest("9") });
    const report = resolveLiveOffers([successor]);
    expect(codes(report)).toEqual(["UNKNOWN_PREDECESSOR"]);
    expect(report.live.map((live) => live.digest)).toEqual([successor.digest]);
  });

  test("a fork leaves both successors live and retires the predecessor", () => {
    const original = entry("1");
    const left = entry("2", { supersedes: original.digest });
    const right = entry("3", { supersedes: original.digest });
    const report = resolveLiveOffers([original, left, right]);
    expect(codes(report)).toEqual(["SUPERSESSION_FORK"]);
    expect(report.live.map((live) => live.digest)).toEqual([left.digest, right.digest]);
  });

  test("a repeated offer is counted once and reported", () => {
    const original = entry("1");
    const report = resolveLiveOffers([original, original]);
    expect(codes(report)).toEqual(["DUPLICATE_OFFER"]);
    expect(report.live).toHaveLength(1);
  });

  test("a self-superseding offer is reported and stays live", () => {
    const self = entry("1");
    const report = resolveLiveOffers([{
      ...self,
      offer: { ...self.offer, supersedes: self.digest } as OfferRecord,
    }]);
    expect(codes(report)).toEqual(["SELF_SUPERSESSION"]);
    expect(report.live).toHaveLength(1);
  });

  // Impossible against honestly sealed bytes, but a set that vanishes with no diagnostic is
  // the worst possible answer to hand-written input.
  test("a supersession cycle is reported and leaves every member live", () => {
    const left = entry("1");
    const right = entry("2");
    const report = resolveLiveOffers([
      { ...left, offer: { ...left.offer, supersedes: right.digest } as OfferRecord },
      { ...right, offer: { ...right.offer, supersedes: left.digest } as OfferRecord },
    ]);
    expect(codes(report)).toEqual(["SUPERSESSION_CYCLE"]);
    expect(report.live).toHaveLength(2);
    expect(report.superseded).toEqual([]);
  });

  test("a cycle does not retire offers outside it", () => {
    const left = entry("1");
    const right = entry("2");
    const outside = entry("3");
    const successor = entry("4", { supersedes: outside.digest });
    const report = resolveLiveOffers([
      { ...left, offer: { ...left.offer, supersedes: right.digest } as OfferRecord },
      { ...right, offer: { ...right.offer, supersedes: left.digest } as OfferRecord },
      outside,
      successor,
    ]);
    expect(codes(report)).toEqual(["SUPERSESSION_CYCLE"]);
    expect(report.live.map((live) => live.digest))
      .toEqual([left.digest, right.digest, successor.digest]);
    expect(report.superseded.map((old) => old.digest)).toEqual([outside.digest]);
  });

  // The mirror of the case above, and the one that costs someone money if it is wrong: an
  // edge pointing INTO a cycle. Dropping the cycle's own edges says nothing about an outside
  // supersession, so 1 must stay retired rather than come back live at its old price.
  test("a cycle does not resurrect a member that an outside offer legitimately retired", () => {
    // cycle 1 -> 2 -> 3 -> 1, plus 4 -> 1 from outside it.
    const report = resolveLiveOffers([
      entry("1", { supersedes: digest("2") }),
      entry("2", { supersedes: digest("3") }),
      entry("3", { supersedes: digest("1") }),
      entry("4", { supersedes: digest("1") }),
    ]);
    expect(codes(report)).toEqual(["SUPERSESSION_FORK", "SUPERSESSION_CYCLE"]);
    expect(report.live.map((live) => live.digest))
      .toEqual([digest("2"), digest("3"), digest("4")]);
    expect(report.superseded.map((old) => old.digest)).toEqual([digest("1")]);
  });

  test("a two-cycle does not resurrect a member an outside offer retired", () => {
    const report = resolveLiveOffers([
      entry("1", { supersedes: digest("2") }),
      entry("2", { supersedes: digest("1") }),
      entry("4", { supersedes: digest("1") }),
    ]);
    expect(codes(report)).toEqual(["SUPERSESSION_FORK", "SUPERSESSION_CYCLE"]);
    expect(report.live.map((live) => live.digest)).toEqual([digest("2"), digest("4")]);
    expect(report.superseded.map((old) => old.digest)).toEqual([digest("1")]);
  });

  test("offers for different subjects never interfere", () => {
    const mine = entry("1");
    const other = entry("2", { subject: OTHER_SUBJECT });
    const report = resolveLiveOffers([mine, other]);
    expect(report.live).toHaveLength(2);
    expect(report.diagnostics).toEqual([]);
  });
});
