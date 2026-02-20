"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { chromium } = require("playwright");

const { envTruthy, emailConfigured, sendEmail, buildRunEmailText } = require("./src/emailer");

const PORT = process.env.PORT || 8080;

// Support both BOT_PASSWORD and RUN_PASSWORD
const BOT_PASSWORD = process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

// Optional: LOGIN_URLS override from Railway (comma-separated)
const LOGIN_URLS_ENV = process.env.LOGIN_URLS || "";

// Debug capture
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

// Verification controls
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");

// Confirm controls
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "8");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "900");
const CONFIRM_WAIT_MS = Number(process.env.CONFIRM_WAIT_MS || "1200");
const CONFIRM_POST_CLICK_SETTLE_MS = Number(process.env.CONFIRM_POST_CLICK_SETTLE_MS || "650");

// Preflight controls
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || process.env.SITE_PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(
  process.env.PREFLIGHT_LOGIN_WAIT_MS || process.env.SITE_PREFLIGHT_GOTO_TIMEOUT_MS || "20000"
);
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || process.env.SITE_PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || process.env.SITE_PREFLIGHT_RETRY_DELAY_MS || "1500");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || process.env.PREFLIGHT_TOPN || "2");
const PREFLIGHT_REQUIRE_OK = envTruthy(process.env.PREFLIGHT_REQUIRE_OK || "1");

// Timings
const WAIT_AFTER_GOTO_MS = Number(process.env.WAIT_AFTER_GOTO_MS || "1200");
const WAIT_AFTER_LOGIN_MS = Number(process.env.WAIT_AFTER_LOGIN_MS || "1800");
const WAIT_AFTER_FUTURES_DIRECT_MS = Number(process.env.WAIT_AFTER_FUTURES_DIRECT_MS || "1400");
const WAIT_AFTER_FUTURES_MS = Number(process.env.WAIT_AFTER_FUTURES_MS || "1400");

// Retry strategy
const ACCOUNT_MAX_ATTEMPTS = Number(process.env.ACCOUNT_MAX_ATTEMPTS || "2"); // full-flow attempts per account

// --------------------
// Helpers
// --------------------
function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}
function safeListDir(dir) {
  try {
    return fs.readdirSync(dir).filter((x) => !x.includes(".."));
  } catch {
    return [];
  }
}
function writePlaceholderLastShot() {
  try {
    const placeholder = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl1mQAAAAASUVORK5CYII=",
      "base64"
    );
    fs.writeFileSync("/app/last-shot.png", placeholder);
  } catch {}
}

function expandPcAndH5(urls) {
  const out = [];
  const seen = new Set();

  function add(u) {
    if (!u) return;
    const k = String(u).trim();
    if (!k) return;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  }

  for (const u of urls) {
    add(u);
    try {
      const url = new URL(u);
      const base = `${url.protocol}//${url.host}`;
      if (u.includes("/pc/#/login")) add(`${base}/h5/#/login`);
      if (u.includes("/h5/#/login")) add(`${base}/pc/#/login`);
    } catch {}
  }

  return out;
}

