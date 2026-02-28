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

// Telegram
const TELEGRAM_TOKEN   = (process.env.TELEGRAM_TOKEN   || "").toString().trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").toString().trim();

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
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sg = require("@sendgrid/mail");
      sg.setApiKey(SENDGRID_API_KEY);
      const [res] = await sg.send({
        to: EMAIL_TO.split(",").map(s=>s.trim()).filter(Boolean),
        from: { email: parseFromEmail(EMAIL_FROM_RAW), name: EMAIL_FROM_NAME },
        subject, text
      });
      console.log(`Email OK (attempt ${attempt}): [${res?.statusCode}] ${subject}`);
      return { ok:true };
    } catch(e) {
      const err = e?.response?.body ? JSON.stringify(e.response.body) : (e?.message||String(e));
      console.log(`Email FAILED (attempt ${attempt}/3): ${subject} => ${err}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  return { ok:false, error:"failed after 3 attempts" };
}

async function sendTelegram(message) {
  return sendTelegramToChat(TELEGRAM_CHAT_ID, message);
}

async function sendTelegramToChat(chatId, message) {
  if (!TELEGRAM_TOKEN || !chatId) return { ok:false, skipped:true };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const https = require("https");
      const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "api.telegram.org",
          path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        }, (res) => {
          let data = "";
          res.on("data", c => data += c);
          res.on("end", () => {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed);
            else reject(new Error(parsed.description || "Telegram error"));
          });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      console.log(`Telegram OK (attempt ${attempt}): ${message.slice(0,60)}`);
      return { ok:true };
    } catch(e) {
      console.log(`Telegram FAILED (attempt ${attempt}/3): ${e?.message||String(e)}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  return { ok:false, error:"failed after 3 attempts" };
}

// Send Telegram notification (email removed - Telegram only)
async function notify(subject, emailBody, telegramMsg) {
  await sendTelegram(telegramMsg || `${subject}\n\n${emailBody.slice(0,300)}`).catch(e => console.log("notify telegram error:", e?.message));
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
  '.follow-input input',
  'input[placeholder*="order code" i]',
  'input[placeholder*="Please enter the order" i]',
  'input[placeholder*="enter the order" i]',
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
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const tab = page.getByText(/invited\s*me/i).first();
    if (await tab.isVisible().catch(()=>false)) {
      await tab.click({ timeout:5000 }).catch(()=>null);
      console.log("Clicked 'Invited me'");
      // Wait until the order code input actually appears (up to 8s) before returning
      const inputEnd = Date.now() + 8000;
      while (Date.now() < inputEnd) {
        const inp = page.locator(ORDER_CODE_SEL).first();
        if (await inp.isVisible().catch(()=>false)) {
          console.log("  Order code input visible");
          return true;
        }
        await sleep(300);
      }
      console.log("  Order code input not found after clicking Invited me");
      return true; // tab was clicked, input just didn't appear - let runFlow handle it
    }
    await sleep(400);
  }
  console.log("'Invited me' tab not found");
  return false;
}

// ── Verification ──────────────────────────────────────────────────────────────
// ── Gate 1: Wait for the follow/code API to return resultCode:true ────────────
async function waitForFollowCodeApi(apiPromise) {
  try {
    const result = await Promise.race([
      apiPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("api_timeout")), VERIFY_TIMEOUT_MS))
    ]);
    return result;
  } catch(e) {
    return { ok:false, type:"api_timeout", detail:e.message };
  }
}

