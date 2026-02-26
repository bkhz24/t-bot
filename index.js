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
// ENV / CONFIG
// --------------------
const BOT_PASSWORD = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString().trim();
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

const DEFAULT_TZ = (process.env.TZ || "America/Denver").toString();

// Mobile mode:
// - FORCE_MOBILE=auto (default): mobile viewport only for /h5 URLs
// - FORCE_MOBILE=1/true: force mobile viewport even for /pc URLs
// - FORCE_MOBILE=0/false: never mobile viewport
const FORCE_MOBILE_RAW = (process.env.FORCE_MOBILE || "auto").toString().trim().toLowerCase();

// Debug artifacts
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

// Email (SendGrid Web API)
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").toString();
const EMAIL_FROM = (process.env.EMAIL_FROM || "").toString().trim();
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO = (process.env.EMAIL_TO || "").toString().trim();
const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

// Verification
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "8");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "2500");

// Preflight
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "2000");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || "2");

// API rewrite (IMPORTANT with your DNS results)
// Default ON because api.* often fails to resolve in Railway
const API_REWRITE_ENABLED = envTruthy(process.env.API_REWRITE || "1");
const API_REWRITE_MATCH = (process.env.API_REWRITE_MATCH || "^api\\.").toString();
const API_REWRITE_TARGET = (process.env.API_REWRITE_TARGET || "api.ddjea.com").toString();

// Safety: if we detect we got kicked back to login, DO NOT type orderCode anywhere.
const STOP_IF_LOGIN_SEEN_AGAIN = envTruthy(process.env.STOP_IF_LOGIN_SEEN_AGAIN || "1");

// --------------------
// Helpers
// --------------------
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
    .slice(0, 90);
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
// Email
// --------------------
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
    return { ok: true, status, msgId, to: msg.to };
  } catch (e) {
    const body = e?.response?.body ?? null;
    const errText = body ? JSON.stringify(body) : e?.message || String(e);
    console.log("Email failed:", errText, "|", subject);
    return { ok: false, error: errText };
  }
}

// --------------------
// Login URLs
// --------------------
function parseLoginUrls() {
  const fallback = [
    "https://dsj12.cc/pc/#/login",
    "https://dsj12.cc/h5/#/login"
  ];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

let LOGIN_URLS = parseLoginUrls();

function isH5Url(u) {
  return /\/h5\/#\//i.test(String(u || ""));
}

function shouldUseMobileContext(loginUrl) {
  if (FORCE_MOBILE_RAW === "auto") return isH5Url(loginUrl);
  if (envTruthy(FORCE_MOBILE_RAW)) return true;
  return false;
}

function baseAndPrefix(anyUrl) {
  try {
    const u = new URL(anyUrl);
    const base = `${u.protocol}//${u.host}`;
    const prefix = isH5Url(anyUrl) ? "/h5/#/" : "/pc/#/";
    return { base, prefix };
  } catch {
    return null;
  }
}

function contractUrlFromLoginUrl(loginUrl) {
  const bp = baseAndPrefix(loginUrl);
  if (!bp) return null;
  return `${bp.base}${bp.prefix}contractTransaction`;
}

function tradeUrlFromLoginUrl(loginUrl) {
  const bp = baseAndPrefix(loginUrl);
  if (!bp) return null;
  return `${bp.base}${bp.prefix}trade`;
}

// --------------------
// Minimal GET (for /net-test)
/// --------------------
function simpleGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("Bad URL"));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: { "User-Agent": "T-Bot/1.0", Accept: "*/*" }
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
// Run State
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;

let lastRunId = null;
let lastDebugDir = null;
let lastShotPath = null;

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
    const href = await page.evaluate(() => location.href).catch(() => "");
    fs.writeFileSync(`${base}.href.txt`, String(href || ""));
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
  await saveScreenshot(page, `${base}.png`);
  return base;
}

