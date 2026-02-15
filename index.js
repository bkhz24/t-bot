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

// --------------------
// Email config (SendGrid Web API)
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = (process.env.EMAIL_FROM || "").toString().trim(); // must match verified sender
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO = (process.env.EMAIL_TO || "").toString().trim();

// Alert controls
const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

// Verification controls
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "20000");
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "3");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "1500");

// Preflight controls
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "12000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "2");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "1500");
const PREFLIGHT_MAX_GOOD_SITES = Number(process.env.PREFLIGHT_MAX_GOOD_SITES || "2"); // pick top N good sites
const PREFLIGHT_REQUIRE_AT_LEAST_ONE_OK = envTruthy(process.env.PREFLIGHT_REQUIRE_OK || "1"); // if none good, abort run

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  return !!(SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO);
}

async function sendEmail(subject, text) {
  const cfgOk = emailConfigured();
  if (!cfgOk) {
    console.log("Email not configured, skipping send.");
    return { ok: false, skipped: true, error: "Email not configured" };
  }

  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(SENDGRID_API_KEY);

    const toList = EMAIL_TO.split(",").map((x) => x.trim()).filter(Boolean);

    const msg = {
      to: toList,
      from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      subject,
      text
    };

    const [res] = await sgMail.send(msg);
    const status = res && res.statusCode ? res.statusCode : null;
    const msgId =
      (res && res.headers && (res.headers["x-message-id"] || res.headers["X-Message-Id"])) || null;

    console.log("Email sent:", { status, msgId, to: toList });
    return { ok: true, skipped: false, status, msgId, to: toList };
  } catch (e) {
    const body = e && e.response && e.response.body ? e.response.body : null;
    const errText = body ? JSON.stringify(body) : (e && e.message ? e.message : String(e));
    console.log("Email failed (SendGrid API):", errText, "|", subject);
    return { ok: false, skipped: false, error: errText };
  }
}

// --------------------
// Login URLs
// --------------------
function parseLoginUrls() {
  const fallback = [
    "https://bgol.pro/pc/#/login",
    "https://dsj89.com/pc/#/login",
    "https://dsj72.com/pc/#/login"
  ];

  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;

  const list = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return list.length ? list : fallback;
}

const LOGIN_URLS = parseLoginUrls();

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
      password: String(a.password || "")
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

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
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

function safeListDir(dir) {
  try {
    return fs.readdirSync(dir).filter((x) => !x.includes(".."));
  } catch {
    return [];
  }
}

// --------------------
// Selectors + blockers
// --------------------
const USERNAME_SELECTOR = [
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

const PASSWORD_SELECTOR = [
  'input[type="password"]',
  'input[name*="pass" i]',
  'input[placeholder*="pass" i]'
].join(", ");

const BLOCKED_TEXT_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /human verification/i,
  /security check/i,
  /access denied/i,
  /temporarily unavailable/i,
  /too many requests/i,
  /rate limit/i,
  /cloudflare/i
];

async function pageLooksBlocked(page) {
  try {
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const t = (bodyText || "").slice(0, 3000);
    for (const re of BLOCKED_TEXT_PATTERNS) {
      if (re.test(t)) return { blocked: true, reason: `Matched: ${re}` };
    }
    return { blocked: false, reason: "" };
  } catch {
    return { blocked: false, reason: "" };
  }
}

async function findVisibleInFrames(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // main frame first
    const mainLoc = page.locator(selector).first();
    if (await mainLoc.isVisible().catch(() => false)) return { where: "main", locator: mainLoc };

    // then frames
    const frames = page.frames();
    for (const fr of frames) {
      if (fr === page.mainFrame()) continue;
      const loc = fr.locator(selector).first();
      const ok = await loc.isVisible().catch(() => false);
      if (ok) return { where: "frame", locator: loc };
    }

    await sleep(250);
  }

  return { where: null, locator: null };
}