// ── Gate 2: Verify "pending" appears in Position order tab ───────────────────
async function verifyPositionOrderPending(page) {
  const end = Date.now() + VERIFY_TIMEOUT_MS;

  // Click the "Position order" tab
  const posTab = page.getByText(/position\s*order/i).first();
  if (await posTab.isVisible().catch(()=>false)) {
    await posTab.click({ timeout:5000 }).catch(()=>null);
    console.log("  Clicked Position order tab");
    await sleep(1200);
  }

  while (Date.now() < end) {
    // Check for pending in table rows
    const pendingResult = await page.evaluate(() => {
      // Table rows
      const rows = Array.from(document.querySelectorAll('.light-table tr, .el-table__row, .order-list-item'));
      for (const r of rows) {
        const txt = (r.textContent||'').trim();
        if (/pending/i.test(txt) && txt.length > 5) {
          return { found:true, text: txt.replace(/\s+/g,' ').slice(0,200) };
        }
      }
      // Any cell
      const cells = Array.from(document.querySelectorAll('td, .el-table__cell'));
      for (const c of cells) {
        const txt = (c.textContent||'').trim();
        if (/^pending$/i.test(txt)) {
          // grab parent row text
          const row = c.closest('tr') || c.parentElement;
          return { found:true, text: (row?.textContent||txt).replace(/\s+/g,' ').slice(0,200) };
        }
      }
      return { found:false };
    }).catch(()=>({ found:false }));

    if (pendingResult.found) {
      return { ok:true, type:"pending", detail:pendingResult.text };
    }

    // Also check toasts / dialog while waiting
    const toastResult = await page.evaluate(() => {
      const msgs = Array.from(document.querySelectorAll(
        '.el-message, .el-notification, .el-message-box__content, .el-message__content'
      ));
      for (const m of msgs) {
        const s = m.getAttribute('style')||'';
        if (!s.includes('display: none') && !s.includes('display:none')) {
          const txt = (m.textContent||'').trim();
          if (txt.length > 2) return { found:true, text:txt.slice(0,150) };
        }
      }
      const dlg = document.querySelector('.successDialog-page');
      if (dlg) {
        const s = dlg.getAttribute('style')||'';
        if (!s.includes('display: none') && !s.includes('display:none')) {
          const txt = (dlg.querySelector('.content-text')?.textContent||'').trim();
          return { found:true, text: txt || 'success dialog' };
        }
      }
      return { found:false };
    }).catch(()=>({ found:false }));

    if (toastResult.found) {
      return { ok:true, type:"toast", detail:toastResult.text };
    }

    await sleep(500);
  }

  return { ok:false, type:"pending_timeout", detail:"No pending order found in Position order tab after waiting" };
}

