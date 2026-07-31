import { describe, expect, test } from "vitest";

import {
  LINE_EVENTS_FORMAT_IRI,
  createLineEventsDecoder,
  describeTraceDecoderContract,
  lineEventsFixtures,
} from "./testing.js";

describeTraceDecoderContract("line-events fake", () => ({
  decoder: createLineEventsDecoder(),
  fixtures: lineEventsFixtures(),
}));

describe("the in-tree fake", () => {
  test("claims a canonical but non-production format identity", () => {
    expect(LINE_EVENTS_FORMAT_IRI).toBe(
      "https://jinn.network/formats/fixture-line-events/v1",
    );
  });

  test("its fixture set covers full, partial, and empty decodes", () => {
    expect(
      new Set(lineEventsFixtures().map((fixture) => fixture.expected.completeness.decoded)),
    ).toEqual(new Set(["full", "partial", "empty"]));
  });
});
