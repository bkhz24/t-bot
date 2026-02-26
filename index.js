"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8080);

// ── Required env ──────────────────────────────────────────────────────────────
const BOT_PASSWORD  = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString();
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

// ── Optional env ──────────────────────────────────────────────────────────────
const DEBUG_CAPTURE      = envTruthy(process.env.DEBUG_CAPTURE || "1");
const FORCE_MOBILE_MODE  = (process.env.FORCE_MOBILE || "auto").toString().trim().toLowerCase();

// Login
const LOGIN_ATTEMPTS      = Number(process.env.LOGIN_ATTEMPTS     || "6");
const LOGIN_FIELD_WAIT_MS = Number(process.env.LOGIN_FIELD_WAIT_MS|| "20000");
const WAIT_AFTER_LOGIN_MS = Number(process.env.WAIT_AFTER_LOGIN_MS|| "2200");

// Navigation
const WAIT_AFTER_FUTURES_MS        = Number(process.env.WAIT_AFTER_FUTURES_MS        || "1800");
const WAIT_AFTER_FUTURES_DIRECT_MS = Number(process.env.WAIT_AFTER_FUTURES_DIRECT_MS || "1800");
const WAIT_AFTER_GOTO_MS           = Number(process.env.WAIT_AFTER_GOTO_MS           || "1500");
const WAIT_AFTER_INVITED_MS        = Number(process.env.WAIT_AFTER_INVITED_MS        || "1500");

// Confirm
const CONFIRM_RETRIES       = Number(process.env.CONFIRM_RETRIES        || "8");
const CONFIRM_RETRY_DELAY_MS= Number(process.env.CONFIRM_RETRY_DELAY_MS || "3500");
const CONFIRM_WAIT_MS       = Number(process.env.CONFIRM_WAIT_MS        || "4000");

// Verify
const VERIFY_TOAST      = envTruthy(process.env.VERIFY_TOAST    || "1");
const VERIFY_PENDING    = envTruthy(process.env.VERIFY_PENDING  || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "25000");

// Email
const EMAIL_ENABLED      = envTruthy(process.env.EMAIL_ENABLED   || "1");
const EMAIL_PROVIDER     = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
const SENDGRID_API_KEY   = (process.env.SENDGRID_API_KEY || "").toString().trim();
const EMAIL_FROM_RAW     = (process.env.EMAIL_FROM || "").toString().trim();
const EMAIL_FROM_NAME    = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO           = (process.env.EMAIL_TO || "").toString().trim();
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "4");

// ── Helpers ───────────────────────────────────────────────────────────────────
function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowLocal() { return new Date().toLocaleString("en-US", { timeZoneName: "short" }); }
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#39;");
}
function sanitizeFilename(s) {
  return String(s ?? "").replace(/[^a-z0-9._-]+/gi,"_").replace(/_+/g,"_")
    .replace(/^_+|_+$/g,"").slice(0,80);
}
function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}
function ensureDir(d) { try { fs.mkdirSync(d, { recursive:true }); } catch {} }
function safeListDir(d) { try { return fs.readdirSync(d).filter(x=>!x.includes("..")); } catch { return []; } }

// ── Accounts ──────────────────────────────────────────────────────────────────
function parseAccounts() {
  if (!ACCOUNTS_JSON) return { ok:false, accounts:[], error:"ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok:false, accounts:[], error:"ACCOUNTS_JSON must be an array" };
    const cleaned = parsed.map(a => ({
      username: String(a?.username||"").trim(),
      password: String(a?.password||"")
    }));
    const bad = cleaned.find(a => !a.username || !a.password);
    if (bad) return { ok:false, accounts:[], error:"Each account needs username + password" };
    return { ok:true, accounts:cleaned, error:null };
  } catch(e) {
    return { ok:false, accounts:[], error:`ACCOUNTS_JSON invalid: ${e?.message||String(e)}` };
  }
}

