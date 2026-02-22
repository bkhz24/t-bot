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

// Support both BOT_PASSWORD and RUN_PASSWORD
const BOT_PASSWORD = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString();

// Accounts are supplied as JSON array: [{ "username": "...", "password": "..." }, ...]
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();

// Optional: LOGIN_URLS override (comma-separated)
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

// Optional: force mobile emulation even for /pc URLs
const FORCE_MOBILE = envTruthy(process.env.FORCE_MOBILE || "0");

// Optional debug capture (extra artifacts at many steps). Failure capture is ALWAYS on.
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

// --------------------
// Helpers
// --------------------
const DEFAULT_TZ = (process.env.TZ || "America/Denver").toString();

function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function nowLocal() {
  try {
    return new Date().toLocaleString("en-US", { timeZone: DEFAULT_TZ, timeZoneName: "short" });
  } catch {
    return new Date().toISOString();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  if (!ACCOUNTS_JSON) {
    return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  }
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) {
      return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    }
    const cleaned = parsed.map((a) => ({
      username: String(a?.username || "").trim(),
      password: String(a?.password || "")
    }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) {
      return { ok: false, accounts: [], error: "Each account must include username + password" };
    }
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e?.message || String(e)}` };
  }
}

// --------------------
// Login URLs
// --------------------
function parseLoginUrls() {
  // IMPORTANT: default to H5 login now (since your manual flow is H5)
  const fallback = [
    "https://dsj12.cc/h5/#/login",
    "https://dsj877.cc/h5/#/login"
  ];

  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;

  const list = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return list.length ? list : fallback;
}

let LOGIN_URLS = parseLoginUrls();

function getBaseAndPrefixFromUrl(anyUrl) {
  try {
    const u = new URL(anyUrl);
    const base = `${u.protocol}//${u.host}`;

    // Prefer what we see in the current URL (h5 vs pc)
    if (anyUrl.includes("/h5/#/")) return { base, prefix: "/h5/#/" };
    if (anyUrl.includes("/pc/#/")) return { base, prefix: "/pc/#/" };

    // Fall back to path hints
    if (anyUrl.includes("/h5/")) return { base, prefix: "/h5/#/" };
    if (anyUrl.includes("/pc/")) return { base, prefix: "/pc/#/" };

    // Default to H5 if unknown (safer for your flow)
    return { base, prefix: "/h5/#/" };
  } catch {
    return null;
  }
}

// ✅ THIS is the critical fix: H5 uses /trade, PC uses /contractTransaction
function futuresUrlFromAnyUrl(anyUrl) {
  const bp = getBaseAndPrefixFromUrl(anyUrl);
  if (!bp) return null;

  if (bp.prefix.startsWith("/h5/")) return `${bp.base}${bp.prefix}trade`;
  return `${bp.base}${bp.prefix}contractTransaction`;
}

// --------------------
// Minimal HTTP fetch (no extra deps)
// --------------------
function simpleGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
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
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode || 0, body });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

// --------------------
// Email config (SendGrid Web API) - optional
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").toString();
const EMAIL_FROM = (process.env.EMAIL_FROM || "").toString().trim();
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO = (process.env.EMAIL_TO || "").toString().trim();
const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  return !!(SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO);
}

