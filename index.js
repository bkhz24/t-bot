"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { chromium } = require("playwright");

// SendGrid Web API (HTTPS)
const sgMail = require("@sendgrid/mail");

const PORT = process.env.PORT || 8080;

// Support both BOT_PASSWORD and RUN_PASSWORD
const BOT_PASSWORD = process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

// Optional: LOGIN_URLS override from Railway (comma-separated)
const LOGIN_URLS_ENV = process.env.LOGIN_URLS || "";

// Twilio (optional, can be left blank)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// Email config
function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const EMAIL_ENABLED = envTruthy(process.env.EMAIL_ENABLED || "1");

// Choose provider:
// - sendgrid (recommended): HTTPS API, works on Railway
// - smtp (kept only for completeness, but likely blocked on Railway)
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();

const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_TO = process.env.EMAIL_TO || "";
const EMAIL_SUBJECT_PREFIX = (process.env.EMAIL_SUBJECT_PREFIX || "T-Bot").toString();

// SendGrid API
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";

// SMTP (optional fallback if your host allows SMTP)
const EMAIL_SMTP_HOST = process.env.EMAIL_SMTP_HOST || "";
const EMAIL_SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT || "587");
const EMAIL_SMTP_SECURE = envTruthy(process.env.EMAIL_SMTP_SECURE || "false"); // true for 465
const EMAIL_SMTP_USER = process.env.EMAIL_SMTP_USER || "";
const EMAIL_SMTP_PASS = process.env.EMAIL_SMTP_PASS || "";

// Neutral debug capture
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

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
// Email helper
// --------------------
function emailConfigured() {
  if (!EMAIL_ENABLED) return false;
  if (!EMAIL_FROM || !EMAIL_TO) return false;

  if (EMAIL_PROVIDER === "sendgrid") {
    return !!SENDGRID_API_KEY;
  }

  // smtp fallback
  return !!(
    EMAIL_SMTP_HOST &&
    EMAIL_SMTP_PORT &&
    EMAIL_SMTP_USER &&
    EMAIL_SMTP_PASS
  );
}

async function sendEmail(subject, text) {
  if (!EMAIL_ENABLED) return { ok: false, skipped: true, error: "EMAIL_ENABLED is off" };
  if (!EMAIL_FROM || !EMAIL_TO) return { ok: false, skipped: false, error: "EMAIL_FROM or EMAIL_TO missing" };

  const fullSubject = `${EMAIL_SUBJECT_PREFIX} | ${subject}`;

  if (EMAIL_PROVIDER === "sendgrid") {
    if (!SENDGRID_API_KEY) return { ok: false, skipped: false, error: "SENDGRID_API_KEY missing" };

    try {
      sgMail.setApiKey(SENDGRID_API_KEY);

      await sgMail.send({
        to: EMAIL_TO,
        from: EMAIL_FROM,
        subject: fullSubject,
        text
      });

      console.log("Email sent via SendGrid API:", fullSubject);
      return { ok: true, skipped: false };
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      console.log("Email failed (SendGrid API):", msg, "|", fullSubject);
      return { ok: false, skipped: false, error: msg };
    }
  }

  // SMTP fallback (likely blocked on Railway)
  try {
    // Lazy require so you can keep this file working even if you remove nodemailer later
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({
      host: EMAIL_SMTP_HOST,
      port: EMAIL_SMTP_PORT,
      secure: EMAIL_SMTP_SECURE,
      auth: { user: EMAIL_SMTP_USER, pass: EMAIL_SMTP_PASS }
    });

    await t.sendMail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: fullSubject,
      text
    });

    console.log("Email sent via SMTP:", fullSubject);
    return { ok: true, skipped: false };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.log("Email failed (SMTP):", msg, "|", fullSubject);
    return { ok: false, skipped: false, error: msg };
  }
}

// --------------------
// Twilio helper (optional)
// --------------------
let twilioClient = null;
let smsLibraryOk = false;
let smsLibraryError = null;

function initTwilioOnce() {
  if (twilioClient || smsLibraryOk || smsLibraryError) return;
  try {
    const twilio = require("twilio");
    smsLibraryOk = true;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }
  } catch (e) {
    smsLibraryOk = false;
    smsLibraryError = e.message || String(e);
  }
}

async function sendSMS(msg) {
  initTwilioOnce();
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !TWILIO_TO) return null;
  if (!twilioClient) return null;

  try {
    const res = await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: TWILIO_TO,
      body: msg
    });
    console.log("SMS sent:", res.sid);
    return res.sid;
  } catch (e) {
    console.log("SMS failed:", e.message || String(e));
    return null;
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
      const ls = await page.evaluate(() => {
        const out = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            out[k] = localStorage.getItem(k);
          }
        } catch {}
        return out;
      }).catch(() => ({}));
      fs.writeFileSync(`${base}.localstorage.json`, JSON.stringify(ls, null, 2));
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