// ── Login URLs ────────────────────────────────────────────────────────────────
function parseLoginUrls() {
  const fallback = ["https://dsj88.net/h5/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map(x=>x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}
const LOGIN_URLS = parseLoginUrls();

function isH5Url(url) { return /\/h5\//i.test(url); }
function shouldUseMobile(loginUrl) {
  if (FORCE_MOBILE_MODE === "true"  || FORCE_MOBILE_MODE === "1") return true;
  if (FORCE_MOBILE_MODE === "false" || FORCE_MOBILE_MODE === "0") return false;
  return isH5Url(loginUrl); // auto
}
function baseFromUrl(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}
function futuresUrlFrom(loginUrl) {
  const base = baseFromUrl(loginUrl);
  if (!base) return null;
  const prefix = loginUrl.includes("/pc/#/") ? "/pc/#/" : "/h5/#/";
  return `${base}${prefix}contractTransaction`;
}

// ── Email ─────────────────────────────────────────────────────────────────────
function parseFromEmail(raw) {
  const s = (raw||"").trim();
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  return s;
}
function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  return !!(SENDGRID_API_KEY && parseFromEmail(EMAIL_FROM_RAW) && EMAIL_TO);
}
async function sendEmail(subject, text) {
  if (!emailConfigured()) { console.log("Email not configured, skipping:", subject); return { ok:false, skipped:true }; }
  try {
    const sg = require("@sendgrid/mail");
    sg.setApiKey(SENDGRID_API_KEY);
    const [res] = await sg.send({
      to: EMAIL_TO.split(",").map(s=>s.trim()).filter(Boolean),
      from: { email: parseFromEmail(EMAIL_FROM_RAW), name: EMAIL_FROM_NAME },
      subject, text
    });
    console.log("Email sent:", subject, res?.statusCode);
    return { ok:true };
  } catch(e) {
    const err = e?.response?.body ? JSON.stringify(e.response.body) : (e?.message||String(e));
    console.log("Email failed:", err);
    return { ok:false, error:err };
  }
}

// ── Debug artifacts ───────────────────────────────────────────────────────────
let isRunning = false, lastRunAt = null, lastError = null;
let lastRunId = null, lastDebugDir = null, lastShotPath = null;

function writePlaceholderShot() {
  try {
    ensureDir("/app");
    fs.writeFileSync("/app/last-shot.png",
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl1mQAAAAASUVORK5CYII=","base64")
    );
  } catch {}
}
async function saveShot(page, filePath) {
  try { await page.screenshot({ path:filePath, fullPage:true }); lastShotPath = filePath; } catch {}
  try { fs.copyFileSync(filePath, "/app/last-shot.png"); } catch {}
}
async function dumpStep(page, tag, extra={}) {
  if (!DEBUG_CAPTURE) return;
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);
  const base = path.join(dir, `${sanitizeFilename(tag)}-${Date.now()}`);
  try { fs.writeFileSync(`${base}.url.txt`,   String(page.url()||"")); } catch {}
  try { fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra,null,2)); } catch {}
  try { fs.writeFileSync(`${base}.html`,       String(await page.content().catch(()=>""))); } catch {}
  try { await saveShot(page, `${base}.png`); } catch {}
}
async function captureFailure(page, tag, msg) {
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);
  const base = path.join(dir, `${sanitizeFilename(tag)}-${Date.now()}`);
  const url = page.url() || "";
  console.log("FAIL:", msg, "| URL:", url);
  try { await saveShot(page, `${base}.png`); } catch {}
  try { fs.writeFileSync(`${base}.html`, String(await page.content().catch(()=>""))); } catch {}
  try { fs.writeFileSync(`${base}.url.txt`, url); } catch {}
}

// ── Selectors ─────────────────────────────────────────────────────────────────
// The login page uses <input type="text"> for email and <input type="password"> for password
// The Login button is a <div class="login-btn"> — NOT a <button>!
const USER_SEL = [
  'input[type="email"]',
  'input[type="text"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="account" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="mobile" i]',
  'input[name*="user" i]',
  'input[name*="email" i]',
].join(", ");

