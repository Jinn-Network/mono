import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import {
  PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  verifyPublicBundleSnapshot,
  type PublicComparisonCell,
  type PublicComparisonView,
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

function score(cell: PublicComparisonCell): string {
  return cell.primaryScore === undefined
    ? "No primary score"
    : `${cell.primaryScore.value} ${cell.primaryScore.name} (${cell.primaryScore.direction})`;
}

function comparisonHtml(comparison: PublicComparisonView): string {
  const fact = comparison.descriptiveComparison;
  const answer = fact === undefined
    ? "No paired descriptive measurement is available."
    : `${fact.firstArm} had lower ${fact.measurement} in ${fact.lowerByFirst} of ${fact.pairedCells} paired cells; ${fact.secondArm} had lower ${fact.measurement} in ${fact.lowerBySecond}; ${fact.ties} tied. Lower is better.`;
  const headings = comparison.arms.map((arm) => `<th scope="col">${escapeMarkup(arm)}</th>`).join("");
  const rows = comparison.tasks.map((task) => {
    const cells = comparison.arms.map((arm) => {
      const matches = comparison.cells.filter((cell) => cell.taskDigest === task.digest && cell.armId === arm);
      return `<td>${matches.length === 0 ? "Not accounted" : matches.map((cell) => `<a href="#cell-${escapeMarkup(cell.cellKey)}"><strong>${escapeMarkup(cell.outputSummary)}</strong><br>${escapeMarkup(score(cell))}<br><span>${escapeMarkup(cell.outcome)} · replicate ${cell.replicate}</span></a>`).join("<hr>")}</td>`;
    }).join("");
    return `<tr><th scope="row"><a href="/bundle/${escapeMarkup(task.evidencePath)}">${escapeMarkup(task.label)}</a><small>${escapeMarkup(task.summary)}</small></th>${cells}</tr>`;
  }).join("");
  const details = comparison.cells.map((cell) => `<details id="cell-${escapeMarkup(cell.cellKey)}"><summary><strong>${escapeMarkup(cell.armId)}</strong> · ${escapeMarkup(score(cell))}</summary><p>${escapeMarkup(cell.outputSummary)}</p><h4>Outputs</h4><ul>${cell.outputs.map((output) => `<li><a href="/bundle/${escapeMarkup(output.evidencePath)}">${escapeMarkup(output.summary)}</a></li>`).join("") || "<li>No solve output.</li>"}</ul><h4>Verdict evidence</h4><ul>${cell.verdicts.map((verdict) => `<li><a href="/bundle/${escapeMarkup(verdict.evidencePath)}">${escapeMarkup(verdict.evaluator)}: ${escapeMarkup(verdict.verdict)}</a> · ${escapeMarkup(JSON.stringify(verdict.measurements))}</li>`).join("") || "<li>No verdict evidence.</li>"}</ul></details>`).join("");
  const sample = comparison.sampleKind === "bundled-prediction"
    ? '<p class="sample-note">The sample outcomes are synthetic and derived from the bundled consensus inputs. This proves the evidence path, not agent quality.</p>'
    : "";
  return `<section aria-labelledby="comparison-heading"><p class="eyebrow">Answer first</p><h2 id="comparison-heading">What happened, task by task</h2><p class="answer">${escapeMarkup(answer)} No comparative winner is stated.</p>${sample}<div class="table-scroll" tabindex="0" role="region" aria-label="Task by configuration comparison"><table><thead><tr><th scope="col">Task</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div><h3>Open a cell to inspect its evidence</h3>${details}</section>`;
}

function viewerHtml(
  bundleDir: string,
  verification: PublicBundleVerificationResult,
  comparison: PublicComparisonView | undefined,
  nonce: string,
  canStartWorkspace: boolean,
  availablePaths: ReadonlySet<string>,
): string {
  // A metadata-first evidence-native bundle defers `artifact-integrity` (issue #2986): it carries
  // the artifact digests without their bytes. The viewer must say so rather than print a pass over
  // bytes nobody read.
  const artifactContent = "artifactContent" in verification ? verification.artifactContent : undefined;
  const artifactContentNotFetched = artifactContent !== undefined && artifactContent.status === "not-fetched";
  const checks = verification.checks.map((check) => {
    const state = artifactContentNotFetched && check === "artifact-integrity" ? "not fetched" : "passed";
    return `<li><strong>${escapeMarkup(check)}</strong> <span>${state}</span></li>`;
  }).join("");
  // The anchored binary-qualification closure is the one format the @0.1 line cannot read
  // (issue #3205), so it is named before the fall-through rather than inheriting it.
  const verificationCommand = verification.format === "benchmark-product-public-bundle/5"
    ? PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND
    : verification.format === "benchmark-product-public-bundle/7"
      ? PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND
      : verification.format === "benchmark-product-public-bundle/4"
        ? PUBLIC_BUNDLE_V4_COMPATIBLE_VERIFICATION_COMMAND
        : PUBLIC_BUNDLE_COMPATIBLE_VERIFICATION_COMMAND;
  const copyCommand = `${verificationCommand} ${JSON.stringify(bundleDir)}`;
  const qualification = verification.format === "benchmark-product-public-bundle/5"
    ? undefined
    : verification.qualification;
  const heading = comparison === undefined
    ? verification.format === "benchmark-product-public-bundle/5"
      ? "Verified evidence-native benchmark"
      : "Verified binary qualification"
    : `Complete comparison on ${comparison.tasks.length} ${comparison.sampleKind === "bundled-prediction" ? "sample " : ""}tasks`;
  const primaryProjection = comparison !== undefined
    ? comparisonHtml(comparison)
    : qualification === undefined
      ? ""
      : `<section aria-labelledby="qualification-heading"><p class="eyebrow">Verified scope</p><h2 id="qualification-heading">Binary qualification</h2><dl><dt>Publication grade</dt><dd>${qualification.publicationGrade ? "yes" : "no"}</dd><dt>Truth admission</dt><dd>${escapeMarkup(qualification.truthAdmission)}</dd><dt>Candidate classes</dt><dd>${escapeMarkup(qualification.candidateClasses.join(", "))}</dd><dt>Strata</dt><dd>${escapeMarkup(qualification.strata.join(", "))}</dd><dt>Arms</dt><dd>${qualification.armCount}</dd><dt>Items</dt><dd>${qualification.itemCount}</dd><dt>Exclusions</dt><dd>${qualification.exclusionCount}</dd></dl><p>No comparative winner, ranking, or preference is stated.</p></section>`;
  const workspaceAction = canStartWorkspace
    ? '<form method="post" action="/use-my-work"><button class="primary" type="submit">Use my work</button></form>'
    : '<p><strong>Use my work:</strong> run <code>colophon open</code> from a terminal with the full product installed.</p>';
  const identity = verification.identity.startsWith("sha256:") ? verification.identity : `sha256:${verification.identity}`;
  const evidencePath = availablePaths.has("evidence.json") ? "evidence.json" : "claim-package.json";
  const reportSection = availablePaths.has("index.html")
    ? '<section><h2>Published report</h2><p>This script-free report is inside the immutable bundle. The live result above was computed from the exact authenticated bytes when this local viewer started.</p><iframe title="Published Colophon benchmark report" src="/bundle/index.html"></iframe></section>'
    : '<section><h2>Published report records</h2><p>The evidence-native report is preserved as exact signed data rather than an embedded HTML projection.</p><p><a href="/bundle/report.json">Open report payload</a> · <a href="/bundle/report-envelope.json">Open signed envelope</a></p></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Colophon — verified bundle</title><style>:root{--paper:#f7f4ed;--panel:#fffdf8;--ink:#14120e;--muted:#6b675f;--line:#cfc8bb;--red:#c7402a;--blue:#27406b}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}header,main{max-width:1200px;margin:auto;padding:24px}main{display:grid;gap:28px}h1,h2{font:500 42px/1.1 Georgia,serif}h2{font-size:34px}.eyebrow{color:var(--red);font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.answer{border-top:3px solid var(--red);padding-top:16px;font-weight:650}.sample-note{background:#eee9df;border-left:3px solid #9d6b23;padding:12px}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;padding:0;list-style:none}.checks li,details{background:var(--panel);border:1px solid var(--line);padding:12px}.checks span{color:#176b3a}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-block:20px}.actions form{margin:0}button,.button{appearance:none;border:1px solid var(--ink);border-radius:3px;background:transparent;color:var(--ink);cursor:pointer;padding:10px 14px;font:inherit;text-decoration:none}.primary{background:var(--ink);color:var(--panel)}code{overflow-wrap:anywhere}.table-scroll{overflow-x:auto;border-top:1px solid var(--ink)}table{width:100%;min-width:720px;border-collapse:collapse;table-layout:fixed}th,td{border-bottom:1px solid var(--line);padding:12px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th small{display:block;color:var(--muted);font-weight:400;margin-top:6px}td span{color:var(--muted);font-size:.85rem}td a{color:inherit;text-decoration:none}details{margin-block:8px}summary{cursor:pointer}iframe{width:100%;min-height:780px;border:1px solid var(--line);background:white}@media(max-width:600px){header,main{padding:16px}h1{font-size:34px}h2{font-size:28px}}</style></head><body><header><p>Colophon · live local reader</p><h1>${heading}</h1><p class="answer">${verification.checks.length} of ${verification.checks.length} bundle checks passed. Nothing was uploaded.</p><p>Format <code>${escapeMarkup(verification.format)}</code></p><p>Bundle <code>${escapeMarkup(bundleDir)}</code></p><p>Identity <code>${escapeMarkup(identity)}</code></p><ul class="checks">${checks}</ul><div class="actions">${workspaceAction}<a class="button" href="/bundle/${evidencePath}">Open the evidence</a><button id="copy-verification" type="button" data-command="${escapeMarkup(copyCommand)}">Copy verification command</button><span id="copy-result" role="status" aria-live="polite"></span></div></header><main>${primaryProjection}${reportSection}</main><script nonce="${nonce}">const button=document.getElementById("copy-verification");const result=document.getElementById("copy-result");button?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(button.dataset.command??"");result.textContent="Copied."}catch{result.textContent="Copy failed. Select the command from the bundle report."}});</script></body></html>`;
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

export interface ViewerLocalSurface {
  readonly url: string;
  close(): Promise<void>;
}

export interface VerifiedBundleViewerDeps {
  readonly verify?: (bundleDir: string) => Promise<VerifiedPublicBundleSnapshot>;
  /** Starts the packaged, loopback-only guided workspace after an explicit browser action. */
  readonly startWorkspace?: () => Promise<ViewerLocalSurface>;
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
  const nonce = randomBytes(18).toString("base64url");
  const cookieName = "colophon_viewer";
  const html = viewerHtml(
    bundleDir,
    verification,
    authenticated.comparison,
    nonce,
    deps.startWorkspace !== undefined,
    new Set(fileBytes.keys()),
  );
  let launchAvailable = true;
  let workspaceAvailable = true;
  let workspace: ViewerLocalSurface | undefined;

  const server = createServer(async (request, response) => {
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
    if (url.pathname === "/use-my-work") {
      if (request.method !== "POST" || deps.startWorkspace === undefined || !workspaceAvailable) {
        response.statusCode = 405;
        response.end("The guided workspace is not available from this viewer.\n");
        return;
      }
      workspaceAvailable = false;
      try {
        workspace = await deps.startWorkspace();
        response.statusCode = 303;
        response.setHeader("Location", workspace.url);
        response.end();
      } catch {
        workspaceAvailable = true;
        response.statusCode = 500;
        response.end("Could not start the guided workspace. Return to the terminal for the local diagnostic.\n");
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      response.setHeader("Permissions-Policy", "clipboard-write=(self)");
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
    close: async () => {
      await Promise.all([
        new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
        workspace?.close() ?? Promise.resolve(),
      ]);
    },
  };
}
