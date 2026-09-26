import { describe, expect, test } from "vitest";
import { presentAnchorProfile, presentProtocolText } from "./present-protocol-profile";

describe("presentAnchorProfile", () => {
  test("names the profile path, not the unhosted origin", () => {
    expect(presentAnchorProfile("https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"))
      .toBe("rfc3161-tsa/v1");
  });
});

describe("presentProtocolText", () => {
  test("keeps a third-party URL", () => {
    expect(presentProtocolText("https://tsa.example/tsr")).toBe("https://tsa.example/tsr");
  });
});
