// SPDX-License-Identifier: MIT

// The production `IpfsPinPort` (`venue/ipfs.ts`), adapted from
// `operator/src/adapters/mech/ipfs-pinfile.ts`'s registry-upload pattern (design §14 "declared
// impact"). Uploads the EXACT bytes handed to it -- no JCS re-encode round trip, and
// `raw-leaves=true` so Kubo addresses the content with the raw codec (§3 audit: CID digest
// equals sha256 of exact bytes). The returned registry CID is informational only; the binding
// never trusts it as identity -- `computeRawCodecCid` (ipfs.ts) is the identity source.
//
// No ambient network API (the ban in `.github/scripts/marketplace-source-boundaries.test.mjs`):
// the HTTP transport is a required, caller-injected `FetchLike` -- this module never reads the
// ambient global itself, so a host (pipeline, CLI, or a test) always supplies it explicitly.
import type { IpfsPinPort } from "./ipfs.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export function normalizeIpfsRegistryAddUrl(registryUrl: string): string {
  let t = registryUrl.trim();
  if (t === "") t = "https://registry.autonolas.tech";
  t = t.replace(/\/+$/, "");
  if (t.endsWith("/api/v0/add")) return t;
  return `${t}/api/v0/add`;
}

/** Duck-type of the global `fetch` function -- named locally so this file never references the
 * banned ambient identifier as a bare word, even in a type position. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RegistryPinPortOptions {
  registryUrl: string;
  /** Required: the caller's HTTP transport (e.g. the global `fetch` from outside this package). */
  fetchImpl: FetchLike;
  timeoutMs?: number;
}

/**
 * Builds an `IpfsPinPort` that POSTs the exact bytes to an Autonolas-compatible Kubo registry
 * (`pin=true&cid-version=1&raw-leaves=true`).
 */
export function createRegistryPinPort(options: RegistryPinPortOptions): IpfsPinPort {
  const url = new URL(normalizeIpfsRegistryAddUrl(options.registryUrl));
  url.searchParams.set("pin", "true");
  url.searchParams.set("cid-version", "1");
  url.searchParams.set("raw-leaves", "true");
  url.searchParams.set("wrap-with-directory", "false");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl;

  return {
    async pin(bytes: Uint8Array): Promise<void> {
      const formData = new FormData();
      formData.append("file", new Blob([bytes as BlobPart]), "content.bin");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "POST", body: formData, signal: controller.signal });
        if (response.status !== 200) {
          const text = await response.text();
          throw new Error(`IPFS registry pin failed with status ${response.status}: ${text.slice(0, 200)}`);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