function sanitize(s) {
  return String(s || "")
    .replaceAll("@", "_at_")
    .replaceAll(".", "_")
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .slice(0, 80);
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
  initTwilioOnce();

  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    configOk: cfg.ok,
    configError: cfg.error,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    smsLibraryOk,
    smsLibraryError,
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
    "email test",
    `Email test sent at ${nowLocal()}\n\nIf you received this, email is set up correctly.\nProvider: ${EMAIL_PROVIDER}\n`
  );

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({ ok: true, attempted: true, result }, null, 2));
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
    "smtp.sendgrid.net"
  ];

  const out = {};
  for (const h of hosts) {
    try {
      const addrs = await dns.lookup(h, { all: true });
      out[h] = { ok: true, addrs };
    } catch (e) {
      out[h] = { ok: false, error: (e && e.message) ? e.message : String(e) };
    }
  }
  res.json(out);
});

app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const urls = [
    "https://bgol.pro/",
    "https://dsj89.com/",
    "https://dsj72.com/",
    "https://api.sendgrid.com/v3/user/profile"
  ];

  const results = {};
  for (const u of urls) {
    try {
      const headers = {};
      if (u.includes("api.sendgrid.com") && SENDGRID_API_KEY) {
        headers["Authorization"] = `Bearer ${SENDGRID_API_KEY}`;
      }
      const r = await fetch(u, { method: "GET", headers });
      const text = await r.text();
      results[u] = { ok: true, status: r.status, bodyPreview: text.slice(0, 240) };
    } catch (e) {
      results[u] = { ok: false, error: (e && e.message) ? e.message : String(e) };
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
    const runLabel = `Run ${lastRunId}`;

    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Code received length:", code.length);
      console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
      console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
      console.log("Email provider:", EMAIL_PROVIDER);
      console.log("Email configured:", emailConfigured());

      console.log("About to send START email...");
      const startEmailRes = await sendEmail(
        `${runLabel} started`,
        `T-Bot started at ${startedAt}\nRun ID: ${lastRunId}\nAccounts: ${cfg.accounts.length}\nDebug capture: ${DEBUG_CAPTURE ? "ON" : "OFF"}\nProvider: ${EMAIL_PROVIDER}\n`
      );
      console.log("START email result:", startEmailRes);

      await sendSMS(`T-Bot started at ${startedAt}`);

      const results = [];

      for (const account of cfg.accounts) {
        console.log("----");
        console.log("Account:", account.username);
        try {
          const used = await runAccountAllSites(account, code);
          results.push({ username: account.username, ok: true, site: used });
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          results.push({ username: account.username, ok: false, error: msg });
          lastError = `Account failed ${account.username}: ${msg}`;
        }
      }

      const finishedAt = nowLocal();
      const anyFailed = results.some((r) => !r.ok);

      const summaryLines = results.map((r) => {
        if (r.ok) return `OK: ${r.username} (${r.site})`;
        return `FAIL: ${r.username} (${r.error})`;
      });

      console.log("About to send FINISH email...");
      const finishEmailRes = await sendEmail(
        `${runLabel} ${anyFailed ? "finished with failures" : "completed"}`,
        `T-Bot finished at ${finishedAt}\nRun ID: ${lastRunId}\n\nResults:\n${summaryLines.join("\n")}\n`
      );
      console.log("FINISH email result:", finishEmailRes);

      await sendSMS(anyFailed ? `T-Bot finished with failures at ${finishedAt}` : `T-Bot completed at ${finishedAt}`);

      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;

      const failedAt = nowLocal();
      console.log("About to send FAILED email...");
      const failEmailRes = await sendEmail(
        `Run ${lastRunId} FAILED`,
        `T-Bot failed at ${failedAt}\nRun ID: ${lastRunId}\nError: ${msg}\n`
      );
      console.log("FAILED email result:", failEmailRes);

      await sendSMS(`T-Bot failed at ${failedAt}: ${msg}`);
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
      await runAccountOnSite(account, orderCode, loginUrl);
      console.log("SUCCESS:", account.username, "on", loginUrl);
      return loginUrl;
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

  const harPath = DEBUG_CAPTURE && lastDebugDir
    ? path.join(lastDebugDir, `har-${sanitize(account.username)}-${Date.now()}.har`)
    : null;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    recordHar: harPath ? { path: harPath, content: "embed" } : undefined
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = (f && f.errorText) ? f.errorText : "unknown";
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

    const userField = page.locator('input[type="email"], input[type="text"]').first();
    const passField = page.locator('input[type="password"]').first();

    await userField.waitFor({ timeout: 20000 });
    await passField.waitFor({ timeout: 20000 });

    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      await userField.fill("");
      await passField.fill("");

      await userField.click({ timeout: 5000 });
      await userField.fill(account.username);
      await sleep(250);

      await passField.click({ timeout: 5000 });
      await passField.fill(account.password);
      await sleep(250);

      const loginBtn = page.getByRole("button", { name: /login/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 });
      } else {
        await passField.press("Enter");
      }

      await sleep(1800);
      await dumpDebugState(page, `after-login-attempt-${attempt}`, { attempt });

      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1500);
        await dumpDebugState(page, "after-futures-direct", { futuresUrl: fu });

        const hasInvitedTab = await page.locator("text=/invited me/i").first().isVisible().catch(() => false);
        const hasPositionOrder = await page.locator("text=Position order").first().isVisible().catch(() => false);

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

    const codeBox = page.locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i]').first();
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

    await confirmBtn.click({ timeout: 10000 });
    await sleep(1500);
    await dumpDebugState(page, "after-confirm", {});
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
  console.log("Email configured:", emailConfigured());
  console.log("Email provider:", EMAIL_PROVIDER);
  writePlaceholderLastShot();
});