function parseLoginUrls() {
  const fallback = ["https://dsj006.cc/pc/#/login", "https://dsj12.cc/pc/#/login", "https://dsj877.cc/pc/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  const baseList = raw
    ? raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : fallback;

  const expanded = expandPcAndH5(baseList);
  return expanded.length ? expanded : fallback;
}

let LOGIN_URLS = parseLoginUrls();

function futuresUrlFromLoginUrl(loginUrl) {
  try {
    const u = new URL(loginUrl);
    const base = `${u.protocol}//${u.host}`;
    const isPc = loginUrl.includes("/pc/#/");
    const prefix = isPc ? "/pc/#/" : "/h5/#/";
    return `${base}${prefix}contractTransaction`;
  } catch {
    return null;
  }
}

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) {
    return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  }
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) {
      return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    }
    const cleaned = parsed.map((a) => ({
      username: (a.username || "").trim(),
      password: String(a.password || ""),
    }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) return { ok: false, accounts: [], error: "Each account must have username + password" };
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e.message}` };
  }
}

// --------------------
// Run state
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;
let lastShotPath = null;
let lastRunId = null;
let lastDebugDir = null;

async function saveShot(page, tag) {
  try {
    const file = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;
    try {
      fs.copyFileSync(file, "/app/last-shot.png");
    } catch {}
    console.log("Saved screenshot:", file, "and updated /app/last-shot.png");
    return file;
  } catch (e) {
    console.log("Screenshot failed:", e && e.message ? e.message : String(e));
    return null;
  }
}

async function dumpDebugState(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return;
  try {
    if (!lastDebugDir) return;
    ensureDir(lastDebugDir);

    const stamp = Date.now();
    const base = path.join(lastDebugDir, `${tag}-${stamp}`);

    try {
      fs.writeFileSync(`${base}.url.txt`, String(page.url() || ""));
    } catch {}
    try {
      const html = await page.content().catch(() => "");
      fs.writeFileSync(`${base}.html`, html || "");
    } catch {}
    try {
      const title = await page.title().catch(() => "");
      fs.writeFileSync(`${base}.title.txt`, title || "");
    } catch {}
    try {
      fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2));
    } catch {}

    await saveShot(page, tag);
  } catch (e) {
    console.log("dumpDebugState failed:", e && e.message ? e.message : String(e));
  }
}

// --------------------
// Selectors
// --------------------
const USER_SELECTORS = [
  'input[type="email"]',
  'input[type="text"]',
  'input[type="tel"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="account" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="mail" i]',
  'input[placeholder*="account" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="mobile" i]',
].join(", ");

const PASS_SELECTORS = [
  'input[type="password"]',
  'input[name*="pass" i]',
  'input[placeholder*="password" i]',
].join(", ");

const ORDER_CODE_SELECTORS = [
  'input[placeholder*="order code" i]',
  'input[placeholder*="Please enter" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]',
].join(", ");

function isCloudflareErrorHtml(html) {
  const s = (html || "").toLowerCase();
  if (!s) return false;
  if (s.includes("cloudflare") && s.includes("cf-error-details")) return true;
  if (s.includes("error 1101")) return true;
  if (s.includes("worker threw exception")) return true;
  return false;
}

async function closeOverlays(page) {
  const candidates = [
    page.getByRole("button", { name: /close|cancel|dismiss|i understand|got it|ok|agree/i }),
    page.locator('[aria-label*="close" i]'),
    page.locator('button:has-text("×")'),
    page.locator(".close"),
    page.locator(".modal-close"),
    page.locator(".ant-modal-close"),
    page.locator(".el-dialog__headerbtn"),
  ];

  for (const c of candidates) {
    try {
      const btn = c.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1500 }).catch(() => null);
        await sleep(200);
      }
    } catch {}
  }
}

async function findVisibleInAnyFrame(page, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await closeOverlays(page);

    const frames = page.frames();
    for (const f of frames) {
      try {
        const loc = f.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) {
          return { ok: true, frame: f, locator: loc };
        }
      } catch {}
    }
    await sleep(250);
  }
  return { ok: false, frame: null, locator: null };
}

// --------------------
// Verification
// --------------------
async function waitForToastOrModal(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off", detail: "VERIFY_TOAST disabled" };

  const patterns = [/already followed/i, /followed/i, /success/i, /successful/i, /completed/i, /submitted/i, /pending/i];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    for (const re of patterns) {
      const loc = page.locator(`text=${re.source}`).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        const txt = await loc.textContent().catch(() => "");
        return { ok: true, type: "toast", detail: (txt || "").trim().slice(0, 160) };
      }
    }
    await sleep(300);
  }
  return { ok: false, type: "toast_timeout", detail: "No confirmation toast/modal found" };
}

async function verifyPendingInPositionOrder(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off", detail: "VERIFY_PENDING disabled" };

  const tab = page.locator("text=/position order/i").first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ timeout: 8000 }).catch(() => null);
    await sleep(800);
  }

  const pending = page.locator("text=/pending/i").first();
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    if (await pending.isVisible().catch(() => false)) return { ok: true, type: "pending", detail: "Pending found" };
    await sleep(350);
  }
  return { ok: false, type: "pending_timeout", detail: "No Pending found" };
}

async function verifyOrderFollowed(page) {
  const toastRes = await waitForToastOrModal(page);
  const pendingRes = await verifyPendingInPositionOrder(page);

  if (toastRes.ok && pendingRes.ok) return { ok: true, detail: "toast and pending seen" };
  if (toastRes.ok) return { ok: true, detail: "toast seen" };
  if (pendingRes.ok) return { ok: true, detail: "pending seen" };

  return { ok: false, detail: `No confirmation. Toast=${toastRes.type}. Pending=${pendingRes.type}.` };
}

// --------------------
// Confirm click: robust
// --------------------
async function clickConfirmAnywhere(page) {
  const candidates = [
    page.getByRole("button", { name: /confirm|submit|ok/i }).first(),
    page.locator("button:has-text('Confirm')").first(),
    page.locator("button:has-text('Submit')").first(),
    page.locator("button:has-text('OK')").first(),
    page.locator("text=Confirm").first(),
    page.locator("text=confirm").first(),
  ];

  for (const btn of candidates) {
    try {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5000 }).catch(() => null);
        return { ok: true, method: "locator" };
      }
    } catch {}
  }

  // Some pages use div/span with onclick handlers. Try JS click by text.
  const jsClicked = await page.evaluate(() => {
    function norm(s) {
      return (s || "").toString().trim().toLowerCase();
    }
    const texts = ["confirm", "submit", "ok"];
    const els = Array.from(document.querySelectorAll("button, a, div, span")).filter((el) => {
      const t = norm(el.textContent);
      if (!t) return false;
      return texts.includes(t);
    });

    for (const el of els) {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      if (!visible) continue;
      try {
        el.click();
        return true;
      } catch {}
    }
    return false;
  }).catch(() => false);

  if (jsClicked) return { ok: true, method: "js" };

  // Last shot: try inside frames by scanning text nodes
  for (const f of page.frames()) {
    try {
      const found = await f.evaluate(() => {
        function norm(s) {
          return (s || "").toString().trim().toLowerCase();
        }
        const texts = ["confirm", "submit", "ok"];
        const els = Array.from(document.querySelectorAll("button, a, div, span")).filter((el) => {
          const t = norm(el.textContent);
          if (!t) return false;
          return texts.includes(t);
        });
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const visible = r.width > 0 && r.height > 0;
          if (!visible) continue;
          try {
            el.click();
            return true;
          } catch {}
        }
        return false;
      }).catch(() => false);
      if (found) return { ok: true, method: "frame-js" };
    } catch {}
  }

  return { ok: false, method: "none" };
}

// --------------------
// Preflight
// --------------------
async function preflightSites() {
  if (!PREFLIGHT_ENABLED) return { ok: true, sites: LOGIN_URLS, note: "preflight disabled" };

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const good = [];
  try {
    for (const loginUrl of LOGIN_URLS) {
      let passed = false;

      for (let i = 1; i <= PREFLIGHT_RETRIES; i++) {
        console.log("Preflight checking:", loginUrl, "attempt", i);

        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "en-US" });
        const page = await context.newPage();

        try {
          const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(650);

          const status = resp ? resp.status() : null;
          if (status && status >= 400) throw new Error(`Preflight failed: HTTP ${status}`);

          const html = await page.content().catch(() => "");
          if (isCloudflareErrorHtml(html)) throw new Error("Preflight failed: Cloudflare error page");

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) throw new Error("Preflight: user field not visible");

          await dumpDebugState(page, "preflight-ok", { loginUrl, status });
          console.log("Preflight OK:", loginUrl);

          passed = true;
          await context.close().catch(() => null);
          break;
        } catch (e) {
          await dumpDebugState(page, `preflight-failed-${i}`, { loginUrl, err: e.message || String(e) });
          await context.close().catch(() => null);
          await sleep(PREFLIGHT_RETRY_DELAY_MS);
        }
      }

      if (passed) {
        good.push(loginUrl);
        if (good.length >= PREFLIGHT_MAX_SITES) break;
      }
    }

    if (!good.length) {
      if (PREFLIGHT_REQUIRE_OK) return { ok: false, sites: [], note: "No sites passed preflight" };
      return { ok: true, sites: LOGIN_URLS.slice(0, 2), note: "No preflight pass, falling back" };
    }

    // IMPORTANT: do not lock to just 1 forever. We use good as priority, but keep full list for fallback.
    const prioritized = [...good, ...LOGIN_URLS.filter((u) => !good.includes(u))];
    return { ok: true, sites: prioritized, note: `Chosen sites: ${good.join(", ")}` };
  } finally {
    await browser.close().catch(() => null);
  }
}

// --------------------
// Context presets
// --------------------
function desktopContextOptions() {
  return {
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
  };
}

function mobileContextOptions() {
  // iPhone-ish emulation: often matches the UI you succeed with manually
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  };
}

// --------------------
// Core bot action
// --------------------
async function runForAccount({ page, loginUrl, username, password, code }) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(WAIT_AFTER_GOTO_MS);
  await dumpDebugState(page, "after-goto", { loginUrl });

  const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
  if (!userRes.ok) throw new Error("Login fields missing (user field not visible)");

  const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 10000);
  if (!passRes.ok) throw new Error("Login fields missing (password field not visible)");

  const frame = userRes.frame;
  await frame.locator(USER_SELECTORS).first().fill(username, { timeout: 15000 });
  await frame.locator(PASS_SELECTORS).first().fill(password, { timeout: 15000 });

  const loginBtn = frame
    .getByRole("button", { name: /login|sign in/i })
    .first()
    .or(frame.locator("button:has-text('Login')").first());
  await loginBtn.click({ timeout: 15000 }).catch(() => null);

  await sleep(WAIT_AFTER_LOGIN_MS);
  await dumpDebugState(page, "after-login", { loginUrl });

  const futuresUrl = futuresUrlFromLoginUrl(loginUrl);
  if (futuresUrl) {
    await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(WAIT_AFTER_FUTURES_DIRECT_MS);
    await dumpDebugState(page, "after-futures-direct", { futuresUrl });
  }

  await sleep(WAIT_AFTER_FUTURES_MS);
  await dumpDebugState(page, "after-futures", {});

  const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 15000);
  if (!codeRes.ok) throw new Error("Order code field not found");

  await codeRes.frame.locator(ORDER_CODE_SELECTORS).first().fill(code, { timeout: 15000 });
  await dumpDebugState(page, "after-code", {});

  let clicked = false;
  for (let i = 1; i <= CONFIRM_RETRIES; i++) {
    const clickRes = await clickConfirmAnywhere(page);
    await sleep(CONFIRM_POST_CLICK_SETTLE_MS);
    await dumpDebugState(page, `after-confirm-attempt-${i}`, { clicked: clickRes.ok, method: clickRes.method });

    if (clickRes.ok) {
      clicked = true;
      break;
    }
    await sleep(CONFIRM_RETRY_DELAY_MS);
  }

  if (!clicked) throw new Error("Confirm button not found");

  await sleep(CONFIRM_WAIT_MS);

  const verify = await verifyOrderFollowed(page);
  if (!verify.ok) throw new Error(verify.detail);

  await dumpDebugState(page, "confirm-verified", { verify });
  return { ok: true, detail: verify.detail };
}

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

function renderRunFormHtml() {
  return `
