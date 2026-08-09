import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { PINNED_PERMISSIONS_POLICY as PERMISSIONS_POLICY } from "./chromium-policy";
import { readRuntimeConfig } from "./runtime-config";

const DRAFT_ID = "bp50-browser";
const runtime = readRuntimeConfig();
const WORKSPACE = runtime.workspaceDir;
const ORIGIN = "http://127.0.0.1:3017";

async function tabTo(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let index = 0; index < 100; index += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`keyboard traversal did not reach ${await target.evaluate((node) => node.outerHTML)}`);
}

async function typeByKeyboard(page: Page, target: Locator, value: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value);
  await expect(target).toHaveValue(value);
}

async function activateByKeyboard(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

function actionForm(page: Page, buttonName: string): Locator {
  return page.locator("form").filter({ has: page.getByRole("button", { name: buttonName, exact: true }) });
}

async function submitAction(page: Page, buttonName: string, expectedText?: RegExp | string): Promise<Locator> {
  const form = actionForm(page, buttonName);
  const formIndex = await form.evaluate((node) => Array.from(document.forms).indexOf(node as HTMLFormElement));
  await activateByKeyboard(page, form.getByRole("button", { name: buttonName, exact: true }));
  // Publication deliberately relabels its button after the server refresh. Retain the form's
  // document position so the assertion follows the same action boundary after that relabel.
  const result = page.locator("form").nth(formIndex).locator("[aria-live]");
  if (expectedText !== undefined) await expect(result).toContainText(expectedText);
  await expect(result).toBeFocused();
  const indicator = await result.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  const visibleOutline = indicator.outlineStyle !== "none" && indicator.outlineWidth !== "0px";
  const visibleRing = indicator.boxShadow !== "none";
  expect(visibleOutline || visibleRing, `${buttonName} result focus has no computed visible indicator: ${JSON.stringify(indicator)}`).toBe(true);
  return result;
}

async function audit(page: Page, label: string): Promise<void> {
  // Next may stream the document head after an action-driven server-component refresh; audit the
  // settled document rather than the transient head replacement frame. No rule, impact, or node is
  // waived: any axe violation fails with its complete diagnostic.
  await expect(page).toHaveTitle(/Benchmark Product/u);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

async function expectContained(page: Page, width: number): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(dimensions.viewport).toBe(width);
  expect(dimensions.body).toBeLessThanOrEqual(width);
  expect(dimensions.document).toBeLessThanOrEqual(width);
}

async function auditState(page: Page, label: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectContained(page, 1440);
  await audit(page, `${label} desktop`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectContained(page, 390);
  await audit(page, `${label} 390px`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

function walkFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function expectBuffersAbsent(bytes: Buffer, secrets: readonly Buffer[], label: string): void {
  for (const secret of secrets) expect(bytes.includes(secret), `${label} contains confidential bytes`).toBe(false);
}

function expectStringsAbsent(value: string, secrets: readonly Buffer[], label: string): void {
  for (const secret of secrets) {
    const text = secret.toString("utf8");
    expect(value, `${label} contains confidential text`).not.toContain(text);
    expect(value, `${label} contains URL-encoded confidential text`).not.toContain(encodeURIComponent(text));
  }
}

test("keyboard-only real lifecycle is accessible, private, responsive, and securely published", async ({ page }) => {
  const consoleMessages: string[] = [];
  const consoleFailures: string[] = [];
  const requestUrls: string[] = [];
  const externalRequests: string[] = [];
  const dynamicResponses: Array<{
    readonly response: Response;
    readonly body: Promise<
      | { readonly kind: "complete"; readonly bytes: Buffer }
      | { readonly kind: "aborted"; readonly detail: string }
      | { readonly kind: "error"; readonly detail: string }
    >;
  }> = [];
  page.on("console", (message) => {
    const rendered = `${message.type()}: ${message.text()}`;
    consoleMessages.push(rendered);
    if (message.type() === "error" || message.type() === "warning") consoleFailures.push(rendered);
  });
  page.on("request", (request) => {
    requestUrls.push(request.url());
    const url = new URL(request.url());
    if (url.protocol !== "data:" && url.origin !== ORIGIN) externalRequests.push(request.url());
  });
  page.on("response", (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (!response.url().startsWith(ORIGIN) || (!type.includes("text/html") && !type.includes("text/x-component"))) return;
    // Retain completed response bytes immediately. Next intentionally cancels speculative RSC
    // prefetches; Chromium rejects those body reads before request.failure is always populated, so
    // poll that explicit failure for at most one second. The promise therefore cannot wedge the
    // gate, and an abort is never mistaken for a scanned completed response.
    const body = response.request().method() === "HEAD" || response.status() === 204 || response.status() === 304
      ? Promise.resolve({ kind: "complete" as const, bytes: Buffer.alloc(0) })
      : (async () => {
      try {
        return { kind: "complete" as const, bytes: await response.body() };
      } catch (cause) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const requestFailure = response.request().failure();
          if (requestFailure !== null) return { kind: "aborted" as const, detail: requestFailure.errorText };
          await delay(10);
        }
        return { kind: "error" as const, detail: cause instanceof Error ? cause.message : String(cause) };
      }
    })();
    dynamicResponses.push({ response, body });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Benchmark Product" })).toBeVisible();
  await auditState(page, "landing route");

  await page.goto("/workspace/new");
  await expect(page.getByRole("heading", { level: 1, name: "New draft" })).toBeVisible();
  await auditState(page, "new draft route");

  await page.goto("/workspace");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();
  await auditState(page, "uninitialized workspace");

  await activateByKeyboard(page, page.getByRole("button", { name: "Initialize workspace", exact: true }));
  await expect(page.getByText("Configured on this server")).toBeVisible();
  await auditState(page, "initialized workspace");
  await activateByKeyboard(page, page.getByRole("link", { name: "New draft" }));
  await expect(page.getByRole("heading", { level: 1, name: "New draft" })).toBeVisible();

  await typeByKeyboard(page, page.getByLabel("Name", { exact: true }), "Hostile <script>alert(1)</script> benchmark");
  await typeByKeyboard(page, page.getByLabel("Draft ID"), DRAFT_ID);
  await typeByKeyboard(page, page.getByLabel("Description"), "</script><img src=x onerror=alert(1)> valid operator text");
  await submitAction(page, "Create draft", /bp50-browser/u);
  await activateByKeyboard(page, page.getByRole("link", { name: "Workspace" }));
  await expect(page.getByText("Hostile <script>alert(1)</script> benchmark")).toBeVisible();
  await activateByKeyboard(page, page.getByRole("link", { name: "Open" }));
  await expect(page.getByRole("heading", { level: 1, name: "Draft" })).toBeVisible();
  await auditState(page, "draft setup");

  const importForm = actionForm(page, "Import rows");
  await typeByKeyboard(page, importForm.getByLabel("SWE-bench rows JSON"), JSON.stringify({ unexpected: "<svg/onload=alert(1)>" }));
  const invalid = await submitAction(page, "Import rows", /validation|invalid-invocation/u);
  await expect(invalid.getByRole("alert")).toBeVisible();
  await auditState(page, "invalid action result");

  await submitAction(page, "Attach sample", /sample/u);
  const addArm = actionForm(page, "Add arm");
  await typeByKeyboard(page, addArm.getByLabel("Arm ID"), "baseline");
  await typeByKeyboard(page, addArm.getByLabel("Pinning JSON"), JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }));
  await submitAction(page, "Add arm", /baseline/u);
  await typeByKeyboard(page, addArm.getByLabel("Arm ID"), "sample");
  await typeByKeyboard(page, addArm.getByLabel("Pinning JSON"), JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }));
  await submitAction(page, "Add arm", /sample/u);

  const lock = page.getByRole("button", { name: "Lock run", exact: true });
  await expect(lock).toBeDisabled();
  await submitAction(page, "Quote", /solveCells/u);
  await expect(lock).toBeEnabled();
  await auditState(page, "quoted draft");
  await submitAction(page, "Lock run", /locked/u);
  await expect(page.getByRole("button", { name: "Quote", exact: true })).toBeDisabled();
  await auditState(page, "locked draft");

  await activateByKeyboard(page, page.getByRole("link", { name: "Run monitor" }));
  await expect(page.getByRole("heading", { level: 1, name: "Durable run monitor" })).toBeVisible();
  await auditState(page, "locked run monitor");
  await submitAction(page, "Launch", /scheduled/u);
  const lifecycle = page.getByRole("heading", { level: 2, name: "Lifecycle" }).locator("../..");
  await expect(lifecycle).toContainText("running", { timeout: 30_000 });
  await expect(page.getByText("active", { exact: true })).toBeVisible();
  await auditState(page, "active run monitor");
  const delivered = page.getByRole("heading", { level: 2, name: "Delivered" }).locator("../..");
  await expect(delivered).toContainText("6", { timeout: 180_000 });
  await submitAction(page, "Collect", /closed/u);
  await expect(page.getByRole("button", { name: "Collect", exact: true })).toBeDisabled();
  await expect(lifecycle).toContainText("closed");
  await auditState(page, "closed run monitor");

  await activateByKeyboard(page, page.getByRole("link", { name: "Results" }));
  await expect(page.getByRole("heading", { level: 1, name: "Results and report" })).toBeVisible();
  await auditState(page, "sealed results");
  await submitAction(page, "Seal report", /Report and claim package sealed/u);
  await expect(page.getByRole("heading", { level: 2, name: "Sealed report" })).toBeVisible();
  await auditState(page, "reported results");
  await submitAction(page, "Verify records", /Verification passed/u);
  await auditState(page, "verified results");
  await submitAction(page, "Publish public bundle", /fixed draft-owned public bundle/u);
  await expect(page.getByRole("heading", { level: 2, name: "Published public bundle" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify published bundle", exact: true })).toBeVisible();
  await expect(page.getByText("claim-consistency", { exact: true }).first()).toBeVisible();
  await auditState(page, "published results");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedDuration = await page.getByRole("button", { name: "Verify published bundle" }).evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(reducedDuration).toMatch(/0\.00001s|1e-05s|0\.01ms/u);

  // A 640 CSS-pixel viewport represents a 1280px-wide layout at 200% browser zoom.
  await page.setViewportSize({ width: 640, height: 720 });
  await expectContained(page, 640);

  const inputNames = await page.locator("input, textarea").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("name")));
  expect(inputNames).not.toContain("workspace");
  expect(inputNames).not.toContain("workspaceDir");
  expect(inputNames).not.toContain("path");

  const privateKeyPaths = walkFiles(WORKSPACE).filter((path) => path.endsWith(".pem"));
  expect(privateKeyPaths.some((path) => basename(path) === "report-signing-key.pem")).toBe(true);
  expect(privateKeyPaths.some((path) => basename(path) === "verdict-signing-key.pem")).toBe(true);
  const privateKeys = privateKeyPaths.map((path) => readFileSync(path));
  for (const key of privateKeys) expect(key.toString("utf8")).toContain("PRIVATE KEY");
  const secrets = [
    Buffer.from(runtime.buildSecret),
    Buffer.from(runtime.runtimeSecret),
    Buffer.from(runtime.credentialSecret),
    Buffer.from(WORKSPACE),
    ...privateKeys,
  ];

  expect(externalRequests).toEqual([]);
  expect(consoleFailures).toEqual([]);
  for (const [index, message] of consoleMessages.entries()) expectStringsAbsent(message, secrets, `console message ${index}`);
  for (const [index, url] of requestUrls.entries()) expectStringsAbsent(url, secrets, `request URL ${index}`);

  expect(dynamicResponses.some(({ response }) => response.request().method() === "POST")).toBe(true);
  expect(dynamicResponses.some(({ response }) => (response.headers()["content-type"] ?? "").includes("text/html"))).toBe(true);
  expect(dynamicResponses.some(({ response }) => (response.headers()["content-type"] ?? "").includes("text/x-component"))).toBe(true);
  for (const captured of dynamicResponses) {
    const { response } = captured;
    const headers = response.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("base-uri 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
    const body = await captured.body;
    if (body.kind === "aborted") {
      expect(body.detail, `${response.request().method()} ${response.url()} did not complete`).toMatch(/ERR_ABORTED|aborted/u);
      continue;
    }
    expect(body.kind, body.kind === "error" ? body.detail : undefined).toBe("complete");
    if (body.kind === "complete") expectBuffersAbsent(body.bytes, secrets, `${response.request().method()} ${response.url()}`);
  }
  expectStringsAbsent(await page.content(), secrets, "rendered HTML");

  const staticFiles = walkFiles(resolve(process.cwd(), ".next", "static"));
  expect(staticFiles.some((path) => path.endsWith(".js"))).toBe(true);
  for (const path of staticFiles) expectBuffersAbsent(readFileSync(path), secrets, `static chunk ${path}`);

  const bundleRoot = resolve(WORKSPACE, "artifacts", DRAFT_ID, "public-bundles");
  const identities = readdirSync(bundleRoot);
  expect(identities).toHaveLength(1);
  expect(identities[0]).toMatch(/^[a-f0-9]{64}$/u);
  const sourceBundle = join(bundleRoot, identities[0]!);
  cpSync(sourceBundle, runtime.copiedBundleDir, { recursive: true, errorOnExist: true, force: false });
  const copiedFiles = walkFiles(runtime.copiedBundleDir);
  expect(copiedFiles.some((path) => path.endsWith("bundle.json"))).toBe(true);
  for (const path of copiedFiles) {
    const stat = lstatSync(path);
    expect(stat.isSymbolicLink(), path).toBe(false);
    expect(stat.nlink, path).toBe(1);
    expectBuffersAbsent(readFileSync(path), secrets, `copied bundle ${path}`);
  }

  rmSync(WORKSPACE, { recursive: true, force: false });
  expect(existsSync(WORKSPACE)).toBe(false);
  const cliPath = resolve(process.cwd(), "../core/dist/cli/bin.js");
  const verification = spawnSync(
    process.execPath,
    [cliPath, "bundle", "verify", "--bundle", runtime.copiedBundleDir, "--json"],
    { cwd: runtime.runRoot, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000, killSignal: "SIGKILL" },
  );
  expect(verification.status, verification.stderr).toBe(0);
  expect(JSON.parse(verification.stdout)).toMatchObject({ ok: true, result: { identity: identities[0] } });
  expectStringsAbsent(`${verification.stdout}\n${verification.stderr}`, secrets, "standalone verifier receipt");
});
