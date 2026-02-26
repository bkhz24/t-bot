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
const BOT_PASSWORD = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString().trim();
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

// --------------------
// FLAGS
// --------------------
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "1"); // keep ON while stabilizing
const FORCE_MOBILE = envTruthy(process.env.FORCE_MOBILE || "0");

// API rewrite (OFF by default)
const API_REWRITE = envTruthy(process.env.API_REWRITE || "0");
const API_REWRITE_MATCH = (process.env.API_REWRITE_MATCH || "^api\\.").toString(); // regex string
const API_REWRITE_TARGET = (process.env.API_REWRITE_TARGET || "api.ddjea.com").toString();

// Verification toggles
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "20000");

// Retries
const LOGIN_ATTEMPTS = Number(process.env.LOGIN_ATTEMPTS || "6");
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_MAX_SITES = Number(process.env.PREFLIGHT_MAX_SITES || "2");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "2");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "20000");

// --------------------
// EMAIL (SendGrid)
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").toString();
const EMAIL_FROM_RAW = (process.env.EMAIL_FROM || "").toString().trim(); // must be email, not "Name <email>"
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
  try {
    return new Date().toLocaleString("en-US", { timeZoneName: "short" });
  } catch {
    return new Date().toISOString();
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function parseEmailFrom(raw) {
  // If user accidentally put "Name <email@x.com>", extract email
  const s = (raw || "").trim();
  const m = s.match(/<([^>]+)>/);
  const email = (m ? m[1] : s).trim();
  return email;
}

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  const fromEmail = parseEmailFrom(EMAIL_FROM_RAW);
  return !!(SENDGRID_API_KEY && fromEmail && EMAIL_TO);
}

async function sendEmail(subject, text) {
  if (!emailConfigured()) {
    console.log("Email not configured, skipping:", subject);
    return { ok: false, skipped: true, error: "Email not configured" };
  }
  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(SENDGRID_API_KEY);

    const fromEmail = parseEmailFrom(EMAIL_FROM_RAW);

    const msg = {
      to: EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
      from: { email: fromEmail, name: EMAIL_FROM_NAME },
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
    const errText = body ? JSON.stringify(body) : (e?.message || String(e));
    console.log("Email failed:", errText, "|", subject);
    return { ok: false, skipped: false, error: errText };
  }
}

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be an array" };
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

function parseLoginUrls() {
  const fallback = ["https://dsj12.cc/h5/#/login", "https://dsj88.net/pc/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function isH5Url(u) {
  return /\/h5\/#\//i.test(u || "");
}

function shouldUseMobileContext(loginUrl) {
  if (FORCE_MOBILE) return true;
  return isH5Url(loginUrl);
}

function baseFromUrl(anyUrl) {
  const u = new URL(anyUrl);
  return `${u.protocol}//${u.host}`;
}

function routePrefixFromLoginUrl(loginUrl) {
  return loginUrl.includes("/pc/#/") ? "/pc/#/" : "/h5/#/";
}

function tradeUrlFromLoginUrl(loginUrl) {
  try {
    return `${baseFromUrl(loginUrl)}${routePrefixFromLoginUrl(loginUrl)}trade`;
  } catch {
    return null;
  }
}

function futuresUrlFromLoginUrl(loginUrl) {
  try {
    return `${baseFromUrl(loginUrl)}${routePrefixFromLoginUrl(loginUrl)}contractTransaction`;
  } catch {
    return null;
  }
}

// --------------------
// Selectors (keep simple + stable)
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
  'input[placeholder*="Please enter the order code" i]',
  'input[placeholder*="order code" i]',
  'input[placeholder*="Please enter" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]'
].join(", ");

