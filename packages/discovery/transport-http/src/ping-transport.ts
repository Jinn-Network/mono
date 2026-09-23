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
      // Why this one keeps the default `redirect: "follow"` while the two GET
      // transports enforce a per-hop origin rule (#3432).
      //
      // The redirect guard exists because a peer-operated serving root can
      // forward a request the operator's containment check already approved,
      // and the daemon then READS what it finds there. A ping is the opposite
      // shape on every axis that matters: it is a POST this operator emits, its
      // destination is an operator-configured endpoint rather than anything a
      // peer introduced, its body carries nothing confidential (a head URL that
      // is public by construction), and the response is inspected for a status
      // and then discarded -- no bytes ever enter a trust decision. A ping is an
      // unauthenticated hint that carries no trust either way (§7 item 4): a
      // lost ping costs latency, never correctness.
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
