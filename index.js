"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { chromium } = require("playwright");

const PORT = process.env.PORT || 8080;

// Support both BOT_PASSWORD and RUN_PASSWORD
const BOT_PASSWORD = process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

// Optional: LOGIN_URLS override from Railway (comma-separated)
const LOGIN_URLS_ENV = process.env.LOGIN_URLS || "";

// --------------------
// Helpers
// --------------------
function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}

function sanitize(s) {
  return String(s || "")
    .replaceAll("@", "_at_")
    .replaceAll(".", "_")
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .slice(0, 80);
}

const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");
const FORCE_MOBILE = envTruthy(process.env.FORCE_MOBILE || "0");

// Optional API host rewrite to avoid api.dsj*. DNS failures
const API_REWRITE = envTruthy(process.env.API_REWRITE || "0");
const API_REWRITE_MATCH = (process.env.API_REWRITE_MATCH || "^api\\.").toString();
const API_REWRITE_TARGET = (process.env.API_REWRITE_TARGET || "api.ddjea.com").toString();

// Verification controls
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "8");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "2500");

// Preflight controls
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "2000");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || "2");

// --------------------
// Login URLs
// --------------------
function parseLoginUrls() {
  const fallback = ["https://dsj12.cc/h5/#/login", "https://dsj877.com/h5/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

let LOGIN_URLS = parseLoginUrls();

function shouldUseMobile(loginUrl) {
  if (FORCE_MOBILE) return true;
  const u = (loginUrl || "").toLowerCase();
  return u.includes("/h5/") || u.includes("h5/#");
}

function baseFromUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}`;
  } catch {
    return null;
  }
}

// Always use H5 post-login routes even if you logged in via /pc
function h5TradeUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  return `${base}/h5/#/trade`;
}
function h5ContractUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  return `${base}/h5/#/contractTransaction`;
}
function pcContractUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  return `${base}/pc/#/contractTransaction`;
}

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    const cleaned = parsed.map((a) => ({ username: (a.username || "").trim(), password: String(a.password || "") }));
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

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function safeListDir(dir) {
  try { return fs.readdirSync(dir).filter((x) => !x.includes("..")); } catch { return []; }
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

async function saveShot(page, tag) {
  try {
    const file = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;
    try { fs.copyFileSync(file, "/app/last-shot.png"); } catch {}
    console.log("Saved screenshot:", file, "and updated /app/last-shot.png");
    return file;
  } catch (e) {
    console.log("Screenshot failed:", e?.message || String(e));
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

    try { fs.writeFileSync(`${base}.url.txt`, String(page.url() || "")); } catch {}
    try { fs.writeFileSync(`${base}.title.txt`, String(await page.title().catch(() => ""))); } catch {}
    try { fs.writeFileSync(`${base}.html`, String(await page.content().catch(() => ""))); } catch {}
    try { fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2)); } catch {}

    await saveShot(page, tag);
  } catch (e) {
    console.log("dumpDebugState failed:", e?.message || String(e));
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
  'input[placeholder*="mobile" i]'
].join(", ");

const PASS_SELECTORS = [
  'input[type="password"]',
  'input[name*="pass" i]',
  'input[placeholder*="password" i]'
].join(", ");

const ORDER_CODE_SELECTORS = [
  'input[placeholder*="order code" i]',
  'input[placeholder*="invite" i]',
  'input[placeholder*="Please enter" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]'
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
    page.locator(".el-dialog__headerbtn")
  ];

  for (const c of candidates) {
    try {
      const btn = c.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1500 }).catch(() => null);
        await sleep(250);
      }
    } catch {}
  }
}

