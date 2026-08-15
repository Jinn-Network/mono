// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { createBuiltinDerivationDetectors } from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  syntheticDerivationInput,
  SYNTHETIC_PRIVATE_VALUES,
} from "./fixtures.js";

const detectors = createBuiltinDerivationDetectors({
  privateConfiguration: {
    schemaVersion: "jinn.private-detector-configuration.v1",
    nonce: "private-test-nonce-0123456789abcdef",
    knownIdentities: [SYNTHETIC_PRIVATE_VALUES.knownIdentity],
    privateAllowlist: [SYNTHETIC_PRIVATE_VALUES.privateAllowlist],
  },
});

test("produces byte-identical output for byte-identical explicit inputs", async () => {
  const deriver = createEvidenceDeriver({ detectors });
  const input = syntheticDerivationInput();
  const first = await deriver.derive(input);
  const second = await deriver.derive(structuredClone(input));
  expect(second).toEqual(first);
});

test("changing completedAt changes derived record identity", async () => {
  const deriver = createEvidenceDeriver({ detectors });
  const firstInput = syntheticDerivationInput();
  const secondInput = syntheticDerivationInput();
  (secondInput as { completedAt: string }).completedAt =
    "2026-07-26T01:00:01Z";
  const first = await deriver.derive(firstInput);
  const second = await deriver.derive(secondInput);
  expect(first.status).toBe("derived");
  expect(second.status).toBe("derived");
  if (first.status === "derived" && second.status === "derived") {
    expect(first.record.reference.digest).not.toBe(
      second.record.reference.digest,
    );
  }
});
