// SPDX-License-Identifier: MIT

// The binding re-homes these three port declarations for the tier-3 adapter tree (composition
// design §6.1). This test fails to compile if the two declarations ever drift apart.
import { describe, test } from "vitest";
import type {
  DeliveryWaitPort as BindingDeliveryWaitPort,
  FinalityPort as BindingFinalityPort,
  ReleaseAttemptPort as BindingReleaseAttemptPort,
} from "@jinn-network/marketplace-binding";
import type { DeliveryWaitPort, FinalityPort, ReleaseAttemptPort } from "./pipeline.js";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertExact = <T extends true>(): T => true as T;

describe("binding's re-homed port declarations stay structurally identical", () => {
  test("compiles only while all three pairs are mutually assignable", () => {
    assertExact<Exact<FinalityPort, BindingFinalityPort>>();
    assertExact<Exact<DeliveryWaitPort, BindingDeliveryWaitPort>>();
    assertExact<Exact<ReleaseAttemptPort, BindingReleaseAttemptPort>>();
  });
});
