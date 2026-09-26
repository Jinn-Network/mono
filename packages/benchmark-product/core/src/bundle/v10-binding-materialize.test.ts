// SPDX-License-Identifier: Apache-2.0

/**
 * The beacon binding, carried in a published `/10` bundle and read back by the portable reader
 * (issue #3370).
 *
 * `check/src/binding/bundle-carriage.test.ts` holds the pure linkage table and
 * `check/src/capability-lattice.test.ts` holds the closure half over generated path sets. This is
 * the half neither can supply, and it cannot live in `check` at all: the reader package cannot
 * depend on the product core, so only a test here can materialize a real bound bundle and then take
 * it through the same `verifyPublicBundle` a third party runs.
 *
 * Unlike `v10-verify.test.ts` the bundle is BUILT as `/10` rather than converted, because the thing
 * under test is the producer's own wiring: the activation fact, the member write, the claim section,
 * and the sentence the sealed `venueHonesty` carries.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  BEACON_BINDING_BUNDLE_MEMBER,
  BUNDLE_V10_FORMAT,
  computeBeaconOrder,
  deriveClaimRunBinding,
  expectedChecks,
  runBindingSentence,
  runBoundVenueLimits,
  verifyPublicBundle,
  verifyPublicBundleSnapshot,
  verifyRunBindingMember,
} from "@colophon-claims/check";
import { buildBundleManifest } from "./manifest.js";
import { createSyntheticV6BundleFixture } from "./testing/v6-synthetic-fixture.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A detached copy, so every mutation below runs against bytes with no workspace behind them. */
function detach(bundleDir: string): string {
  const root = mkdtempSync(join(tmpdir(), "v10-binding-detached-"));
  roots.push(root);
  const copy = join(root, "bundle");
  cpSync(bundleDir, copy, { recursive: true });
  return copy;
}

function json(bundleDir: string, path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(bundleDir, path), "utf8")) as Record<string, any>;
}

function memberPaths(bundleDir: string): string[] {
  return (json(bundleDir, "bundle.json") as { files: { path: string }[] }).files.map((file) => file.path);
}

/**
 * Re-seals the manifest over the directory's current members and declared vector.
 *
 * Without this every mutation below would be caught by the manifest digest alone, which proves only
 * that the manifest works. Re-sealing is what makes each case test the check it is named for.
 */
function reseal(
  bundleDir: string,
  options: { readonly capabilities?: readonly string[]; readonly files?: readonly string[] } = {},
): void {
  const manifest = json(bundleDir, "bundle.json") as { capabilities?: string[]; files: { path: string }[] };
  writeFileSync(
    join(bundleDir, "bundle.json"),
    buildBundleManifest(bundleDir, options.files ?? manifest.files.map((file) => file.path), {
      format: BUNDLE_V10_FORMAT,
      capabilities: options.capabilities ?? manifest.capabilities ?? [],
    }).bytes,
  );
}

/** Rewrites the carried binding record, then re-seals, so the bundle is internally well formed. */
function mutateBinding(bundleDir: string, mutate: (record: Record<string, any>) => void): void {
  const record = json(bundleDir, BEACON_BINDING_BUNDLE_MEMBER);
  mutate(record);
  writeFileSync(join(bundleDir, BEACON_BINDING_BUNDLE_MEMBER), JSON.stringify(record));
  reseal(bundleDir);
}

async function refusal(bundleDir: string): Promise<{ path: string; message: string }> {
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    const issue = (cause as { readonly issues?: readonly { path?: string; message?: string }[] }).issues?.[0];
    return { path: issue?.path ?? "", message: issue?.message ?? String(cause) };
  }
  return { path: "NOT REFUSED", message: "NOT REFUSED" };
}

async function boundFixture(label: string): Promise<{
  readonly bundleDir: string;
  readonly recordBytes: Uint8Array;
  readonly recordSha256: string;
}> {
  const workspaceDir = mkdtempSync(join(tmpdir(), `v10-binding-${label}-`));
  roots.push(workspaceDir);
  const built = await createSyntheticV6BundleFixture({ workspaceDir, bind: true, composedFormat: true });
  if (built.bindingRecordSha256 === undefined) throw new Error("bound fixture recorded no binding digest");
  const recordBytes = getSealedBytes(workspaceDir, built.bindingRecordSha256);
  const bundleDir = detach(built.bundle.bundleDir);
  return { bundleDir, recordBytes, recordSha256: built.bindingRecordSha256 };
}