<hr/>
<h3>Run bot</h3>
<form method="POST" action="/run">
  <label>Password:</label><br/>
  <input name="p" type="password" style="width: 320px; padding: 6px;" /><br/><br/>
  <label>Code:</label><br/>
  <input name="code" type="text" style="width: 320px; padding: 6px;" /><br/><br/>
  <button type="submit" style="padding: 8px 14px;">Run</button>
</form>
`;
}

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const pwMissing = !BOT_PASSWORD;
  const accountsMissing = !cfg.ok;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<h2>T-Bot</h2>
<p><b>Running:</b> ${isRunning ? "YES" : "NO"}</p>
<p><b>Last run:</b> ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</p>
<p><b>Debug capture:</b> ${DEBUG_CAPTURE ? "ON" : "OFF"}</p>
<p><b>LOGIN_URLS:</b> ${escapeHtml(LOGIN_URLS.join(", "))}</p>
<p><b>Email configured:</b> ${emailConfigured(process.env) ? "YES" : "NO"}</p>
<p><b>Verify toast:</b> ${VERIFY_TOAST ? "ON" : "OFF"}</p>
<p><b>Verify pending:</b> ${VERIFY_PENDING ? "ON" : "OFF"}</p>
<p><b>Confirm retries:</b> ${CONFIRM_RETRIES}</p>
<p><b>Preflight enabled:</b> ${PREFLIGHT_ENABLED ? "ON" : "OFF"}</p>
<p><b>Preflight max sites:</b> ${PREFLIGHT_MAX_SITES}</p>
${pwMissing ? "<p style='color:#b00'><b>BOT_PASSWORD/RUN_PASSWORD not set</b></p>" : ""}
${accountsMissing ? `<p style='color:#b00'><b>${escapeHtml(cfg.error || "ACCOUNTS_JSON not set")}</b></p>` : ""}
${lastError ? `<p style='color:#b00'><b>Last error:</b> ${escapeHtml(lastError)}</p>` : ""}

${renderRunFormHtml()}

<hr/>
<p>
  <a href="/health">/health</a> |
  <a href="/last-shot?p=YOUR_PASSWORD">/last-shot</a> |
  <a href="/debug?p=YOUR_PASSWORD">/debug</a> |
  <a href="/dns-test?p=YOUR_PASSWORD">/dns-test</a> |
  <a href="/net-test?p=YOUR_PASSWORD">/net-test</a> |
  <a href="/email-test?p=YOUR_PASSWORD">/email-test</a>
</p>
  `);
});

