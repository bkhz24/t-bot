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

// Neutral debug capture
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

// --------------------
// Email config (SendGrid Web API)
// --------------------
const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = (process.env.EMAIL_FROM || "").toString().trim(); // must match verified sender
const EMAIL_FROM_NAME = (process.env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
const EMAIL_TO_RAW = (process.env.EMAIL_TO || "").toString().trim();

// Alert controls
const EMAIL_ACCOUNT_FAIL_ALERTS = envTruthy(process.env.EMAIL_ACCOUNT_FAIL_ALERTS || "1");
const EMAIL_MAX_FAIL_ALERTS = Number(process.env.EMAIL_MAX_FAIL_ALERTS || "2");

// Verification controls
const VERIFY_TOAST = envTruthy(process.env.VERIFY_TOAST || "1");
const VERIFY_PENDING = envTruthy(process.env.VERIFY_PENDING || "1");
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || "18000");

// Confirm click retries (kept)
const CONFIRM_RETRIES = Number(process.env.CONFIRM_RETRIES || "3");
const CONFIRM_RETRY_DELAY_MS = Number(process.env.CONFIRM_RETRY_DELAY_MS || "1500");

// New: recovery when site glitches and kicks you out after confirm
const CONFIRM_RECOVER_ON_LOGOUT = envTruthy(process.env.CONFIRM_RECOVER_ON_LOGOUT || "1");
const CONFIRM_RECOVER_MAX = Number(process.env.CONFIRM_RECOVER_MAX || "1");

// New: extra wait after confirm click before checking detectors (helps slow UI)
const CONFIRM_POST_CLICK_SETTLE_MS = Number(process.env.CONFIRM_POST_CLICK_SETTLE_MS || "800");

// Preflight (fast skip dead sites)
const PREFLIGHT_ENABLED = envTruthy(process.env.PREFLIGHT_ENABLED || "1");
const PREFLIGHT_LOGIN_WAIT_MS = Number(process.env.PREFLIGHT_LOGIN_WAIT_MS || "5000");
const PREFLIGHT_RETRIES = Number(process.env.PREFLIGHT_RETRIES || "3");
const PREFLIGHT_RETRY_DELAY_MS = Number(process.env.PREFLIGHT_RETRY_DELAY_MS || "1500");

// New: allow more time for login fields when site is loaded but slow
const LOGIN_FIELD_WAIT_MS = Number(process.env.LOGIN_FIELD_WAIT_MS || "20000");

// New: treat 4xx/5xx at goto as immediate skip
const PREFLIGHT_FAIL_ON_HTTP = envTruthy(process.env.PREFLIGHT_FAIL_ON_HTTP || "1");

// New: detect explicit confirm error messages
const DETECT_CONFIRM_ERRORS = envTruthy(process.env.DETECT_CONFIRM_ERRORS || "1");

// New: poll interval for toast/outcome checks
const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS || "120");

function parseEmailTo(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const EMAIL_TO = parseEmailTo(EMAIL_TO_RAW);

function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (EMAIL_PROVIDER !== "sendgrid") return false;
  return !!(SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO.length);
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

    const msg = {
      to: EMAIL_TO,
      from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      subject,
      text
    };

    const [res] = await sgMail.send(msg);
    const status = res && res.statusCode ? res.statusCode : null;
    const msgId =
      (res && res.headers && (res.headers["x-message-id"] || res.headers["X-Message-Id"])) || null;

    console.log("Email sent:", { status, msgId, to: EMAIL_TO });
    return { ok: true, skipped: false, status, msgId, to: EMAIL_TO };
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
// Preflight site gate
// --------------------
async function preflightSite(page, loginUrl) {
  if (!PREFLIGHT_ENABLED) return { ok: true, note: "preflight_off" };

  let lastErr = null;

  for (let i = 1; i <= PREFLIGHT_RETRIES; i++) {
    try {
      const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      if (PREFLIGHT_FAIL_ON_HTTP) {
        const status = resp ? resp.status() : null;
        if (status && status >= 400) {
          throw new Error(`Preflight failed: HTTP ${status}`);
        }
      }

      const userField = page.locator('input[type="email"], input[type="text"]').first();
      await userField.waitFor({ timeout: PREFLIGHT_LOGIN_WAIT_MS });

      return { ok: true, note: "preflight_ok" };
    } catch (e) {
      lastErr = e;
      console.log(`Preflight attempt ${i} failed for ${loginUrl} err:`, e && e.message ? e.message : String(e));
      await dumpDebugState(page, `preflight-failed-${i}`, { loginUrl, err: e && e.message ? e.message : String(e) });
      await sleep(PREFLIGHT_RETRY_DELAY_MS);
    }
  }

  throw lastErr || new Error("Preflight failed");
}

// --------------------
// Confirmation gates
// --------------------
async function findToastText(page) {
  // Many frameworks use role=alert / aria-live regions
  const candidates = [
    '[role="alert"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    ".van-toast",
    ".van-notify",
    ".el-message",
    ".el-notification",
    ".ant-message",
    ".ant-notification",
    ".toast",
    ".Toastify",
    ".message",
    ".notify"
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    const vis = await loc.isVisible().catch(() => false);
    if (!vis) continue;

    const txt = await loc.innerText().catch(() => "");
    const cleaned = (txt || "").trim();
    if (cleaned) return cleaned.slice(0, 300);
  }

  return "";
}

function matchAny(text, regexes) {
  const t = (text || "").toString();
  return regexes.find((re) => re.test(t)) || null;
}

async function waitForToastOrModal(page) {
  if (!VERIFY_TOAST) return { ok: false, type: "toast_off", detail: "VERIFY_TOAST disabled" };

  const successPatterns = [
    /already followed/i,
    /followed the order/i,
    /order followed/i,
    /success/i,
    /successful/i,
    /completed/i,
    /confirm success/i
  ];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    const toastText = await findToastText(page);

    // Also allow plain page text matches if toast is not in common containers
    const bodyText = toastText
      ? toastText
      : await page.locator("body").innerText().catch(() => "");

    const hit = matchAny(bodyText || "", successPatterns);
    if (hit) {
      return { ok: true, type: "toast", detail: (bodyText || "").trim().slice(0, 180) };
    }

    await sleep(VERIFY_POLL_MS);
  }

  return { ok: false, type: "toast_timeout", detail: "No confirmation toast/modal found" };
}

