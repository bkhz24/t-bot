// index.js
// Playwright runner with extra logging + failure artifacts (screenshot + HTML)
//
// Required env vars:
//   DSJ_URL        (example: https://dsj877.com)
//   DSJ_EMAIL
//   DSJ_PASSWORD
//
// Optional:
//   HEADLESS=false
//   SLOWMO=250

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const { ensureDir, writeText, nowStamp } = require("./utils");

function env(name, fallback = "") {
  const v = process.env[name];
  return (v === undefined || v === null || v === "") ? fallback : v;
}

async function saveFailureArtifacts(page, label = "failure") {
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), "artifacts", `${label}-${stamp}`);
  ensureDir(outDir);

  const screenshotPath = path.join(outDir, "screenshot.png");
  const htmlPath = path.join(outDir, "page.html");

  const href = await page.evaluate(() => window.location.href).catch(() => "unknown");
  console.log(`\n[FAIL] location.href: ${href}`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  writeText(htmlPath, html);

  console.log(`[FAIL] Saved screenshot: ${screenshotPath}`);
  console.log(`[FAIL] Saved HTML      : ${htmlPath}\n`);

  return { outDir, screenshotPath, htmlPath, href };
}

async function elementExists(page, selector) {
  try {
    const loc = page.locator(selector);
    return (await loc.count()) > 0;
  } catch {
    return false;
  }
}

async function elementVisible(page, selector) {
  try {
    const loc = page.locator(selector).first();
    return await loc.isVisible();
  } catch {
    return false;
  }
}

// Update these selectors if your login form uses something different.
// These are intentionally broad.
const SELECTORS = {
  email: 'input[type="email"], input[name*="email" i], input[placeholder*="email" i]',
  password: 'input[type="password"], input[name*="pass" i], input[placeholder*="pass" i]',
  loginButton: 'button:has-text("Login"), button:has-text("Sign in"), input[type="submit"]',
  // "Login form still visible?" detection:
  // If either email or password inputs are visible, we consider the form still on-screen.
  loginFormSignal: 'input[type="password"], input[type="email"], input[name*="email" i], input[name*="pass" i]',
  // Mobile bottom nav "Futures" (you mentioned it’s required on mobile)
  futuresNav: 'text=Futures, a:has-text("Futures"), button:has-text("Futures")',
  // Generic "invited me" hint you mentioned
  invitedMe: 'text=invited me, text=Invited me'
};

async function main() {
  const DSJ_URL = env("DSJ_URL", "https://dsj877.com");
  const DSJ_EMAIL = env("DSJ_EMAIL");
  const DSJ_PASSWORD = env("DSJ_PASSWORD");

  if (!DSJ_EMAIL || !DSJ_PASSWORD) {
    console.error("Missing DSJ_EMAIL or DSJ_PASSWORD in env vars.");
    process.exit(1);
  }

  const headless = env("HEADLESS", "true") !== "false";
  const slowMo = parseInt(env("SLOWMO", "0"), 10) || 0;

  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    // Emulate iPhone-ish viewport so we reproduce the mobile issue
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  try {
    console.log(`[INFO] Navigating to: ${DSJ_URL}`);
    await page.goto(DSJ_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // If your flow starts somewhere else, keep it here as-is; we’ll refine after logs.
    // Try to find login inputs.
    console.log("[INFO] Looking for login fields...");
    await page.waitForTimeout(1000);

    const hasEmail = await elementExists(page, SELECTORS.email);
    const hasPassword = await elementExists(page, SELECTORS.password);

    if (!hasEmail || !hasPassword) {
      console.log("[WARN] Login inputs not found right away. Trying to scroll...");
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(1000);
    }

    // Fill creds
    console.log("[INFO] Filling email/password...");
    await page.locator(SELECTORS.email).first().fill(DSJ_EMAIL, { timeout: 15000 });
    await page.locator(SELECTORS.password).first().fill(DSJ_PASSWORD, { timeout: 15000 });

    // Click login
    console.log("[INFO] Clicking Login...");
    await page.locator(SELECTORS.loginButton).first().click({ timeout: 15000 });

    // ✅ REQUIRED LOG #1: immediately after clicking login
    await page.waitForTimeout(800); // tiny delay to let the click register
    const urlAfterClick = page.url();
    const loginStillVisible = await elementVisible(page, SELECTORS.loginFormSignal);

    console.log(`[CHECK1] After Login click: url=${urlAfterClick}`);
    console.log(`[CHECK1] Login form still visible? ${loginStillVisible}`);

    // Wait for navigation or content change a bit
    await page.waitForTimeout(2500);

    // Your note: on mobile you might have to tap Futures in bottom nav
    // We’ll attempt it if it exists.
    const futuresVisible = await elementVisible(page, SELECTORS.futuresNav);
    console.log(`[INFO] Futures nav visible? ${futuresVisible}`);
    if (futuresVisible) {
      console.log("[INFO] Clicking Futures nav (mobile)...");
      await page.locator(SELECTORS.futuresNav).first().click({ timeout: 15000 });
      await page.waitForTimeout(2000);
    }

    // Check if we can see “invited me” (your hint that we’re on right page)
    const invitedVisible = await elementVisible(page, SELECTORS.invitedMe);
    console.log(`[INFO] "invited me" visible? ${invitedVisible}`);

    // Decide success/failure
    // If the login form is still visible after waiting, treat as failure.
    const loginStillVisibleLater = await elementVisible(page, SELECTORS.loginFormSignal);
    if (loginStillVisibleLater) {
      throw new Error("Login appears to have failed: login form still visible after waiting.");
    }

    console.log("[SUCCESS] Login flow appears to have progressed past login form.");
    console.log(`[INFO] Final URL: ${page.url()}`);

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error(`\n[ERROR] ${err?.message || err}\n`);

    // ✅ REQUIRED LOG #2: on failure, save screenshot+HTML and log location.href
    await saveFailureArtifacts(page, "login-failure");

    await browser.close();
    process.exit(1);
  }
}

main();