// ── Two-gate verify: API confirmation + Position order pending ────────────────
async function verifyOrderTwoGate(page, followCodeApiPromise) {
  console.log("  Gate 1: waiting for follow/code API response...");
  const gate1 = await waitForFollowCodeApi(followCodeApiPromise);
  console.log("  Gate 1:", JSON.stringify(gate1));

  if (!gate1.ok) {
    return {
      ok: false,
      gate1, gate2: null,
      detail: `Gate1 FAILED: ${gate1.detail||gate1.type||"api not received"}`,
      summary: "❌ Gate 1 failed — server did not confirm order"
    };
  }

  console.log("  Gate 2: checking Position order tab for pending...");
  const gate2 = await verifyPositionOrderPending(page);
  console.log("  Gate 2:", JSON.stringify(gate2));

  if (!gate2.ok) {
    return {
      ok: false,
      gate1, gate2,
      detail: `Gate1 OK, Gate2 FAILED: ${gate2.detail}`,
      summary: "⚠️ Gate 1 passed (API confirmed) but no pending order visible in Position order tab"
    };
  }

  return {
    ok: true,
    gate1, gate2,
    detail: `Gate1: api ok | Gate2: ${gate2.detail}`,
    summary: `✅ CONFIRMED: API accepted + pending order visible in Position order tab\nOrder: ${gate2.detail}`
  };
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

  // ── Intercept ONLY the follow/code API — this is Gate 1's signal ──────────
  // We use a promise that resolves the moment the real order-submission API fires.
  // ANY other API (quotes, depth, etc.) is ignored here.
  let followCodeResolve = null;
  const followCodeApiPromise = new Promise(resolve => { followCodeResolve = resolve; });

  const apiResponseHandler = async (response) => {
    try {
      const url = response.url();
      // Only care about the specific order submission endpoint
      if (!url.includes('/second/share/user/follow/code') &&
          !url.includes('/follow/code') &&
          !url.includes('/user/follow')) return;
      let body = "";
      try { body = await response.text(); } catch(_) {}
      const data = JSON.parse(body);
      const ok = data?.resultCode === true;
      const detail = `${response.status()} ${url.slice(-60)} => resultCode:${data?.resultCode}, errCode:${data?.errCode}, msg:${data?.errCodeDes}`;
      console.log(`FOLLOW_CODE_API: ${detail}`);
      followCodeResolve({ ok, resultCode: data?.resultCode, errCode: data?.errCode, errCodeDes: data?.errCodeDes, detail });
    } catch(_) {}
  };
  page.on('response', apiResponseHandler);

  // ── Fill the code ─────────────────────────────────────────────────────────
  await codeBox.click({ timeout:5000 }).catch(()=>null);
  await sleep(200);
  await codeBox.fill('').catch(()=>null);
  await codeBox.pressSequentially(String(orderCode), { delay: 50 }).catch(()=>null);
  await sleep(300);

  const filled = await codeBox.inputValue().catch(()=>"");
  console.log(`Code filled: "${filled}" (expected length ${String(orderCode).length})`);
  await dumpStep(page, "after-code-fill", { filled });

  // ── Prime Vue: set followCode on parent component, call followCodeClick ───
  const vuePrimed = await page.evaluate((code) => {
    const input = document.querySelector('.follow-input input') ||
                  document.querySelector('input[placeholder*="order"]');
    if (!input) return { ok:false, reason:'no_input' };

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, code);
    else input.value = code;

    const CODE_PROPS = ['followCode','orderCode','code','inviteCode','copyCode',
                        'tradeCode','followOrderCode','inputCode','codeValue'];
    let el = input;
    let parentVm = null;
    while (el && el !== document.body) {
      if (el.__vue__) {
        const vm = el.__vue__;
        if ('currentValue' in vm) vm.currentValue = code;
        if (typeof vm.handleInput === 'function') {
          try { vm.handleInput({ target: { value: code } }); } catch(_) {}
        }
        vm.$emit('input', code);
        let pvm = vm.$parent;
        let depth = 0;
        while (pvm && depth < 10) {
          const pdata = pvm.$data || {};
          let found = false;
          for (const prop of CODE_PROPS) {
            if (prop in pdata) { pdata[prop] = code; try { pvm.$set(pvm, prop, code); } catch(_) {} found = true; }
          }
          if (found) { parentVm = pvm; break; }
          pvm = pvm.$parent;
          depth++;
        }
        break;
      }
      el = el.parentElement;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    if (parentVm) {
      const candidates = ['followCodeClick','userFollowCode','checkFollowCode','searchFollowCode','handleFollowCode'];
      for (const m of candidates) {
        if (typeof parentVm[m] === 'function') {
          try { parentVm[m](); return { ok:true, called:m }; } catch(e) {}
        }
      }
      return { ok:true, called:'none' };
    }
    return { ok:false, reason:'no_parent_vm' };
  }, String(orderCode)).catch(e => ({ ok:false, reason:String(e).slice(0,80) }));

  console.log('Vue prime:', JSON.stringify(vuePrimed));
  await sleep(400);

  // ── Click the button once (Vue prime already called followCodeClick) ───────
  const confirmBtn = page.locator('.follow-input .el-input-group__append button').first();
  const vis = await confirmBtn.isVisible().catch(()=>false);
  if (vis) {
    await confirmBtn.scrollIntoViewIfNeeded().catch(()=>null);
    await confirmBtn.click({ force: true, timeout: 5000 }).catch(()=>null);
    console.log('Confirm button clicked');
  }
  await sleep(200);
  await codeBox.press('Enter').catch(()=>null);

  // ── GATE 1: Wait for follow/code API response ─────────────────────────────
  console.log('Gate 1: waiting for follow/code API response...');
  const gate1 = await Promise.race([
    followCodeApiPromise,
    new Promise(res => setTimeout(() => res({ ok:false, detail:'api_timeout: no follow/code response in time' }), VERIFY_TIMEOUT_MS))
  ]);
  page.off('response', apiResponseHandler);
  console.log('Gate 1 result:', JSON.stringify(gate1));

  if (!gate1.ok) {
    await dumpStep(page, 'gate1-failed', {});
    // If server explicitly rejected the code as invalid, no point trying other URLs
    const isBadCode = gate1.errCode === 100001 || /invalid.param|invalid.code|code.*invalid|not.*exist/i.test(gate1.errCodeDes||'');
    return {
      ok: false,
      reason: isBadCode ? 'bad_code' : 'gate1_failed',
      detail: gate1.detail || 'follow/code API did not return resultCode:true',
      gate1, gate2: null
    };
  }

  // ── GATE 2: Check Invited me tab for the order row (already on this tab) ──
  // After the follow/code API succeeds, the order appears as a row on this tab
  // showing: Title, Trading pair, Purchase duration, Release time, Order amount
  console.log('Gate 2: checking Invited me tab for order row...');
  await sleep(1500); // let the page render the new row

  const gate2End = Date.now() + 10000;
  let gate2 = { ok:false, detail:'order row not found on Invited me tab' };

  while (Date.now() < gate2End) {
    const result = await page.evaluate((code) => {
      const pageText = (document.body.innerText || '').replace(/\s+/g, ' ');

      // 1. Order code itself visible on page
      if (code && pageText.includes(code)) {
        return { found:true, how:'order_code', text:`Order code ${code} visible on page` };
      }

      // 2. Any row with a title + release time (the order entry row)
      // Looks for cells/rows containing a title-like string + a date
      const rows = Array.from(document.querySelectorAll(
        'tr, .el-table__row, .order-row, li, .list-item, [class*="item"]'
      ));
      for (const r of rows) {
        const txt = (r.textContent || '').replace(/\s+/g,' ').trim();
        // Must have a date pattern (YYYY/MM/DD or similar) and some title text
        if (txt.length > 10 && /202\d[\/\-\.]\d{2}[\/\-\.]\d{2}/.test(txt)) {
          return { found:true, how:'order_row_with_date', text: txt.slice(0,200) };
        }
      }

      // 3. "No more" means the list loaded and has at least one entry above it
      if (/no more/i.test(pageText)) {
        // Find the entry above "No more"
        const allText = pageText;
        const noMoreIdx = allText.toLowerCase().indexOf('no more');
        const beforeNoMore = allText.slice(Math.max(0, noMoreIdx - 300), noMoreIdx).trim();
        if (beforeNoMore.length > 20) {
          return { found:true, how:'no_more_with_content', text: beforeNoMore.slice(-200) };
        }
      }

      // 4. Any visible text that looks like an order title
      if (/BG Wealth|Wealth Sharing|sharing \d+/i.test(pageText)) {
        const match = pageText.match(/(BG Wealth[^.]{0,100}|Wealth Sharing[^.]{0,100})/i);
        return { found:true, how:'order_title', text: match?.[0] || 'order title found' };
      }

      return { found:false, sample: pageText.slice(0, 200) };
    }, String(orderCode)).catch(()=>({ found:false }));

    if (result.found) {
      gate2 = { ok:true, how:result.how, detail:result.text };
      break;
    }
    if (result.sample) {
      console.log('  Gate 2 page sample:', result.sample.slice(0,120));
    }
    await sleep(500);
  }

  await dumpStep(page, 'gate2-result', { gate2ok: gate2.ok, how: gate2.how });
  console.log('Gate 2 result:', JSON.stringify(gate2));

  return {
    ok: true,
    reason: gate2.ok ? 'both_gates_passed' : 'gate1_confirmed',
    detail: gate2.ok
      ? `Gate1: API confirmed | Gate2: ${gate2.how} — ${gate2.detail}`
      : `Gate1: API confirmed (resultCode:true) | Gate2: order row not yet visible`,
    gate1, gate2
  };
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
      if (res.ok) return { ok:true, detail:res.detail, reason:res.reason, gate1:res.gate1, gate2:res.gate2, warning:res.warning };

      if (res.reason === "kicked_to_login" && attempt === 1) {
        console.log("Kicked to login mid-flow, re-logging in...");
        const relog = await login(page, account, loginUrl);
        if (!relog) break;
        continue;
      }

      await captureFailure(page, `${sanitizeFilename(account.username)}-flow-failed`,
        `Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`);
      // Use a special error class so runAccountAllUrls can bail immediately
      const err = new Error(`Flow failed: ${res.reason}${res.detail ? ` | ${res.detail}` : ""}`);
      err.reason = res.reason;
      throw err;
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
      const r = await runAccountOnUrl(account, orderCode, loginUrl);
      console.log(`✓ SUCCESS: ${account.username} on ${loginUrl} | ${r.detail||r.reason||'ok'}`);
      return { ok:true, site:loginUrl, note:r.detail, reason:r.reason, gate1:r.gate1, gate2:r.gate2, warning:r.warning };
    } catch(e) {
      console.log(`✗ FAILED: ${loginUrl} for ${account.username}: ${e?.message||String(e)}`);
      lastErr = e;
      // bad_code = server confirmed the code is invalid — no point trying other URLs
      if (e.reason === 'bad_code') {
        console.log(`  ↳ Code rejected by server (errCode 100001) — skipping remaining URLs for ${account.username}`);
        break;
      }
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

// ── Core run function (called from web UI or Telegram) ───────────────────────
function startRun(code, cfg) {
  isRunning   = true;
  lastError   = null;
  lastRunAt   = nowLocal();
  lastRunId   = crypto.randomBytes(6).toString("hex");
  lastDebugDir= `/tmp/debug-${lastRunId}`;
  ensureDir(lastDebugDir);
  writePlaceholderShot();

  (async () => {
    const startedAt = nowLocal();

    console.log(`\n====== BOT RUN ${lastRunId} ======`);
    console.log(`Started: ${startedAt}`);
    console.log(`Accounts: ${cfg.accounts.length}`);
    console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
    console.log(`Force mobile: ${FORCE_MOBILE_MODE}`);
    console.log(`Code length: ${code.length}`);

    await notify(
      `T-Bot STARTED | Code: ${code} | Run ${lastRunId}`,
      [
        `T-Bot has started a new run.`,
        ``,
        `Time:     ${startedAt}`,
        `Run ID:   ${lastRunId}`,
        `Accounts: ${cfg.accounts.length}`,
        `Code:     ${code}`,
        ``,
        `You will receive a message for each account and a final summary.`,
      ].join('\n'),
      `🚀 <b>T-Bot STARTED</b>\nCode: <code>${code}</code>\nAccounts: ${cfg.accounts.length}\nTime: ${startedAt}`
    );

    await sleep(4000);

    try {
      const results = [];

      for (const account of cfg.accounts) {
        console.log(`\n====== Account: ${account.username} ======`);
        const r = await runAccountAllUrls(account, code, LOGIN_URLS);
        results.push({ username:account.username, ...r });

        try {
          if (r.ok) {
            const g2confirmed = r.reason === 'both_gates_passed';
            const g2note = g2confirmed
              ? `Gate 2: ${(r.gate2?.how||'tab')} confirmed ✓`
              : `Gate 2: order row not yet visible (normal)`;

            await notify(
              `T-Bot | ${account.username} - ORDER CONFIRMED`,
              [
                `ORDER CONFIRMED — server accepted the order.`,
                ``,
                `Account:  ${account.username}`,
                `Site:     ${r.site || '-'}`,
                `Time:     ${nowLocal()}`,
                ``,
                `-- Gate 1: Server API --`,
                `PASSED — Server returned resultCode:true`,
                r.gate1?.detail ? `Detail: ${r.gate1.detail}` : '',
                ``,
                `-- Gate 2: Visual Check --`,
                g2confirmed
                  ? `PASSED — ${r.gate2?.how}: ${(r.gate2?.detail||'').slice(0,150)}`
                  : `NOTE — Order row not yet visible in tab (normal if page still loading)`,
              ].filter(l => l !== null).join('\n'),
              `✅ <b>ORDER CONFIRMED</b>\n<b>${account.username}</b>\nCode: <code>${code}</code>\nTime: ${nowLocal()}\nGate 1: API confirmed ✓\n${g2note}`
            );
          } else {
            lastError = `${account.username}: ${r.error}`;
            await notify(
              `T-Bot | ${account.username} - FAILED`,
              [
                `This account FAILED to place an order.`,
                ``,
                `Account: ${account.username}`,
                `Time:    ${nowLocal()}`,
                `Run ID:  ${lastRunId}`,
                ``,
                `Error: ${r.error}`,
                ``,
                r.gate1 ? `Gate 1: ${r.gate1.ok ? 'passed' : 'FAILED'} — ${r.gate1.detail || ''}` : '',
                r.gate2 ? `Gate 2: ${r.gate2.ok ? 'passed' : 'FAILED'} — ${r.gate2.detail || ''}` : '',
              ].filter(l => l !== null).join('\n'),
              `❌ <b>FAILED</b>\n<b>${account.username}</b>\nTime: ${nowLocal()}\nError: ${r.error?.slice(0,120)}`
            );
          }
        } catch(notifyErr) {
          console.log(`Notify failed for ${account.username}:`, notifyErr?.message||String(notifyErr));
        }
      }

      const finishedAt = nowLocal();
      const okCount    = results.filter(x => x.ok).length;
      const failCount  = results.filter(x => !x.ok).length;

      const summaryLines = results.map(r => {
        if (!r.ok) return `FAILED: ${r.username}\n    Error: ${r.error}`;
        const g2note = r.reason === 'both_gates_passed' ? 'API + tab confirmed' : 'API confirmed';
        return `CONFIRMED: ${r.username} (${r.site})\n    ${g2note}`;
      });

      const tgSummary = results.map(r =>
        r.ok ? `✅ ${r.username}` : `❌ ${r.username}`
      ).join('\n');

      console.log(`\n====== DONE: ${okCount} confirmed, ${failCount} failed ======`);
      console.log(summaryLines.join('\n'));

      const allOk = failCount === 0;
      await notify(
        allOk
          ? `T-Bot DONE | ${okCount}/${results.length} accounts confirmed`
          : `T-Bot DONE | ${okCount} confirmed, ${failCount} FAILED`,
        [
          `T-Bot run complete.`,
          ``,
          `Started:  ${startedAt}`,
          `Finished: ${finishedAt}`,
          `Run ID:   ${lastRunId}`,
          ``,
          `-- Results --`,
          `  Confirmed: ${okCount}`,
          `  Failed:    ${failCount}`,
          `  Total:     ${results.length}`,
          ``,
          `-- Per-account --`,
          ...summaryLines,
        ].join('\n'),
        `${allOk ? '✅' : '⚠️'} <b>T-Bot DONE</b>\n${okCount}/${results.length} confirmed\nStarted: ${startedAt}\nFinished: ${finishedAt}\n\n${tgSummary}`
      );
    } catch(e) {
      const msg = e?.message || String(e);
      lastError = msg;
      console.log("Run error:", msg);
      await notify(`T-Bot CRASHED | Run ${lastRunId}`, `Crashed: ${nowLocal()}\n\n${msg}\n`,
        `💥 <b>T-Bot CRASHED</b>\n${msg.slice(0,200)}`);
    } finally {
      isRunning = false;
    }
  })();
}

app.post("/run", async (req, res) => {
  const p    = (req.body.p    || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running.");

  const cfg = parseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error||"ACCOUNTS_JSON invalid.");

  startRun(code, cfg);
  res.setHeader("Content-Type","text/plain; charset=utf-8");
  res.send(`Run ${lastRunId} started.`);
});

// ── Telegram command polling ──────────────────────────────────────────────────
// Anyone in the authorized chat can send:
//   /run CODE   — starts a run with that code
//   /status     — reports current status
// No password needed — access is controlled by who is in the Telegram chat.
async function telegramGetUpdates(offset) {
  const https = require("https");
  return new Promise((resolve) => {
    const path = `/bot${TELEGRAM_TOKEN}/getUpdates?timeout=25&offset=${offset||0}`;
    const req = https.request({ hostname:"api.telegram.org", path, method:"GET" }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok:false, result:[] }); }
      });
    });
    req.on("error", () => resolve({ ok:false, result:[] }));
    req.end();
  });
}