app.get("/health", (req, res) => {
  const cfg = safeJsonParseAccounts();
  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    emailConfigured: emailConfigured(process.env),
    debugCapture: DEBUG_CAPTURE,
    lastDebugDir,
    loginUrls: LOGIN_URLS,
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const result = await sendEmail(process.env, "T-Bot | Started", `T-Bot email test\nSent at: ${nowLocal()}\n`);
  res.json({ ok: true, result });
});

app.get("/last-shot", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const stable = "/app/last-shot.png";
  if (fs.existsSync(stable)) {
    res.setHeader("Content-Type", "image/png");
    fs.createReadStream(stable).pipe(res);
    return;
  }
  if (lastShotPath && fs.existsSync(lastShotPath)) {
    res.setHeader("Content-Type", "image/png");
    fs.createReadStream(lastShotPath).pipe(res);
    return;
  }
  res.send("No screenshot captured yet.");
});

app.get("/debug", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!lastDebugDir) {
    res.send(`<h3>Debug</h3><p>No debug dir yet. Set DEBUG_CAPTURE=1 and run once.</p>`);
    return;
  }
  const files = safeListDir(lastDebugDir);
  const links = files
    .map(
      (f) =>
        `<li><a href="/debug/files?p=${encodeURIComponent(req.query.p)}&f=${encodeURIComponent(
          f
        )}">${escapeHtml(f)}</a></li>`
    )
    .join("");
  res.send(`
<h3>Debug</h3>
<p><b>Last debug dir:</b> ${escapeHtml(lastDebugDir)}</p>
<hr/>
<ul>${links}</ul>
  `);
});

