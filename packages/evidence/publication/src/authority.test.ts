// SPDX-License-Identifier: Apache-2.0
import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vitest";

import {
  assertNoAuthorityMarkerLeaks,
  validateAuthorityMarkers,
} from "./authority.js";

const encoder = new TextEncoder();
const printable = encoder.encode(
  "printable-publication-authority-marker-0001",
);
const binary = Uint8Array.from([
  0xff, 0xfe, 0x80, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
  0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

describe("authority-marker conformance scanner", () => {
  test("rejects raw and canonical encoded markers in nested values and causes", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const representations = [
      new TextDecoder().decode(printable),
      Buffer.from(printable).toString("hex"),
      Buffer.from(printable).toString("base64"),
      Buffer.from(printable).toString("base64url"),
      [...printable].map((byte) =>
        `%${byte.toString(16).padStart(2, "0").toUpperCase()}`
      ).join(""),
    ];
    for (const leaked of representations) {
      expect(() =>
        assertNoAuthorityMarkerLeaks(markers, [{
          nested: new Error("outer", {
            cause: { leaked },
          }),
        }])
      ).toThrowError(/authority marker/u);
    }
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{
        output: Uint8Array.from([7, ...binary, 8]),
      }])
    ).toThrowError(/authority marker/u);
  });

  test("is cycle-safe and does not evaluate accessor extensions", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    let getterCalls = 0;
    const value: Record<string, unknown> = { status: "not-found" };
    value.cycle = value;
    Object.defineProperty(value, "futureExtension", {
      get: () => {
        getterCalls += 1;
        return new TextDecoder().decode(printable);
      },
    });

    expect(() => assertNoAuthorityMarkerLeaks(markers, [value])).not.toThrow();
    expect(getterCalls).toBe(0);
  });

  test("detects marker bytes through ArrayBuffer, DataView, and non-byte typed views", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const buffer = new ArrayBuffer(binary.byteLength + 4);
    new Uint8Array(buffer, 2, binary.byteLength).set(binary);
    const values = [
      buffer,
      new DataView(buffer, 2, binary.byteLength),
      new Uint16Array(buffer, 2, binary.byteLength / 2),
    ];

    for (const value of values) {
      expect(() =>
        assertNoAuthorityMarkerLeaks(markers, [{ nested: value }])
      ).toThrowError(/authority marker/u);
    }
  });

  test("detects marker bytes in raw cross-realm ArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffer = runInNewContext(
      "Uint8Array.from(bytes).buffer",
      { bytes: [...binary] },
    ) as ArrayBuffer;

    expect(foreignBuffer instanceof ArrayBuffer).toBe(false);
    expect(ArrayBuffer.isView(foreignBuffer)).toBe(false);
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{ nested: foreignBuffer }])
    ).toThrowError(/authority marker/u);
  });

  test("detects marker bytes in raw cross-realm SharedArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffer = runInNewContext(
      `
        const buffer = new SharedArrayBuffer(bytes.length);
        new Uint8Array(buffer).set(bytes);
        buffer;
      `,
      { bytes: [...printable] },
    ) as SharedArrayBuffer;

    expect(foreignBuffer instanceof SharedArrayBuffer).toBe(false);
    expect(ArrayBuffer.isView(foreignBuffer)).toBe(false);
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{ nested: foreignBuffer }])
    ).toThrowError(/authority marker/u);
  });

  test("accepts benign raw cross-realm ArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffers = [
      runInNewContext("Uint8Array.from([1, 2, 3]).buffer"),
      runInNewContext(`
        const buffer = new SharedArrayBuffer(3);
        new Uint8Array(buffer).set([4, 5, 6]);
        buffer;
      `),
    ];
    let getterCalls = 0;
    Object.defineProperty(foreignBuffers[0], Symbol.toStringTag, {
      get: () => {
        getterCalls += 1;
        return new TextDecoder().decode(printable);
      },
    });

    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, foreignBuffers)
    ).not.toThrow();
    expect(getterCalls).toBe(0);
  });

  test("detects marker bytes when typed-array view metadata is shadowed", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const metadataShadows = [
      ["buffer"],
      ["byteOffset"],
      ["byteLength"],
      ["length"],
      ["buffer", "byteOffset", "byteLength", "length"],
    ] as const;

    for (const shadowedFields of metadataShadows) {
      const backing = new ArrayBuffer(printable.byteLength * 2);
      const view = new Uint8Array(
        backing,
        printable.byteLength,
        printable.byteLength,
      );
      view.set(printable);
      const shadows = {
        buffer: new ArrayBuffer(printable.byteLength),
        byteOffset: 0,
        byteLength: 0,
        length: printable.byteLength,
      } as const;
      for (const field of shadowedFields) {
        Object.defineProperty(view, field, {
          configurable: true,
          enumerable: false,
          value: shadows[field],
        });
      }

      expect(
        () => assertNoAuthorityMarkerLeaks(markers, [{ nested: view }]),
        shadowedFields.join(","),
      ).toThrowError(/authority marker/u);
    }
  });

  test("scans custom own fields attached to binary objects", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const representations = [
      printable,
      Buffer.from(printable).toString("hex"),
      Buffer.from(printable).toString("base64"),
      Buffer.from(printable).toString("base64url"),
      [...printable].map((byte) =>
        `%${byte.toString(16).padStart(2, "0").toUpperCase()}`
      ).join(""),
    ];
    const binaryObjects = [
      () => new Uint8Array(4),
      () => new DataView(new ArrayBuffer(4)),
      () => new ArrayBuffer(4),
    ];

    for (const createBinaryObject of binaryObjects) {
      for (const representation of representations) {
        const value = createBinaryObject() as object & {
          hiddenAuthority?: unknown;
          cycle?: unknown;
        };
        Object.defineProperty(value, "hiddenAuthority", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: representation,
        });
        value.cycle = value;

        expect(() =>
          assertNoAuthorityMarkerLeaks(markers, [value])
        ).toThrowError(/authority marker/u);
      }
    }
  });

  test("requires two unique long markers spanning printable and binary data", () => {
    expect(() => validateAuthorityMarkers([printable])).toThrow();
    expect(() =>
      validateAuthorityMarkers([printable, printable])
    ).toThrow();
    expect(() =>
      validateAuthorityMarkers([
        encoder.encode("another-printable-authority-marker-0002"),
        encoder.encode("another-printable-authority-marker-0003"),
      ])
    ).toThrow();
  });

  test("snapshots exact marker bytes without consulting hostile iterator metadata", () => {
    const marker = Uint8Array.from(printable);
    const decoy = encoder.encode(
      "decoy-printable-authority-marker-0000002",
    );
    let metadataReads = 0;
    for (const key of ["length", "byteLength"] as const) {
      Object.defineProperty(marker, key, {
        configurable: true,
        get: () => {
          metadataReads += 1;
          return 0;
        },
      });
    }
    Object.defineProperty(marker, Symbol.iterator, {
      configurable: true,
      get: () => {
        metadataReads += 1;
        return function* (): IterableIterator<number> {
          yield* decoy;
        };
      },
    });

    const markers = validateAuthorityMarkers([marker, binary]);

    const exact = Buffer.from(printable);
    const representations: readonly unknown[] = [
      Uint8Array.from(printable),
      exact.toString("hex"),
      exact.toString("base64"),
      exact.toString("base64url"),
    ];
    for (const representation of representations) {
      expect(() =>
        assertNoAuthorityMarkerLeaks(markers, [
          { nested: representation },
        ])
      ).toThrowError(/authority marker/u);
    }
    expect(metadataReads).toBe(0);
  });

  test("continues rejecting proxied, detached, and cross-realm marker bytes", () => {
    const detached = Uint8Array.from(printable);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const foreign = runInNewContext(
      "Uint8Array.from(bytes)",
      { bytes: [...printable] },
    ) as Uint8Array;

    for (const invalid of [
      new Proxy(Uint8Array.from(printable), {}),
      detached,
      foreign,
    ]) {
      expect(() =>
        validateAuthorityMarkers([invalid, binary])
      ).toThrowError(TypeError);
    }
  });
});