function isCloudflareErrorHtml(html) {
  const s = (html || "").toLowerCase();
  if (!s) return false;
  return (s.includes("cloudflare") && s.includes("cf-error-details")) || s.includes("error 1101") || s.includes("worker threw exception");
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

async function isVisibleInAnyFrame(page, selector) {
  for (const f of page.frames()) {
    try {
      const loc = f.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}

// --------------------
// Debug capture
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

async function saveScreenshot(page, outPath) {
  try {
    await page.screenshot({ path: outPath, fullPage: true });
    lastShotPath = outPath;
    ensureDir("/app");
    try { fs.copyFileSync(outPath, "/app/last-shot.png"); } catch {}
    return true;
  } catch (e) {
    console.log("Screenshot failed:", e?.message || String(e));
    return false;
  }
}

async function dumpDebugStep(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return null;
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag);
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  const base = path.join(dir, `${safeTag}-${stamp}`);
  try { fs.writeFileSync(`${base}.url.txt`, String(page.url() || "")); } catch {}
  try { fs.writeFileSync(`${base}.href.txt`, String(await page.evaluate(() => location.href).catch(() => "") || "")); } catch {}
  try { fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2)); } catch {}
  try { const html = await page.content().catch(() => ""); fs.writeFileSync(`${base}.html`, html || ""); } catch {}
  await saveScreenshot(page, `${base}.png`);
  return base;
}

async function captureFailure(page, tag, extra = {}) {
  await dumpDebugStep(page, `FAIL-${tag}`, extra);
}

// --------------------
// Click helpers for Futures + tabs
// --------------------
async function clickByTextSmart(page, regex, preferBottom = false) {
  // Try roles
  const roleCandidates = [
    page.getByRole("tab", { name: regex }).first(),
    page.getByRole("button", { name: regex }).first(),
    page.getByRole("link", { name: regex }).first()
  ];
  for (const c of roleCandidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.click({ timeout: 8000 }).catch(() => null);
        return { ok: true, method: "role" };
      }
    } catch {}
  }

  // Try text locator
  try {
    const t = page.getByText(regex).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click({ timeout: 8000 }).catch(() => null);
      return { ok: true, method: "text" };
    }
  } catch {}

  // DOM scan: click best matching element (prefer bottom for mobile nav)
  try {
    const res = await page.evaluate(({ source, flags, preferBottom }) => {
      const re = new RegExp(source, flags);
      const els = Array.from(document.querySelectorAll("a,button,[role='tab'],[role='button'],[onclick],div,span,li"));
      function visible(el) {
        const s = getComputedStyle(el);
        if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom < 0 || r.right < 0) return false;
        if (r.top > innerHeight || r.left > innerWidth) return false;
        return true;
      }
      function clickable(el) {
        const tag = (el.tagName || "").toLowerCase();
        const role = (el.getAttribute("role") || "").toLowerCase();
        const cursor = getComputedStyle(el).cursor;
        return tag === "a" || tag === "button" || role === "tab" || role === "button" || cursor === "pointer" || el.hasAttribute("onclick");
      }

      const matches = [];
      for (const el of els) {
        if (!visible(el)) continue;
        const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        if (!txt) continue;
        if (!re.test(txt)) continue;

        const r = el.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const bottomScore = preferBottom ? (y / innerHeight) : 0;
        const clickScore = clickable(el) ? 1 : 0;

        matches.push({ el, txt: txt.slice(0, 50), score: clickScore * 10 + bottomScore * 6 });
      }
      matches.sort((a, b) => b.score - a.score);
      if (!matches[0]) return { ok: false };
      matches[0].el.click();
      return { ok: true, txt: matches[0].txt };
    }, { source: regex.source, flags: regex.flags, preferBottom });

    if (res?.ok) return { ok: true, method: "dom", detail: res.txt };
  } catch {}

  return { ok: false };
}

async function tapBottomCenter(page) {
  const vp = page.viewportSize() || { width: 390, height: 844 };
  const x = Math.round(vp.width * 0.50);
  const y = Math.round(vp.height * 0.94);
  await page.mouse.click(x, y, { delay: 40 }).catch(() => null);
  return { x, y, w: vp.width, h: vp.height };
}

