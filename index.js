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

// --------------------
// Email config (SendGrid Web API)
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = (process.env.EMAIL_FROM || "").toString().trim();
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO = (process.env.EMAIL_TO || "").toString().trim();

const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

// Verification controls
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "5");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "2500");

// Preflight controls
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "2000");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || "2");

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  return !!(SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO);
}

async function sendEmail(subject, text) {
  if (!emailConfigured()) {
    console.log("Email not configured, skipping send.");
    return { ok: false, skipped: true };
  }

  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(SENDGRID_API_KEY);

    const msg = {
      to: EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
      from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      subject,
      text
    };

    const [res] = await sgMail.send(msg);
    const status = res?.statusCode ?? null;
    const msgId = (res?.headers?.["x-message-id"] || res?.headers?.["X-Message-Id"]) ?? null;

    console.log("Email sent:", { status, msgId, to: msg.to });
    return { ok: true, status, msgId, to: msg.to };
  } catch (e) {
    const body = e?.response?.body ?? null;
    const errText = body ? JSON.stringify(body) : (e?.message ? e.message : String(e));
    console.log("Email failed:", errText, "|", subject);
    return { ok: false, error: errText };
  }
}

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

function homeUrlFromLoginUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  const isPc = loginUrl.includes("/pc/#/");
  // IMPORTANT: h5 needs /trade first to initialize session state
  return isPc ? `${base}/pc/#/` : `${base}/h5/#/trade`;
}

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

async function isVisibleOrderCodeBox(page) {
  for (const f of page.frames()) {
    try {
      const loc = f.locator(ORDER_CODE_SELECTORS).first();
      if (await loc.isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}

// --------------------
// Futures navigation (BOTTOM NAV)
// --------------------
async function bottomMiddleTap(page, label = "BOTTOM-MIDDLE TAP") {
  const vp = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.floor(vp.width * 0.50);
  const y = Math.floor(vp.height * 0.94);
  console.log(`${label}: x=${x} y=${y} (w=${vp.width} h=${vp.height})`);
  await page.mouse.click(x, y, { delay: 30 }).catch(() => null);
  await sleep(900);
}

// Click the bottom NAV "Futures" (DOM scan near bottom) OR coordinate tap
async function clickBottomNavFutures(page) {
  // 1) Try DOM scan: click a visible element whose text is "Futures" and is near the bottom
  const domClicked = await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = window.getComputedStyle(el);
      if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      if (r.bottom < 0 || r.right < 0) return false;
      if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
      return true;
    }
    const els = Array.from(document.querySelectorAll("a,button,div,span,li,[role='tab'],[role='button']"));
    const cand = [];
    for (const el of els) {
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (!t) continue;
      if (t.toLowerCase() !== "futures") continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Only trust items in bottom 25% of screen (bottom nav)
      if (r.top < window.innerHeight * 0.75) continue;
      const score = (r.top / window.innerHeight) * 100 + (r.left / window.innerWidth) * 10;
      cand.push({ el, score });
    }
    cand.sort((a, b) => b.score - a.score);
    if (!cand[0]) return false;
    cand[0].el.click();
    return true;
  });

  if (domClicked) {
    console.log("Clicked Futures (bottom nav DOM scan)");
    await sleep(900);
    return true;
  }

  // 2) Fallback to bottom-middle tap
  for (let i = 1; i <= 3; i++) {
    await bottomMiddleTap(page, `BOTTOM-MIDDLE FUTURES TAP attempt ${i}`);
    const invited = await page.getByText(/invited\s*me/i).first().isVisible().catch(() => false);
    const codeBox = await isVisibleOrderCodeBox(page);
    if (invited || codeBox) return true;
  }

  return false;
}

