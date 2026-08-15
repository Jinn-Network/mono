import { expect, test } from "@playwright/test";
import {
  PINNED_CHROMIUM_VERSION,
  PINNED_PERMISSIONS_POLICY,
  PINNED_PERMISSIONS_POLICY_FEATURES,
} from "./chromium-policy";

test("packaged local-server boundary requires and consumes the one-time launch capability", async ({ playwright }) => {
  const capability = process.env.COLOPHON_LOCAL_APP_CAPABILITY;
  if (capability === undefined) throw new Error("production browser run did not receive the local-app capability");
  const client = await playwright.request.newContext({
    baseURL: "http://127.0.0.1:3017",
    storageState: { cookies: [], origins: [] },
  });
  try {
    expect((await client.get("/")).status()).toBe(403);
    const launch = await client.get(`/__colophon_launch?capability=${encodeURIComponent(capability)}`, { maxRedirects: 0 });
    expect(launch.status()).toBe(303);
    expect(launch.headers()["set-cookie"]).toContain("HttpOnly");
    expect(launch.headers()["set-cookie"]).toContain("SameSite=Strict");
    expect((await client.get(`/__colophon_launch?capability=${encodeURIComponent(capability)}`, { maxRedirects: 0 })).status()).toBe(403);
    expect((await client.get("/workspace")).status()).toBe(200);
  } finally {
    await client.dispose();
  }
});

test("skip navigation leaves the main target with a computed visible indicator", async ({ page }) => {
  await page.goto("/workspace");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  const target = page.locator("main#main-content");
  await expect(target).toBeFocused();
  const indicator = await target.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  const visibleOutline = indicator.outlineStyle !== "none" && indicator.outlineWidth !== "0px";
  const visibleRing = indicator.boxShadow !== "none";
  expect(visibleOutline || visibleRing, JSON.stringify(indicator)).toBe(true);
});

test("Chromium 147 recognizes exactly the pinned feature set and permits none", async ({ browser, page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  const response = await page.goto("/");
  expect(browser.version()).toBe(PINNED_CHROMIUM_VERSION);
  expect(response?.headers()["permissions-policy"]).toBe(PINNED_PERMISSIONS_POLICY);
  const policy = await page.evaluate(() => {
    const featurePolicy = document.featurePolicy;
    if (featurePolicy === undefined) throw new Error("Chromium did not expose document.featurePolicy");
    return {
      recognized: featurePolicy.features().sort(),
      allowed: featurePolicy.allowedFeatures().sort(),
    };
  });
  expect(policy.recognized).toEqual(PINNED_PERMISSIONS_POLICY_FEATURES);
  expect(policy.allowed).toEqual([]);
  await expect(page).toHaveTitle(/Colophon/u);
  expect(warnings).toEqual([]);
});
