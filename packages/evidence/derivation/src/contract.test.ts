// SPDX-License-Identifier: Apache-2.0

import { createBuiltinDerivationDetectors } from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  createSyntheticDerivationDetectorFixtures,
  createSyntheticPrivateDetectorConfiguration,
  describeDerivationDetectorContract,
  describeEvidenceDeriverContract,
} from "./testing.js";

const privateConfiguration = createSyntheticPrivateDetectorConfiguration();

describeEvidenceDeriverContract((detectors) =>
  createEvidenceDeriver({
    detectors:
      detectors ??
      createBuiltinDerivationDetectors({ privateConfiguration }),
  }),
);

const builtinDetectors = createBuiltinDerivationDetectors({
  privateConfiguration,
});
const fixtures = createSyntheticDerivationDetectorFixtures();

describeDerivationDetectorContract(
  () => builtinDetectors[0]!,
  fixtures.knownIdentity,
);
describeDerivationDetectorContract(
  () => builtinDetectors[1]!,
  fixtures.deterministicPatterns,
);
