"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8080);

// --------------------
// REQUIRED ENV
// --------------------
const BOT_PASSWORD = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString();
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();

// Comma-separated list of login URLs (/pc/#/login and/or /h5/#/login)
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

// --------------------
// OPTIONAL ENV (sane defaults)
// --------------------
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "1"); // keep ON while stabilizing
const FORCE_MOBILE_MODE = (process.env.FORCE_MOBILE || "auto").toString().trim().toLowerCase(); // "auto" | "true" | "false"
const API_REWRITE_ENABLED = envTruthy(process.env.API_REWRITE || "0"); // OFF by default
const API_REWRITE_MATCH = (process.env.API_REWRITE_MATCH || "^api\\.").toString(); // default: host starts with "api."
const API_REWRITE_TARGET = (process.env.API_REWRITE_TARGET || "api.ddjea.com").toString();

const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "0"); // OFF by default (was causing regressions)
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "2");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "1500");

// Confirmation behavior
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "5");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "2500");

// --------------------
// EMAIL (SendGrid Web API) - optional
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").toString().trim();
const EMAIL_FROM_RAW = (process.env.EMAIL_FROM || "").toString().trim(); // user sometimes sets "Name <email>"
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO = (process.env.EMAIL_TO || "").toString().trim();
const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

// --------------------
// Helpers
// --------------------
function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeForFilename(s) {
  return String(s ?? "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
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

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    const cleaned = parsed.map((a) => ({
      username: String(a?.username || "").trim(),
      password: String(a?.password || "")
    }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) return { ok: false, accounts: [], error: "Each account must include username + password" };
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e?.message || String(e)}` };
  }
}

// --------------------
// LOGIN URLS
// --------------------
function parseLoginUrls() {
  const fallback = ["https://dsj12.cc/pc/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

let LOGIN_URLS = parseLoginUrls();

function isH5Url(url) {
  return /\/h5\/#\//i.test(url) || /\/h5\//i.test(url);
}

function shouldUseMobileContext(loginUrl) {
  if (FORCE_MOBILE_MODE === "true" || FORCE_MOBILE_MODE === "1") return true;
  if (FORCE_MOBILE_MODE === "false" || FORCE_MOBILE_MODE === "0") return false;
  // auto
  return isH5Url(loginUrl);
}

function baseFromUrl(anyUrl) {
  try {
    const u = new URL(anyUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function futuresUrlFromLoginUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  const prefix = loginUrl.includes("/pc/#/") ? "/pc/#/" : "/h5/#/";
  return `${base}${prefix}contractTransaction`;
}

function tradeUrlFromLoginUrl(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  // Your known trade route on h5 is /h5/#/trade; for pc, it varies, but trade page exists too.
  const prefix = loginUrl.includes("/pc/#/") ? "/pc/#/" : "/h5/#/";
  return `${base}${prefix}trade`;
}

// --------------------
// Minimal GET (for /net-test)
// --------------------
function simpleGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Bad URL: ${url}`));
      return;
    }

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          "User-Agent": "T-Bot/1.0",
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

// --------------------
// EMAIL helpers (fixes common "Name <email>" mistake automatically)
// --------------------
function parseFromEmail(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  // If user put "Name <email@x.com>"
  const m = s.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  return s;
}

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  const fromEmail = parseFromEmail(EMAIL_FROM_RAW);
  return !!(SENDGRID_API_KEY && fromEmail && EMAIL_TO);
}

async function sendEmail(subject, text) {
  if (!emailConfigured()) {
    console.log("Email not configured, skipping send:", subject);
    return { ok: false, skipped: true, error: "Email not configured" };
  }

  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(SENDGRID_API_KEY);

    const fromEmail = parseFromEmail(EMAIL_FROM_RAW);

    const msg = {
      to: EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
      from: { email: fromEmail, name: EMAIL_FROM_NAME || "T-Bot" },
      subject,
      text
    };

    const [res] = await sgMail.send(msg);
    const status = res?.statusCode ?? null;
    const msgId = (res?.headers?.["x-message-id"] || res?.headers?.["X-Message-Id"]) ?? null;

    console.log("Email sent:", { status, msgId, to: msg.to, subject });
    return { ok: true, status, msgId, to: msg.to };
  } catch (e) {
    const body = e?.response?.body ?? null;
    const errText = body ? JSON.stringify(body) : e?.message ? e.message : String(e);
    console.log("Email failed (SendGrid):", errText, "|", subject);
    return { ok: false, error: errText };
  }
}