const PASS_SEL = [
  'input[type="password"]',
  'input[placeholder*="password" i]',
].join(", ");

const ORDER_CODE_SEL = [
  'input[placeholder*="order code" i]',
  'input[placeholder*="Please enter the order" i]',
  'input[placeholder*="order" i]',
  'input[placeholder*="code" i]',
].join(", ");

// ── Core helpers ──────────────────────────────────────────────────────────────
async function findVisible(page, selector, timeoutMs=10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(()=>false)) return { ok:true, locator:loc };
    await sleep(300);
  }
  return { ok:false, locator:null };
}

async function closeOverlays(page) {
  const candidates = [
    page.getByRole("button", { name:/close|cancel|dismiss|got it|ok|agree/i }).first(),
    page.locator('[aria-label*="close" i]').first(),
    page.locator('button:has-text("×")').first(),
    page.locator(".modal-close").first(),
  ];
  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(()=>false)) {
        await c.click({ timeout:1500 }).catch(()=>null);
        await sleep(200);
      }
    } catch {}
  }
}

async function loginFieldsVisible(page) {
  const u = page.locator(USER_SEL).first();
  const p = page.locator(PASS_SEL).first();
  return (await u.isVisible().catch(()=>false)) && (await p.isVisible().catch(()=>false));
}

function isOnLoginPage(url) {
  return (url||"").includes("/#/login") || (url||"").includes("/login");
}

// ── THE KEY FIX: Click the login button (it's a div, not a button) ────────────
async function clickLoginButton(page) {
  // 1. The site uses <div class="login-btn"> - try this first
  const divBtn = page.locator('.login-btn').first();
  if (await divBtn.isVisible().catch(()=>false)) {
    console.log("Clicking .login-btn div");
    await divBtn.click({ timeout:8000 }).catch(()=>null);
    return true;
  }

  // 2. Try text content matches
  const textTargets = [
    page.locator('div:has-text("Login")').filter({ hasText:/^Login$/ }).first(),
    page.getByText(/^Login$/i).first(),
    page.getByRole("button", { name:/login|sign in/i }).first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
  ];
  for (const t of textTargets) {
    if (await t.isVisible().catch(()=>false)) {
      console.log("Clicking login via fallback");
      await t.click({ timeout:5000 }).catch(()=>null);
      return true;
    }
  }

  // 3. Last resort: press Enter on the password field
  const passField = page.locator(PASS_SEL).first();
  if (await passField.isVisible().catch(()=>false)) {
    console.log("Pressing Enter on password field");
    await passField.press("Enter").catch(()=>null);
    return true;
  }

  return false;
}