// Ensure the correct flow: Home -> Futures -> Invited me -> Code box
async function ensureFuturesInvitedAndCode(page, loginUrl) {
  const homeUrl = homeUrlFromLoginUrl(loginUrl);

  // CRITICAL: load /trade first on h5 to avoid being kicked to login later
  if (homeUrl) {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1200);
    await closeOverlays(page);
    await dumpDebugState(page, "after-home-trade", { homeUrl });
  }

  // Click bottom nav futures
  const futOk = await clickBottomNavFutures(page);
  await dumpDebugState(page, "after-futures-nav", { futOk, url: page.url() });

  // If we got bounced to login, stop immediately (don’t type code into email)
  const u = page.url() || "";
  if (/\/login\b|#\/login\b/i.test(u)) {
    return { ok: false, reason: "bounced_to_login_after_futures", url: u };
  }

  // Click "Invited me" if present
  const invited = page.getByText(/invited\s*me/i).first();
  if (await invited.isVisible().catch(() => false)) {
    console.log('Clicking "Invited me"');
    await invited.click({ timeout: 8000 }).catch(() => null);
    await sleep(1000);
  }

  // Confirm code input exists
  const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 12000);
  return { ok: codeRes.ok, reason: codeRes.ok ? "code_box_found" : "code_box_missing", url: page.url() };
}

// Robust confirm click
async function clickConfirmSmart(page) {
  const direct = [
    page.getByRole("button", { name: /confirm/i }).first(),
    page.getByText(/^confirm$/i).first(),
    page.getByText(/confirm/i).first()
  ];

  for (const c of direct) {
    if (await c.isVisible().catch(() => false)) {
      console.log("Confirm click: locator-based");
      await c.click({ timeout: 8000 }).catch(() => null);
      await sleep(900);
      return true;
    }
  }

  const ok = await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = window.getComputedStyle(el);
      if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      if (r.bottom < 0 || r.right < 0) return false;
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

      const r = el.getBoundingClientRect();
      const score = (r.left / window.innerWidth) * 100 + (r.top / window.innerHeight) * 10;
      cand.push({ el, score });
    }

    cand.sort((a, b) => b.score - a.score);
    if (!cand[0]) return false;
    cand[0].el.click();
    return true;
  });

  if (ok) {
    console.log("Confirm click: dom-scan");
    await sleep(900);
    return true;
  }

  return false;
}

// --------------------
// Confirmation gates
// --------------------
async function waitForToastOrModal(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off", detail: "VERIFY_TOAST disabled" };

  const patterns = [
    /already followed/i,
    /followed/i,
    /success/i,
    /successful/i,
    /completed/i,
    /confirm success/i,
    /submitted/i,
    /pending/i
  ];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    for (const re of patterns) {
      const loc = page.getByText(re).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        const txt = await loc.textContent().catch(() => "");
        return { ok: true, type: "toast", detail: (txt || "").trim().slice(0, 160) || re.toString() };
      }
    }
    await sleep(300);
  }

  return { ok: false, type: "toast_timeout", detail: "No confirmation toast/modal found" };
}

async function verifyPendingInPositionOrder(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off", detail: "VERIFY_PENDING disabled" };

  const tab = page.getByText(/position\s*order/i).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ timeout: 8000 }).catch(() => null);
    await sleep(1200);
  }

  const pending = page.getByText(/pending/i).first();
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    const ok = await pending.isVisible().catch(() => false);
    if (ok) return { ok: true, type: "pending", detail: "Pending found in Position order" };
    await sleep(350);
  }

  return { ok: false, type: "pending_timeout", detail: "No Pending found in Position order" };
}