async function sendEmail(subject, text) {
  if (!emailConfigured()) {
    console.log("Email not configured, skipping send:", subject);
    return { ok: false, skipped: true, error: "Email not configured" };
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
    console.log("Email sent:", { status, msgId, to: msg.to, subject });
    return { ok: true, skipped: false, status, msgId, to: msg.to };
  } catch (e) {
    const body = e?.response?.body ?? null;
    const errText = body ? JSON.stringify(body) : e?.message ? e.message : String(e);
    console.log("Email failed (SendGrid API):", errText, "|", subject);
    return { ok: false, skipped: false, error: errText };
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

function writePlaceholderLastShot() {
  try {
    const placeholder = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl1mQAAAAASUVORK5CYII=",
      "base64"
    );
    ensureDir("/app");
    fs.writeFileSync("/app/last-shot.png", placeholder);
  } catch {}
}

async function tryCopyToStableLastShot(srcPath) {
  try {
    ensureDir("/app");
    fs.copyFileSync(srcPath, "/app/last-shot.png");
  } catch {}
}

async function saveScreenshot(page, fullPath) {
  try {
    await page.screenshot({ path: fullPath, fullPage: true });
    lastShotPath = fullPath;
    await tryCopyToStableLastShot(fullPath);
    return true;
  } catch (e) {
    console.log("Screenshot failed:", e?.message || String(e));
    return false;
  }
}

/**
 * FAILURE CAPTURE (always on):
 * - save screenshot
 * - save full HTML
 * - log location.href (page.url())
 * - log file paths
 */
async function captureFailureArtifacts(page, tag, extra = {}) {
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag || "failure");
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  let url = "";
  try {
    url = page?.url?.() || "";
  } catch {}
  if (!url) {
    try {
      url = await page.evaluate(() => location.href).catch(() => "");
    } catch {}
  }

  const shotPath = path.join(dir, `${safeTag}-${stamp}.png`);
  const htmlPath = path.join(dir, `${safeTag}-${stamp}.html`);
  const urlPath = path.join(dir, `${safeTag}-${stamp}.url.txt`);
  const extraPath = path.join(dir, `${safeTag}-${stamp}.extra.json`);

  let savedShot = false;
  let savedHtml = false;

  try {
    if (page) savedShot = await saveScreenshot(page, shotPath);
  } catch {}

  try {
    if (page) {
      const html = await page.content().catch(() => "");
      fs.writeFileSync(htmlPath, html || "");
      savedHtml = true;
    }
  } catch (e) {
    console.log("HTML dump failed:", e?.message || String(e));
  }

  try {
    fs.writeFileSync(urlPath, String(url || ""));
  } catch {}
  try {
    fs.writeFileSync(extraPath, JSON.stringify({ ...extra, url }, null, 2));
  } catch {}

  console.log("FAILURE URL:", url || "(unknown)");
  console.log("FAILURE screenshot saved:", savedShot ? shotPath : "(screenshot failed)");
  console.log("FAILURE html saved:", savedHtml ? htmlPath : "(html failed)");
  console.log("FAILURE debug dir:", dir);

  return { url, shotPath: savedShot ? shotPath : null, htmlPath: savedHtml ? htmlPath : null, dir };
}

/**
 * Optional step capture (when DEBUG_CAPTURE=1)
 */
async function dumpDebugStep(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return null;
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag || "step");
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  const base = path.join(dir, `${safeTag}-${stamp}`);
  try {
    fs.writeFileSync(`${base}.url.txt`, String(page.url() || ""));
  } catch {}
  try {
    const title = await page.title().catch(() => "");
    fs.writeFileSync(`${base}.title.txt`, title || "");
  } catch {}
  try {
    const html = await page.content().catch(() => "");
    fs.writeFileSync(`${base}.html`, html || "");
  } catch {}
  try {
    fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2));
  } catch {}
  try {
    await saveScreenshot(page, `${base}.png`);
  } catch {}
  return base;
}

// --------------------
// Resilient selectors
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
  'input[placeholder*="order" i]',
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