// ── Login flow ────────────────────────────────────────────────────────────────
async function login(page, account, loginUrl) {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    console.log(`Login attempt ${attempt}/${LOGIN_ATTEMPTS} for ${account.username} on ${loginUrl}`);

    await page.goto(loginUrl, { waitUntil:"domcontentloaded", timeout:60000 }).catch(()=>null);
    await sleep(1500);
    await closeOverlays(page);

    // Wait for fields
    const userRes = await findVisible(page, USER_SEL, LOGIN_FIELD_WAIT_MS);
    const passRes = await findVisible(page, PASS_SEL, 5000);

    if (!userRes.ok || !passRes.ok) {
      console.log("  Fields not found, retrying...");
      await dumpStep(page, `login-no-fields-${attempt}`, { loginUrl });
      continue;
    }

    // Fill credentials
    const userField = userRes.locator;
    const passField = passRes.locator;

    await userField.click({ timeout:3000 }).catch(()=>null);
    await userField.fill("").catch(()=>null);
    await sleep(100);
    await userField.fill(account.username).catch(()=>null);
    await sleep(200);

    await passField.click({ timeout:3000 }).catch(()=>null);
    await passField.fill("").catch(()=>null);
    await sleep(100);
    await passField.fill(account.password).catch(()=>null);
    await sleep(200);

    // Verify filled correctly
    const filledUser = await userField.inputValue().catch(()=>"");
    const filledPass = await passField.inputValue().catch(()=>"");
    console.log(`  Filled user: "${filledUser}" (expected: "${account.username}"), pass length: ${filledPass.length}`);

    // Click login
    await clickLoginButton(page);
    await sleep(WAIT_AFTER_LOGIN_MS);
    await closeOverlays(page);

    await dumpStep(page, `after-login-${attempt}`, { loginUrl, attempt });

    // Check if we got past the login page
    const url = page.url() || "";
    const stillHasFields = await loginFieldsVisible(page);
    const onLoginPage = isOnLoginPage(url);

    console.log(`  After login: url=${url}, stillHasFields=${stillHasFields}, onLoginPage=${onLoginPage}`);

    if (!stillHasFields && !onLoginPage) {
      console.log("  ✓ Login SUCCESS");
      return true;
    }
    if (!stillHasFields) {
      console.log("  ✓ Login likely success (fields gone)");
      return true;
    }

    // Still on login — wait a bit more and check again
    await sleep(2000);
    const stillOnLogin2 = await loginFieldsVisible(page);
    if (!stillOnLogin2) {
      console.log("  ✓ Login success (delayed)");
      return true;
    }

    console.log(`  Login attempt ${attempt} failed, retrying...`);
  }

  return false;
}

// ── Navigation: Futures ───────────────────────────────────────────────────────
async function gotoFuturesPC(page) {
  // On PC, "Futures" is in the top nav with a dropdown
  // Try clicking the "Futures" nav item which has a popover with "Futures" and "Perpetual" options
  console.log("PC: Looking for Futures nav item...");

  // The nav item is a div with text " Futures " and a dropdown icon
  // Try clicking the nav Futures item to open the dropdown
  const futuresNav = page.locator('.el-popover__reference').filter({ hasText: /futures/i }).first();
  if (await futuresNav.isVisible().catch(()=>false)) {
    await futuresNav.click({ timeout:5000 }).catch(()=>null);
    await sleep(600);
    console.log("PC: Clicked Futures nav popover");

    // Now click "Futures" in the dropdown (as opposed to "Perpetual" or "Convert")
    const dropdownFutures = page.locator('.lang-item.pointer').filter({ hasText: /^Futures$/i }).first();
    if (await dropdownFutures.isVisible().catch(()=>false)) {
      await dropdownFutures.click({ timeout:5000 }).catch(()=>null);
      await sleep(WAIT_AFTER_FUTURES_MS);
      console.log("PC: Clicked Futures in dropdown");
      return true;
    }

    // fallback: any visible "Futures" text in dropdown area
    const anyFutures = page.getByText(/^Futures$/i).first();
    if (await anyFutures.isVisible().catch(()=>false)) {
      await anyFutures.click({ timeout:3000 }).catch(()=>null);
      await sleep(WAIT_AFTER_FUTURES_MS);
      return true;
    }
  }

  // Simpler fallback: just click any element with "Futures" text
  const simpleFutures = page.getByText(/futures/i).first();
  if (await simpleFutures.isVisible().catch(()=>false)) {
    await simpleFutures.click({ timeout:5000 }).catch(()=>null);
    await sleep(WAIT_AFTER_FUTURES_MS);
    return true;
  }

  return false;
}

