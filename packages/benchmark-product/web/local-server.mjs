import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";
import next from "next";

const hostname = process.env.HOSTNAME;
const port = Number(process.env.PORT ?? "0");
const capability = process.env.COLOPHON_LOCAL_APP_CAPABILITY;
let launchAvailable = true;

if (hostname !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 0 || port > 65_535 || capability === undefined || capability.length < 32) {
  throw new Error("Colophon local app must bind to 127.0.0.1 on a valid TCP port.");
}

function sameCapability(value) {
  const expected = Buffer.from(capability);
  const actual = Buffer.from(value ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cookieValue(header, name) {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function localHeaders(response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

const app = next({ dev: false, dir: process.cwd(), hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => {
  localHeaders(response);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__colophon_launch") {
    if (request.method !== "GET" || !launchAvailable || !sameCapability(url.searchParams.get("capability"))) {
      response.statusCode = 403;
      response.end("This local workspace requires its one-time launch URL.\n");
      return;
    }
    launchAvailable = false;
    response.statusCode = 303;
    response.setHeader("Set-Cookie", `colophon_local_app=${capability}; HttpOnly; SameSite=Strict; Path=/`);
    response.setHeader("Location", "/workspace");
    response.end();
    return;
  }
  if (!sameCapability(cookieValue(request.headers.cookie, "colophon_local_app"))) {
    response.statusCode = 403;
    response.end("This local workspace requires its one-time launch URL.\n");
    return;
  }
  handle(request, response);
});

server.listen({ host: hostname, port }, () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Colophon local app did not bind a TCP port.");
  }
  process.send?.({ kind: "colophon-local-app-ready", port: address.port });
});

function close() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