async function isVisibleInAnyFrame(page, selector) {
  for (const f of page.frames()) {
    try {
      const loc = f.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
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

async function debugDumpButtons(page, tag) {
  const texts = [];
  try {
    const frames = page.frames();
    for (const f of frames) {
      const btns = await f.locator("button").all().catch(() => []);
      for (const b of btns.slice(0, 40)) {
        const t = ((await b.textContent().catch(() => "")) || "").trim();
        if (t) texts.push(t.slice(0, 80));
      }
    }
  } catch {}
  await dumpDebugStep(page, tag, { buttonTextPreview: texts.slice(0, 80) });
}

// --------------------
// Required logging: after clicking Login
// --------------------
async function logAfterLoginClick(page) {
  const url = (() => {
    try {
      return page.url();
    } catch {
      return "";
    }
  })();

  const userVisible = await isVisibleInAnyFrame(page, USER_SELECTORS);
  const passVisible = await isVisibleInAnyFrame(page, PASS_SELECTORS);
  const loginFormVisible = userVisible && passVisible;

  console.log(
    "AFTER LOGIN CLICK | url:",
    url,
    "| loginFormVisible:",
    loginFormVisible,
    "| userVisible:",
    userVisible,
    "| passVisible:",
    passVisible
  );

  return { url, loginFormVisible, userVisible, passVisible };
}

async function waitForLoginToSettle(page, timeoutMs = 25000) {
  const start = Date.now();
  let last = null;

  while (Date.now() - start < timeoutMs) {
    await closeOverlays(page);

    const url = page.url();
    const userVisible = await isVisibleInAnyFrame(page, USER_SELECTORS);
    const passVisible = await isVisibleInAnyFrame(page, PASS_SELECTORS);
    const loginFormVisible = userVisible && passVisible;

    if (!loginFormVisible) {
      return { ok: true, url, userVisible, passVisible, reason: "login_fields_hidden" };
    }

    if (!/\/login\b|#\/login\b/i.test(url) && !(userVisible || passVisible)) {
      return { ok: true, url, userVisible, passVisible, reason: "url_changed_and_fields_gone" };
    }

    last = { url, userVisible, passVisible, loginFormVisible };
    await sleep(350);
  }

  return { ok: false, reason: "timeout", ...(last || {}), url: page.url() };
}

// --------------------
// Mobile Futures navigation helpers
// --------------------
const FUTURES_TEXT_PATTERNS = [
  /futures/i,
  /contract/i,
  /contracts/i,
  /trade/i,
  /合约/i,
  /期货/i
];

async function tryClickByRoleOrText(page, regex, preferBottom = false) {
  const roleCandidates = [
    page.getByRole("tab", { name: regex }).first(),
    page.getByRole("link", { name: regex }).first(),
    page.getByRole("button", { name: regex }).first()
  ];

  for (const loc of roleCandidates) {
    try {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 8000 }).catch(() => null);
        return { ok: true, method: "role", label: regex.toString() };
      }
    } catch {}
  }

  try {
    const t = page.getByText(regex).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 8000 }).catch(() => null);
      return { ok: true, method: "text", label: regex.toString() };
    }
  } catch {}

  try {
    const result = await page.evaluate(
      ({ source, flags, preferBottom }) => {
        const re = new RegExp(source, flags);

        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          if (r.bottom < 0 || r.right < 0) return false;
          if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
          return true;
        }

        function isClickable(el) {
          const tag = (el.tagName || "").toLowerCase();
          const role = (el.getAttribute("role") || "").toLowerCase();
          const hasOnclick = typeof el.onclick === "function" || el.hasAttribute("onclick");
          const cursor = window.getComputedStyle(el).cursor;
          return tag === "a" || tag === "button" || role === "tab" || role === "button" || hasOnclick || cursor === "pointer";
        }

        const els = Array.from(document.querySelectorAll("a,button,[role='tab'],[role='button'],[onclick],div,span,li"));
        const matches = [];

        for (const el of els) {
          if (!isVisible(el)) continue;

          const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
          if (!text) continue;
          if (!re.test(text)) continue;

          const r = el.getBoundingClientRect();
          const yCenter = r.top + r.height / 2;
          const bottomScore = preferBottom ? yCenter / window.innerHeight : 0;
          const clickScore = isClickable(el) ? 1 : 0;

          matches.push({
            el,
            text: text.slice(0, 60),
            yCenter,
            clickScore,
            bottomScore,
            score: clickScore * 10 + bottomScore * 5
          });
        }

        matches.sort((a, b) => b.score - a.score);

        const best = matches[0];
        if (!best) return { ok: false };

        best.el.click();
        return { ok: true, text: best.text || "" };
      },
      { source: regex.source, flags: regex.flags, preferBottom }
    );

    if (result?.ok) {
      return { ok: true, method: "dom_scan", label: result.text || regex.toString() };
    }
  } catch {}

  return { ok: false };
}