async function gotoFuturesMobile(page) {
  console.log("Mobile: Looking for Futures bottom tab...");

  // Mobile bottom nav has: Home, Markets, Futures (middle), Perpetual, Assets
  const clicked =
    await page.getByRole("tab",   { name:/^futures$/i }).first().isVisible().catch(()=>false) ?
      (await page.getByRole("tab", { name:/^futures$/i }).first().click({ timeout:5000 }).catch(()=>false), true) :
    await page.getByText(/^Futures$/i).first().isVisible().catch(()=>false) ?
      (await page.getByText(/^Futures$/i).first().click({ timeout:5000 }).catch(()=>false), true) :
    false;

  if (clicked) {
    await sleep(WAIT_AFTER_FUTURES_MS);
    console.log("Mobile: Clicked Futures tab");
    return true;
  }

  // Tap the middle-bottom of the screen (Futures is the 3rd of 5 bottom tabs)
  const vp = page.viewportSize() || { width:390, height:844 };
  const x = Math.floor(vp.width * 0.50);
  const y = Math.floor(vp.height * 0.94);
  for (let i = 1; i <= 3; i++) {
    console.log(`Mobile: Bottom-middle tap attempt ${i} at (${x}, ${y})`);
    await page.mouse.click(x, y).catch(()=>null);
    await sleep(1000);
    const hasInvitedMe = await page.getByText(/invited\s*me/i).first().isVisible().catch(()=>false);
    if (hasInvitedMe) {
      console.log("Mobile: Found 'Invited me' after tap - success");
      return true;
    }
  }
  return false;
}

// ── Navigation: Invited Me ────────────────────────────────────────────────────
async function clickInvitedMe(page) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const tab = page.getByText(/invited\s*me/i).first();
    if (await tab.isVisible().catch(()=>false)) {
      await tab.click({ timeout:5000 }).catch(()=>null);
      await sleep(WAIT_AFTER_INVITED_MS);
      console.log("Clicked 'Invited me'");
      return true;
    }
    await sleep(400);
  }
  console.log("'Invited me' tab not found");
  return false;
}

// ── Verification ──────────────────────────────────────────────────────────────
async function waitForToast(page) {
  if (!VERIFY_TOAST) return { ok:false, type:"toast_off" };
  const patterns = [/already\s*followed/i, /followed/i, /success/i, /completed/i, /submitted/i, /pending/i];
  const end = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < end) {
    for (const re of patterns) {
      const loc = page.getByText(re).first();
      if (await loc.isVisible().catch(()=>false)) {
        const txt = (await loc.textContent().catch(()=>""))?.trim().slice(0,120)||"";
        return { ok:true, type:"toast", detail:txt };
      }
    }
    await sleep(300);
  }
  return { ok:false, type:"toast_timeout" };
}

async function verifyPending(page) {
  if (!VERIFY_PENDING) return { ok:false, type:"pending_off" };
  // Click "Position order" tab if visible
  const posTab = page.getByText(/position\s*order/i).first();
  if (await posTab.isVisible().catch(()=>false)) {
    await posTab.click({ timeout:5000 }).catch(()=>null);
    await sleep(800);
  }
  const end = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < end) {
    if (await page.getByText(/pending/i).first().isVisible().catch(()=>false)) return { ok:true, type:"pending" };
    await sleep(350);
  }
  return { ok:false, type:"pending_timeout" };
}

async function verifyOrder(page) {
  const [t, p] = await Promise.all([waitForToast(page), verifyPending(page)]);
  if (t.ok) return { ok:true, detail:`toast: ${t.detail||t.type}` };
  if (p.ok) return { ok:true, detail:"pending seen" };
  return { ok:false, detail:`toast=${t.type}, pending=${p.type}` };
}

