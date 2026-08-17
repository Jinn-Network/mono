// SPDX-License-Identifier: Apache-2.0

/**
 * The OpenTimestamps provider's run against the parameterized proof-verifier
 * contract (design §11, §6.2).
 *
 * The kit landed before the verifier did, so this file is the whole gate: every
 * case the kit states for `opentimestamps/v1` runs against the implementation in
 * trust-core, and the implementation gets no say in which cases it faces.
 *
 * The trust adapter below is the only seam. The kit publishes its synthetic
 * headers as `{ height, header, time }`; the verifier asks for `{ height,
 * header }` and reads the block time out of the header bytes rather than
 * accepting a caller's rendering of it. Dropping `time` here is therefore not
 * tidiness -- it keeps the suite honest, because a verifier that echoed a
 * caller-supplied string would pass the `verified` cases without ever parsing a
 * header.
 */

import {
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  createOpenTimestampsProofVerifier,
} from "@jinn-network/trust-core";
import type { OpenTimestampsTrustMaterial } from "@jinn-network/trust-core";

import { describeAnchorProofVerifierContract } from "./conformance.js";

describeAnchorProofVerifierContract<OpenTimestampsTrustMaterial>(
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  (kit) => ({
    verifier: createOpenTimestampsProofVerifier(),
    trust: {
      blockHeaders: kit.openTimestamps.blockHeaders.map((supplied) => ({
        height: supplied.height,
        header: supplied.header,
      })),
    },
  }),
);