// --------------------
// Debug artifacts
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;
let lastRunId = null;
let lastDebugDir = null;
let lastShotPath = null;

function writePlaceholderLastShot() {
  try {
    ensureDir("/app");
    const placeholder = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl1mQAAAAASUVORK5CYII=",
      "base64"
    );
    fs.writeFileSync("/app/last-shot.png", placeholder);
  } catch {}
}

async function tryCopyStableShot(srcPath) {
  try {
    ensureDir("/app");
    fs.copyFileSync(srcPath, "/app/last-shot.png");
  } catch {}
}

async function saveShot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    lastShotPath = filePath;
    await tryCopyStableShot(filePath);
    return true;
  } catch (e) {
    console.log("Screenshot failed:", e?.message || String(e));
    return false;
  }
}

async function dumpStep(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return null;
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag);
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  const base = path.join(dir, `${safeTag}-${stamp}`);

  try { fs.writeFileSync(`${base}.url.txt`, String(page.url() || "")); } catch {}
  try { fs.writeFileSync(`${base}.href.txt`, String(await page.evaluate(() => location.href).catch(() => ""))); } catch {}
  try { fs.writeFileSync(`${base}.title.txt`, String(await page.title().catch(() => ""))); } catch {}
  try { fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2)); } catch {}
  try { fs.writeFileSync(`${base}.html`, String(await page.content().catch(() => ""))); } catch {}
  try { await saveShot(page, `${base}.png`); } catch {}

  return base;
}

async function captureFailure(page, tag, message, extra = {}) {
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag);
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  const shotPath = path.join(dir, `${safeTag}-${stamp}.png`);
  const htmlPath = path.join(dir, `${safeTag}-${stamp}.html`);
  const urlPath = path.join(dir, `${safeTag}-${stamp}.url.txt`);
  const extraPath = path.join(dir, `${safeTag}-${stamp}.extra.json`);

  let url = "";
  try { url = page.url(); } catch {}
  if (!url) { try { url = await page.evaluate(() => location.href).catch(() => ""); } catch {} }

  try { await saveShot(page, shotPath); } catch {}
  try { fs.writeFileSync(htmlPath, String(await page.content().catch(() => ""))); } catch {}
  try { fs.writeFileSync(urlPath, String(url || "")); } catch {}
  try { fs.writeFileSync(extraPath, JSON.stringify({ message, url, ...extra }, null, 2)); } catch {}

  console.log("FAIL:", message);
  console.log("FAIL URL:", url);
  console.log("FAIL screenshot:", shotPath);
  console.log("FAIL html:", htmlPath);
  console.log("FAIL debug dir:", dir);
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
  'input[placeholder*="password" i]',
  'input[placeholder*="Please enter your password" i]'
].join(", ");

const ORDER_CODE_SELECTORS = [
  'input[placeholder*="Please enter the order code" i]',
  'input[placeholder*="Please enter" i]',
  'input[placeholder*="order code" i]',
  'input[placeholder*="order" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]'
].join(", ");

function isLoginPageBySignals(url, page) {
  if ((url || "").includes("/#/login") || (url || "").includes("/login")) return true;
  // Also treat as login if the login fields are visible
  return false;
}

async function loginFieldsVisible(page) {
  const u = page.locator(USER_SELECTORS).first();
  const p = page.locator(PASS_SELECTORS).first();
  const uv = await u.isVisible().catch(() => false);
  const pv = await p.isVisible().catch(() => false);
  return uv && pv;
}

async function findVisible(page, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) return { ok: true, locator: loc };
    await sleep(250);
  }
  return { ok: false, locator: null };
}