// ── Main flow ─────────────────────────────────────────────────────────────────
async function runFlow(page, loginUrl, orderCode) {
  const mobile = shouldUseMobile(loginUrl);
  console.log(`runFlow: mobile=${mobile}, loginUrl=${loginUrl}`);

  // Step 1: Navigate to Futures
  if (mobile) {
    await gotoFuturesMobile(page);
  } else {
    await gotoFuturesPC(page);
  }

  // Step 2: Always try the direct contractTransaction URL (reliable)
  const directUrl = futuresUrlFrom(loginUrl);
  if (directUrl) {
    console.log("Navigating directly to:", directUrl);
    await page.goto(directUrl, { waitUntil:"domcontentloaded", timeout:60000 }).catch(()=>null);
    await sleep(WAIT_AFTER_FUTURES_DIRECT_MS);
    await closeOverlays(page);
  }

  await dumpStep(page, "after-futures-nav", { directUrl, mobile });

  // Safety check: not kicked back to login
  const urlNow = page.url()||"";
  if (isOnLoginPage(urlNow) || await loginFieldsVisible(page)) {
    return { ok:false, reason:"kicked_to_login" };
  }

  // Step 3: Click "Invited me"
  const invitedOk = await clickInvitedMe(page);
  await dumpStep(page, "after-invited-me", { invitedOk });

  // Safety check again
  const urlNow2 = page.url()||"";
  if (isOnLoginPage(urlNow2) || await loginFieldsVisible(page)) {
    return { ok:false, reason:"kicked_to_login_after_invited" };
  }

  // Step 4: Find order code input
  const codeRes = await findVisible(page, ORDER_CODE_SEL, 15000);
  if (!codeRes.ok) {
    await dumpStep(page, "code-box-missing", {});
    return { ok:false, reason:"code_box_missing" };
  }

  const codeBox = codeRes.locator;
  await codeBox.scrollIntoViewIfNeeded().catch(()=>null);
  await codeBox.click({ timeout:5000 }).catch(()=>null);
  await sleep(200);
  await codeBox.fill(String(orderCode)).catch(()=>null);
  await sleep(500);

  const filled = await codeBox.inputValue().catch(()=>"");
  console.log(`Code filled: "${filled}" (expected length ${String(orderCode).length})`);
  await dumpStep(page, "after-code-fill", { filled });

  // Step 5: Click Confirm button
  // The confirm button appears next to the order code input
  // From HTML: the Confirm button is <button class="el-button el-button--default el-button--mini">
  // inside a div.el-input-group__append, next to the order code input
  const confirmCandidates = [
    page.locator('.el-input-group__append button').first(),
    page.locator('.el-button--mini').filter({ hasText:/confirm/i }).first(),
    page.locator('.el-button').filter({ hasText:/confirm/i }).first(),
    page.locator('.confirm-btn').first(),
    page.getByRole("button", { name:/confirm/i }).first(),
    page.locator('button:has-text("Confirm")').first(),
  ];

  let confirmBtn = null;
  for (const c of confirmCandidates) {
    if (await c.isVisible().catch(()=>false)) { confirmBtn = c; break; }
  }

  if (!confirmBtn) {
    await dumpStep(page, "confirm-btn-missing", {});
    return { ok:false, reason:"confirm_btn_missing" };
  }

  // Step 6: Click confirm with retries
  let lastVerify = null;
  for (let i = 1; i <= CONFIRM_RETRIES; i++) {
    console.log(`Confirm click attempt ${i}`);
    await confirmBtn.scrollIntoViewIfNeeded().catch(()=>null);
    await confirmBtn.click({ timeout:8000 }).catch(()=>null);
    await sleep(CONFIRM_WAIT_MS);
    await dumpStep(page, `after-confirm-${i}`, {});

    const v = await verifyOrder(page);
    lastVerify = v;
    if (v.ok) {
      console.log("✓ Order confirmed:", v.detail);
      return { ok:true, detail:v.detail };
    }

    await sleep(CONFIRM_RETRY_DELAY_MS);
  }

  return { ok:false, reason:"verify_failed", detail:lastVerify?.detail||"" };
}

