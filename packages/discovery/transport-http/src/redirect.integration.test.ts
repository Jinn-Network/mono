import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { TransportRedirectError, createHttpTransport } from "./fetch-transport.js";

// Every other test in this package injects a `FetchLike`, so nothing exercised
// the real primitive the transport ships with. The #3411 redirect guard rests
// entirely on one contract of that primitive: `redirect: "manual"` must hand
// back the actual 3xx response with a readable `Location`. The Fetch spec's
// browser behavior is an OPAQUE-REDIRECT filtered response -- status 0, no
// headers -- and under that reading the guard would never follow a hop and
// would turn every legitimate redirect into an HTTP-0 error. Node's undici does
// not opaque-filter, which is why the guard is written the way it is. That is a
// runtime assumption about the platform, so it is pinned against a real socket.

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("createHttpTransport over a real socket (#3411)", () => {
  it("refuses a cross-origin redirect instead of following it", async () => {
    let internalHits = 0;
    const internal = await serve((_request, response) => {
      internalHits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"secret":true}');
    });
    const peer = await serve((_request, response) => {
      response.writeHead(302, { location: `${internal}/` });
      response.end();
    });

    const transport = createHttpTransport("", globalThis.fetch.bind(globalThis));
    await expect(transport.fetch(`${peer}/archive/0001.json`)).rejects.toThrow(TransportRedirectError);
    expect(internalHits).toBe(0);
  });

  it("follows a same-origin redirect, proving undici surfaces a readable 3xx under manual", async () => {
    const peer = await serve((request, response) => {
      if (request.url === "/archive/0001.json") {
        response.writeHead(302, { location: "/archive/0001-final.json" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });

    const transport = createHttpTransport("", globalThis.fetch.bind(globalThis));
    const result = await transport.fetch(`${peer}/archive/0001.json`);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.bytes)).toBe('{"ok":true}');
  });
});