async function closeOverlays(page) {
  const candidates = [
    page.getByRole("button", { name: /close|cancel|dismiss|i understand|got it|ok|agree/i }).first(),
    page.locator('[aria-label*="close" i]').first(),
    page.locator('button:has-text("×")').first(),
    page.locator(".close").first(),
    page.locator(".modal-close").first(),
    page.locator(".ant-modal-close").first()
  ];

  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 1200 }).catch(() => null);
        await sleep(200);
      }
    } catch {}
  }
}

// --------------------
// API rewrite (optional)
// --------------------
function setupApiRewrite(page) {
  if (!API_REWRITE_ENABLED) return;

  let re = null;
  try { re = new RegExp(API_REWRITE_MATCH); } catch { re = /^api\./; }

  page.route("**/*", async (route) => {
    try {
      const req = route.request();
      const url = req.url();

      const u = new URL(url);
      const host = u.hostname || "";

      if (re.test(host)) {
        const oldHost = u.hostname;
        u.hostname = API_REWRITE_TARGET;

        console.log("API REWRITE:", oldHost, "->", u.hostname, "|", u.pathname);

        await route.continue({ url: u.toString() });
        return;
      }
    } catch {}

    await route.continue();
  });
}

// --------------------
// Navigation helpers
// --------------------
async function clickByText(page, regex, timeout = 3000) {
  const loc = page.getByText(regex).first();
  if (await loc.isVisible().catch(() => false)) {
    await loc.click({ timeout }).catch(() => null);
    return true;
  }
  return false;
}

async function clickByRole(page, role, regex, timeout = 3000) {
  const loc = page.getByRole(role, { name: regex }).first();
  if (await loc.isVisible().catch(() => false)) {
    await loc.click({ timeout }).catch(() => null);
    return true;
  }
  return false;
}

// Mobile: click bottom Futures tab (text first, then bottom-middle coordinate tap)
async function gotoMobileFutures(page) {
  // 1) Try text/role click (best case)
  const clicked =
    (await clickByRole(page, "tab", /futures/i, 5000)) ||
    (await clickByRole(page, "button", /futures/i, 5000)) ||
    (await clickByRole(page, "link", /futures/i, 5000)) ||
    (await clickByText(page, /^Futures$/i, 5000)) ||
    (await clickByText(page, /futures/i, 5000));

  if (clicked) {
    console.log("Clicked Futures (text/role) in bottom nav");
    await sleep(1200);
    return true;
  }

  // 2) Bottom-middle tap fallback
  const vp = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.floor(vp.width * 0.50);
  const y = Math.floor(vp.height * 0.94); // slightly above bottom edge
  for (let i = 1; i <= 3; i++) {
    console.log(`BOTTOM-MIDDLE FUTURES TAP attempt ${i}: x=${x} y=${y} (w=${vp.width} h=${vp.height})`);
    await page.mouse.click(x, y).catch(() => null);
    await sleep(900);
    // If "Invited me" appears, likely we are in the futures area
    const inv = await page.getByText(/invited\s*me/i).first().isVisible().catch(() => false);
    if (inv) return true;
  }

  return false;
}

// PC: open Futures menu and click Futures/Contract option if present
async function gotoPcFutures(page) {
  // Try top nav "Futures" (often has dropdown)
  const opened =
    (await clickByText(page, /^Futures$/i, 5000)) ||
    (await clickByText(page, /Futures\s*▼/i, 5000)) ||
    (await clickByRole(page, "link", /futures/i, 5000));

  if (opened) {
    await sleep(500);
    // Dropdown options often include "Futures", "Contract", "Contract transaction"
    const picked =
      (await clickByText(page, /contract\s*transaction/i, 5000)) ||
      (await clickByText(page, /^contract$/i, 5000)) ||
      (await clickByText(page, /futures/i, 5000)) ||
      false;

    if (picked) {
      console.log("PC: clicked Futures dropdown item");
      await sleep(1200);
      return true;
    }
  }

  // If clicking doesn’t work, we’ll still try direct contractTransaction URL later.
  return false;
}

// Once on futures area, click Invited me tab
async function clickInvitedMe(page) {
  const ok =
    (await clickByText(page, /invited\s*me/i, 6000)) ||
    (await clickByRole(page, "tab", /invited\s*me/i, 6000)) ||
    false;
  if (ok) await sleep(900);
  return ok;
}

