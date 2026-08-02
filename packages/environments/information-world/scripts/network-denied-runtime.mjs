// Runs inside Docker's `--network none` namespace. That namespace retains loopback but has no
// external interface, so this verifies the replay service under the actual OS boundary rather
// than trying to infer an absolute property from JavaScript source.
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

import { createReplayService, parseInformationWorldRecord } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const timeout = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds, { kind: "timeout" }));

function localRequest(address) {
  return new Promise((resolve, reject) => {
    const incoming = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/guide",
      headers: { host: "docs.example.test" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    incoming.once("error", reject);
    incoming.end();
  });
}

async function externalTcpMustFail() {
  const outcome = await Promise.race([
    new Promise((resolve) => {
      const socket = connect({ host: "1.1.1.1", port: 443 });
      socket.once("connect", () => { socket.destroy(); resolve({ kind: "connected" }); });
      socket.once("error", (error) => resolve({ kind: "error", code: error.code }));
    }),
    timeout(2_000),
  ]);
  if (outcome.kind === "connected") throw new Error("network-denied profile admitted external TCP");
}

async function dnsMustFail() {
  const outcome = await Promise.race([
    lookup("example.com").then(() => ({ kind: "resolved" }), (error) => ({ kind: "error", code: error.code })),
    timeout(2_000),
  ]);
  if (outcome.kind === "resolved") throw new Error("network-denied profile admitted external DNS");
}

const world = parseInformationWorldRecord(await readFile(join(packageRoot, "fixtures/world/synthetic.json")));
const service = await createReplayService(world, {
  listen: { host: "127.0.0.1", port: 0 },
  artifacts: {
    read: async (descriptor) => new Uint8Array(await readFile(join(
      packageRoot,
      "fixtures/world/bodies",
      `${descriptor.digest.slice("sha256:".length)}.bin`,
    ))),
  },
});

try {
  const response = await localRequest(service.address);
  if (response.status !== 200 || response.body.length === 0) {
    throw new Error(`loopback replay did not return its sealed response: ${JSON.stringify(response)}`);
  }
  await externalTcpMustFail();
  await dnsMustFail();
  process.stdout.write("network-denied replay proof passed\n");
} finally {
  await service.close();
}