async function clickFuturesNavIfPresent(page) {
  for (const re of FUTURES_TEXT_PATTERNS) {
    const res = await tryClickByRoleOrText(page, re, true);
    if (res.ok) return res;
  }
  return { ok: false };
}

async function hasFuturesPageSignals(page) {
  const url = page.url();

  // PC route
  if (/contractTransaction/i.test(url)) return true;

  // ✅ H5 route
  if (/\/h5\/#\/trade/i.test(url)) return true;
  if (/#\/trade\b/i.test(url)) return true;

  const invitedVisible = await page
    .getByText(/invited\s*me/i)
    .first()
    .isVisible()
    .catch(() => false);

  const positionVisible = await page
    .getByText(/position\s*order/i)
    .first()
    .isVisible()
    .catch(() => false);

  if (invitedVisible || positionVisible) return true;

  const codeVisible = await isVisibleInAnyFrame(page, ORDER_CODE_SELECTORS);
  return codeVisible;
}

async function ensureOnFuturesPage(page, loginUrl) {
  const target = futuresUrlFromAnyUrl(page.url() || loginUrl);

  async function waitForSignals() {
    await closeOverlays(page);
    for (let i = 0; i < 6; i++) {
      if (await hasFuturesPageSignals(page)) return true;
      await sleep(500);
    }
    return false;
  }

  // Mobile-first: try Futures/Trade tab click first
  const clicked1 = await clickFuturesNavIfPresent(page);
  if (clicked1.ok) {
    await sleep(1200);
    if (await waitForSignals()) {
      return { ok: true, method: `nav:${clicked1.method}`, futuresUrl: target || null, detail: clicked1.label };
    }
  }

  // Direct navigation
  if (target) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1200);
    if (await waitForSignals()) {
      return { ok: true, method: "direct", futuresUrl: target };
    }
  }

  // Retry tab click
  const clicked2 = await clickFuturesNavIfPresent(page);
  if (clicked2.ok) {
    await sleep(1200);
    if (await waitForSignals()) {
      return { ok: true, method: `nav_retry:${clicked2.method}`, futuresUrl: target || null, detail: clicked2.label };
    }
  }

  // Last direct retry
  if (target) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await sleep(1200);
    if (await waitForSignals()) {
      return { ok: true, method: "direct_after_nav", futuresUrl: target };
    }
  }

  return {
    ok: false,
    futuresUrl: target || null,
    detail: clicked2.ok ? clicked2.label : clicked1.ok ? clicked1.label : "no futures nav match"
  };
}

// --------------------
// Confirmation gates
// --------------------
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "5");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "2500");

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
        const txt = (await loc.textContent().catch(() => "")) || "";
        return { ok: true, type: "toast", detail: txt.trim().slice(0, 180) || re.toString() };
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
    await sleep(900);
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

  return {
    ok: false,
    detail: `No confirmation. Toast: ${toastRes.type}. Pending: ${pendingRes.type}.`
  };
}