async function verifyOrderFollowed(page) {
  const toastRes = await waitForToastOrModal(page);
  const pendingRes = await verifyPendingInPositionOrder(page);

  if (toastRes.ok && pendingRes.ok) return { ok: true, detail: "toast and pending seen" };
  if (toastRes.ok) return { ok: true, detail: `toast seen (${toastRes.detail})` };
  if (pendingRes.ok) return { ok: true, detail: "pending seen" };

  return { ok: false, detail: `No confirmation. Toast: ${toastRes.type}. Pending: ${pendingRes.type}.` };
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

          if (status && status >= 400) throw new Error(`Preflight HTTP ${status}`);
          if (isCloudflareErrorHtml(html)) throw new Error("Preflight Cloudflare");

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) throw new Error(`locator.waitFor: Timeout ${PREFLIGHT_LOGIN_WAIT_MS}ms exceeded.`);

          await dumpDebugState(page, "preflight-ok", { loginUrl, status, mobile });
          console.log("Preflight OK:", loginUrl);
          passed = true;

          await context.close().catch(() => null);
          break;
        } catch (e) {
          console.log("Preflight failed:", loginUrl, "err:", e?.message || String(e));
          await dumpDebugState(page, `preflight-failed-${i}`, { loginUrl, err: e?.message || String(e) });
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
      Health: <a href="/health">/health</a>
      | Last screenshot: <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
      | Debug: <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/debug</a>
      | DNS test: <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/dns-test</a>
      | Net test: <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/net-test</a>
      | Email test: <a href="/email-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/email-test</a>
    </div>
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
    loginUrls: LOGIN_URLS,
    debugCapture: DEBUG_CAPTURE,
    forceMobile: FORCE_MOBILE,
    apiRewrite: { enabled: API_REWRITE, match: API_REWRITE_MATCH, target: API_REWRITE_TARGET }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const result = await sendEmail("T-Bot | email test", `Email test sent at ${nowLocal()}`);
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

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const hosts = ["dsj12.cc", "dsj877.com", "dsj72.com", "api.ddjea.com", "api.sendgrid.com"];
  const out = {};
  for (const h of hosts) {
    try { out[h] = { ok: true, addrs: await dns.lookup(h, { all: true }) }; }
    catch (e) { out[h] = { ok: false, error: e?.message || String(e) }; }
  }
  res.json(out);
});