// --------------------
// Confirmation gates
// --------------------
async function waitForToastOrModal(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off", detail: "VERIFY_TOAST disabled" };

  const patterns = [
    /already followed/i,
    /followed the order/i,
    /success/i,
    /successful/i,
    /completed/i,
    /confirm success/i
  ];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    for (const re of patterns) {
      const loc = page.locator(`text=${re.source}`).first();
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

  const tab = page.locator("text=/position order/i").first();
  const canClick = await tab.isVisible().catch(() => false);
  if (canClick) {
    await tab.click({ timeout: 8000 }).catch(() => null);
    await sleep(1200);
  }

  const pending = page.locator("text=/pending/i").first();
  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    const ok = await pending.isVisible().catch(() => false);
    if (ok) {
      return { ok: true, type: "pending", detail: "Pending found in Position order" };
    }
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
// Preflight: find good sites once per run
// --------------------
async function preflightSite(loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();

  try {
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const status = resp ? resp.status() : null;
    if (status && status >= 400) {
      await dumpDebugState(page, "preflight-http-fail", { loginUrl, status });
      throw new Error(`Preflight failed: HTTP ${status}`);
    }

    await sleep(800);

    const blocked = await pageLooksBlocked(page);
    if (blocked.blocked) {
      await dumpDebugState(page, "preflight-blocked", { loginUrl, reason: blocked.reason });
      throw new Error(`Preflight blocked: ${blocked.reason}`);
    }

    const foundUser = await findVisibleInFrames(page, USERNAME_SELECTOR, PREFLIGHT_LOGIN_WAIT_MS);
    if (!foundUser.locator) {
      await dumpDebugState(page, "preflight-no-user", { loginUrl, waitedMs: PREFLIGHT_LOGIN_WAIT_MS });
      throw new Error(`locator.waitFor: Timeout ${PREFLIGHT_LOGIN_WAIT_MS}ms exceeded.`);
    }

    return { ok: true, loginUrl };
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function chooseSitesForRun() {
  if (!PREFLIGHT_ENABLED) return { chosen: LOGIN_URLS.slice(0, PREFLIGHT_MAX_GOOD_SITES), details: [] };

  const good = [];
  const details = [];

  for (const url of LOGIN_URLS) {
    let lastErr = null;

    for (let i = 1; i <= PREFLIGHT_RETRIES; i++) {
      try {
        console.log("Preflight checking:", url, "attempt", i);
        const r = await preflightSite(url);
        good.push(r.loginUrl);
        details.push({ url, ok: true });
        console.log("Preflight OK:", url);
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        lastErr = msg;
        details.push({ url, ok: false, err: msg, attempt: i });
        console.log("Preflight attempt", i, "failed for", url, "err:", msg);
        await sleep(PREFLIGHT_RETRY_DELAY_MS);
      }
    }

    if (good.length >= PREFLIGHT_MAX_GOOD_SITES) break;

    if (!good.includes(url) && lastErr) {
      console.log("Preflight: skipping", url, "final err:", lastErr);
    }
  }

  const chosen = good.slice(0, PREFLIGHT_MAX_GOOD_SITES);

  if (PREFLIGHT_REQUIRE_AT_LEAST_ONE_OK && chosen.length === 0) {
    throw new Error("No healthy sites found in preflight. Aborting run.");
  }

  console.log("Chosen sites for this run:", chosen.join(", ") || "(none)");
  return { chosen, details };
}

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const pwMissing = !BOT_PASSWORD;
  const accountsMissing = !cfg.ok;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>
    <div>Debug capture: <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
    <div>LOGIN_URLS: <code>${escapeHtml(LOGIN_URLS.join(", "))}</code></div>
    <div>Email configured: <b>${emailConfigured() ? "YES" : "NO"}</b></div>
    <div>Email provider: <b>${escapeHtml(EMAIL_PROVIDER)}</b></div>
    <div>Verify toast: <b>${VERIFY_TOAST ? "ON" : "OFF"}</b></div>
    <div>Verify pending: <b>${VERIFY_PENDING ? "ON" : "OFF"}</b></div>
    <div>Confirm retries: <b>${CONFIRM_RETRIES}</b></div>
    <div>Preflight enabled: <b>${PREFLIGHT_ENABLED ? "YES" : "NO"}</b>, loginWaitMs: <b>${PREFLIGHT_LOGIN_WAIT_MS}</b></div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD or RUN_PASSWORD not set<br/>" : ""}
      ${accountsMissing ? escapeHtml(cfg.error || "ACCOUNTS_JSON not set") : ""}
      ${lastError ? `<br/>Last error: ${escapeHtml(lastError)}` : ""}
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
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    configOk: cfg.ok,
    configError: cfg.error,
    emailConfigured: emailConfigured(),
    emailProvider: EMAIL_PROVIDER,
    debugCapture: DEBUG_CAPTURE,
    lastDebugDir,
    loginUrls: LOGIN_URLS
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const result = await sendEmail(
    "T-Bot | email test",
    `Email test sent at ${nowLocal()}\n\nIf you received this, SendGrid Web API is set up correctly.\n\nFrom: ${EMAIL_FROM}\nTo: ${EMAIL_TO}\n`
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
    res.send(`<h3>Debug</h3><div>No debug run directory yet. Set DEBUG_CAPTURE=1 and run once.</div>`);
    return;
  }

  const files = safeListDir(lastDebugDir);
  const links = files
    .map(
      (f) =>
        `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${encodeURIComponent(f)}">${escapeHtml(
          f
        )}</a></li>`
    )
    .join("");

  res.send(`
    <h3>Debug</h3>
    <div>Debug capture is <b>${DEBUG_CAPTURE ? "ON" : "OFF"}</b></div>
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

  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const hosts = [
    "dsj006.cc",
    "dsj12.cc",
    "dsj91.cc",
    "dsj96.com",
    "dsj82.com",
    "dsj85.com",
    "api.sendgrid.com"
  ];

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

app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const urls = ["https://dsj006.cc/", "https://dsj12.cc/", "https://api.sendgrid.com/"];

  const results = {};
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "GET" });
      const text = await r.text();
      results[u] = { ok: true, status: r.status, bodyPreview: text.slice(0, 240) };
    } catch (e) {
      results[u] = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  res.json(results);
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

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
  res.send("Run started. Check logs, /health, and /debug if enabled.");

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
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("Email provider:", EMAIL_PROVIDER);
      console.log("Email configured:", emailConfigured());

      // Choose sites once per run
      let chosenSites = [];
      try {
        const chosen = await chooseSitesForRun();
        chosenSites = chosen.chosen;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        await sendEmail(
          `${subjectPrefix} FAILED`,
          `T-Bot failed immediately because no healthy sites were found.\nRun ID: ${lastRunId}\nTime: ${nowLocal()}\n\nError:\n${msg}\n`
        );
        throw e;
      }

      await sendEmail(
        `${subjectPrefix} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nDebug capture: ${
          DEBUG_CAPTURE ? "ON" : "OFF"
        }\n\nChosen sites for this run:\n${chosenSites.join("\n")}\n\nYou will get a completion email with per-account results.\n`
      );

      const results = [];

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);

        try {
          const used = await runAccountAllSites(account, code, chosenSites);
          results.push({ username: account.username, ok: true, site: used.site, note: used.note });
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          results.push({ username: account.username, ok: false, error: msg });
          lastError = `Account failed ${account.username}: ${msg}`;

          if (EMAIL_ACCOUNT_FAIL_ALERTS && failAlertsSent < EMAIL_MAX_FAIL_ALERTS) {
            failAlertsSent += 1;
            await sendEmail(
              `${subjectPrefix} account FAILED: ${account.username}`,
              `Account failed: ${account.username}\nRun ID: ${lastRunId}\nTime: ${nowLocal()}\n\nError:\n${msg}\n`
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
        )}\n`
      );

      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Playwright core
// --------------------
async function runAccountAllSites(account, orderCode, sites) {
  let last = null;

  for (const loginUrl of sites) {
    console.log("Trying site:", loginUrl, "for", account.username);
    try {
      const note = await runAccountOnSite(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl);
      return { site: loginUrl, note };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.log("Site failed:", loginUrl, "for", account.username, "err:", msg);
      last = e;
    }
  }

  throw last || new Error("All chosen sites failed");
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const harPath =
    DEBUG_CAPTURE && lastDebugDir ? path.join(lastDebugDir, `har-${sanitize(account.username)}-${Date.now()}.har`) : null;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    recordHar: harPath ? { path: harPath, content: "embed" } : undefined
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f && f.errorText ? f.errorText : "unknown";
    if (req.url().includes("/api/")) console.log("REQUEST FAILED:", req.url(), "=>", errText);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("PAGE CONSOLE: error", msg.text());
  });

  page.on("pageerror", (err) => {
    console.log("PAGE ERROR:", err && err.message ? err.message : String(err));
  });

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);
    await dumpDebugState(page, "after-goto", { loginUrl, username: account.username });

    const blocked = await pageLooksBlocked(page);
    if (blocked.blocked) {
      await dumpDebugState(page, "blocked-on-login", { reason: blocked.reason });
      throw new Error(`BLOCKED: ${blocked.reason}`);
    }

    const foundUser = await findVisibleInFrames(page, USERNAME_SELECTOR, 25000);
    const foundPass = await findVisibleInFrames(page, PASSWORD_SELECTOR, 25000);

    if (!foundUser.locator || !foundPass.locator) {
      await dumpDebugState(page, "login-fields-missing", { loginUrl });
      throw new Error("Login form not found");
    }

    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      const b2 = await pageLooksBlocked(page);
      if (b2.blocked) {
        await dumpDebugState(page, "blocked-during-login", { reason: b2.reason, attempt });
        throw new Error(`BLOCKED: ${b2.reason}`);
      }

      const uField = (await findVisibleInFrames(page, USERNAME_SELECTOR, 20000)).locator;
      const pField = (await findVisibleInFrames(page, PASSWORD_SELECTOR, 20000)).locator;

      if (!uField || !pField) {
        await dumpDebugState(page, "login-fields-missing-retry", { attempt });
        continue;
      }

      await uField.fill("").catch(() => null);
      await pField.fill("").catch(() => null);

      await uField.click({ timeout: 5000 }).catch(() => null);
      await uField.fill(account.username).catch(() => null);
      await sleep(250);

      await pField.click({ timeout: 5000 }).catch(() => null);
      await pField.fill(account.password).catch(() => null);
      await sleep(250);

      const loginBtn = page.getByRole("button", { name: /login/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 }).catch(() => null);
      } else {
        await pField.press("Enter").catch(() => null);
      }

      await sleep(1800);
      await dumpDebugState(page, `after-login-attempt-${attempt}`, { attempt });

      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1500);
        await dumpDebugState(page, "after-futures-direct", { futuresUrl: fu });

        const hasInvitedTab = await page.locator("text=/invited me/i").first().isVisible().catch(() => false);
        const hasPositionOrder = await page.locator("text=/position order/i").first().isVisible().catch(() => false);

        if (hasInvitedTab || hasPositionOrder) {
          loggedIn = true;
          console.log("Login confirmed via Futures page for", account.username, "on", loginUrl);
          break;
        }
      }

      await sleep(800);
    }

    if (!loggedIn) {
      await dumpDebugState(page, "login-failed", { loginUrl });
      throw new Error("Login failed");
    }

    const futuresUrl = futuresUrlFromLoginUrl(loginUrl);
    if (!futuresUrl) throw new Error("Could not build Futures URL from login URL");

    await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);
    await dumpDebugState(page, "after-futures", { futuresUrl });

    const invited = page.locator("text=/invited me/i").first();
    if (!(await invited.isVisible().catch(() => false))) {
      await dumpDebugState(page, "invited-missing", {});
      throw new Error("Could not find Invited me tab");
    }

    await invited.click({ timeout: 10000 }).catch(() => null);
    await sleep(1200);
    await dumpDebugState(page, "after-invited", {});

    // If code box sometimes fails to show, re-click Invited and retry once
    let codeBox = page
      .locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i], input[type="text"]')
      .first();

    if (!(await codeBox.isVisible().catch(() => false))) {
      await invited.click({ timeout: 10000 }).catch(() => null);
      await sleep(1200);
      await dumpDebugState(page, "after-invited-reclick", {});
      codeBox = page
        .locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i], input[type="text"]')
        .first();
    }

    if (!(await codeBox.isVisible().catch(() => false))) {
      await dumpDebugState(page, "code-box-missing", {});
      throw new Error("Order code input not found");
    }

    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode);
    await sleep(600);
    await dumpDebugState(page, "after-code", { codeLength: String(orderCode || "").length });

    const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      await dumpDebugState(page, "confirm-missing", {});
      throw new Error("Confirm button not found");
    }

    let lastVerify = null;

    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      console.log("Confirm attempt", i, "for", account.username);
      await confirmBtn.click({ timeout: 10000 }).catch(() => null);
      await sleep(1200);
      await dumpDebugState(page, `after-confirm-attempt-${i}`, {});

      const verify = await verifyOrderFollowed(page);
      lastVerify = verify;

      if (verify.ok) {
        await dumpDebugState(page, "confirm-verified", { verify });
        return verify.detail || "verified";
      }

      console.log("Verification not satisfied:", verify.detail);
      await sleep(CONFIRM_RETRY_DELAY_MS);
    }

    await dumpDebugState(page, "confirm-verification-failed", { lastVerify });
    throw new Error(lastVerify && lastVerify.detail ? lastVerify.detail : "Confirm verification failed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("Email provider:", EMAIL_PROVIDER);
  console.log("Email configured:", emailConfigured());
  console.log("Email from/to:", EMAIL_FROM, EMAIL_TO);
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);
  console.log("Preflight retries:", PREFLIGHT_RETRIES, "retryDelayMs:", PREFLIGHT_RETRY_DELAY_MS);
  writePlaceholderLastShot();
});