// --------------------
// Confirmation gates
// --------------------
async function waitForToast(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off" };

  const patterns = [
    /already\s*followed/i,
    /already\s*follow/i,
    /followed/i,
    /success/i,
    /successful/i,
    /completed/i,
    /submitted/i,
    /pending/i
  ];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    for (const re of patterns) {
      const loc = page.getByText(re).first();
      if (await loc.isVisible().catch(() => false)) {
        const txt = (await loc.textContent().catch(() => "")) || "";
        return { ok: true, type: "toast", detail: txt.trim().slice(0, 180) || re.toString() };
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
    await tab.click({ timeout: 6000 }).catch(() => null);
    await sleep(900);
  }

  const pending = page.getByText(/pending/i).first();
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    if (await pending.isVisible().catch(() => false)) return { ok: true, type: "pending" };
    await sleep(350);
  }
  return { ok: false, type: "pending_timeout" };
}

async function verifyOrder(page) {
  const t = await waitForToast(page);
  const p = await verifyPendingInPositionOrder(page);
  if (t.ok || p.ok) return { ok: true, detail: t.ok ? `toast: ${t.detail || t.type}` : "pending seen" };
  return { ok: false, detail: `Toast: ${t.type}. Pending: ${p.type}.` };
}

// --------------------
// Preflight (optional; OFF by default)
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

        const mobile = shouldUseMobileContext(loginUrl);
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
        setupApiRewrite(page);

        try {
          await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(900);
          await closeOverlays(page);

          const user = await findVisible(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!user.ok) throw new Error(`user field not found within ${PREFLIGHT_LOGIN_WAIT_MS}ms`);

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

      if (passed) good.push(loginUrl);
    }

    if (!good.length) return { ok: false, sites: [], note: "No sites passed preflight" };
    return { ok: true, sites: good, note: `Chosen sites: ${good.join(", ")}` };
  } finally {
    await browser.close().catch(() => null);
  }
}

// --------------------
// Playwright core flow
// --------------------
async function clickLoginSubmit(page) {
  const candidates = [
    page.getByRole("button", { name: /login|sign in/i }).first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
    page.locator('button:has-text("Login")').first(),
    page.locator("text=/login/i").first()
  ];

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) {
      await c.click({ timeout: 10000 }).catch(() => null);
      return true;
    }
  }
  return false;
}

async function login(page, account, loginUrl) {
  // Must be on login page
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1200);
  await closeOverlays(page);

  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

    // refresh each attempt
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1200);
    await closeOverlays(page);

    const userRes = await findVisible(page, USER_SELECTORS, 20000);
    const passRes = await findVisible(page, PASS_SELECTORS, 20000);
    if (!userRes.ok || !passRes.ok) {
      await dumpStep(page, `login-fields-missing`, { attempt, loginUrl });
      continue;
    }

    const user = userRes.locator;
    const pass = passRes.locator;

    await user.fill("").catch(() => null);
    await pass.fill("").catch(() => null);

    await user.click({ timeout: 3000 }).catch(() => null);
    await user.fill(account.username).catch(() => null);
    await sleep(150);

    await pass.click({ timeout: 3000 }).catch(() => null);
    await pass.fill(account.password).catch(() => null);
    await sleep(150);

    const clicked = await clickLoginSubmit(page);
    if (!clicked) {
      await pass.press("Enter").catch(() => null);
    }

    await sleep(1500);
    await closeOverlays(page);
    await dumpStep(page, `after-login-attempt`, { attempt, clicked });

    // Success condition: login form not visible anymore
    const still = await loginFieldsVisible(page);
    const href = await page.evaluate(() => location.href).catch(() => "");
    const url = page.url();

    if (!still && !isLoginPageBySignals(href || url, page)) {
      console.log("Login confirmed: login_inputs_gone");
      return true;
    }

    // Some sites keep URL on login but hide inputs briefly; still treat as success if inputs are gone
    if (!still) {
      console.log("Login likely success (inputs gone), continuing.");
      return true;
    }
  }

  return false;
}