app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const urls = ["https://dsj12.cc/", "https://dsj877.com/", "https://api.ddjea.com/api/app/ping"];
  const results = {};
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "GET" });
      results[u] = { ok: true, status: r.status, bodyPreview: (await r.text()).slice(0, 240) };
    } catch (e) {
      results[u] = { ok: false, error: e?.message || String(e) };
    }
  }
  res.json(results);
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
    const startedAt = nowLocal();
    const subjectPrefix = `T-Bot | Run ${lastRunId}`;
    let failAlertsSent = 0;

    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Code received length:", code.length);
      console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
      console.log("FORCE_MOBILE:", FORCE_MOBILE);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);

      const pf = await preflightSites();
      if (!pf.ok) throw new Error(`Preflight failed. ${pf.note}`);

      const runSites = pf.sites;
      console.log("Chosen sites for this run:", runSites.join(", "));

      await sendEmail(`${subjectPrefix} started`, `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nSites: ${runSites.join(", ")}`);

      const results = [];

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);

        try {
          const used = await runAccountAllSites(account, code, runSites);
          results.push({ username: account.username, ok: true, site: used.site, note: used.note });
        } catch (e) {
          const msg = e?.message || String(e);
          results.push({ username: account.username, ok: false, error: msg });
          lastError = `Account failed ${account.username}: ${msg}`;

          if (EMAIL_ACCOUNT_FAIL_ALERTS && failAlertsSent < EMAIL_MAX_FAIL_ALERTS) {
            failAlertsSent += 1;
            await sendEmail(`${subjectPrefix} account FAILED: ${account.username}`, `Account failed: ${account.username}\nRun: ${lastRunId}\nError:\n${msg}`);
          }
        }
      }

      await sendEmail(
        `${subjectPrefix} finished`,
        results.map((r) => (r.ok ? `SUCCESS: ${r.username} (${r.site}) ${r.note || ""}` : `FAIL: ${r.username} (${r.error})`)).join("\n")
      );
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      await sendEmail(`${subjectPrefix} FAILED`, `Run failed at ${nowLocal()}\nRun ID: ${lastRunId}\nError: ${msg}`);
      console.log("Run failed:", msg);
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
      const note = await runAccountOnSite(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl);
      return { site: loginUrl, note };
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

  const harPath =
    DEBUG_CAPTURE && lastDebugDir ? path.join(lastDebugDir, `har-${sanitize(account.username)}-${Date.now()}.har`) : null;

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
    recordHar: harPath ? { path: harPath, content: "embed" } : undefined
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

    const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
    const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 25000);
    if (!userRes.ok || !passRes.ok) throw new Error("Login fields not found");

    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(1200);
      await closeOverlays(page);

      const userRes2 = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
      const passRes2 = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
      if (!userRes2.ok || !passRes2.ok) continue;

      await userRes2.locator.fill("").catch(() => null);
      await passRes2.locator.fill("").catch(() => null);

      await userRes2.locator.click({ timeout: 5000 }).catch(() => null);
      await userRes2.locator.fill(account.username).catch(() => null);
      await sleep(200);

      await passRes2.locator.click({ timeout: 5000 }).catch(() => null);
      await passRes2.locator.fill(account.password).catch(() => null);
      await sleep(200);

      const loginBtn = page.getByRole("button", { name: /login|sign in/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) await loginBtn.click({ timeout: 10000 }).catch(() => null);
      else await passRes2.locator.press("Enter").catch(() => null);

      await sleep(1800);
      await dumpDebugState(page, `after-login-attempt-${attempt}`, { attempt, url: page.url() });

      // Confirm login by landing on Home/Trade (this also initializes state)
      const home = homeUrlFromLoginUrl(loginUrl);
      if (home) {
        await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(1200);
        await closeOverlays(page);
        await dumpDebugState(page, "after-home-confirm", { homeUrl: home, url: page.url() });

        // If we are not on /login anymore, consider login good
        const u = page.url() || "";
        if (!/\/login\b|#\/login\b/i.test(u)) {
          loggedIn = true;
          console.log("Login confirmed for", account.username, "on", loginUrl);
          break;
        }
      }
    }

    if (!loggedIn) throw new Error("Login failed");

    // Now do: Home -> Futures bottom tab -> Invited me -> Code box
    const flow = await ensureFuturesInvitedAndCode(page, loginUrl);
    await dumpDebugState(page, "after-flow", flow);

    if (!flow.ok) {
      if (flow.reason === "bounced_to_login_after_futures") {
        throw new Error("Bounced back to login after tapping Futures (session not stable)");
      }
      throw new Error("Could not reach order code input after Futures + Invited me");
    }

    // Find code input
    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 15000);
    if (!codeRes.ok) throw new Error("Order code input not found");

    // Guard: stop if kicked to login
    const curUrl = page.url() || "";
    if (/\/login\b|#\/login\b/i.test(curUrl)) {
      await dumpDebugState(page, "kicked-to-login", { curUrl });
      throw new Error("Kicked back to login before entering order code (stopping to avoid typing into email).");
    }

    await codeRes.locator.click().catch(() => null);
    await codeRes.locator.fill(orderCode).catch(() => null);
    await sleep(700);
    await dumpDebugState(page, "after-code", { codeLength: String(orderCode || "").length });

    // Click confirm
    const clicked = await clickConfirmSmart(page);
    await dumpDebugState(page, "after-confirm-click", { clicked });

    if (!clicked) throw new Error("Confirm button not found");

    // Verify
    let lastVerify = null;
    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      const verify = await verifyOrderFollowed(page);
      lastVerify = verify;
      if (verify.ok) {
        await dumpDebugState(page, "confirm-verified", { verify });
        return verify.detail || "verified";
      }
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }

    throw new Error(lastVerify?.detail || "Confirm verification failed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("FORCE_MOBILE:", FORCE_MOBILE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Email from/to:", EMAIL_FROM_NAME ? `${EMAIL_FROM_NAME} <${EMAIL_FROM}>` : EMAIL_FROM, EMAIL_TO);
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS, "retries:", PREFLIGHT_RETRIES, "maxSites:", PREFLIGHT_MAX_SITES);
  writePlaceholderLastShot();
});