// ── Per-account runner ────────────────────────────────────────────────────────
async function runAccountOnUrl(account, orderCode, loginUrl) {
  const mobile = shouldUseMobile(loginUrl);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"]
  });

  const context = await browser.newContext({
    viewport: mobile ? { width:390, height:844 } : { width:1280, height:720 },
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined
  });

  const page = await context.newPage();

  page.on("requestfailed", req => {
    if (req.url().includes("/api/")) {
      console.log("REQ FAILED:", req.url(), "=>", req.failure()?.errorText||"?");
    }
  });
  page.on("pageerror", err => console.log("PAGE ERROR:", err?.message||String(err)));

  try {
    // Step A: Login
    const loggedIn = await login(page, account, loginUrl);
    if (!loggedIn) {
      await captureFailure(page, `${sanitizeFilename(account.username)}-login-failed`, "Login failed");
      throw new Error("Login failed (stayed on login page)");
    }

    // Step B: Run main flow, retry once if kicked to login
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await runFlow(page, loginUrl, orderCode);
      if (res.ok) return res.detail || "ok";

      if (res.reason === "kicked_to_login" && attempt === 1) {
        console.log("Kicked to login mid-flow, re-logging in...");
        const relog = await login(page, account, loginUrl);
        if (!relog) break;
        continue;
      }

      await captureFailure(page, `${sanitizeFilename(account.username)}-flow-failed`,
        `Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`);
      throw new Error(`Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`);
    }

    throw new Error("Flow failed after retry");
  } finally {
    await context.close().catch(()=>null);
    await browser.close().catch(()=>null);
  }
}

async function runAccountAllUrls(account, orderCode, urls) {
  let lastErr = null;
  for (const loginUrl of urls) {
    console.log(`\n--- Trying ${loginUrl} for ${account.username} ---`);
    try {
      const note = await runAccountOnUrl(account, orderCode, loginUrl);
      console.log(`✓ SUCCESS: ${account.username} on ${loginUrl} | ${note}`);
      return { ok:true, site:loginUrl, note };
    } catch(e) {
      console.log(`✗ FAILED: ${loginUrl} for ${account.username}: ${e?.message||String(e)}`);
      lastErr = e;
    }
  }
  return { ok:false, error:lastErr?.message||"All URLs failed" };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended:true }));
app.use(express.json());