app.get("/debug/files", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const f = (req.query.f || "").toString();
  if (!lastDebugDir) return res.status(404).send("No debug dir.");
  if (!f || f.includes("..") || f.includes("/") || f.includes("\\")) return res.status(400).send("Bad filename.");

  const full = path.join(lastDebugDir, f);
  if (!fs.existsSync(full)) return res.status(404).send("Not found.");

  if (f.endsWith(".html") || f.endsWith(".txt") || f.endsWith(".json")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
  }
  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const hosts = ["dsj006.cc", "dsj12.cc", "dsj877.cc", "api.sendgrid.com"];
  const out = {};
  for (const h of hosts) {
    try {
      const addrs = await dns.lookup(h, { all: true });
      out[h] = { ok: true, addrs };
    } catch (e) {
      out[h] = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  res.json(out);
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");

  if (DEBUG_CAPTURE) {
    lastDebugDir = `/tmp/debug-${lastRunId}`;
    ensureDir(lastDebugDir);
  } else {
    lastDebugDir = null;
  }
  writePlaceholderLastShot();

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("Run started. Watch email + Railway logs.");

  (async () => {
    const startedAt = nowLocal();

    // Started email
    await sendEmail(
      process.env,
      "T-Bot | Started",
      buildRunEmailText({
        phase: "Started",
        runId: lastRunId,
        startedAt,
        finishedAt: null,
        chosenSites: [],
        perAccount: cfg.accounts.map((a) => ({ username: a.username, status: "QUEUED", detail: "Queued" })),
      })
    );

    let chosenSites = [];
    const perAccount = [];

    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Code received length:", code.length);
      console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("Email configured:", emailConfigured(process.env));
      console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);

      const pf = await preflightSites();
      if (!pf.ok) throw new Error(`Preflight failed. ${pf.note || ""}`);
      chosenSites = pf.sites;

      console.log("Chosen sites for this run:", chosenSites.slice(0, 4).join(", "), chosenSites.length > 4 ? "..." : "");

      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });

      try {
        for (const acct of cfg.accounts) {
          console.log("----");
          console.log("Account:", acct.username);

          let success = false;
          let lastErr = null;

          // full-flow attempts
          for (let attempt = 1; attempt <= ACCOUNT_MAX_ATTEMPTS && !success; attempt++) {
            // context variants: desktop first, then mobile
            const variants = [desktopContextOptions(), mobileContextOptions()];

            for (const variant of variants) {
              if (success) break;

              for (const loginUrl of chosenSites) {
                const context = await browser.newContext(variant);
                const page = await context.newPage();

                try {
                  console.log("Trying site:", loginUrl, "| attempt", attempt, "| mode", variant.isMobile ? "mobile" : "desktop");

                  const result = await runForAccount({
                    page,
                    loginUrl,
                    username: acct.username,
                    password: acct.password,
                    code,
                  });

                  perAccount.push({ username: acct.username, ok: true, status: "SUCCESS", detail: result.detail });
                  success = true;

                  // Per-account success email
                  await sendEmail(
                    process.env,
                    "T-Bot | Complete",
                    buildRunEmailText({
                      phase: "Complete",
                      runId: lastRunId,
                      startedAt,
                      finishedAt: nowLocal(),
                      chosenSites: [loginUrl],
                      perAccount: [{ username: acct.username, ok: true, status: "SUCCESS", detail: result.detail }],
                      extraLines: [`Mode: ${variant.isMobile ? "mobile" : "desktop"}`, `Attempt: ${attempt}`],
                    })
                  );

                  await context.close().catch(() => null);
                  break;
                } catch (e) {
                  lastErr = e && e.message ? e.message : String(e);
                  await dumpDebugState(page, "account-failed", {
                    username: acct.username,
                    loginUrl,
                    attempt,
                    mode: variant.isMobile ? "mobile" : "desktop",
                    err: lastErr,
                  });
                  await context.close().catch(() => null);
                }
              }
            }
          }

          if (!success) {
            perAccount.push({ username: acct.username, ok: false, status: "FAIL", detail: lastErr || "Unknown failure" });

            // Per-account fail email
            await sendEmail(
              process.env,
              "T-Bot | Failed",
              buildRunEmailText({
                phase: "Failed",
                runId: lastRunId,
                startedAt,
                finishedAt: nowLocal(),
                chosenSites,
                perAccount: [{ username: acct.username, ok: false, status: "FAIL", detail: lastErr || "Unknown failure" }],
              })
            );
          }
        }
      } finally {
        await browser.close().catch(() => null);
      }

      const failCount = perAccount.filter((x) => x.ok === false).length;
      if (failCount > 0) lastError = `Some accounts failed (${failCount})`;

      // Final summary email (always)
      await sendEmail(
        process.env,
        failCount > 0 ? "T-Bot | Failed" : "T-Bot | Complete",
        buildRunEmailText({
          phase: failCount > 0 ? "Failed" : "Complete",
          runId: lastRunId,
          startedAt,
          finishedAt: nowLocal(),
          chosenSites,
          perAccount,
        })
      );

      console.log("Bot completed");
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);

      await sendEmail(
        process.env,
        "T-Bot | Failed",
        buildRunEmailText({
          phase: "Failed",
          runId: lastRunId,
          startedAt,
          finishedAt: nowLocal(),
          chosenSites,
          perAccount: perAccount.length
            ? perAccount
            : cfg.accounts.map((a) => ({ username: a.username, ok: false, status: "FAIL", detail: lastError })),
        })
      );

      console.log("Bot error:", lastError);
    } finally {
      isRunning = false;
    }
  })();
});

app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
