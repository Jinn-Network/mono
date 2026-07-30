// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SafeInnerRevertError } from "@jinn-network/marketplace-binding";
import {
  classifyBroadcastError,
  isNonceTooLow,
  isReplacementUnderpriced,
} from "./classify.js";

describe("broadcast error classification (venue kit fixture obligations)", () => {
  test("a decoded permanent inner revert is permanent", () => {
    const error = new SafeInnerRevertError(
      "Safe execTransaction inner revert: TCMaxClaimsReached",
      "0x90386e7c", "0x90386e7c", "TCMaxClaimsReached", null, null,
    );
    expect(classifyBroadcastError(error)).toBe("permanent");
  });

  test("RouterNotDelivered is retryable: marketplace state may not have settled yet", () => {
    const error = new SafeInnerRevertError(
      "Safe execTransaction inner revert: RouterNotDelivered",
      "0xe5a88624", "0xe5a88624", "RouterNotDelivered", null, null,
    );
    expect(classifyBroadcastError(error)).toBe("retryable");
  });

  test("RouterAlreadyClaimed is already-settled, not an error", () => {
    const error = new SafeInnerRevertError(
      "Safe execTransaction inner revert: RouterAlreadyClaimed",
      "0x22d686d9", "0x22d686d9", "RouterAlreadyClaimed", null, null,
    );
    expect(classifyBroadcastError(error)).toBe("already-settled");
  });

  test("an undecoded but deterministic inner selector is permanent, never retried forever", () => {
    const error = new SafeInnerRevertError(
      "Safe execTransaction inner revert (undecoded selector 0x33f626d3)",
      "0x33f626d3", "0x33f626d3", null, null, null,
    );
    expect(classifyBroadcastError(error)).toBe("permanent");
  });

  test("bare GS013 and GS026 are permanent", () => {
    expect(classifyBroadcastError(new Error("execution reverted: GS013"))).toBe("permanent");
    expect(classifyBroadcastError(new Error("execution reverted: GS026"))).toBe("permanent");
  });

  test("insufficient funds and user rejection are permanent", () => {
    expect(classifyBroadcastError(new Error("insufficient funds for gas * price + value"))).toBe("permanent");
    expect(classifyBroadcastError(new Error("User rejected the request"))).toBe("permanent");
  });

  test("nonce, replacement, transport and provider-throttle failures are retryable", () => {
    for (const message of [
      "nonce too low", "already known", "could not coalesce error",
      "replacement transaction underpriced", "fee cap less than block base fee",
      "read ECONNRESET", "socket hang up", "fetch failed",
      "All RPC providers in the fallback chain failed",
      'The contract function "nonce" returned no data ("0x").',
      "HTTP 429 Too Many Requests", "503 Service Unavailable",
    ]) {
      expect(classifyBroadcastError(new Error(message)), message).toBe("retryable");
    }
  });

  test("nested causes are flattened before matching", () => {
    const error = new Error("outer", { cause: new Error("nonce too low") });
    expect(isNonceTooLow(error)).toBe(true);
    expect(classifyBroadcastError(error)).toBe("retryable");
  });

  test("the two nonce predicates are distinct", () => {
    expect(isNonceTooLow(new Error("nonce too low"))).toBe(true);
    expect(isReplacementUnderpriced(new Error("nonce too low"))).toBe(false);
    expect(isReplacementUnderpriced(new Error("replacement fee too low"))).toBe(true);
    expect(isNonceTooLow(new Error("replacement fee too low"))).toBe(false);
  });
});