// --------------------
// Preflight (pick working sites)
// --------------------
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "2000");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || "2");

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

        const isMobile = shouldUseMobileContext(loginUrl);

        const context = await browser.newContext({
          viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
          locale: "en-US",
          isMobile,
          hasTouch: isMobile
        });

        const page = await context.newPage();
        page.setDefaultTimeout(30000);

        try {
          const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(700);

          const status = resp ? resp.status() : null;

          if (status && status >= 400) {
            await dumpDebugStep(page, "preflight-http-fail", { loginUrl, status });
            throw new Error(`Preflight failed: HTTP ${status}`);
          }

          const html = await page.content().catch(() => "");
          if (isCloudflareErrorHtml(html)) {
            await dumpDebugStep(page, "preflight-cloudflare", { loginUrl, status });
            throw new Error("Preflight failed: Cloudflare error page");
          }

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) {
            await dumpDebugStep(page, "preflight-no-user", { loginUrl, status });
            throw new Error(`Preflight failed: user field not found within ${PREFLIGHT_LOGIN_WAIT_MS}ms`);
          }

          await dumpDebugStep(page, "preflight-ok", { loginUrl, status });
          console.log("Preflight OK:", loginUrl);

          passed = true;
          await context.close().catch(() => null);
          break;
        } catch (e) {
          const msg = e?.message || String(e);
          console.log("Preflight attempt", i, "failed for", loginUrl, "err:", msg);
          await dumpDebugStep(page, `preflight-failed-${i}`, { loginUrl, err: msg });
          await context.close().catch(() => null);
          await sleep(PREFLIGHT_RETRY_DELAY_MS);
        }
      }

      if (passed) {
        good.push(loginUrl);
        if (good.length >= PREFLIGHT_MAX_SITES) break;
      } else {
        console.log("Preflight: skipping", loginUrl, "after failures");
      }
    }

    if (!good.length) {
      return { ok: false, sites: [], note: "No sites passed preflight" };
    }

    return { ok: true, sites: good, note: `Chosen sites: ${good.join(", ")}` };
  } finally {
    await browser.close().catch(() => null);
  }
}

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