// The full “go to futures -> invited me -> code box -> confirm -> verify” flow
async function runFlow(page, loginUrl, orderCode) {
  const mobile = shouldUseMobileContext(loginUrl);

  // Step A: go to trade (often more stable after login)
  const tradeUrl = tradeUrlFromLoginUrl(loginUrl);
  if (tradeUrl) {
    await page.goto(tradeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1200);
    await closeOverlays(page);
    await dumpStep(page, "after-home-trade", { tradeUrl, mobile });
  }

  // Step B: go to futures
  if (mobile) {
    // try clicking tab first
    await gotoMobileFutures(page);
  } else {
    await gotoPcFutures(page);
  }

  // Always also try direct futures URL (works on many)
  const fu = futuresUrlFromLoginUrl(loginUrl);
  if (fu) {
    await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1500);
    await closeOverlays(page);
  }

  await dumpStep(page, "after-futures-nav", { futuresUrl: fu, mobile });

  // Step C: click "Invited me"
  const invitedClicked = await clickInvitedMe(page);
  await dumpStep(page, "after-invited-me", { invitedClicked, mobile });

  // SAFETY: if we got kicked back to login, DO NOT type code anywhere
  const stillLogin = await loginFieldsVisible(page);
  const href = await page.evaluate(() => location.href).catch(() => "");
  if (stillLogin || (href || "").includes("/#/login")) {
    return { ok: false, reason: "kicked_to_login" };
  }

  // Step D: find order code box
  const codeRes = await findVisible(page, ORDER_CODE_SELECTORS, 15000);
  if (!codeRes.ok) {
    return { ok: false, reason: "code_box_missing" };
  }

  const codeBox = codeRes.locator;
  await codeBox.scrollIntoViewIfNeeded().catch(() => null);
  await codeBox.click({ timeout: 5000 }).catch(() => null);
  await codeBox.fill(orderCode).catch(() => null);
  await sleep(600);
  await dumpStep(page, "after-code-fill", { codeLength: String(orderCode).length });

  // Step E: click confirm
  const confirmCandidates = [
    page.getByRole("button", { name: /confirm/i }).first(),
    page.locator('button:has-text("Confirm")').first(),
    page.locator("text=/^confirm$/i").first(),
    page.getByRole("button", { name: /submit/i }).first(),
    page.getByRole("button", { name: /ok/i }).first()
  ];

  let confirmBtn = null;
  for (const c of confirmCandidates) {
    if (await c.isVisible().catch(() => false)) {
      confirmBtn = c;
      break;
    }
  }
  if (!confirmBtn) {
    await dumpStep(page, "confirm-missing", {});
    return { ok: false, reason: "confirm_missing" };
  }

  let lastVerify = null;
  for (let i = 1; i <= CONFIRM_RETRIES; i++) {
    await confirmBtn.scrollIntoViewIfNeeded().catch(() => null);
    await confirmBtn.click({ timeout: 10000 }).catch(() => null);
    await sleep(1200);
    await dumpStep(page, `after-confirm-${i}`, {});

    const verify = await verifyOrder(page);
    lastVerify = verify;
    if (verify.ok) {
      await dumpStep(page, "confirmed", { verify });
      return { ok: true, detail: verify.detail || "verified" };
    }

    await sleep(CONFIRM_RETRY_DELAY_MS);
  }

  return { ok: false, reason: "verification_failed", detail: lastVerify?.detail || "" };
}

async function runAccountOnUrl(account, orderCode, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const mobile = shouldUseMobileContext(loginUrl);

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
  setupApiRewrite(page);

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f?.errorText || "unknown";
    if (req.url().includes("/api/")) console.log("REQ FAILED:", req.url(), "=>", errText);
  });

  page.on("pageerror", (err) => {
    console.log("PAGE ERROR:", err?.message || String(err));
  });

  try {
    await dumpStep(page, "start-url", { loginUrl, mobile, apiRewrite: API_REWRITE_ENABLED });

    const okLogin = await login(page, account, loginUrl);
    if (!okLogin) {
      await captureFailure(page, `${sanitizeForFilename(account.username)}-login-failed`, "Login failed (stayed on login)", { loginUrl });
      throw new Error("Login failed (stayed on login)");
    }

    // Run main flow. If kicked-to-login, retry login+flow once.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await runFlow(page, loginUrl, orderCode);

      if (res.ok) return res.detail || "ok";

      if (res.reason === "kicked_to_login" && attempt === 1) {
        console.log("Kicked to login mid-flow. Retrying login once...");
        const relog = await login(page, account, loginUrl);
        if (!relog) break;
        continue;
      }

      await captureFailure(
        page,
        `${sanitizeForFilename(account.username)}-flow-failed`,
        `Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`,
        { loginUrl, res }
      );
      throw new Error(`Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`);
    }

    throw new Error("Flow failed after retry");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// Try ALL urls for this account (no skipping), in order.