app.get("/", (req, res) => {
  const cfg = parseAccounts();
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <p>Running: <b>${isRunning ? "YES" : "NO"}</b></p>
    <p>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</p>
    <p>Last error: ${lastError ? escapeHtml(lastError) : "-"}</p>
    <p>Accounts: ${cfg.ok ? cfg.accounts.length : "ERROR: "+escapeHtml(cfg.error||"")}</p>
    <p>Login URLs: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></p>
    <p>Email configured: <b>${emailConfigured() ? "YES" : "NO"}</b></p>
    <hr/>
    <form method="POST" action="/run">
      <input name="p" type="password" placeholder="Password" required /><br/><br/>
      <input name="code" placeholder="Order code" required style="width:300px"/><br/><br/>
      <button type="submit">Run Bot</button>
    </form>
    <p>
      <a href="/health">/health</a> |
      <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD||"")}">/last-shot</a> |
      <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD||"")}">/debug</a> |
      <a href="/email-test?p=${encodeURIComponent(BOT_PASSWORD||"")}">/email-test</a>
    </p>
  `);
});

app.get("/health", (req, res) => {
  const cfg = parseAccounts();
  res.json({
    ok: true, running: isRunning, lastRun: lastRunAt, lastError,
    config: {
      botPasswordSet: !!BOT_PASSWORD,
      accountsOk: cfg.ok, accountsCount: cfg.ok ? cfg.accounts.length : 0,
      loginUrls: LOGIN_URLS,
      forceMobile: FORCE_MOBILE_MODE,
      email: { configured: emailConfigured(), from: parseFromEmail(EMAIL_FROM_RAW), to: EMAIL_TO }
    }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized");
  const r = await sendEmail("T-Bot | email test", `Test at ${nowLocal()}`);
  res.json(r);
});

app.get("/last-shot", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized");
  const stable = "/app/last-shot.png";
  const src = fs.existsSync(stable) ? stable : (lastShotPath && fs.existsSync(lastShotPath) ? lastShotPath : null);
  if (!src) return res.send("No screenshot yet.");
  res.setHeader("Content-Type","image/png");
  fs.createReadStream(src).pipe(res);
});

app.get("/debug", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized");
  res.setHeader("Content-Type","text/html; charset=utf-8");
  if (!lastDebugDir) return res.send("<h3>No debug dir yet. Run the bot once.</h3>");
  const files = safeListDir(lastDebugDir);
  const links = files.map(f =>
    `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`
  ).join("");
  res.send(`<h3>Debug: ${escapeHtml(lastDebugDir)}</h3><ul>${links}</ul>`);
});

app.get("/debug/files", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized");
  const f = (req.query.f||"").toString();
  if (!lastDebugDir || !f || f.includes("..") || f.includes("/")) return res.status(400).send("Bad request");
  const full = path.resolve(lastDebugDir, f);
  if (!full.startsWith(path.resolve(lastDebugDir))) return res.status(400).send("Bad path");
  if (!fs.existsSync(full)) return res.status(404).send("Not found");
  res.setHeader("Content-Type", full.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8");
  fs.createReadStream(full).pipe(res);
});

app.post("/run", async (req, res) => {
  const p    = (req.body.p    || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running.");

  const cfg = parseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error||"ACCOUNTS_JSON invalid.");

  isRunning   = true;
  lastError   = null;
  lastRunAt   = nowLocal();
  lastRunId   = crypto.randomBytes(6).toString("hex");
  lastDebugDir= `/tmp/debug-${lastRunId}`;
  ensureDir(lastDebugDir);
  writePlaceholderShot();

  res.setHeader("Content-Type","text/plain; charset=utf-8");
  res.send(`Run ${lastRunId} started. Check /health and /debug for status.`);

  (async () => {
    const startedAt = nowLocal();
    let failAlertsSent = 0;

    console.log(`\n====== BOT RUN ${lastRunId} ======`);
    console.log(`Started: ${startedAt}`);
    console.log(`Accounts: ${cfg.accounts.length}`);
    console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
    console.log(`Force mobile: ${FORCE_MOBILE_MODE}`);
    console.log(`Code length: ${code.length}`);

    try {
      await sendEmail(
        `T-Bot | Run ${lastRunId} started`,
        `Started: ${startedAt}\nAccounts: ${cfg.accounts.length}\nURLs: ${LOGIN_URLS.length}\n`
      );

      const results = [];

      for (const account of cfg.accounts) {
        console.log(`\n====== Account: ${account.username} ======`);
        const r = await runAccountAllUrls(account, code, LOGIN_URLS);
        results.push({ username:account.username, ...r });

        if (!r.ok) {
          lastError = `${account.username}: ${r.error}`;
          if (failAlertsSent < EMAIL_MAX_FAIL_ALERTS) {
            failAlertsSent++;
            await sendEmail(
              `T-Bot | Run ${lastRunId} FAILED: ${account.username}`,
              `Account: ${account.username}\nRun: ${lastRunId}\nTime: ${nowLocal()}\n\nError:\n${r.error}\n`
            );
          }
        }
      }

      const finishedAt = nowLocal();
      const okCount   = results.filter(x=>x.ok).length;
      const failCount = results.length - okCount;

      const summary = results.map(r =>
        r.ok ? `✓ ${r.username} (${r.site}) - ${r.note||""}` : `✗ ${r.username} - ${r.error}`
      ).join("\n");

      console.log(`\n====== DONE: ${okCount} ok, ${failCount} failed ======`);
      console.log(summary);

      await sendEmail(
        `T-Bot | Run ${lastRunId} finished (${okCount} ok, ${failCount} failed)`,
        `Finished: ${finishedAt}\nRun: ${lastRunId}\n\n${summary}\n`
      );
    } catch(e) {
      const msg = e?.message||String(e);
      lastError = msg;
      console.log("Run error:", msg);
      await sendEmail(`T-Bot | Run ${lastRunId} CRASHED`, `Crashed: ${nowLocal()}\n\n${msg}\n`);
    } finally {
      isRunning = false;
    }
  })();
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`T-Bot listening on port ${PORT}`);
  console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
  console.log(`Force mobile: ${FORCE_MOBILE_MODE}`);
  console.log(`Email configured: ${emailConfigured()}`);
  writePlaceholderShot();
});
