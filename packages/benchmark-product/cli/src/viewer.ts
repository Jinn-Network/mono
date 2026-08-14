import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import {
  verifyPublicBundleSnapshot,
  type PublicBundleVerificationResult,
  type VerifiedPublicBundleSnapshot,
} from "@colophon-claims/verify";

function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function commonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function viewerHtml(bundleDir: string, verification: PublicBundleVerificationResult): string {
  const checks = verification.checks.map((check) => `<li><strong>${escapeMarkup(check)}</strong> <span>passed</span></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Colophon — verified bundle</title><style>body{margin:0;background:#f7f4ed;color:#14120e;font:16px/1.5 system-ui,sans-serif}header,main{max-width:1200px;margin:auto;padding:24px}h1{font:500 42px/1.1 Georgia,serif}.answer{border-top:3px solid #c7402a;padding-top:16px}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:0;list-style:none}.checks li{border:1px solid #cfc8bb;padding:12px}.checks span{color:#176b3a}code{overflow-wrap:anywhere}iframe{width:100%;min-height:780px;border:1px solid #cfc8bb;background:white}@media(max-width:600px){header,main{padding:16px}h1{font-size:34px}}</style></head><body><header><p>Colophon · local reader result</p><h1>Verified: ${verification.checks.length} of 6 checks passed</h1><p class="answer">Complete comparison. No comparative winner stated. Nothing was uploaded.</p><p>Bundle <code>${escapeMarkup(bundleDir)}</code></p><p>Identity <code>sha256:${escapeMarkup(verification.identity)}</code></p><ul class="checks">${checks}</ul></header><main><h2>Published report</h2><p>This report is inside the immutable bundle. The verification result above was computed when this local viewer started.</p><iframe title="Published Colophon benchmark report" src="/bundle/index.html"></iframe></main></body></html>`;
}

function contentType(path: string): string {
  return ({
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".eval": "text/plain; charset=utf-8",
  } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

export interface VerifiedBundleViewer {
  readonly url: string;
  readonly port: number;
  readonly verification: PublicBundleVerificationResult;
  close(): Promise<void>;
}

export interface VerifiedBundleViewerDeps {
  readonly verify?: (bundleDir: string) => Promise<VerifiedPublicBundleSnapshot>;
}

export async function createVerifiedBundleViewer(
  bundlePath: string,
  requestedPort = 0,
  deps: VerifiedBundleViewerDeps = {},
): Promise<VerifiedBundleViewer> {
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) throw new TypeError("port must be an integer from 0 to 65535");
  const bundleDir = realpathSync(resolve(bundlePath));
  if (!lstatSync(bundleDir).isDirectory()) throw new TypeError("bundle path must be a directory");
  const authenticated = await (deps.verify ?? verifyPublicBundleSnapshot)(bundleDir);
  const verification = authenticated.verification;
  const fileBytes = authenticated.snapshot.fileBytes;
  const token = randomBytes(32).toString("base64url");
  const cookieName = "colophon_viewer";
  const html = viewerHtml(bundleDir, verification);
  let launchAvailable = true;

  const server = createServer((request, response) => {
    commonHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/launch") {
      if (request.method !== "GET" || !launchAvailable || !sameToken(url.searchParams.get("token") ?? undefined, token)) {
        response.statusCode = 403;
        response.end("This viewer requires its one-time launch URL.\n");
        return;
      }
      launchAvailable = false;
      response.statusCode = 303;
      response.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      response.setHeader("Location", "/");
      response.end();
      return;
    }
    if (!sameToken(cookieValue(request.headers.cookie, cookieName), token)) {
      response.statusCode = 403;
      response.end("This viewer requires the one-time launch URL.\n");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      response.setHeader("X-Frame-Options", "DENY");
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    if (!url.pathname.startsWith("/bundle/")) {
      response.statusCode = 404;
      response.end();
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(url.pathname.slice("/bundle/".length));
    } catch {
      response.statusCode = 404;
      response.end();
      return;
    }
    const bytes = fileBytes.get(name);
    if (bytes === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", contentType(name));
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    if (request.method === "HEAD") response.end();
    else response.end(bytes);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("viewer did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/launch?token=${encodeURIComponent(token)}`,
    port: address.port,
    verification,
    close: () => new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}