async function verifyPendingInPositionOrder(page) {
  if (!VERIFY_PENDING) return { ok: false, type: "pending_off", detail: "VERIFY_PENDING disabled" };

  // tab label variants
  const tabLocators = [
    page.locator("text=/position order/i").first(),
    page.locator("text=/position orders/i").first(),
    page.locator("text=/orders/i").first()
  ];

  for (const tab of tabLocators) {
    const canClick = await tab.isVisible().catch(() => false);
    if (canClick) {
      await tab.click({ timeout: 8000 }).catch(() => null);
      await sleep(900);
      break;
    }
  }

  const pendingPatterns = [/pending/i];

  const start = Date.now();
  while (Date.now() - start < VERIFY_TIMEOUT_MS) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (matchAny(bodyText || "", pendingPatterns)) {
      return { ok: true, type: "pending", detail: "Pending found in Position order" };
    }
    await sleep(VERIFY_POLL_MS);
  }

  return { ok: false, type: "pending_timeout", detail: "No Pending found in Position order" };
}

async function detectConfirmError(page) {
  if (!DETECT_CONFIRM_ERRORS) return { ok: false, detail: "error_detection_off" };

  // Common failure patterns you actually want to treat as a real fail
  const errorPatterns = [
    /invalid/i,
    /expired/i,
    /incorrect/i,
    /not found/i,
    /failed/i,
    /error/i,
    /try again/i,
    /too (many|much)/i,
    /forbidden/i,
    /not eligible/i,
    /insufficient/i,
    /captcha/i,
    /risk/i,
    /suspended/i,
    /please log in/i
  ];

  const toastText = await findToastText(page);
  const bodyText = await page.locator("body").innerText().catch(() => "");

  const combined = `${toastText}\n${bodyText}`.slice(0, 8000);
  const hit = matchAny(combined, errorPatterns);
  if (hit) {
    // Reduce noise and return a meaningful snippet
    const snippet = (toastText && toastText.trim()) ? toastText.trim() : (bodyText || "").trim().slice(0, 240);
    return { ok: true, detail: `Confirm error detected: ${snippet}` };
  }

  return { ok: false, detail: "no_error_detected" };
}

async function isBackOnLoginForm(page) {
  const userField = page.locator('input[type="email"], input[type="text"]').first();
  const passField = page.locator('input[type="password"]').first();
  const u = await userField.isVisible().catch(() => false);
  const p = await passField.isVisible().catch(() => false);
  return u && p;
}