async function findVisibleInAnyFrame(page, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await closeOverlays(page);
    for (const f of page.frames()) {
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

async function loginInputsVisible(page) {
  const u = await findVisibleInAnyFrame(page, USER_SELECTORS, 900);
  const p = await findVisibleInAnyFrame(page, PASS_SELECTORS, 900);
  return u.ok && p.ok;
}

async function loginConfirmed(page) {
  // if login inputs are gone, we're authenticated (even if hash stays /login)
  if (!(await loginInputsVisible(page))) return { ok: true, reason: "login_inputs_gone" };

  // or if bottom-nav labels exist, we are post-login UI
  const navWords = [/home/i, /markets/i, /futures/i, /perpetual/i, /assets/i];
  for (const re of navWords) {
    const vis = await page.getByText(re).first().isVisible().catch(() => false);
    if (vis) return { ok: true, reason: "bottom_nav_present" };
  }

  return { ok: false, reason: "still_looks_like_login" };
}

// --------------------
// Bottom tab clicking (robust)
// --------------------
async function clickTabByCoordinate(page, name, slotIndex) {
  // 5 tabs: 0..4 across bottom
  const vp = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.floor(vp.width * ((slotIndex + 0.5) / 5));
  const y = Math.floor(vp.height * 0.94);
  console.log(`TAB TAP ${name}: x=${x} y=${y} (w=${vp.width} h=${vp.height})`);
  await page.mouse.click(x, y, { delay: 30 }).catch(() => null);
  await sleep(1000);
}

async function clickFuturesTab(page) {
  // Strategy A: click any visible "Futures" text across frames
  for (const f of page.frames()) {
    try {
      const t = f.getByText(/futures/i).first();
      if (await t.isVisible().catch(() => false)) {
        await t.click({ timeout: 5000 }).catch(() => null);
        console.log("Clicked Futures (text)");
        await sleep(1000);
        return true;
      }
    } catch {}
  }

  // Strategy B: coordinate click the 3rd tab (index 2)
  await clickTabByCoordinate(page, "FUTURES", 2);

  // Strategy C: brute tap all 5 tabs once, then Futures again
  await clickTabByCoordinate(page, "HOME", 0);
  await clickTabByCoordinate(page, "MARKETS", 1);
  await clickTabByCoordinate(page, "FUTURES", 2);
  await clickTabByCoordinate(page, "PERPETUAL", 3);
  await clickTabByCoordinate(page, "ASSETS", 4);
  await clickTabByCoordinate(page, "FUTURES", 2);

  return true;
}

async function tryReachCodeBox(page, loginUrl) {
  // Always start from trade (builds the bottom nav + state)
  const trade = h5TradeUrl(loginUrl);
  if (trade) {
    await page.goto(trade, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1400);
    await closeOverlays(page);
    await dumpDebugState(page, "after-home-trade", { trade, url: page.url() });
  }

  // Try Futures tab clicking (best effort)
  await clickFuturesTab(page);
  await closeOverlays(page);
  await dumpDebugState(page, "after-futures-nav", { url: page.url() });

  // Now do the reliable part: hard navigate to contractTransaction (H5 then PC)
  const c1 = h5ContractUrl(loginUrl);
  if (c1) {
    await page.goto(c1, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1400);
    await closeOverlays(page);
    await dumpDebugState(page, "after-contract-h5", { c1, url: page.url() });

    // click Invited me if present
    const inv = page.getByText(/invited\s*me/i).first();
    if (await inv.isVisible().catch(() => false)) {
      await inv.click({ timeout: 8000 }).catch(() => null);
      await sleep(1000);
      await closeOverlays(page);
      await dumpDebugState(page, "after-invited-h5", { url: page.url() });
    }

    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 8000);
    if (codeRes.ok) return { ok: true, where: "h5_contract", url: page.url() };
  }

  const c2 = pcContractUrl(loginUrl);
  if (c2) {
    await page.goto(c2, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1400);
    await closeOverlays(page);
    await dumpDebugState(page, "after-contract-pc", { c2, url: page.url() });

    const inv = page.getByText(/invited\s*me/i).first();
    if (await inv.isVisible().catch(() => false)) {
      await inv.click({ timeout: 8000 }).catch(() => null);
      await sleep(1000);
      await closeOverlays(page);
      await dumpDebugState(page, "after-invited-pc", { url: page.url() });
    }

    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 8000);
    if (codeRes.ok) return { ok: true, where: "pc_contract", url: page.url() };
  }

  return { ok: false, where: "none", url: page.url() };
}

async function clickConfirmSmart(page) {
  const candidates = [
    page.getByRole("button", { name: /confirm/i }).first(),
    page.getByText(/^confirm$/i).first(),
    page.getByText(/confirm/i).first()
  ];

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) {
      await c.click({ timeout: 8000 }).catch(() => null);
      await sleep(900);
      return true;
    }
  }

  // fallback: click any visible element containing "Confirm"
  const ok = await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = window.getComputedStyle(el);
      if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
      return true;
    }
    const els = Array.from(document.querySelectorAll("button,a,[role='button'],div,span"));
    const cand = [];
    for (const el of els) {
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (!t) continue;
      if (!/\bconfirm\b/i.test(t)) continue;
      if (!visible(el)) continue;
      cand.push(el);
    }
    if (!cand[0]) return false;
    cand[0].click();
    return true;
  });

  if (ok) {
    await sleep(900);
    return true;
  }

  return false;
}

// --------------------
// Confirmation gates
// --------------------
async function waitForToastOrModal(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off" };

  const patterns = [/already followed/i, /followed/i, /success/i, /successful/i, /completed/i, /submitted/i, /pending/i];
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    for (const re of patterns) {
      const loc = page.getByText(re).first();
      if (await loc.isVisible().catch(() => false)) {
        const txt = await loc.textContent().catch(() => "");
        return { ok: true, type: "toast", detail: (txt || "").trim().slice(0, 160) };
      }
    }
    await sleep(300);
  }
  return { ok: false, type: "toast_timeout" };
}

