import { describe, expect, test, vi } from "vitest";
import { computeRawCodecCid, uploadRawCodecCid } from "./ipfs.js";
import { createRegistryPinPort, normalizeIpfsRegistryAddUrl, type FetchLike } from "./ipfs-pinfile.js";

describe("normalizeIpfsRegistryAddUrl", () => {
  test("appends /api/v0/add and strips trailing slashes", () => {
    expect(normalizeIpfsRegistryAddUrl("https://registry.autonolas.tech/")).toBe(
      "https://registry.autonolas.tech/api/v0/add",
    );
  });

  test("is idempotent when already pointed at /api/v0/add", () => {
    expect(normalizeIpfsRegistryAddUrl("https://registry.autonolas.tech/api/v0/add")).toBe(
      "https://registry.autonolas.tech/api/v0/add",
    );
  });

  test("defaults empty input to the Autonolas registry", () => {
    expect(normalizeIpfsRegistryAddUrl("")).toBe("https://registry.autonolas.tech/api/v0/add");
  });
});

describe("createRegistryPinPort", () => {
  test("POSTs the exact bytes with raw-leaves + cid-version=1 and resolves on 200", async () => {
    const bytes = new TextEncoder().encode('{"pinned":true}');
    let capturedUrl: URL | undefined;
    let capturedBody: FormData | undefined;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = new URL(url as string);
      capturedBody = init?.body as FormData;
      return new Response("", { status: 200 });
    });

    const port = createRegistryPinPort({ registryUrl: "https://registry.example", fetchImpl: fetchImpl as unknown as FetchLike });
    const result = await uploadRawCodecCid(bytes, port);

    expect(result).toEqual(computeRawCodecCid(bytes));
    expect(capturedUrl?.searchParams.get("raw-leaves")).toBe("true");
    expect(capturedUrl?.searchParams.get("cid-version")).toBe("1");
    expect(capturedBody?.get("file")).toBeInstanceOf(Blob);
  });

  test("throws with the response body on a non-200 status (bytes were not actually pinned)", async () => {
    const fetchImpl = vi.fn(async () => new Response("gateway busy", { status: 503 }));
    const port = createRegistryPinPort({ registryUrl: "https://registry.example", fetchImpl: fetchImpl as unknown as FetchLike });

    await expect(port.pin(new TextEncoder().encode("x"))).rejects.toThrow(/503/);
  });
});