async function startTelegramPolling() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — polling disabled");
    return;
  }
  console.log("Telegram polling started — send /run CODE or /status to your bot");

  let offset = 0;
  while (true) {
    try {
      const data = await telegramGetUpdates(offset);
      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message || update.channel_post;
          if (!msg) continue;

          const fromChatId = String(msg.chat?.id || "");
          const text = (msg.text || "").trim();
          const fromName = msg.from?.first_name || msg.from?.username || "someone";

          // /chatid works from ANY chat — so you can find the ID of a new group
          if (/^\/chatid/i.test(text)) {
            await sendTelegramToChat(fromChatId, `Chat ID: <code>${fromChatId}</code>\n\nPaste this into Railway as TELEGRAM_CHAT_ID`).catch(()=>{});
            continue;
          }

          // Only accept other commands from the authorized chat
          if (fromChatId !== String(TELEGRAM_CHAT_ID)) {
            console.log(`Telegram: ignored message from unauthorized chat ${fromChatId}`);
            continue;
          }
          if (/^\/status/i.test(text)) {
            const statusMsg = isRunning
              ? `⏳ <b>Bot is currently running</b>\nRun ID: ${lastRunId}\nStarted: ${lastRunAt}`
              : lastRunAt
                ? `✅ <b>Bot is idle</b>\nLast run: ${lastRunAt}\n${lastError ? '❌ Last error: '+lastError : 'Last run completed OK'}`
                : `💤 <b>Bot is idle</b>\nNo runs yet.`;
            await sendTelegram(statusMsg).catch(()=>{});
            continue;
          }

          // /run CODE
          const runMatch = text.match(/^\/run\s+([A-Za-z0-9]+)/i);
          if (runMatch) {
            const code = runMatch[1].trim();
            if (isRunning) {
              await sendTelegram(`⚠️ Bot is already running (Run ID: ${lastRunId}). Wait for it to finish.`).catch(()=>{});
              continue;
            }
            const cfg = parseAccounts();
            if (!cfg.ok) {
              await sendTelegram(`❌ Cannot start — accounts not configured: ${cfg.error}`).catch(()=>{});
              continue;
            }
            console.log(`Telegram trigger: /run ${code} from ${fromName}`);
            await sendTelegram(`👍 Got it ${fromName}! Starting run with code <code>${code}</code>...`).catch(()=>{});
            startRun(code, cfg);
            continue;
          }

          // Unknown command — send help
          if (text.startsWith('/')) {
            await sendTelegram(
              `<b>T-Bot commands:</b>\n\n/run CODE — start a run\n    Example: <code>/run 1GR0QF3KL</code>\n\n/status — check if bot is running`
            ).catch(()=>{});
          }
        }
      }
    } catch(e) {
      console.log("Telegram polling error:", e?.message||String(e));
      await sleep(5000);
    }
  }
}



// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`T-Bot listening on port ${PORT}`);
  console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
  console.log(`Force mobile: ${FORCE_MOBILE_MODE}`);
  console.log(`Email configured: ${emailConfigured()}`);
  writePlaceholderShot();
  startTelegramPolling();
});