async function captureFailureArtifacts(page, tag, extra = {}) {
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag || "fail");
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  let url = "";
  try {
    url = page.url();
  } catch {}
  if (!url) {
    url = await page.evaluate(() => location.href).catch(() => "");
  }

  const shotPath = path.join(dir, `${safeTag}-${stamp}.png`);
  const htmlPath = path.join(dir, `${safeTag}-${stamp}.html`);
  const extraPath = path.join(dir, `${safeTag}-${stamp}.extra.json`);

  await saveScreenshot(page, shotPath).catch(() => null);
  try {
    const html = await page.content().catch(() => "");
    fs.writeFileSync(htmlPath, html || "");
  } catch {}
  try {
    fs.writeFileSync(extraPath, JSON.stringify({ url, ...extra }, null, 2));
  } catch {}

  console.log("FAILURE URL:", url || "(unknown)");
  console.log("FAILURE screenshot saved:", shotPath);
  console.log("FAILURE html saved:", htmlPath);
  console.log("FAILURE debug dir:", dir);

  return { url, shotPath, htmlPath, dir };
}

// --------------------
// Selectors (expanded)
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
  'input[placeholder*="Please enter" i]',
  'input[placeholder*="code" i]',
  'textarea[placeholder*="order" i]',
  'textarea[placeholder*="code" i]',
  'input[name*="code" i]',
  'textarea[name*="code" i]'
].join(", ");

function isCloudflareErrorHtml(html) {
  const s = (html || "").toLowerCase();
  if (!s) return false;
  if (s.includes("cloudflare") && s.includes("cf-error-details")) return true;
  if (s.includes("error 1101")) return true;
  if (s.includes("worker threw exception")) return true;
  return false;
}

// --------------------
// Overlay helper
// --------------------
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

async function isVisibleSomewhere(page, selector) {
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
    for (const f of page.frames()) {
      try {
        const loc = f.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) return { ok: true, frame: f, locator: loc };
      } catch {}
    }
    await sleep(250);
  }
  return { ok: false, frame: null, locator: null };
}

function looksLikeLoginUrl(u) {
  const s = String(u || "");
  return /#\/login\b/i.test(s) || /\/login\b/i.test(s);
}

async function isLoginFormVisible(page) {
  const userVisible = await isVisibleSomewhere(page, USER_SELECTORS);
  const passVisible = await isVisibleSomewhere(page, PASS_SELECTORS);
  return userVisible || passVisible || looksLikeLoginUrl(page.url());
}

// --------------------
// API rewrite (route interception)
// --------------------
function makeApiRewrite(hostMatchRe, targetHost) {
  const re = new RegExp(hostMatchRe);
  return async (route, request) => {
    try {
      const url = request.url();
      // Only rewrite XHR/fetch/navigation to api.* (NOT images/css/js from same host)
      const rt = request.resourceType();
      if (!["xhr", "fetch", "document"].includes(rt)) return route.continue();

      const u = new URL(url);
      if (!re.test(u.hostname)) return route.continue();

      const oldHost = u.hostname;
      u.hostname = targetHost;

      console.log("API REWRITE:", oldHost, "->", targetHost, "|", u.pathname);

      return route.continue({ url: u.toString() });
    } catch {
      return route.continue();
    }
  };
}

// --------------------
// Login submit (resilient)
// --------------------
async function clickLoginSubmit(page) {
  const candidates = [
    page.getByRole("button", { name: /login|sign in/i }).first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
    page.locator('button:has-text("Login")').first(),
    page.locator("text=/^login$/i").first()
  ];

  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 10000 }).catch(() => null);
        return "clicked";
      }
    } catch {}
  }

  return "not_found";
}

// If after login you land on a marketing/landing page with a Trade button, click it.
async function clickTradeIfPresent(page) {
  const candidates = [
    page.getByRole("button", { name: /^trade$/i }).first(),
    page.getByRole("link", { name: /^trade$/i }).first(),
    page.locator('button:has-text("Trade")').first(),
    page.locator('a:has-text("Trade")').first()
  ];
  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 8000 }).catch(() => null);
        await sleep(1200);
        await closeOverlays(page);
        console.log("Clicked Trade (post-login landing).");
        return true;
      }
    } catch {}
  }
  return false;
}

// --------------------
// Futures navigation (mobile + pc)
// --------------------
async function tapBottomMiddle(page) {
  const vp = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.floor(vp.width * 0.50);
  const y = Math.floor(vp.height * 0.94);
  await page.mouse.click(x, y, { delay: 50 }).catch(() => null);
  return { x, y, w: vp.width, h: vp.height };
}