async function verifyPendingInPositionOrder(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off" };

  const tab = page.getByText(/position\s*order/i).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ timeout: 8000 }).catch(() => null);
    await sleep(1000);
  }

  const pending = page.getByText(/pending/i).first();
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    if (await pending.isVisible().catch(() => false)) return { ok: true, type: "pending" };
    await sleep(350);
  }
  return { ok: false, type: "pending_timeout" };
}

async function verifyOrderFollowed(page) {
  const toastRes = await waitForToastOrModal(page);
  const pendingRes = await verifyPendingInPositionOrder(page);
  if (toastRes.ok || pendingRes.ok) return { ok: true, detail: toastRes.ok ? "toast" : "pending" };
  return { ok: false, detail: `No confirmation: toast=${toastRes.type} pending=${pendingRes.type}` };
}

// --------------------
// Preflight
// --------------------
async function preflightSites() {
  if (!PREFLIGHT_ENABLED) return { ok: true, sites: LOGIN_URLS, note: "preflight disabled" };

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const good = [];
  try {
    for (const loginUrl of LOGIN_URLS) {
      let passed = false;
      for (let i = 1; i <= PREFLIGHT_RETRIES; i++) {
        console.log("Preflight checking:", loginUrl, "attempt", i);

        const mobile = shouldUseMobile(loginUrl);
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
          locale: "en-US",
          isMobile: mobile,
          hasTouch: mobile,
          userAgent: mobile
            ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            : undefined
        });

        const page = await context.newPage();

        try {
          const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(700);

          const status = resp ? resp.status() : null;
          const html = await page.content().catch(() => "");
          if (status && status >= 400) throw new Error(`HTTP ${status}`);
          if (isCloudflareErrorHtml(html)) throw new Error("Cloudflare");

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) throw new Error(`Timeout ${PREFLIGHT_LOGIN_WAIT_MS}ms`);

          await dumpDebugState(page, "preflight-ok", { loginUrl, status, mobile });
          console.log("Preflight OK:", loginUrl);
          passed = true;

          await context.close().catch(() => null);
          break;
        } catch (e) {
          console.log("Preflight failed:", loginUrl, "err:", e?.message || String(e));
          await context.close().catch(() => null);
          await sleep(PREFLIGHT_RETRY_DELAY_MS);
        }
      }

      if (passed) {
        good.push(loginUrl);
        if (good.length >= PREFLIGHT_MAX_SITES) break;
      }
    }

    if (!good.length) return { ok: false, sites: [], note: "No sites passed preflight" };
    return { ok: true, sites: good, note: `Chosen sites: ${good.join(", ")}` };
  } finally {
    await browser.close().catch(() => null);
  }
}