describe("AC1 — a published /10 bundle carries the run's beacon-binding/1 record", () => {
  test("declares the capability, carries the record verbatim, and verifies with the derived checks", async () => {
    const { bundleDir, recordBytes, recordSha256 } = await boundFixture("ac1");

    const manifest = json(bundleDir, "bundle.json");
    expect(manifest["format"]).toBe(BUNDLE_V10_FORMAT);
    expect(manifest["capabilities"]).toContain("beacon-binding");

    // Verbatim is the property, not merely "a record is present": the member is the sealed store's
    // own bytes, so the manifest's digest, the claim's `recordSha256`, and the store's digest are
    // ONE value and nothing was re-encoded in transit.
    const carried = new Uint8Array(readFileSync(join(bundleDir, BEACON_BINDING_BUNDLE_MEMBER)));
    expect(Buffer.from(carried).equals(Buffer.from(recordBytes))).toBe(true);
    expect(sha256Hex(carried)).toBe(recordSha256);
    const entry = (manifest as { files: { path: string; sha256: string }[] }).files
      .find((file) => file.path === BEACON_BINDING_BUNDLE_MEMBER);
    expect(entry?.sha256).toBe(recordSha256);

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.capabilities).toContain("beacon-binding");
    expect(verified.checks).toEqual(expectedChecks(verified.capabilities));
    expect(verified.checks.at(-1)).toBe("beacon-binding");
  }, 180_000);
});

describe("AC2 — the verifier resolves the record and refuses a foreign one", () => {
  test("a record retargeted at another run is refused, though it verifies clean on its own", async () => {
    const { bundleDir } = await boundFixture("ac2-seal");
    // The order is recomputed for the foreign seal, so `verifyRunBinding` passes: this is the
    // post-hoc move the binding exists to make impossible, and the ONLY thing wrong with the record
    // is the run it belongs to. A mutation that merely broke the recomputation would prove the
    // recomputation works, not that the linkage does.
    const foreign = `sha256:${"c".repeat(64)}`;
    mutateBinding(bundleDir, (record) => {
      record["sealDigest"] = foreign;
      record["order"] = computeBeaconOrder({
        sealDigest: foreign,
        beaconValue: record["beacon"].value as string,
        itemSha256s: record["itemSha256s"] as string[],
      }).order;
    });
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe(BEACON_BINDING_BUNDLE_MEMBER);
    expect(refused.message).toContain("which is not this run's sealed Run");
  }, 180_000);

  test("a record whose sealedAt disagrees with the Run's declared instant is refused", async () => {
    const { bundleDir } = await boundFixture("ac2-instant");
    // Lowered, which is the direction that matters: it is how a beacon that actually predated the
    // real seal would be made to pass the postdating check. The fixture's Run declares a seal
    // instant (it was sealed after `beacon-source/v1` gained the field), so the comparison runs.
    mutateBinding(bundleDir, (record) => { record["sealedAt"] = "2020-01-01T00:00:00.000Z"; });
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe(BEACON_BINDING_BUNDLE_MEMBER);
    expect(refused.message).toContain("but this run was sealed at");
  }, 180_000);

  test("a record that drops the source its Run declared is refused", async () => {
    const { bundleDir } = await boundFixture("ac2-omit");
    // Omission is the escape the record's own verification cannot see: it verifies clean and reads
    // as `operator-chosen`, which is exactly how a declared run's binding would look honest.
    mutateBinding(bundleDir, (record) => { delete record["declaredSource"]; });
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe(BEACON_BINDING_BUNDLE_MEMBER);
    expect(refused.message).toContain("binding declares no beacon source, but its sealed Run declares drand/quicknet");
  }, 180_000);

  test("a record naming a different source than its Run is refused", async () => {
    const { bundleDir } = await boundFixture("ac2-source");
    // BOTH fields move, because `verifyRunBinding`'s own rule is that the restatement agrees with
    // the beacon the record names -- so the only forgery that reaches the linkage is one that is
    // internally consistent about a source the Run never named. The order survives the swap: the
    // derivation keys on the beacon VALUE, never on its source id.
    mutateBinding(bundleDir, (record) => {
      record["beacon"] = { ...record["beacon"], source: "drand/default" };
      record["declaredSource"] = "drand/default";
    });
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe(BEACON_BINDING_BUNDLE_MEMBER);
    expect(refused.message)
      .toContain("binding names drand/default as this run's declared beacon source, but its sealed Run declares drand/quicknet");
  }, 180_000);

  test("a record whose declared order is not the recomputation is refused", async () => {
    const { bundleDir } = await boundFixture("ac2-order");
    mutateBinding(bundleDir, (record) => { record["order"] = [...(record["order"] as string[])].reverse(); });
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe(BEACON_BINDING_BUNDLE_MEMBER);
    expect(refused.message).toContain("recomputation");
  }, 180_000);

  test("stripping the member while declaring the capability is a closure failure", async () => {
    const { bundleDir } = await boundFixture("ac2-strip");
    unlinkSync(join(bundleDir, BEACON_BINDING_BUNDLE_MEMBER));
    reseal(bundleDir, { files: memberPaths(bundleDir).filter((path) => path !== BEACON_BINDING_BUNDLE_MEMBER) });
    expect(await refusal(bundleDir)).toEqual({
      path: BEACON_BINDING_BUNDLE_MEMBER,
      message: expect.stringContaining("is missing"),
    });
  }, 180_000);

  test("keeping the member while dropping the declaration is a non-allowlisted file", async () => {
    const { bundleDir } = await boundFixture("ac2-undeclare");
    const capabilities = (json(bundleDir, "bundle.json")["capabilities"] as string[])
      .filter((token) => token !== "beacon-binding");
    reseal(bundleDir, { capabilities });
    expect(await refusal(bundleDir)).toEqual({
      path: BEACON_BINDING_BUNDLE_MEMBER,
      message: expect.stringContaining("non-allowlisted"),
    });
  }, 180_000);
});