async function clickFuturesByText(page) {
  const patterns = [/futures/i, /contract/i, /contracts/i, /合约/i, /期货/i];
  for (const re of patterns) {
    const candidates = [
      page.getByRole("tab", { name: re }).first(),
      page.getByRole("button", { name: re }).first(),
      page.getByRole("link", { name: re }).first(),
      page.getByText(re).first()
    ];
    for (const c of candidates) {
      try {
        if (await c.isVisible().catch(() => false)) {
          await c.click({ timeout: 8000 }).catch(() => null);
          await sleep(1000);
          await closeOverlays(page);
          console.log("Clicked Futures (text):", re.toString());
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function goToContractRoute(page, loginUrl) {
  const cu = contractUrlFromLoginUrl(loginUrl);
  if (!cu) return false;
  await page.goto(cu, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await sleep(1200);
  await closeOverlays(page);
  return true;
}

// This makes “Invited me” clickable even if it’s offscreen / inside a horizontal scroller.
async function clickByDomScan(page, regex, preferTop = false) {
  try {
    const result = await page.evaluate(
      ({ source, flags, preferTop }) => {
        const re = new RegExp(source, flags);

        function visible(el) {
          const style = window.getComputedStyle(el);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          if (r.bottom < 0 || r.right < 0) return false;
          if (r.top > window.innerHeight || r.left > window.innerWidth) return false;
          return true;
        }

        const els = Array.from(document.querySelectorAll("a,button,[role='tab'],[role='button'],div,span,li"));
        const matches = [];

        for (const el of els) {
          const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
          if (!txt) continue;
          if (!re.test(txt)) continue;

          const r = el.getBoundingClientRect();
          if (!visible(el)) continue;

          const y = r.top + r.height / 2;
          const topScore = preferTop ? (1 - y / window.innerHeight) : 0;
          matches.push({ el, txt: txt.slice(0, 60), score: topScore });
        }

        matches.sort((a, b) => b.score - a.score);
        if (!matches[0]) return { ok: false };

        matches[0].el.click();
        return { ok: true, txt: matches[0].txt };
      },
      { source: regex.source, flags: regex.flags, preferTop }
    );

    if (result?.ok) {
      console.log("DOM-SCAN click:", result.txt);
      await sleep(900);
      return true;
    }
  } catch {}
  return false;
}

async function ensureInvitedMeVisibleAndClicked(page) {
  // Try direct text click
  const direct = page.getByText(/invited\s*me/i).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click({ timeout: 8000 }).catch(() => null);
    await sleep(900);
    return true;
  }

  // Try DOM scan click (handles offscreen scrollers)
  if (await clickByDomScan(page, /invited\s*me/i, true)) return true;

  // Try scrolling a likely tab bar horizontally (best-effort)
  try {
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("div,ul"))
        .filter((el) => {
          const style = window.getComputedStyle(el);
          if (!style) return false;
          const overflowX = style.overflowX;
          const canScroll = (overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + 20;
          return canScroll;
        })
        .slice(0, 6);

      for (const el of candidates) {
        el.scrollLeft = el.scrollWidth; // to end
      }
    });
    await sleep(700);
  } catch {}

  // Try again
  if (await clickByDomScan(page, /invited\s*me/i, true)) return true;

  return false;
}

async function ensureOnFuturesAndInvited(page, loginUrl, mobile) {
  // 1) If we landed on a marketing page, click Trade
  await clickTradeIfPresent(page);

  // 2) First try direct contract route
  await goToContractRoute(page, loginUrl);

  // 3) If still not on the right UI, try Futures navigation
  // Mobile: text click then bottom-middle tap fallback
  // PC: text click only
  for (let i = 1; i <= 3; i++) {
    await closeOverlays(page);

    // If got kicked to login, stop here and let caller re-login
    if (await isLoginFormVisible(page)) return { ok: false, reason: "kicked_to_login" };

    const codeVisible = await isVisibleSomewhere(page, ORDER_CODE_SELECTORS);
    const invitedVisible = await page.getByText(/invited\s*me/i).first().isVisible().catch(() => false);

    if (codeVisible || invitedVisible) {
      // Try to click invited if present (puts us on correct subtab)
      if (invitedVisible) await ensureInvitedMeVisibleAndClicked(page);
      return { ok: true, reason: "already_there" };
    }

    const clickedText = await clickFuturesByText(page);
    if (!clickedText && mobile) {
      const tap = await tapBottomMiddle(page);
      console.log(`BOTTOM-MIDDLE FUTURES TAP attempt ${i}: x=${tap.x} y=${tap.y} (w=${tap.w} h=${tap.h})`);
      await sleep(1100);
    }

    // Also try re-going to contract route after nav click (some SPAs require it)
    await goToContractRoute(page, loginUrl);

    // Try clicking invited me again after nav
    await ensureInvitedMeVisibleAndClicked(page);

    // Re-check
    const codeNow = await isVisibleSomewhere(page, ORDER_CODE_SELECTORS);
    const invitedNow = await page.getByText(/invited\s*me/i).first().isVisible().catch(() => false);
    if (codeNow || invitedNow) return { ok: true, reason: "after_nav" };
  }

  return { ok: false, reason: "futures_or_invited_not_found" };
}

// --------------------
// Order flow + verify
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

async function verifyPending(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off" };

  // click Position order tab if visible
  const pos = page.getByText(/position\s*order/i).first();
  if (await pos.isVisible().catch(() => false)) {
    await pos.click({ timeout: 8000 }).catch(() => null);
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

async function verifyOrderFollowed(page) {
  const toast = await waitForToast(page);
  const pending = await verifyPending(page);
  if (toast.ok && pending.ok) return { ok: true, detail: "toast + pending" };
  if (toast.ok) return { ok: true, detail: `toast (${toast.detail})` };
  if (pending.ok) return { ok: true, detail: "pending" };
  return { ok: false, detail: `No confirmation. toast=${toast.type}, pending=${pending.type}` };
}

async function clickConfirm(page) {
  const candidates = [
    page.getByRole("button", { name: /confirm/i }).first(),
    page.getByRole("button", { name: /submit/i }).first(),
    page.getByRole("button", { name: /ok/i }).first(),
    page.getByText(/^confirm$/i).first(),
    page.getByText(/confirm/i).first()
  ];
  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.scrollIntoViewIfNeeded().catch(() => null);
        await c.click({ timeout: 8000 }).catch(() => null);
        return true;
      }
    } catch {}
  }
  return false;
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

        const mobile = shouldUseMobileContext(loginUrl);
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
          locale: "en-US",
          isMobile: mobile,
          hasTouch: mobile
        });

        const page = await context.newPage();
        page.setDefaultTimeout(30000);

        if (API_REWRITE_ENABLED) {
          await page.route("**/*", makeApiRewrite(API_REWRITE_MATCH, API_REWRITE_TARGET));
        }

        try {
          const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(700);

          const status = resp ? resp.status() : null;
          if (status && status >= 400) throw new Error(`HTTP ${status}`);

          const html = await page.content().catch(() => "");
          if (isCloudflareErrorHtml(html)) throw new Error("Cloudflare error page");

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) throw new Error(`user field not found within ${PREFLIGHT_LOGIN_WAIT_MS}ms`);

          await dumpDebugStep(page, "preflight-ok", { loginUrl, status, mobile });
          console.log("Preflight OK:", loginUrl);

          passed = true;
          await context.close().catch(() => null);
          break;
        } catch (e) {
          console.log("Preflight failed:", loginUrl, "err:", e?.message || String(e));
          await dumpDebugStep(page, `preflight-failed-${i}`, { loginUrl, err: e?.message || String(e) });
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
    <div>Debug capture: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
    <div>LOGIN_URLS: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></div>
    <div>Force mobile: <b>${escapeHtml(FORCE_MOBILE_RAW)}</b></div>

    <div>API rewrite: <b>${API_REWRITE_ENABLED ? "ON" : "OFF"}</b>
      (match: <code>${escapeHtml(API_REWRITE_MATCH)}</code> → target: <code>${escapeHtml(API_REWRITE_TARGET)}</code>)
    </div>

    <div>Email configured: <b>${emailConfigured() ? "YES" : "NO"}</b></div>

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
      forceMobile: FORCE_MOBILE_RAW
    },
    email: {
      enabled: EMAIL_ENABLED,
      provider: EMAIL_PROVIDER,
      configured: emailConfigured(),
      from: EMAIL_FROM,
      to: EMAIL_TO
    },
    apiRewrite: {
      enabled: API_REWRITE_ENABLED,
      match: API_REWRITE_MATCH,
      target: API_REWRITE_TARGET
    },
    debug: {
      lastRunId,
      lastDebugDir,
      lastShotPath,
      stableShotPath: "/app/last-shot.png"
    }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const result = await sendEmail("T-Bot | email test", `Email test at ${nowLocal()}`);
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
    .map((f) => {
      const safeF = encodeURIComponent(f);
      return `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${safeF}">${escapeHtml(f)}</a></li>`;
    })
    .join("");

  res.send(`
    <h3>Debug</h3>
    <div>Last run ID: <code>${escapeHtml(lastRunId || "-")}</code></div>
    <div>Last debug dir: <code>${escapeHtml(lastDebugDir || "-")}</code></div>
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
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
  }

  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  // quick sanity: base + api rewrite target
  const hosts = [
    "api.ddjea.com",
    ...LOGIN_URLS.map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return null;
      }
    }).filter(Boolean)
  ];

  const out = {};
  for (const h of Array.from(new Set(hosts))) {
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
    "https://api.ddjea.com/api/app/ping",
    ...LOGIN_URLS.slice(0, 3).map((u) => {
      try {
        const x = new URL(u);
        return `${x.protocol}//${x.host}/`;
      } catch {
        return null;
      }
    }).filter(Boolean)
  ];

  const results = {};
  for (const u of Array.from(new Set(urls))) {
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

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set.");
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
      console.log("FORCE_MOBILE:", FORCE_MOBILE_RAW);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("API_REWRITE:", API_REWRITE_ENABLED, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);

      console.log("Email configured:", emailConfigured(), "provider:", EMAIL_PROVIDER);
      console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
      console.log("Confirm retries:", CONFIRM_RETRIES);

      const pf = await preflightSites();
      if (!pf.ok) throw new Error(`Preflight failed. ${pf.note}`);
      const runSites = pf.sites;
      console.log("Chosen sites for this run:", runSites.join(", "));

      await sendEmail(
        `${subjectPrefix} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nSites: ${runSites.join(
          ", "
        )}\nAPI rewrite: ${API_REWRITE_ENABLED ? "ON" : "OFF"}\n`
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

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      const summary = results
        .map((r) => (r.ok ? `SUCCESS: ${r.username} (${r.site})` : `FAIL: ${r.username} (${r.error})`))
        .join("\n");

      await sendEmail(
        `${subjectPrefix} ${anyFailed ? "finished with failures" : "completed"}`,
        `Finished at ${finishedAt}\nRun ID: ${lastRunId}\n\nSummary: ${okCount} success, ${failCount} failed\n\n${summary}\n\nDebug: /debug (needs password)\n`
      );

      console.log("Bot completed");
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      await sendEmail(`${subjectPrefix} FAILED`, `Run failed at ${nowLocal()}\nRun ID: ${lastRunId}\nError: ${msg}\n`);
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Core runner
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
  const mobile = shouldUseMobileContext(loginUrl);

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
  page.setDefaultTimeout(30000);

  if (API_REWRITE_ENABLED) {
    await page.route("**/*", makeApiRewrite(API_REWRITE_MATCH, API_REWRITE_TARGET));
  }

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
    const e = new Error(message);
    e.__captured = true;
    throw e;
  }

  try {
    // 1) Load login
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);

    const status = resp ? resp.status() : null;
    const html0 = await page.content().catch(() => "");
    if (isCloudflareErrorHtml(html0)) await fail("cloudflare", "Cloudflare error page on login", { status });

    await dumpDebugStep(page, "after-goto-login", { loginUrl, status, mobile });

    // 2) Find fields
    const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
    const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 25000);
    if (!userRes.ok || !passRes.ok) await fail("login-fields-missing", "Login fields not found");

    // 3) Login attempts
    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(1200);
      await closeOverlays(page);

      const userRes2 = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
      const passRes2 = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
      if (!userRes2.ok || !passRes2.ok) {
        await dumpDebugStep(page, `login-fields-missing-${attempt}`, { attempt });
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

      const did = await clickLoginSubmit(page);
      if (did !== "clicked") {
        await passField.press("Enter").catch(() => null);
      }

      await sleep(1200);
      await closeOverlays(page);

      const stillLogin = await isLoginFormVisible(page);
      await dumpDebugStep(page, `after-login-attempt-${attempt}`, { attempt, stillLogin, submit: did });

      if (stillLogin) continue;

      // Sometimes it lands on a marketing page — click Trade and/or go directly to Trade route
      await clickTradeIfPresent(page);
      const tu = tradeUrlFromLoginUrl(loginUrl);
      if (tu) {
        await page.goto(tu, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(1200);
        await closeOverlays(page);
      }

      // Login confirmation heuristic: login form gone
      const stillLogin2 = await isLoginFormVisible(page);
      if (!stillLogin2) {
        loggedIn = true;
        console.log("Login confirmed: login_inputs_gone");
        break;
      }
    }

    if (!loggedIn) await fail("login-failed", "Login failed (stayed on login)");

    // 4) Ensure Futures + Invited Me + code box
    await dumpDebugStep(page, "after-login-confirmed", {});

    // IMPORTANT: We sometimes get kicked back after entering futures; we handle that and re-login once.
    for (let relog = 0; relog <= 1; relog++) {
      const fut = await ensureOnFuturesAndInvited(page, loginUrl, mobile);
      await dumpDebugStep(page, "after-futures-nav", { fut, relog });

      if (fut.ok) break;

      if (fut.reason === "kicked_to_login" && relog === 0) {
        console.log("Detected kick to login. Re-logging once and retrying futures flow.");
        // go back to login and retry login one more time quickly
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(1200);
        // quick login fill (single attempt)
        const userRes3 = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
        const passRes3 = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
        if (!userRes3.ok || !passRes3.ok) await fail("relogin-fields-missing", "Re-login fields missing");
        await userRes3.locator.fill(account.username).catch(() => null);
        await passRes3.locator.fill(account.password).catch(() => null);
        await clickLoginSubmit(page).catch(() => null);
        await sleep(1400);
        continue;
      }

      await fail("futures-nav-failed", `Could not reach Futures/Invited Me (${fut.reason})`);
    }

    // 5) Guard: if kicked to login here, STOP
    if (STOP_IF_LOGIN_SEEN_AGAIN && (await isLoginFormVisible(page))) {
      await dumpDebugStep(page, "kicked-to-login", {});
      await fail("kicked-to-login", "Kicked back to login before entering order code (stopping to avoid typing code into email).");
    }

    // 6) Find order code box
    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 20000);
    await dumpDebugStep(page, "after-invited-me", { codeFound: codeRes.ok });

    if (!codeRes.ok) await fail("code-box-missing", "Order code input not found");

    // 7) Fill code
    const codeBox = codeRes.locator;
    await codeBox.scrollIntoViewIfNeeded().catch(() => null);
    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode).catch(() => null);
    await sleep(600);
    await dumpDebugStep(page, "after-code-fill", { codeLength: String(orderCode || "").length });

    // 8) Confirm
    let confirmed = false;
    let lastVerify = null;

    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      console.log("Confirm attempt", i, "for", account.username);

      const okClick = await clickConfirm(page);
      await sleep(1200);
      await dumpDebugStep(page, `after-confirm-attempt-${i}`, { okClick });

      const verify = await verifyOrderFollowed(page);
      lastVerify = verify;

      if (verify.ok) {
        confirmed = true;
        await dumpDebugStep(page, "confirm-verified", { verify });
        break;
      }

      console.log("Verification not satisfied:", verify.detail);
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }

    if (!confirmed) await fail("confirm-verification-failed", lastVerify?.detail || "Confirm verification failed");

    return lastVerify?.detail || "verified";
  } catch (e) {
    const msg = e?.message || String(e);
    if (!e.__captured) {
      await captureFailureArtifacts(page, `${sanitizeForFilename(account.username)}-unhandled`, {
        loginUrl,
        username: account.username,
        error: msg
      });
    }
    throw e instanceof Error ? e : new Error(msg);
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// --------------------
// Startup
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  const errs = startupConfigErrors();
  console.log("Starting Container");
  console.log("Listening on", PORT);

  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("FORCE_MOBILE:", FORCE_MOBILE_RAW);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));

  console.log("API_REWRITE:", API_REWRITE_ENABLED, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);

  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Email from/to:", EMAIL_FROM, EMAIL_TO);

  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);

  console.log(
    "Preflight enabled:",
    PREFLIGHT_ENABLED,
    "loginWaitMs:",
    PREFLIGHT_LOGIN_WAIT_MS,
    "retries:",
    PREFLIGHT_RETRIES,
    "maxSites:",
    PREFLIGHT_MAX_SITES
  );

  if (errs.length) console.log("CONFIG ERRORS:", errs);
  writePlaceholderLastShot();
});