// --------------------
// Confirmation checks
// --------------------
async function waitForAlreadyFollowedToast(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off" };
  const start = Date.now();
  const re = /already\s*followed|already\s*follow|followed|success|successful|completed/i;

  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    try {
      const loc = page.getByText(re).first();
      if (await loc.isVisible().catch(() => false)) {
        const t = (await loc.textContent().catch(() => "")) || "";
        return { ok: true, type: "toast", detail: t.trim().slice(0, 200) || "toast" };
      }
    } catch {}
    await sleep(250);
  }
  return { ok: false, type: "toast_timeout" };
}

async function verifyPending(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off" };
  // click Position order tab
  await clickByTextSmart(page, /position\s*order/i, false).catch(() => null);
  await sleep(700);
  try {
    const pending = page.getByText(/pending/i).first();
    if (await pending.isVisible().catch(() => false)) return { ok: true, type: "pending" };
  } catch {}
  return { ok: false, type: "pending_missing" };
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
  if (!cfg.ok) errs.push(cfg.error || "ACCOUNTS_JSON missing/invalid.");
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
    <div>DEBUG_CAPTURE: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
    <div>FORCE_MOBILE: <b>${FORCE_MOBILE ? "ON" : "OFF"}</b></div>
    <div>API_REWRITE: <b>${API_REWRITE ? "ON" : "OFF"}</b> (${escapeHtml(API_REWRITE_MATCH)} → ${escapeHtml(API_REWRITE_TARGET)})</div>
    <div>LOGIN_URLS: <code>${escapeHtml(parseLoginUrls().join(", "))}</code></div>
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
      <a href="/health">/health</a>
      | <a href="/email-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/email-test</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
      | <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/debug</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/dns-test</a>
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
      loginUrls: parseLoginUrls(),
      debugCapture: DEBUG_CAPTURE,
      forceMobile: FORCE_MOBILE,
      apiRewrite: API_REWRITE,
      apiRewriteMatch: API_REWRITE_MATCH,
      apiRewriteTarget: API_REWRITE_TARGET
    },
    debug: { lastRunId, lastDebugDir, lastShotPath, stableShotPath: "/app/last-shot.png" },
    email: {
      enabled: EMAIL_ENABLED,
      provider: EMAIL_PROVIDER,
      configured: emailConfigured(),
      from: parseEmailFrom(EMAIL_FROM_RAW),
      fromName: EMAIL_FROM_NAME,
      to: EMAIL_TO
    }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const result = await sendEmail("T-Bot | email test", `Email test sent at ${nowLocal()}`);
  res.json({ ok: true, result, emailConfigured: emailConfigured() });
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
    <div>Last debug dir: <code>${escapeHtml(lastDebugDir || "-")}</code></div>
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
  const hosts = ["dsj88.net", "dsj35.com", "dsj12.cc", "dsj877.com", "api.ddjea.com", "api.sendgrid.com"];
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

