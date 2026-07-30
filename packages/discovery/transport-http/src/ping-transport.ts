import type { PingTransport } from "@jinn-network/record-discovery-serve";

import type { FetchLike } from "./ports.js";

// The producer-side `PingTransport` plug (design §7 item 4). One of the
// three modules the discovery source-boundaries guard allows to name an
// ambient network API (Finding F1).
//
// Finding F4: the composition spec §6.2 groups "ping" with the
// client-side plugs, but the only ping PORT in the stack is producer-
// side (`serve`'s `PingTransport.announce(headUrl)`); the consumer's
// obligation -- debouncing pull-on-ping so a flood costs at most the
// consumer's own configured pull rate -- already ships in `client`
// (`createPullDebounce`). So this module implements the emitting half
// and nothing else; receiving pings is a host loop, not a transport.
//
// Pings are unauthenticated hints and carry no trust either way (§7 item
// 4): a lost ping costs latency, never correctness.

export class PingDeliveryError extends Error {
  readonly endpointUrl: string;
  readonly status: number;

  constructor(endpointUrl: string, status: number) {
    super(`Announcement ping to ${endpointUrl} failed with HTTP ${status}.`);
    this.name = "PingDeliveryError";
    this.endpointUrl = endpointUrl;
    this.status = status;
  }
}

export function createHttpPingTransport(
  endpointUrl: string,
  fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
): PingTransport {
  return {
    async announce(headUrl: string): Promise<void> {
      const response = await fetchLike(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headUrl }),
      });
      if (response.status < 200 || response.status > 299) {
        throw new PingDeliveryError(endpointUrl, response.status);
      }
    },
  };
}