// --------------------
// Express
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>
    <div>Last error: ${lastError ? escapeHtml(lastError) : "-"}</div>
    <div>Debug capture: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
    <div>Force mobile: <b>${FORCE_MOBILE ? "ON" : "AUTO"}</b></div>
    <div>API rewrite: <b>${API_REWRITE ? "ON" : "OFF"}</b> (${escapeHtml(API_REWRITE_MATCH)} → ${escapeHtml(API_REWRITE_TARGET)})</div>
    <div>LOGIN_URLS: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></div>
    <div>Accounts loaded: <b>${cfg.ok ? cfg.accounts.length : 0}</b></div>

    <form method="POST" action="/run" style="margin-top:12px;">
      <input name="p" placeholder="Password" type="password" required />
      <br/><br/>
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <div style="margin-top:12px;">
      Last screenshot: <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
      | Debug: <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/debug</a>
    </div>
  `);
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
    res.send(`<h3>Debug</h3><div>No debug run directory yet. Set DEBUG_CAPTURE=1 and run once.</div>`);
    return;
  }

  const files = safeListDir(lastDebugDir);
  const links = files
    .map((f) => `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`)
    .join("");

  res.send(`
    <h3>Debug</h3>
    <div>Last debug dir: <code>${escapeHtml(lastDebugDir)}</code></div>
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

  if (f.endsWith(".html") || f.endsWith(".txt") || f.endsWith(".json")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  else if (f.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else res.setHeader("Content-Type", "application/octet-stream");

  fs.createReadStream(full).pipe(res);
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON invalid.");

  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

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
  res.send("Run started. Check logs, /last-shot, and /debug.");

  (async () => {
    try {
      const pf = await preflightSites();
      if (!pf.ok) throw new Error(`Preflight failed. ${pf.note}`);

      const runSites = pf.sites;
      console.log("Chosen sites for this run:", runSites.join(", "));

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);
        await runAccountAllSites(account, code, runSites);
      }
    } catch (e) {
      lastError = e?.message || String(e);
      console.log("Run failed:", lastError);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Playwright core
// --------------------
async function runAccountAllSites(account, orderCode, runSites) {
  let last = null;

  for (const loginUrl of runSites) {
    console.log("Trying site:", loginUrl, "for", account.username);
    try {
      await runAccountOnSite(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl);
      return;
    } catch (e) {
      const msg = e?.message || String(e);
      console.log("Site failed:", loginUrl, "for", account.username, "err:", msg);
      last = e;
    }
  }

  throw last || new Error("All sites failed");
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const mobile = shouldUseMobile(loginUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  if (API_REWRITE) {
    const re = new RegExp(API_REWRITE_MATCH);
    await page.route("**/*", async (route) => {
      const req = route.request();
      try {
        const u = new URL(req.url());
        if (re.test(u.hostname) && u.pathname.startsWith("/api/")) {
          const newUrl = `${u.protocol}//${API_REWRITE_TARGET}${u.pathname}${u.search}`;
          console.log("API REWRITE:", u.hostname, "->", API_REWRITE_TARGET, "|", u.pathname);
          return route.continue({ url: newUrl });
        }
      } catch {}
      return route.continue();
    });
  }

  page.on("pageerror", (err) => console.log("PAGE ERROR:", err?.message || String(err)));

  try {
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);

    const html0 = await page.content().catch(() => "");
    if (isCloudflareErrorHtml(html0)) throw new Error("Cloudflare error page on login");

    await dumpDebugState(page, "after-goto", { loginUrl, status: resp ? resp.status() : null, mobile });

    // Find login fields
    const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
    const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 25000);
    if (!userRes.ok || !passRes.ok) throw new Error("Login fields not found");

    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(1200);
      await closeOverlays(page);

      const u2 = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
      const p2 = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
      if (!u2.ok || !p2.ok) continue;

      await u2.locator.fill("").catch(() => null);
      await p2.locator.fill("").catch(() => null);

      await u2.locator.click({ timeout: 5000 }).catch(() => null);
      await u2.locator.fill(account.username).catch(() => null);
      await sleep(200);

      await p2.locator.click({ timeout: 5000 }).catch(() => null);
      await p2.locator.fill(account.password).catch(() => null);
      await sleep(200);

      const loginBtn = page.getByRole("button", { name: /login|sign in/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) await loginBtn.click({ timeout: 10000 }).catch(() => null);
      else await p2.locator.press("Enter").catch(() => null);

      await sleep(1600);

      // go to h5 trade immediately after login click
      const trade = h5TradeUrl(loginUrl);
      if (trade) {
        await page.goto(trade, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(1400);
        await closeOverlays(page);
      }

      const conf = await loginConfirmed(page);
      await dumpDebugState(page, `after-home-confirm`, { attempt, conf, url: page.url() });

      if (conf.ok) {
        loggedIn = true;
        console.log("Login confirmed:", conf.reason);
        break;
      }
    }

    if (!loggedIn) throw new Error("Login failed");

    // Now reach code box (this is the part that failed for you)
    const flow = await tryReachCodeBox(page, loginUrl);
    await dumpDebugState(page, "after-flow", flow);

    if (!flow.ok) throw new Error("Flow failed: code_box_missing");

    // SAFETY: If we're on login screen again, STOP
    const curUrl = page.url() || "";
    if (/\/login\b|#\/login\b/i.test(curUrl) && (await loginInputsVisible(page))) {
      await dumpDebugState(page, "kicked-to-login", { curUrl });
      throw new Error("Kicked back to login before entering order code (stopping to avoid typing into email).");
    }

    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 15000);
    if (!codeRes.ok) throw new Error("Order code input not found");

    await codeRes.locator.click().catch(() => null);
    await codeRes.locator.fill(orderCode).catch(() => null);
    await sleep(700);
    await dumpDebugState(page, "after-code", { codeLength: String(orderCode || "").length });

    const clicked = await clickConfirmSmart(page);
    await dumpDebugState(page, "after-confirm-click", { clicked });
    if (!clicked) throw new Error("Confirm button not found");

    let lastVerify = null;
    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      const verify = await verifyOrderFollowed(page);
      lastVerify = verify;
      if (verify.ok) {
        await dumpDebugState(page, "confirm-verified", { verify });
        return;
      }
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }

    throw new Error(lastVerify?.detail || "Confirm verification failed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// --------------------
// Startup
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("FORCE_MOBILE:", FORCE_MOBILE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS, "retries:", PREFLIGHT_RETRIES, "maxSites:", PREFLIGHT_MAX_SITES);
  writePlaceholderLastShot();
});