function startupConfigErrors() {
  const errs = [];
  if (!BOT_PASSWORD) errs.push("BOT_PASSWORD or RUN_PASSWORD is not set.");
  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) errs.push(cfg.error || "ACCOUNTS_JSON is missing/invalid.");
  return errs;
}

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const errs = startupConfigErrors();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>
    <div>Last error: ${lastError ? escapeHtml(lastError) : "-"}</div>
    <div>Debug capture: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b> (Failure capture is ALWAYS on)</div>
    <div>LOGIN_URLS: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></div>
    <div>Force mobile: <b>${FORCE_MOBILE ? "ON" : "OFF"}</b></div>
    <div>Accounts loaded: <b>${cfg.ok ? cfg.accounts.length : 0}</b></div>
    <div>Email configured: <b>${emailConfigured() ? "YES" : "NO"}</b> (provider: ${escapeHtml(EMAIL_PROVIDER)})</div>
    <div>Preflight enabled: <b>${PREFLIGHT_ENABLED ? "ON" : "OFF"}</b> (max sites: ${PREFLIGHT_MAX_SITES})</div>
    <div style="color:red; margin-top:10px;">
      ${errs.length ? errs.map((e) => escapeHtml(e)).join("<br/>") : ""}
    </div>

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
    config: {
      botPasswordSet: !!BOT_PASSWORD,
      accountsOk: cfg.ok,
      accountsCount: cfg.ok ? cfg.accounts.length : 0,
      accountsError: cfg.error || null,
      loginUrls: LOGIN_URLS,
      debugCapture: DEBUG_CAPTURE,
      forceMobile: FORCE_MOBILE
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
      from: EMAIL_FROM,
      to: EMAIL_TO
    },
    verify: {
      toast: VERIFY_TOAST,
      pending: VERIFY_PENDING,
      timeoutMs: VERIFY_TIMEOUT_MS,
      confirmRetries: CONFIRM_RETRIES,
      confirmRetryDelayMs: CONFIRM_RETRY_DELAY_MS
    },
    preflight: {
      enabled: PREFLIGHT_ENABLED,
      loginWaitMs: PREFLIGHT_LOGIN_WAIT_MS,
      retries: PREFLIGHT_RETRIES,
      retryDelayMs: PREFLIGHT_RETRY_DELAY_MS,
      maxSites: PREFLIGHT_MAX_SITES
    }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const result = await sendEmail(
    "T-Bot | email test",
    `Email test sent at ${nowLocal()}\n\nFrom: ${EMAIL_FROM}\nTo: ${EMAIL_TO}\n`
  );

  res.json({
    ok: true,
    attempted: true,
    config: {
      enabled: EMAIL_ENABLED,
      provider: EMAIL_PROVIDER,
      configured: emailConfigured(),
      from: EMAIL_FROM,
      to: EMAIL_TO
    },
    result
  });
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
    .map((f) => {
      const safeF = encodeURIComponent(f);
      return `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${safeF}">${escapeHtml(f)}</a></li>`;
    })
    .join("");

  res.send(`
    <h3>Debug</h3>
    <div>Failure capture: <b>ALWAYS ON</b></div>
    <div>Debug capture: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
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
  if (!f) return res.status(400).send("Missing f=");
  if (f.includes("..") || f.includes("/") || f.includes("\\")) return res.status(400).send("Bad filename.");

  const full = path.resolve(lastDebugDir, f);
  const base = path.resolve(lastDebugDir);
  if (!full.startsWith(base)) return res.status(400).send("Bad path.");

  if (!fs.existsSync(full)) return res.status(404).send("Not found.");

  if (full.endsWith(".html") || full.endsWith(".txt") || full.endsWith(".json")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  } else if (full.endsWith(".png")) {
    res.setHeader("Content-Type", "image/png");
  } else if (full.endsWith(".har")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
  }

  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  // ✅ Added dsj877 + api hosts so we can see Railway DNS problems clearly
  const hosts = [
    "dsj12.cc",
    "dsj877.cc",
    "api.dsj12.cc",
    "api.dsj877.cc",
    "api.dsj006.cc",
    "api.ddjea.com",
    "api.sendgrid.com"
  ];

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

  const urls = [
    "https://dsj12.cc/",
    "https://dsj877.cc/",
    "https://api.dsj12.cc/api/app/ping",
    "https://api.dsj877.cc/api/app/ping",
    "https://api.dsj006.cc/api/app/ping",
    "https://api.ddjea.com/api/app/ping",
    "https://api.sendgrid.com/"
  ];

  const results = {};
  for (const u of urls) {
    try {
      const r = await simpleGet(u, 15000);
      results[u] = { ok: true, status: r.status, bodyPreview: (r.body || "").slice(0, 240) };
    } catch (e) {
      results[u] = { ok: false, error: e?.message || String(e) };
    }
  }

  res.json(results);
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

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
      console.log("FORCE_MOBILE:", FORCE_MOBILE);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("Email provider:", EMAIL_PROVIDER);
      console.log("Email configured:", emailConfigured());
      console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);

      const pf = await preflightSites();
      if (!pf.ok) {
        throw new Error(`Preflight failed. ${pf.note}`);
      }
      const runSites = pf.sites;
      console.log("Chosen sites for this run:", runSites.join(", "));

      await sendEmail(
        `${subjectPrefix} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nDebug capture: ${
          DEBUG_CAPTURE ? "ON" : "OFF"
        }\nFailure capture: ALWAYS ON\nPreflight: ${pf.note}\n\nYou will get a completion email with per-account results.\n`
      );

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
            await sendEmail(
              `${subjectPrefix} account FAILED: ${account.username}`,
              `Account failed: ${account.username}\nRun ID: ${lastRunId}\nTime: ${nowLocal()}\n\nError:\n${msg}\n\nDebug: /debug (needs password)\n`
            );
          }
        }
      }

      const finishedAt = nowLocal();
      const anyFailed = results.some((r) => !r.ok);

      const summaryLines = results.map((r) => {
        if (r.ok) return `SUCCESS: ${r.username} (${r.site})${r.note ? ` - ${r.note}` : ""}`;
        return `FAIL: ${r.username} (${r.error})`;
      });

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      await sendEmail(
        `${subjectPrefix} ${anyFailed ? "finished with failures" : "completed"}`,
        `T-Bot finished at ${finishedAt}\nRun ID: ${lastRunId}\n\nSummary: ${okCount} success, ${failCount} failed\n\nPer-account status:\n${summaryLines.join(
          "\n"
        )}\n\nDebug: /debug (needs password)\n`
      );

      console.log("Bot completed");
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;

      const failedAt = nowLocal();
      await sendEmail(`${subjectPrefix} FAILED`, `T-Bot failed at ${failedAt}\nRun ID: ${lastRunId}\nError: ${msg}\n`);

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

function shouldUseMobileContext(loginUrl) {
  if (FORCE_MOBILE) return true;
  const u = (loginUrl || "").toLowerCase();
  return u.includes("/h5/#/") || u.includes("/h5/") || u.includes("#/h5") || u.includes("h5/#");
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const mobile = shouldUseMobileContext(loginUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const harPath =
    DEBUG_CAPTURE && lastDebugDir
      ? path.join(lastDebugDir, `har-${sanitizeForFilename(account.username)}-${Date.now()}.har`)
      : null;

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    recordHar: harPath ? { path: harPath, content: "embed" } : undefined,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f?.errorText || "unknown";
    if (req.url().includes("/api/")) console.log("REQUEST FAILED:", req.url(), "=>", errText);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("PAGE CONSOLE: error", msg.text());
  });

  page.on("pageerror", (err) => {
    console.log("PAGE ERROR:", err?.message || String(err));
  });

  async function fail(tag, message, extra = {}) {
    await captureFailureArtifacts(page, `${sanitizeForFilename(account.username)}-${tag}`, {
      loginUrl,
      username: account.username,
      message,
      ...extra
    });
    const err = new Error(message);
    err.__captured = true;
    throw err;
  }

  try {
    // 1) Go to login
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);

    const status = resp ? resp.status() : null;

    const html0 = await page.content().catch(() => "");
    if (isCloudflareErrorHtml(html0)) {
      await dumpDebugStep(page, "cloudflare-login", { loginUrl, username: account.username, status });
      await fail("cloudflare", "Cloudflare error page on login", { status });
    }

    await dumpDebugStep(page, "after-goto-login", { loginUrl, username: account.username, status, mobile });

    // 2) Find login fields
    const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
    const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 25000);
    if (!userRes.ok || !passRes.ok) {
      await dumpDebugStep(page, "login-fields-missing", { userFound: userRes.ok, passFound: passRes.ok });
      await fail("login-fields-missing", "Login fields not found", { userFound: userRes.ok, passFound: passRes.ok });
    }

    // 3) Fill + click login (retry a few times)
    let loggedIn = false;
    let lastAfterClick = null;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(1200);
      await closeOverlays(page);

      const userRes2 = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
      const passRes2 = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
      if (!userRes2.ok || !passRes2.ok) {
        await dumpDebugStep(page, `login-attempt-${attempt}-fields-missing`, { attempt });
        continue;
      }

      const userField = userRes2.locator;
      const passField = passRes2.locator;

      await userField.fill("").catch(() => null);
      await passField.fill("").catch(() => null);

      await userField.click({ timeout: 5000 }).catch(() => null);
      await userField.fill(account.username).catch(() => null);
      await sleep(150);

      await passField.click({ timeout: 5000 }).catch(() => null);
      await passField.fill(account.password).catch(() => null);
      await sleep(150);

      const loginBtn = page.getByRole("button", { name: /login|sign in/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 }).catch(() => null);
      } else {
        await passField.press("Enter").catch(() => null);
      }

      await sleep(450);
      lastAfterClick = await logAfterLoginClick(page);

      const settled = await waitForLoginToSettle(page, 25000);
      await dumpDebugStep(page, `after-login-attempt-${attempt}`, { attempt, lastAfterClick, settled });

      if (!settled.ok) continue;

      if ((await isVisibleInAnyFrame(page, USER_SELECTORS)) && (await isVisibleInAnyFrame(page, PASS_SELECTORS))) {
        continue;
      }

      loggedIn = true;
      console.log("Login likely succeeded for", account.username, "on", loginUrl, "| reason:", settled.reason);
      break;
    }

    if (!loggedIn) {
      await fail("login-failed", "Login failed (login form never disappeared)", { lastAfterClick });
    }

    // 4) Ensure we are on Futures/Trade page
    const fut = await ensureOnFuturesPage(page, loginUrl);
    await dumpDebugStep(page, "after-ensure-futures", { fut });

    if (!fut.ok) {
      await fail("futures-nav-failed", "Could not reach Futures/Trade page (nav + direct attempts failed)", { fut });
    }

    // 5) Navigate/open the order code flow
    const flowOk = await openOrderCodeFlow(page);
    await dumpDebugStep(page, "after-open-order-flow", { flowOk });

    if (!flowOk) {
      await fail("order-flow-missing", "Could not reach order code input");
    }

    // 6) Find and fill order code input
    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 15000);
    if (!codeRes.ok) {
      await fail("code-box-missing", "Order code input not found");
    }

    const codeBox = codeRes.locator;
    await codeBox.scrollIntoViewIfNeeded().catch(() => null);
    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode).catch(() => null);
    await sleep(600);
    await dumpDebugStep(page, "after-code-fill", { codeLength: String(orderCode || "").length });

    // 7) Find confirm/submit button
    const confirmCandidates = [
      page.getByRole("button", { name: /confirm/i }).first(),
      page.getByRole("button", { name: /submit/i }).first(),
      page.getByRole("button", { name: /follow/i }).first(),
      page.getByRole("button", { name: /ok/i }).first()
    ];

    let confirmBtn = null;
    for (const b of confirmCandidates) {
      if (await b.isVisible().catch(() => false)) {
        confirmBtn = b;
        break;
      }
    }

    if (!confirmBtn) {
      await debugDumpButtons(page, "confirm-missing");
      await fail("confirm-missing", "Confirm button not found");
    }

    // 8) Click confirm + verification
    let lastVerify = null;
    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      console.log("Confirm attempt", i, "for", account.username);

      await confirmBtn.scrollIntoViewIfNeeded().catch(() => null);
      await confirmBtn.click({ timeout: 10000 }).catch(() => null);
      await sleep(1200);
      await dumpDebugStep(page, `after-confirm-attempt-${i}`, {});

      const verify = await verifyOrderFollowed(page);
      lastVerify = verify;

      if (verify.ok) {
        await dumpDebugStep(page, "confirm-verified", { verify });
        return verify.detail || "verified";
      }

      console.log("Verification not satisfied:", verify.detail);
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }

    await fail("confirm-verification-failed", lastVerify?.detail || "Confirm verification failed", { lastVerify });
  } catch (e) {
    const msg = e?.message || String(e);
    const alreadyCaptured = !!(e && typeof e === "object" && e.__captured);

    if (!alreadyCaptured) {
      await captureFailureArtifacts(page, `${sanitizeForFilename(account.username)}-unhandled`, {
        loginUrl,
        username: account.username,
        error: msg
      });
    }

    const err = e instanceof Error ? e : new Error(msg);
    err.__captured = true;
    throw err;
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function openOrderCodeFlow(page) {
  const attempts = [
    { name: "invited_me", regex: /invited\s*me/i },
    { name: "invite", regex: /invite|invitation/i },
    { name: "position_order", regex: /position\s*order/i },
    { name: "trade", regex: /trade/i },
    { name: "futures", regex: /futures|contract|合约|期货/i }
  ];

  for (const a of attempts) {
    try {
      const loc = page.getByText(a.regex).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 8000 }).catch(() => null);
        await sleep(900);
        await closeOverlays(page);

        const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 2500);
        if (codeRes.ok) return true;
      }
    } catch {}
  }

  const codeRes2 = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 2500);
  return codeRes2.ok;
}

// --------------------
// Startup logging + listen
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  const errs = startupConfigErrors();
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("Failure capture: ALWAYS ON");
  console.log("FORCE_MOBILE:", FORCE_MOBILE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);
  if (errs.length) console.log("CONFIG ERRORS:", errs);
  writePlaceholderLastShot();
});
