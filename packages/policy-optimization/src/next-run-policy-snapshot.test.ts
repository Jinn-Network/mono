import { readFileSync } from "node:fs";
import { canonicalJsonBytes, prefixedDigest } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import {
  captureNextRunPolicySnapshot,
  parseExactNextRunPolicySnapshot,
  sealNextRunPolicySnapshot,
  type CaptureNextRunPolicySnapshotInput,
} from "./next-run-policy-snapshot.js";

function fixture(): CaptureNextRunPolicySnapshotInput {
  const rows = JSON.parse(readFileSync(
    new URL("../fixtures/adapters/outcomes-golden.json", import.meta.url), "utf8",
  )) as { task: unknown; submission: unknown; profile: { sealedBytes: string; profile: string; requirementKeys: [] } }[];
  const row = rows[0]!;
  const bytes = (value: unknown) => canonicalJsonBytes(value);
  const task = bytes(row.task);
  const submission = bytes(row.submission);
  const profile = Uint8Array.from(Buffer.from(row.profile.sealedBytes, "base64"));
  const loadout = new TextEncoder().encode("notes/public.md\nOnly public operating notes.\n");
  return {
    configRevisionBefore: "config:42",
    configRevisionAfter: "config:42",
    resolutions: [{
      route: { taskProfile: row.profile.profile, route: "default" },
      task: { bytes: task, digest: prefixedDigest(task) },
      submission: { bytes: submission, digest: prefixedDigest(submission) },
      profile: {
        bytes: profile,
        digest: prefixedDigest(profile),
        profile: row.profile.profile,
        requirementKeys: row.profile.requirementKeys,
      },
      loadout: { bytes: loadout, digest: prefixedDigest(loadout) },
    }],
  };
}

describe("captureNextRunPolicySnapshot", () => {
  test("derives a tuple seed from one coherent exact-byte batch", () => {
    const snapshot = captureNextRunPolicySnapshot(fixture());
    expect(snapshot.configRevision).toBe("config:42");
    expect(snapshot.seed.kind).toBe("tuple");
    expect(snapshot.seed.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(snapshot.inputs.loadout.hashProfile).toBe("learner-public.v1");
  });

  test("seals and exact-parses the versioned snapshot without tolerating substitutions", () => {
    const captured = captureNextRunPolicySnapshot(fixture());
    const sealed = sealNextRunPolicySnapshot(captured);
    expect(parseExactNextRunPolicySnapshot(sealed.bytes)).toEqual(captured);

    const unknown = { ...captured, surprise: true };
    expect(() => parseExactNextRunPolicySnapshot(canonicalJsonBytes(unknown))).toThrow(/unknown/u);

    const changed = {
      ...captured,
      seed: { ...captured.seed, digest: `sha256:${"0".repeat(64)}` },
    };
    expect(() => parseExactNextRunPolicySnapshot(canonicalJsonBytes(changed))).toThrow(/recompute/u);

    const canonical = new TextDecoder().decode(sealed.bytes);
    const duplicate = new TextEncoder().encode(canonical.replace(
      "{", `{"formatToken":"${captured.formatToken}",`,
    ));
    expect(() => parseExactNextRunPolicySnapshot(duplicate)).toThrow(/canonical/u);
  });

  test("fails closed on revision drift, ambiguity, substitution, and secret material", () => {
    const base = fixture();
    expect(() => captureNextRunPolicySnapshot({ ...base, configRevisionAfter: "config:43" }))
      .toThrow(/moved during capture/u);
    expect(() => captureNextRunPolicySnapshot({ ...base, resolutions: [...base.resolutions, ...base.resolutions] }))
      .toThrow(/ambiguous/u);
    expect(() => captureNextRunPolicySnapshot({
      ...base,
      resolutions: [{ ...base.resolutions[0]!, task: { ...base.resolutions[0]!.task, digest: `sha256:${"0".repeat(64)}` } }],
    })).toThrow(/exact bytes digest/u);
    const secret = new TextEncoder().encode("api_key = super-secret-value");
    expect(() => captureNextRunPolicySnapshot({
      ...base,
      resolutions: [{
        ...base.resolutions[0]!,
        loadout: { bytes: secret, digest: prefixedDigest(secret) },
      }],
    })).toThrow(/contain a secret/u);
  });
});
