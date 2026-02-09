"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { chromium } = require("playwright");

const PORT = process.env.PORT || 8080;

const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// Neutral debug capture (no bypasses, just recording)
// Set DEBUG_CAPTURE=1 in Railway Variables to enable.
const DEBUG_CAPTURE = (process.env.DEBUG_CAPTURE || "").toString() === "1";

// Keep PC only as you had it when it was working better.
const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj72.com/pc/#/login"
];

// After login, go straight to the Futures trading page
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
// Twilio helper
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
let runReport = null;

// Debug artifacts: keep the latest run folder path
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

// Neutral debug state capture
async function dumpDebugState(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return;

  try {
    if (!lastDebugDir) return;
    ensureDir(lastDebugDir);

    const stamp = Date.now();
    const base = path.join(lastDebugDir, `${tag}-${stamp}`);

    // URL
    try {
      fs.writeFileSync(`${base}.url.txt`, String(page.url() || ""));
    } catch {}

    // HTML content
    try {
      const html = await page.content().catch(() => "");
      fs.writeFileSync(`${base}.html`, html || "");
    } catch {}

    // Title
    try {
      const title = await page.title().catch(() => "");
      fs.writeFileSync(`${base}.title.txt`, title || "");
    } catch {}

    // LocalStorage snapshot
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

    // Extra JSON
    try {
      fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2));
    } catch {}

    // Screenshot
    await saveShot(page, tag);
  } catch (e) {
    console.log("dumpDebugState failed:", e && e.message ? e.message : String(e));
  }
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

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
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
      | SMS test: <a href="/sms-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/sms-test</a>
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
    debugCapture: DEBUG_CAPTURE,
    lastDebugDir
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
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
    res.send(`<h3>Debug</h3><div>No debug run directory yet.</div>`);
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
    <div style="margin-top:10px;"><a href="/debug/download?p=${encodeURIComponent(BOT_PASSWORD)}">Download file list</a></div>
    <hr/>
    <ul>${links}</ul>
  `);
});

function safeListDir(dir) {
  try {
    return fs.readdirSync(dir).filter((x) => !x.includes(".."));
  } catch {
    return [];
  }
}

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

app.get("/debug/download", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  if (!lastDebugDir) return res.status(404).send("No debug dir.");

  const files = safeListDir(lastDebugDir);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(
    `Last debug dir: ${lastDebugDir}\n\nFiles:\n` +
      files.map((x) => `- ${x}`).join("\n") +
      `\n\nTip: open /debug to click files individually.\n`
  );
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

// Network tests
app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const hosts = [
    "bgol.pro",
    "dsj89.com",
    "dsj72.com",
    "api.bgol.pro",
    "api.dsj89.com",
    "api.dsj72.com",
    "api.ddjea.com"
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
    "https://api.bgol.pro/api/app/ping",
    "https://api.dsj89.com/api/app/ping",
    "https://api.dsj72.com/api/app/ping",
    "https://api.ddjea.com/api/app/ping"
  ];

  const results = {};
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: "GET" });
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

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");

  // Create a fresh debug dir per run
  if (DEBUG_CAPTURE) {
    lastDebugDir = `/tmp/debug-${lastRunId}`;
    ensureDir(lastDebugDir);
  } else {
    lastDebugDir = null;
  }

  runReport = {
    id: lastRunId,
    started: lastRunAt,
    codeLength: code.length,
    accounts: cfg.accounts.map((a) => ({
      username: a.username,
      completed: false,
      siteUsed: null,
      error: null
    })),
    status: "Running now. Refresh this page."
  };

  writePlaceholderLastShot();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

  (async () => {
    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Code received length:", code.length);

      await sendSMS(`T-Bot started at ${lastRunAt}`);

      for (let i = 0; i < cfg.accounts.length; i++) {
        const account = cfg.accounts[i];
        try {
          const used = await runAccountAllSites(account, code);
          runReport.accounts[i].completed = true;
          runReport.accounts[i].siteUsed = used;
          runReport.accounts[i].error = null;
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          runReport.accounts[i].completed = false;
          runReport.accounts[i].error = msg;
          lastError = `Account failed ${account.username}: ${msg}`;
        }
      }

      const anyFailed = runReport.accounts.some((a) => !a.completed);
      runReport.status = anyFailed ? "Finished with failures. See account errors." : "Completed successfully.";

      await sendSMS(anyFailed ? `T-Bot finished with failures at ${nowLocal()}` : `T-Bot completed at ${nowLocal()}`);
      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      runReport.status = "Run failed: " + msg;
      await sendSMS(`T-Bot failed at ${nowLocal()}: ${msg}`);
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

  // HAR recording (neutral observation)
  const harPath = DEBUG_CAPTURE && lastDebugDir
    ? path.join(lastDebugDir, `har-${sanitize(account.username)}-${Date.now()}.har`)
    : null;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
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

    for (let attempt = 1; attempt <= 8; attempt++) {
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

      const wrongPw =
        (await page.locator("text=Wrong password").first().isVisible().catch(() => false)) ||
        (await page.locator("text=wrong password").first().isVisible().catch(() => false));
      if (wrongPw) {
        throw new Error("Wrong password reported by site");
      }

      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1500);
        await dumpDebugState(page, "after-futures-direct", { futuresUrl: fu });

        const hasPositionOrder = await page.locator("text=Position order").first().isVisible().catch(() => false);
        const hasInvitedTab = await page.locator("text=/invited me/i").first().isVisible().catch(() => false);

        if (hasPositionOrder || hasInvitedTab) {
          loggedIn = true;
          console.log("Login confirmed via Futures page for", account.username, "on", loginUrl);
          break;
        }
      }

      await sleep(1200);
    }

    if (!loggedIn) {
      await dumpDebugState(page, "login-failed", { loginUrl });
      throw new Error("Login failed");
    }

    await dumpDebugState(page, "after-login", { loginUrl });

    const futuresUrl = futuresUrlFromLoginUrl(loginUrl);
    if (!futuresUrl) throw new Error("Could not build Futures URL from login URL");

    await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);
    await dumpDebugState(page, "after-futures", { futuresUrl });

    // This section intentionally stays the same as your current behavior.
    // Instrumentation helps you see why elements are missing.

    const invited = page.locator("text=/invited me/i").first();
    const invitedVisible = await invited.isVisible().catch(() => false);
    if (!invitedVisible) {
      await dumpDebugState(page, "invited-missing", {});
      throw new Error("Could not find Invited me tab");
    }

    await invited.scrollIntoViewIfNeeded().catch(() => null);
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

    // Do not assume a specific popup.
    // We only record state for you to inspect in debug outputs.
    // Success/failure validation should be based on what you observe in the UI.
    await dumpDebugState(page, "post-confirm-state", {});
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
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
// Run report UI
// --------------------
function renderRunReport(report) {
  const rows = report.accounts
    .map((a, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(a.username)}</td>
        <td>${a.completed ? "YES" : "NO"}</td>
        <td>${a.siteUsed ? escapeHtml(a.siteUsed) : "--"}</td>
        <td>${a.error ? `<span style="color:red">${escapeHtml(a.error)}</span>` : "--"}</td>
      </tr>
    `)
    .join("");

  const refresh = report.status.includes("Running") ? `<meta http-equiv="refresh" content="3">` : "";

  return `
    ${refresh}
    <h2>Run Started</h2>
    <div><b>Run ID:</b> ${escapeHtml(report.id)}</div>
    <div><b>Started:</b> ${escapeHtml(report.started)}</div>
    <div><b>Code length:</b> ${report.codeLength}</div>
    <div><b>Debug capture:</b> ${DEBUG_CAPTURE ? "ON" : "OFF"}</div>
    <hr/>
    <h3>Accounts</h3>
    <table border="1" cellpadding="8" cellspacing="0">
      <thead>
        <tr><th>#</th><th>Username</th><th>Completed</th><th>Site used</th><th>Error</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p><b>Status:</b> ${escapeHtml(report.status)}</p>

    <div>
      <a href="/?p=${encodeURIComponent(BOT_PASSWORD)}">Back to home</a>
      | <a href="/health">Health</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}">Last screenshot</a>
      | <a href="/debug?p=${encodeURIComponent(BOT_PASSWORD)}">Debug</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD)}">DNS test</a>
      | <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD)}">Net test</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  writePlaceholderLastShot();
});
