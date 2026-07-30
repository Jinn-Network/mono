import { describe, it, expect } from "vitest";
import { dssePreAuthEncoding } from "./dsse.js";

describe("dssePreAuthEncoding", () => {
  it("encodes DSSE PAE deterministically", () => {
    expect(
      new TextDecoder().decode(
        dssePreAuthEncoding(
          "application/test",
          new TextEncoder().encode("payload"),
        ),
      ),
    ).toBe("DSSEv1 16 application/test 7 payload");
  });
});