// --------------------
// RUN
// --------------------
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
    const subjectPrefix = `T-Bot | Run ${lastRunId}`;
    let failAlertsSent = 0;

    try {
      const loginUrls = parseLoginUrls();

      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Order code length:", code.length);
      console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
      console.log("FORCE_MOBILE:", FORCE_MOBILE);
      console.log("LOGIN_URLS:", loginUrls.join(", "));
      console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
      console.log("Email configured:", emailConfigured());

      await sendEmail(`${subjectPrefix} started`, `Started: ${nowLocal()}\nAccounts: ${cfg.accounts.length}\n`);

      const runSites = await pickSitesByPreflight(loginUrls);
      console.log("Chosen sites for this run:", runSites.join(", "));

      const results = [];

      for (const account of cfg.accounts) {
        try {
          const used = await runAccountAllSites(account, code, runSites);
          results.push({ username: account.username, ok: true, site: used.site, note: used.note || "" });
        } catch (e) {
          const msg = e?.message || String(e);
          results.push({ username: account.username, ok: false, error: msg });
          lastError = `Account failed ${account.username}: ${msg}`;

          if (EMAIL_ACCOUNT_FAIL_ALERTS && failAlertsSent < EMAIL_MAX_FAIL_ALERTS) {
            failAlertsSent += 1;
            await sendEmail(`${subjectPrefix} account FAILED: ${account.username}`, `Error:\n${msg}\n\nDebug: /debug?p=YOUR_PASSWORD\n`);
          }
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      const lines = results.map((r) => r.ok ? `SUCCESS: ${r.username} (${r.site}) ${r.note}` : `FAIL: ${r.username} (${r.error})`);

      await sendEmail(
        `${subjectPrefix} finished (${okCount} ok / ${failCount} failed)`,
        `Finished: ${nowLocal()}\n\n${lines.join("\n")}\n\nDebug: /debug?p=YOUR_PASSWORD\n`
      );

      console.log("Bot completed");
    } catch (e) {
      const msg = e?.message || String(e);
      lastError = msg;
      console.log("Run failed:", msg);
      await sendEmail(`${subjectPrefix} FAILED`, `Failed: ${nowLocal()}\n\n${msg}\n\nDebug: /debug?p=YOUR_PASSWORD\n`);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Preflight: pick working sites
// --------------------
async function pickSitesByPreflight(loginUrls) {
  if (!PREFLIGHT_ENABLED) return loginUrls.slice(0, PREFLIGHT_MAX_SITES);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const good = [];
  try {
    for (const loginUrl of loginUrls) {
      let ok = false;

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
        try {
          const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await sleep(600);

          const status = resp ? resp.status() : null;
          const html = await page.content().catch(() => "");

          if (status && status >= 400) throw new Error(`HTTP ${status}`);
          if (isCloudflareErrorHtml(html)) throw new Error("Cloudflare error page");

          const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, PREFLIGHT_LOGIN_WAIT_MS);
          if (!userRes.ok) throw new Error("User field not found");

          await dumpDebugStep(page, "preflight-ok", { loginUrl, status, mobile });
          console.log("Preflight OK:", loginUrl);
          ok = true;
          await context.close().catch(() => null);
          break;
        } catch (e) {
          await dumpDebugStep(page, `preflight-failed-${i}`, { loginUrl, err: e?.message || String(e) });
          await context.close().catch(() => null);
          await sleep(800);
        }
      }

      if (ok) {
        good.push(loginUrl);
        if (good.length >= PREFLIGHT_MAX_SITES) break;
      }
    }

    return good.length ? good : loginUrls.slice(0, PREFLIGHT_MAX_SITES);
  } finally {
    await browser.close().catch(() => null);
  }
}

// --------------------
// Runner
// --------------------
async function runAccountAllSites(account, orderCode, runSites) {
  let lastErr = null;

  for (const loginUrl of runSites) {
    console.log("----");
    console.log("Account:", account.username);
    console.log("Trying site:", loginUrl, "for", account.username);

    try {
      const note = await runAccountOnSite(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl);
      return { site: loginUrl, note };
    } catch (e) {
      const msg = e?.message || String(e);
      console.log("Site failed:", loginUrl, "for", account.username, "err:", msg);
      lastErr = e;
    }
  }

  throw lastErr || new Error("All sites failed");
}

function buildApiRewriteRegex() {
  try {
    return new RegExp(API_REWRITE_MATCH, "i");
  } catch {
    return /^api\./i;
  }
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

  // API rewrite: OFF by default
  if (API_REWRITE) {
    const re = buildApiRewriteRegex();
    await page.route("**/*", async (route) => {
      try {
        const req = route.request();
        const u = new URL(req.url());
        if (re.test(u.hostname)) {
          const newUrl = `${u.protocol}//${API_REWRITE_TARGET}${u.pathname}${u.search}`;
          return route.continue({ url: newUrl });
        }
      } catch {}
      return route.continue();
    });
  }

  // Capture login API success
  let loginApiOk = false;
  let loginApiDetail = null;

  page.on("response", async (resp) => {
    try {
      const u = resp.url();
      if (/\/api\/app\/user\/login/i.test(u)) {
        const status = resp.status();
        const body = await resp.text().catch(() => "");
        loginApiDetail = { status, url: u, bodyPreview: (body || "").slice(0, 400) };
        if (status >= 200 && status < 300) loginApiOk = true;
      }
    } catch {}
  });

  page.on("pageerror", (err) => console.log("PAGE ERROR:", err?.message || String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("PAGE CONSOLE error:", msg.text()); });
  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f?.errorText || "unknown";
    if (req.url().includes("/api/")) console.log("REQ FAILED:", req.url(), "=>", errText);
  });

  async function assertNotOnLogin(tag) {
    const href = await page.evaluate(() => location.href).catch(() => "");
    const onLogin = /\/login\b|#\/login\b/i.test(href || "") || (await isVisibleInAnyFrame(page, USER_SELECTORS) && await isVisibleInAnyFrame(page, PASS_SELECTORS));
    if (onLogin) {
      await dumpDebugStep(page, `kicked-to-login-${tag}`, { href });
      throw new Error("Kicked back to login (stopping to avoid typing code into email).");
    }
  }

  try {
    // 1) Go login
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(900);

    const html0 = await page.content().catch(() => "");
    if (isCloudflareErrorHtml(html0)) {
      await captureFailure(page, "cloudflare-login", { loginUrl, status: resp?.status?.() });
      throw new Error("Cloudflare error page on login");
    }

    await dumpDebugStep(page, "after-goto-login", { loginUrl, mobile, status: resp?.status?.() });

    // 2) Login attempts
    let loggedIn = false;

    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
      loginApiOk = false;
      loginApiDetail = null;

      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(900);
      await closeOverlays(page);

      const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 20000);
      const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 20000);
      if (!userRes.ok || !passRes.ok) {
        await dumpDebugStep(page, `login-fields-missing-${attempt}`, { userFound: userRes.ok, passFound: passRes.ok });
        continue;
      }

      await userRes.locator.fill("").catch(() => null);
      await passRes.locator.fill("").catch(() => null);

      await userRes.locator.click().catch(() => null);
      await userRes.locator.fill(account.username).catch(() => null);
      await sleep(150);

      await passRes.locator.click().catch(() => null);
      await passRes.locator.fill(account.password).catch(() => null);
      await sleep(150);

      // Click login (robust)
      const loginButtons = [
        page.getByRole("button", { name: /login|sign in/i }).first(),
        page.locator('button[type="submit"]').first(),
        page.getByText(/^login$/i).first(),
        page.getByText(/login/i).first()
      ];

      let clicked = false;
      for (const b of loginButtons) {
        try {
          if (await b.isVisible().catch(() => false)) {
            await b.click({ timeout: 10000 }).catch(() => null);
            clicked = true;
            break;
          }
        } catch {}
      }
      if (!clicked) {
        await passRes.locator.press("Enter").catch(() => null);
      }

      await sleep(1200);

      // Hard signals:
      // A) /api/app/user/login returns 200
      // B) we leave /login route
      // C) token shows up in storage
      const href = await page.evaluate(() => location.href).catch(() => "");
      const leftLogin = href && !/\/login\b|#\/login\b/i.test(href);

      const tokenHint = await page.evaluate(() => {
        const stores = [localStorage, sessionStorage];
        const hits = [];
        for (const st of stores) {
          try {
            for (let i = 0; i < st.length; i++) {
              const k = st.key(i);
              const v = st.getItem(k);
              if (!k || !v) continue;
              const kk = k.toLowerCase();
              if (kk.includes("token") || kk.includes("auth") || kk.includes("access")) {
                hits.push({ k, preview: String(v).slice(0, 60) });
              }
            }
          } catch {}
        }
        return hits.slice(0, 6);
      }).catch(() => []);

      await dumpDebugStep(page, `after-login-attempt-${attempt}`, {
        attempt,
        clicked,
        href,
        loginApiOk,
        loginApiDetail,
        tokenHint
      });

      if (loginApiOk || leftLogin || (tokenHint && tokenHint.length)) {
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      await captureFailure(page, "login-failed", { loginUrl, loginApiDetail });
      throw new Error("Login failed (no successful login API / no token / never left login).");
    }

    // 3) Go to TRADE page first (stabilizes bottom nav)
    const tradeUrl = tradeUrlFromLoginUrl(loginUrl);
    if (tradeUrl) {
      await page.goto(tradeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
      await sleep(900);
      await closeOverlays(page);
      await dumpDebugStep(page, "after-trade", { tradeUrl, mobile });
    }

    await assertNotOnLogin("after-trade");

    // 4) Navigate to Futures
    if (mobile) {
      // Mobile: click bottom "Futures" text/icon or tap bottom-center
      let ok = (await clickByTextSmart(page, /^futures$/i, true)).ok;
      if (!ok) ok = (await clickByTextSmart(page, /futures/i, true)).ok;

      if (!ok) {
        for (let i = 1; i <= 3; i++) {
          const p = await tapBottomCenter(page);
          console.log(`BOTTOM-CENTER TAP attempt ${i}: x=${p.x} y=${p.y} (w=${p.w} h=${p.h})`);
          await sleep(650);
          ok = (await clickByTextSmart(page, /invited\s*me/i, false)).ok; // sometimes tab appears
          if (ok) break;
        }
      }

      // Also try direct futures URL after tap
      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(900);
        await closeOverlays(page);
      }
    } else {
      // PC: direct futures URL first (fast + stable)
      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        await sleep(900);
        await closeOverlays(page);
      }

      // If futures page is actually behind a dropdown, still try clicking Futures label
      await clickByTextSmart(page, /futures|contract/i, false).catch(() => null);
      await sleep(600);
      await closeOverlays(page);
    }

    await dumpDebugStep(page, "after-futures-nav", { mobile });

    await assertNotOnLogin("after-futures-nav");

    // 5) Click "Invited me"
    const invited = await clickByTextSmart(page, /invited\s*me/i, false);
    await sleep(700);
    await closeOverlays(page);

    await dumpDebugStep(page, "after-invited-me", { invited, mobile });

    await assertNotOnLogin("after-invited-me");

    // 6) Find code box (hard gate)
    const codeRes = await findVisibleInAnyFrame(page, ORDER_CODE_SELECTORS, 12000);
    if (!codeRes.ok) {
      await captureFailure(page, "code-box-missing", { mobile });
      throw new Error("Flow failed: code_box_missing (not on Invited me screen with code input).");
    }

    // 7) Fill order code
    await codeRes.locator.scrollIntoViewIfNeeded().catch(() => null);
    await codeRes.locator.click().catch(() => null);
    await codeRes.locator.fill(orderCode).catch(() => null);
    await sleep(450);
    await dumpDebugStep(page, "after-code-fill", { codeLength: String(orderCode).length });

    // 8) Click confirm
    const confirmCandidates = [
      page.getByRole("button", { name: /confirm/i }).first(),
      page.getByText(/^confirm$/i).first(),
      page.getByText(/confirm/i).first()
    ];

    let confirmBtn = null;
    for (const c of confirmCandidates) {
      if (await c.isVisible().catch(() => false)) { confirmBtn = c; break; }
    }
    if (!confirmBtn) {
      await captureFailure(page, "confirm-missing", {});
      throw new Error("Confirm button not found.");
    }

    await confirmBtn.click({ timeout: 10000 }).catch(() => null);
    await sleep(1200);
    await dumpDebugStep(page, "after-confirm", {});

    // 9) Verify (toast and/or pending)
    const toast = await waitForAlreadyFollowedToast(page);
    const pending = await verifyPending(page);

    await dumpDebugStep(page, "after-verify", { toast, pending });

    if (toast.ok || pending.ok) {
      return `verified: ${toast.ok ? toast.detail : "pending seen"}`;
    }

    throw new Error("No confirmation detected (no toast + no pending).");
  } catch (e) {
    const msg = e?.message || String(e);
    await captureFailure(page, "unhandled", { loginUrl, username: account.username, error: msg });
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
  console.log("FORCE_MOBILE:", FORCE_MOBILE);
  console.log("LOGIN_URLS:", parseLoginUrls().join(", "));
  console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET);
  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS, "retries:", PREFLIGHT_RETRIES, "maxSites:", PREFLIGHT_MAX_SITES);
  if (errs.length) console.log("CONFIG ERRORS:", errs);
  writePlaceholderLastShot();
});