describe("AC3 — venueHonesty carries the sentence and the claim stays a byte compare", () => {
  test("the sealed claim ends its limits in the binding sentence and carries the projected section", async () => {
    const { bundleDir, recordBytes } = await boundFixture("ac3");
    const claim = json(bundleDir, "claim-package.json");
    const binding = verifyRunBindingMember(recordBytes);

    expect(claim["venueHonesty"].limits.at(-1)).toBe(runBindingSentence(binding));
    expect(claim["binding"]).toEqual(deriveClaimRunBinding(recordBytes));
    // The strongest sentence the face can print, so the fixture is not quietly exercising the
    // weakest branch: the seal fixed both the source and the round, and the round's own schedule
    // proves the value postdates the seal.
    expect(binding.sourceBasis).toBe("seal-declared");
    expect(binding.roundBasis).toBe("seal-derived");
    expect(binding.postSeal).toBe("proven-offline");

    const snapshot = await verifyPublicBundleSnapshot(bundleDir);
    expect(snapshot.verification.format).toBe(BUNDLE_V10_FORMAT);
  }, 180_000);

  test("a re-encoded member is refused by claim-consistency's byte compare, not by the binding check", async () => {
    const { bundleDir } = await boundFixture("ac3-reencode");
    // Pretty-printed: the SAME record semantically, so `verifyRunBinding` and the linkage both pass
    // and no semantic check can see the difference. What does see it is `recordSha256`, computed
    // from the bytes handed over rather than from a separately supplied digest -- which is what
    // proves the claim's `binding` section is still an exact byte compare against those bytes and
    // not a re-derivation that would forgive a re-encoding.
    const record = json(bundleDir, BEACON_BINDING_BUNDLE_MEMBER);
    writeFileSync(join(bundleDir, BEACON_BINDING_BUNDLE_MEMBER), JSON.stringify(record, null, 2));
    reseal(bundleDir);
    const refused = await refusal(bundleDir);
    expect(refused.path).toBe("claim-consistency");
    expect(refused.message).toContain("binding.recordSha256");
  }, 180_000);
});

describe("AC4 — an unbound run publishes exactly as it did before", () => {
  test("no capability, no member, no claim section, and the limits are the unbound identity", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "v10-binding-ac4-"));
    roots.push(workspaceDir);
    const built = await createSyntheticV6BundleFixture({ workspaceDir, composedFormat: true });
    expect(built.bindingRecordSha256).toBeUndefined();
    const bundleDir = detach(built.bundle.bundleDir);

    const manifest = json(bundleDir, "bundle.json") as { capabilities: string[]; files: { path: string }[] };
    expect(manifest.capabilities).not.toContain("beacon-binding");
    expect(manifest.files.map((file) => file.path)).not.toContain(BEACON_BINDING_BUNDLE_MEMBER);

    const claim = json(bundleDir, "claim-package.json");
    expect(claim).not.toHaveProperty("binding");
    expect(claim["verification"].checks).toEqual(expectedChecks(manifest.capabilities));
    expect(claim["verification"].checks).not.toContain("beacon-binding");

    // The identity that carries AC4: an absent binding appends nothing, so every limits byte — and
    // through the claim, every page byte — is what it was before this feature existed. Asserted as
    // the identity rather than against a recorded digest because the fixture uses the real clock,
    // so the run's own record digests legitimately move between builds. The committed golden blobs
    // in `legacy-composed-equivalence.test.ts` are where the actual byte pin lives.
    const limits = claim["venueHonesty"].limits as string[];
    expect(runBoundVenueLimits(limits, undefined)).toBe(limits);

    const verified = await verifyPublicBundle(bundleDir);
    expect(verified.format).toBe(BUNDLE_V10_FORMAT);
    if (verified.format !== BUNDLE_V10_FORMAT) throw new Error("unreachable");
    expect(verified.checks).not.toContain("beacon-binding");
  }, 180_000);
});