async function verifyOrderOutcome(page) {
  // If the site glitches and throws you back to login, that is a real failure signal
  if (await isBackOnLoginForm(page)) {
    return { ok: false, type: "logged_out", detail: "Returned to login form (likely kicked out)" };
  }

  // If site shows explicit error, fail fast with reason
  const err = await detectConfirmError(page);
  if (err.ok) {
    return { ok: false, type: "confirm_error", detail: err.detail };
  }

  // Success gates
  const toastRes = await waitForToastOrModal(page);
  if (toastRes.ok) return { ok: true, type: "toast", detail: toastRes.detail };

  const pendingRes = await verifyPendingInPositionOrder(page);
  if (pendingRes.ok) return { ok: true, type: "pending", detail: pendingRes.detail };

  return {
    ok: false,
    type: "no_confirmation",
    detail: `No confirmation. Toast: ${toastRes.type}. Pending: ${pendingRes.type}.`
  };
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
    <div>Email to: <b>${escapeHtml(EMAIL_TO.join(", "))}</b></div>

    <div>Verify toast: <b>${VERIFY_TOAST ? "ON" : "OFF"}</b></div>
    <div>Verify pending: <b>${VERIFY_PENDING ? "ON" : "OFF"}</b></div>
    <div>Verify timeout ms: <b>${VERIFY_TIMEOUT_MS}</b></div>
    <div>Confirm retries: <b>${CONFIRM_RETRIES}</b></div>
    <div>Confirm recover on logout: <b>${CONFIRM_RECOVER_ON_LOGOUT ? "ON" : "OFF"}</b> (max ${CONFIRM_RECOVER_MAX})</div>

    <div>Preflight enabled: <b>${PREFLIGHT_ENABLED ? "ON" : "OFF"}</b> loginWaitMs: <b>${PREFLIGHT_LOGIN_WAIT_MS}</b></div>

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
    emailTo: EMAIL_TO,
    debugCapture: DEBUG_CAPTURE,
    lastDebugDir,
    loginUrls: LOGIN_URLS,
    verify: {
      toast: VERIFY_TOAST,
      pending: VERIFY_PENDING,
      timeoutMs: VERIFY_TIMEOUT_MS,
      pollMs: VERIFY_POLL_MS,
      confirmRetries: CONFIRM_RETRIES,
      confirmRetryDelayMs: CONFIRM_RETRY_DELAY_MS,
      recoverOnLogout: CONFIRM_RECOVER_ON_LOGOUT,
      recoverMax: CONFIRM_RECOVER_MAX,
      detectConfirmErrors: DETECT_CONFIRM_ERRORS
    },
    preflight: {
      enabled: PREFLIGHT_ENABLED,
      loginWaitMs: PREFLIGHT_LOGIN_WAIT_MS,
      retries: PREFLIGHT_RETRIES,
      retryDelayMs: PREFLIGHT_RETRY_DELAY_MS,
      failOnHttp: PREFLIGHT_FAIL_ON_HTTP
    }
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const result = await sendEmail(
    "T-Bot | email test",
    `Email test sent at ${nowLocal()}\n\nIf you received this, SendGrid Web API is set up correctly.\n\nFrom: ${EMAIL_FROM}\nTo: ${EMAIL_TO.join(", ")}\n`
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
    "bgol.pro",
    "dsj89.com",
    "dsj72.com",
    "api.bgol.pro",
    "api.dsj89.com",
    "api.dsj72.com",
    "api.ddjea.com",
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

  const urls = ["https://bgol.pro/", "https://dsj89.com/", "https://dsj72.com/", "https://api.sendgrid.com/"];

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
      console.log("Email from/to:", EMAIL_FROM, EMAIL_TO.join(", "));
      console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
      console.log("Confirm retries:", CONFIRM_RETRIES);
      console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);
      console.log("Preflight retries:", PREFLIGHT_RETRIES, "retryDelayMs:", PREFLIGHT_RETRY_DELAY_MS);

      await sendEmail(
        `${subjectPrefix} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nDebug capture: ${
          DEBUG_CAPTURE ? "ON" : "OFF"
        }\n\nYou will get a completion email with per-account results.\n`
      );

      const results = [];

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);

        try {
          const used = await runAccountAllSites(account, code);
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
async function runAccountAllSites(account, orderCode) {
  let last = null;

  for (const loginUrl of LOGIN_URLS) {
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

  throw last || new Error("All sites failed");
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

  async function doLoginFlow() {
    await preflightSite(page, loginUrl);

    await dumpDebugState(page, "after-goto", { loginUrl, username: account.username });

    const userField = page.locator('input[type="email"], input[type="text"]').first();
    const passField = page.locator('input[type="password"]').first();

    await userField.waitFor({ timeout: LOGIN_FIELD_WAIT_MS });
    await passField.waitFor({ timeout: LOGIN_FIELD_WAIT_MS });

    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(900);

      await userField.fill("").catch(() => null);
      await passField.fill("").catch(() => null);

      await userField.click({ timeout: 5000 }).catch(() => null);
      await userField.fill(account.username).catch(() => null);
      await sleep(200);

      await passField.click({ timeout: 5000 }).catch(() => null);
      await passField.fill(account.password).catch(() => null);
      await sleep(200);

      const loginBtn = page.getByRole("button", { name: /login/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 }).catch(() => null);
      } else {
        await passField.press("Enter").catch(() => null);
      }

      await sleep(1400);
      await dumpDebugState(page, `after-login-attempt-${attempt}`, { attempt });

      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1200);
        await dumpDebugState(page, "after-futures-direct", { futuresUrl: fu });

        const hasInvitedTab = await page.locator("text=/invited me/i").first().isVisible().catch(() => false);
        const hasPositionOrder = await page.locator("text=/position order/i").first().isVisible().catch(() => false);

        if (hasInvitedTab || hasPositionOrder) {
          loggedIn = true;
          console.log("Login confirmed via Futures page for", account.username, "on", loginUrl);
          break;
        }
      }

      await sleep(600);
    }

    if (!loggedIn) {
      await dumpDebugState(page, "login-failed", { loginUrl });
      throw new Error("Login failed");
    }
  }

  try {
    // Initial login
    await doLoginFlow();

    const futuresUrl = futuresUrlFromLoginUrl(loginUrl);
    if (!futuresUrl) throw new Error("Could not build Futures URL from login URL");

    await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1200);
    await dumpDebugState(page, "after-futures", { futuresUrl });

    const invited = page.locator("text=/invited me/i").first();
    if (!(await invited.isVisible().catch(() => false))) {
      await dumpDebugState(page, "invited-missing", {});
      throw new Error("Could not find Invited me tab");
    }

    await invited.click({ timeout: 10000 }).catch(() => null);
    await sleep(900);
    await dumpDebugState(page, "after-invited", {});

    const codeBox = page
      .locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i]')
      .first();
    if (!(await codeBox.isVisible().catch(() => false))) {
      await dumpDebugState(page, "code-box-missing", {});
      throw new Error("Order code input not found");
    }

    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode).catch(() => null);
    await sleep(500);
    await dumpDebugState(page, "after-code", { codeLength: String(orderCode || "").length });

    const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      await dumpDebugState(page, "confirm-missing", {});
      throw new Error("Confirm button not found");
    }

    let lastOutcome = null;
    let recoveriesUsed = 0;

    for (let i = 1; i <= CONFIRM_RETRIES; i++) {
      console.log("Confirm attempt", i, "for", account.username);

      await confirmBtn.click({ timeout: 10000 }).catch(() => null);
      await sleep(CONFIRM_POST_CLICK_SETTLE_MS);

      await dumpDebugState(page, `after-confirm-attempt-${i}`, {});

      // Evaluate outcome (success, explicit error, logged out, no-confirm)
      const outcome = await verifyOrderOutcome(page);
      lastOutcome = outcome;

      if (outcome.ok) {
        await dumpDebugState(page, "confirm-verified", { outcome });
        return outcome.detail || "verified";
      }

      // If we got kicked to login and recovery is enabled, try one recovery login and re-run this attempt
      if (
        outcome.type === "logged_out" &&
        CONFIRM_RECOVER_ON_LOGOUT &&
        recoveriesUsed < CONFIRM_RECOVER_MAX
      ) {
        recoveriesUsed += 1;
        console.log("Detected logout after confirm. Recovery login attempt", recoveriesUsed, "for", account.username);

        await dumpDebugState(page, "confirm-logout-detected", { outcome, recoveriesUsed });

        // Re-login and go back to futures
        await doLoginFlow();
        await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1200);
        await dumpDebugState(page, "after-futures-recovered", {});

        // Re-open Invited and re-enter the code
        const invited2 = page.locator("text=/invited me/i").first();
        if (await invited2.isVisible().catch(() => false)) {
          await invited2.click({ timeout: 10000 }).catch(() => null);
          await sleep(900);
        }
        await dumpDebugState(page, "after-invited-recovered", {});

        const codeBox2 = page
          .locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i]')
          .first();

        if (await codeBox2.isVisible().catch(() => false)) {
          await codeBox2.click().catch(() => null);
          await codeBox2.fill(orderCode).catch(() => null);
          await sleep(400);
        }

        await dumpDebugState(page, "after-code-recovered", {});
        // Continue loop to attempt confirm again
      } else {
        console.log("Verification not satisfied:", outcome.detail);
        await sleep(CONFIRM_RETRY_DELAY_MS);
      }
    }

    await dumpDebugState(page, "confirm-verification-failed", { lastOutcome });
    throw new Error(lastOutcome && lastOutcome.detail ? lastOutcome.detail : "Confirm verification failed");
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
  console.log("Email from/to:", EMAIL_FROM, EMAIL_TO.join(", "));
  console.log("Verify toast/pending:", VERIFY_TOAST, VERIFY_PENDING);
  console.log("Confirm retries:", CONFIRM_RETRIES);
  console.log("Preflight enabled:", PREFLIGHT_ENABLED, "loginWaitMs:", PREFLIGHT_LOGIN_WAIT_MS);
  console.log("Preflight retries:", PREFLIGHT_RETRIES, "retryDelayMs:", PREFLIGHT_RETRY_DELAY_MS);
  writePlaceholderLastShot();
});
