// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import {
  presentInternalProtocolIdentifiers,
  resolvesAtSpecOrigin,
  SPEC_RELEASE_SERVED_PATHS,
} from "./identifier-presentation.js";

describe("presentInternalProtocolIdentifiers", () => {
  test("keeps an actionable third-party URL", () => {
    expect(presentInternalProtocolIdentifiers("see https://example.com/docs")).toBe("see https://example.com/docs");
  });

  test("keeps an identifier the spec release serves whole, so a reader can follow it", () => {
    for (const served of [
      "https://spec.jinn.network/task-profiles/binary-judgment/2.0",
      "https://spec.jinn.network/profiles/task-execution/v1",
    ]) {
      expect(presentInternalProtocolIdentifiers(`profile ${served}.`)).toBe(`profile ${served}.`);
    }
  });

  test("keeps a served identifier whole in escaped HTML and in the README's escaped scheme", () => {
    const html = "&quot;https://spec.jinn.network/task-profiles/binary-judgment/2.0&quot;";
    const markdown = '"https\\://spec.jinn.network/task-profiles/binary-judgment/2.0"';
    expect(presentInternalProtocolIdentifiers(html)).toBe(html);
    expect(presentInternalProtocolIdentifiers(markdown)).toBe(markdown);
  });

  test("drops the origin of an identifier the spec release does not serve and keeps the name", () => {
    expect(
      presentInternalProtocolIdentifiers(
        "kind https://spec.jinn.network/records/benchmark-matrix/v1",
      ),
    ).toBe("kind records/benchmark-matrix/v1");
    expect(
      presentInternalProtocolIdentifiers('"https\\://spec.jinn.network/records/benchmark-matrix/v1"'),
    ).toBe('"records/benchmark-matrix/v1"');
  });

  test("a served path prefix is not enough: an unserved version keeps only its name", () => {
    expect(presentInternalProtocolIdentifiers("https://spec.jinn.network/task-profiles/binary-judgment/1.0"))
      .toBe("task-profiles/binary-judgment/1.0");
    expect(presentInternalProtocolIdentifiers("https://spec.jinn.network/profiles/benchmark-product-public-bundle/5"))
      .toBe("profiles/benchmark-product-public-bundle/5");
  });

  test("strips the method namespace rather than inviting a fetch", () => {
    expect(presentInternalProtocolIdentifiers("jinn.benchmarking.method/wilson @ 1"))
      .toBe("method/wilson @ 1");
  });

  test("names an anchor profile by its path remainder", () => {
    expect(
      presentInternalProtocolIdentifiers(
        "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      ),
    ).toBe("rfc3161-tsa/v1");
  });
});

describe("resolvesAtSpecOrigin", () => {
  test("is exact over the paths the spec release serves", () => {
    expect(SPEC_RELEASE_SERVED_PATHS.size).toBe(78);
    for (const path of SPEC_RELEASE_SERVED_PATHS) {
      expect(resolvesAtSpecOrigin(`https://spec.jinn.network/${path}`), path).toBe(true);
    }
    for (const unserved of [
      "https://spec.jinn.network/",
      "https://spec.jinn.network/protocols/benchmarking/v1",
      "https://spec.jinn.network/extensions/benchmark-publication/v1",
      "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      "https://spec.jinn.network/records/benchmark-report/v1",
      "http://spec.jinn.network/task-profiles/binary-judgment/2.0",
    ]) {
      expect(resolvesAtSpecOrigin(unserved), unserved).toBe(false);
    }
  });
});