async function runAccountAllUrls(account, orderCode, urls) {
  let lastErr = null;
  for (const loginUrl of urls) {
    console.log("Trying site:", loginUrl, "for", account.username);
    try {
      const note = await runAccountOnUrl(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl, "|", note);
      return { ok: true, site: loginUrl, note };
    } catch (e) {
      const msg = e?.message || String(e);
      console.log("Site failed:", loginUrl, "for", account.username, "err:", msg);
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr?.message || "All URLs failed" };
}

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const errs = [];
  if (!BOT_PASSWORD) errs.push("BOT_PASSWORD or RUN_PASSWORD is not set");
  if (!cfg.ok) errs.push(cfg.error || "ACCOUNTS_JSON invalid");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>
    <div>Last error: ${lastError ? escapeHtml(lastError) : "-"}</div>
    <div>Run ID: ${lastRunId ? escapeHtml(lastRunId) : "-"}</div>

    <hr/>

    <div>DEBUG_CAPTURE: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
    <div>FORCE_MOBILE: <b>${escapeHtml(FORCE_MOBILE_MODE)}</b></div>
    <div>API_REWRITE: <b>${API_REWRITE_ENABLED ? "ON" : "OFF"}</b> (${escapeHtml(API_REWRITE_MATCH)} → ${escapeHtml(API_REWRITE_TARGET)})</div>
    <div>PREFLIGHT_ENABLED: <b>${PREFLIGHT_ENABLED ? "ON" : "OFF"}</b></div>
    <div>LOGIN_URLS: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></div>

    <div>Email configured: <b>${emailConfigured() ? "YES" : "NO"}</b></div>

    <div style="color:red; margin-top:10px;">
      ${errs.length ? errs.map(escapeHtml).join("<br/>") : ""}
    </div>

    <form method="POST" action="/run" style="margin-top:12px;">
      <input name="p" placeholder="Password" type="password" required />
      <br/><br/>
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <div style="margin-top:12px;">
      <a href="/health">/health</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
      | <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/debug</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/dns-test</a>
      | <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/net-test</a>
      | <a href="/email-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/email-test</a>
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
    config: {
      botPasswordSet: !!BOT_PASSWORD,
      accountsOk: cfg.ok,
      accountsCount: cfg.ok ? cfg.accounts.length : 0,
      loginUrls: LOGIN_URLS,
      debugCapture: DEBUG_CAPTURE,
      forceMobile: FORCE_MOBILE_MODE,
      apiRewrite: { enabled: API_REWRITE_ENABLED, match: API_REWRITE_MATCH, target: API_REWRITE_TARGET },
      preflight: { enabled: PREFLIGHT_ENABLED, waitMs: PREFLIGHT_LOGIN_WAIT_MS }
    },
    debug: {
      lastRunId,
      lastDebugDir,
      lastShotPath,
      stableShotPath: "/app/last-shot.png"
    },
    email: {
      enabled: EMAIL_ENABLED,
      provider: EMAIL_PROVIDER,
      configured: emailConfigured(),
      from: parseFromEmail(EMAIL_FROM_RAW),
      fromName: EMAIL_FROM_NAME,
      to: EMAIL_TO
    }
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
    res.send(`<h3>Debug</h3><div>No debug directory yet. Run the bot once.</div>`);
    return;
  }

  const files = safeListDir(lastDebugDir);
  const links = files
    .map((f) => `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`)
    .join("");

  res.send(`
    <h3>Debug</h3>
    <div>Last run ID: <code>${escapeHtml(lastRunId || "-")}</code></div>
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

  const full = path.resolve(lastDebugDir, f);
  const base = path.resolve(lastDebugDir);
  if (!full.startsWith(base)) return res.status(400).send("Bad path.");
  if (!fs.existsSync(full)) return res.status(404).send("Not found.");

  if (full.endsWith(".html") || full.endsWith(".txt") || full.endsWith(".json")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  } else if (full.endsWith(".png")) {
    res.setHeader("Content-Type", "image/png");
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
  }

  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const hosts = ["api.sendgrid.com", ...new Set(LOGIN_URLS.map((u) => new URL(u).hostname))];
  const out = {};
  for (const h of hosts) {
    try {
      const addrs = await dns.lookup(h, { all: true });
      out[h] = { ok: true, addrs };
    } catch (e) {
      out[h] = { ok: false, error: e?.message || String(e) };
    }
  }
  res.json(out);
});

app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const urls = [...new Set(LOGIN_URLS.map((u) => baseFromUrl(u)).filter(Boolean))].slice(0, 8);
  const results = {};
  for (const u of urls) {
    try {
      const r = await simpleGet(u, 15000);
      results[u] = { ok: true, status: r.status, bodyPreview: (r.body || "").slice(0, 200) };
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
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON invalid.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");
  lastDebugDir = `/tmp/debug-${lastRunId}`;
  ensureDir(lastDebugDir);
  writePlaceholderLastShot();

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("Run started. Check logs, /health, and /debug.");

  (async () => {
    const startedAt = nowLocal();
    const subjectPrefix = `T-Bot | Run ${lastRunId}`;
    let failAlertsSent = 0;

    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Started:", startedAt);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Order code length:", code.length);
      console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
      console.log("FORCE_MOBILE:", FORCE_MOBILE_MODE);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("API_REWRITE:", API_REWRITE_ENABLED, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
      console.log("Email configured:", emailConfigured(), "provider:", EMAIL_PROVIDER);

      const pf = await preflightSites();
      if (!pf.ok) throw new Error(`Preflight failed: ${pf.note}`);
      const runSites = pf.sites;
      console.log("Chosen sites for this run:", runSites.join(", "));

      await sendEmail(
        `${subjectPrefix} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nURLs tested per account: ${runSites.length}\nAPI_REWRITE: ${API_REWRITE_ENABLED}\n`
      );

      const results = [];

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);

        const r = await runAccountAllUrls(account, code, runSites);
        results.push({ username: account.username, ...r });

        if (!r.ok) {
          lastError = `Account failed ${account.username}: ${r.error}`;
          if (EMAIL_ACCOUNT_FAIL_ALERTS && failAlertsSent < EMAIL_MAX_FAIL_ALERTS) {
            failAlertsSent += 1;
            await sendEmail(
              `${subjectPrefix} account FAILED: ${account.username}`,
              `Account failed: ${account.username}\nRun ID: ${lastRunId}\nTime: ${nowLocal()}\n\nError:\n${r.error}\n\nDebug: /debug?p=YOUR_PASSWORD\n`
            );
          }
        }
      }

      const finishedAt = nowLocal();
      const okCount = results.filter((x) => x.ok).length;
      const failCount = results.length - okCount;

      const summaryLines = results.map((r) =>
        r.ok ? `SUCCESS: ${r.username} (${r.site}) - ${r.note || ""}` : `FAIL: ${r.username} (${r.error})`
      );

      await sendEmail(
        `${subjectPrefix} finished (${okCount} ok, ${failCount} failed)`,
        `Finished at ${finishedAt}\nRun ID: ${lastRunId}\n\n${summaryLines.join("\n")}\n\nDebug: /debug?p=YOUR_PASSWORD\n`
      );

      console.log("Bot completed");
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      await sendEmail(`${subjectPrefix} FAILED`, `Run failed at ${nowLocal()}\nRun ID: ${lastRunId}\n\n${msg}\n`);
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Startup
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("FORCE_MOBILE:", FORCE_MOBILE_MODE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("API_REWRITE:", API_REWRITE_ENABLED, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Email from/to:", parseFromEmail(EMAIL_FROM_RAW), EMAIL_TO);
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);
  writePlaceholderLastShot();
});
