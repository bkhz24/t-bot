"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns").promises;

let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  // If this throws in logs: Cannot find module 'playwright'
  // then Playwright is not installed as a dependency.
  // Fix: add "playwright" to dependencies in package.json (not devDependencies) and redeploy.
  throw e;
}
const { chromium } = playwright;

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 8080;

const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// Try both pc + h5 for each base domain
const BASE_DOMAINS = [
  "bgol.pro",
  "dsj89.com",
  "dsj72.com",
];

function buildLoginUrls() {
  const out = [];
  for (const d of BASE_DOMAINS) {
    out.push(`https://${d}/pc/#/login`);
    out.push(`https://${d}/h5/#/login`);
  }
  return out;
}

const LOGIN_URLS = buildLoginUrls();

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      password: String(a.password || ""),
    }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) return { ok: false, accounts: [], error: "Each account must have username + password" };
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e.message}` };
  }
}

async function visibleText(page, text) {
  try {
    const loc = page.locator(`text=${text}`).first();
    return await loc.isVisible({ timeout: 1200 });
  } catch {
    return false;
  }
}

function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}

function cleanBaseUrl(req) {
  // Build a base URL that works behind Railway
  return `${req.protocol}://${req.get("host")}`;
}

// --------------------
// SMS helper (Twilio)
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
      body: msg,
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

let lastShotPath = null;     // file on disk to serve
let lastRunId = null;
let runReport = null;

// Keep a stable file path for /last-shot
const LAST_SHOT_FILE = "/app/last-shot.png";

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const pwMissing = !BOT_PASSWORD;
  const accountsBad = !cfg.ok;

  const base = cleanBaseUrl(req);
  const lastShotUrl = `${base}/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}`;
  const smsTestUrl = `${base}/sms-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}`;
  const dnsTestUrl = `${base}/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}`;
  const netTestUrl = `${base}/net-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
      ${accountsBad ? escapeHtml(cfg.error || "ACCOUNTS_JSON not set/invalid") : ""}
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
      <a href="/health">/health</a>
      | <a href="${lastShotUrl}">Last screenshot</a>
      | <a href="${smsTestUrl}">SMS test</a>
      | <a href="${dnsTestUrl}">DNS test</a>
      | <a href="${netTestUrl}">NET test</a>
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
    lastError: lastError,
    loginUrls: LOGIN_URLS.slice(0, 6),
    configOk: cfg.ok,
    configError: cfg.error,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    smsLibraryOk,
    smsLibraryError,
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

// Quick DNS check for the domains and their api subdomains
app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const results = {};
  const hosts = [];
  for (const d of BASE_DOMAINS) {
    hosts.push(d);
    hosts.push(`api.${d}`);
  }
  // Also include api.ddjea.com since your console showed it
  hosts.push("api.ddjea.com");

  for (const h of hosts) {
    try {
      const addrs = await dns.lookup(h, { all: true });
      results[h] = { ok: true, addrs };
    } catch (e) {
      results[h] = { ok: false, error: e.code ? `${e.code} ${e.message}` : (e.message || String(e)) };
    }
  }

  res.json(results);
});

// Simple network fetch check (no browser) so you can see who is blocked
app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const tests = [];
  for (const d of BASE_DOMAINS) {
    tests.push(`https://${d}/`);
    tests.push(`https://api.${d}/api/app/ping`);
  }
  tests.push("https://api.ddjea.com/api/app/ping");

  const out = {};
  for (const url of tests) {
    try {
      const r = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const text = await r.text();
      out[url] = {
        ok: r.ok,
        status: r.status,
        // keep short
        bodyPreview: text.slice(0, 300),
      };
    } catch (e) {
      out[url] = { ok: false, error: e.message || String(e) };
    }
  }

  res.json(out);
});

app.get("/last-shot", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  // serve stable file if present
  const file = fs.existsSync(LAST_SHOT_FILE) ? LAST_SHOT_FILE : lastShotPath;
  if (!file || !fs.existsSync(file)) return res.send("No screenshot captured yet.");

  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(file).pipe(res);
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport, req));
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

  runReport = {
    id: lastRunId,
    started: lastRunAt,
    codeLength: code.length,
    accounts: cfg.accounts.map((a) => ({
      username: a.username,
      completed: false,
      siteUsed: null,
      error: null,
    })),
    status: "Running now. Refresh this page.",
  };

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport, req));

  (async () => {
    try {
      console.log("Bot started");
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
// Core: run account across sites
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

function hostFromUrl(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

// Stricter: decide logged in only if login inputs gone AND url changed OR we see Account/Logout
async function isReallyLoggedIn(page) {
  const urlNow = page.url();
  const stillOnLogin = urlNow.includes("/login") || urlNow.includes("#/login");

  const loginInputsVisible = await page
    .locator('input[type="password"], input[placeholder*="password" i]')
    .first()
    .isVisible()
    .catch(() => false);

  const hasAccount =
    (await visibleText(page, "Account")) ||
    (await visibleText(page, "Logout")) ||
    (await visibleText(page, "Sign out"));

  // Logged in if:
  // - account/logout text is visible, OR
  // - not on login and login inputs are not visible
  if (hasAccount) return true;
  if (!stillOnLogin && !loginInputsVisible) return true;

  return false;
}

async function clickFuturesDropdown(page) {
  // The "Futures" item is typically in the top nav with a down arrow.
  // Try multiple strategies.

  // 1) role=link or role=button
  const futuresLink = page.getByRole("link", { name: /^Futures$/i }).first();
  const futuresButton = page.getByRole("button", { name: /^Futures$/i }).first();

  if (await futuresLink.isVisible().catch(() => false)) {
    await futuresLink.click({ timeout: 8000 }).catch(() => null);
    await sleep(600);
  } else if (await futuresButton.isVisible().catch(() => false)) {
    await futuresButton.click({ timeout: 8000 }).catch(() => null);
    await sleep(600);
  } else {
    // 2) raw text locator
    const futuresText = page.locator("text=Futures").first();
    if (await futuresText.isVisible().catch(() => false)) {
      await futuresText.click({ timeout: 8000 }).catch(() => null);
      await sleep(600);
    }
  }

  // After opening dropdown, click the Futures option inside the dropdown if it exists.
  // Sometimes the dropdown includes "Futures" and subitems like "Perpetual", etc.
  const futuresOption = page.locator("text=Futures").nth(1);
  if (await futuresOption.isVisible().catch(() => false)) {
    await futuresOption.click({ timeout: 8000 }).catch(() => null);
    await sleep(800);
    return true;
  }

  // Sometimes it is already on the Futures page. If we see invited me / position order area, also ok.
  if ((await visibleText(page, "invited me")) || (await visibleText(page, "Invited me"))) return true;

  return false;
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const siteHost = hostFromUrl(loginUrl);

  // Quick DNS check: if site host cannot resolve, skip immediately.
  try {
    await dns.lookup(siteHost);
  } catch (e) {
    throw new Error(`DNS failed for ${siteHost}: ${e.code || ""} ${e.message || String(e)}`.trim());
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  // Desktop first. We only switch to mobile if desktop cannot progress.
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f && f.errorText ? f.errorText : "unknown";
    console.log("REQUEST FAILED:", req.url(), "=>", errText);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("PAGE CONSOLE: error", msg.text());
  });

  page.on("pageerror", (err) => {
    console.log("PAGE ERROR:", err && err.message ? err.message : String(err));
  });

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1000);
    await saveShot(page, "after-goto");

    // Identify login fields
    const userField = page.locator(
      'input[type="email"], input[type="text"], input[autocomplete="username"], input[placeholder*="email" i], input[placeholder*="account" i], input[placeholder*="user" i]'
    ).first();

    const passField = page.locator(
      'input[type="password"], input[autocomplete="current-password"], input[placeholder*="password" i]'
    ).first();

    // Retry login loop
    let loggedIn = false;

    for (let attempt = 1; attempt <= 12; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1200);

        await userField.waitFor({ timeout: 15000 });
        await userField.click({ timeout: 5000 });
        await userField.fill(account.username);
        await sleep(300);

        await passField.waitFor({ timeout: 15000 });
        await passField.click({ timeout: 5000 });
        await passField.fill(account.password);
        await sleep(300);

        const loginBtn = page.getByRole("button", { name: /login/i }).first();
        if (await loginBtn.isVisible().catch(() => false)) {
          await loginBtn.click({ timeout: 10000 });
        } else {
          await passField.press("Enter");
        }

        await sleep(2500);
        await saveShot(page, `after-login-attempt-${attempt}`);

        if (await isReallyLoggedIn(page)) {
          loggedIn = true;
          console.log("Login confirmed for", account.username, "on", loginUrl);
          break;
        }
      } catch (e) {
        console.log("Login attempt exception:", e && e.message ? e.message : String(e));
      }

      await sleep(1200);
    }

    if (!loggedIn) {
      await saveShot(page, "login-failed");
      throw new Error("Login failed");
    }

    await saveShot(page, "after-login");

    // Now we must find and click Futures dropdown, then Futures again.
    const futuresOk = await clickFuturesDropdown(page);
    if (!futuresOk) {
      await saveShot(page, "futures-not-visible");
      throw new Error("Could not see Futures in the top nav");
    }

    await sleep(1500);
    await saveShot(page, "after-futures");

    // Click "Invited me" tab
    const invited = page.locator("text=Invited me").first();
    const invited2 = page.locator("text=invited me").first();

    if (await invited.isVisible().catch(() => false)) {
      await invited.click({ timeout: 8000 }).catch(() => null);
    } else if (await invited2.isVisible().catch(() => false)) {
      await invited2.click({ timeout: 8000 }).catch(() => null);
    } else {
      await saveShot(page, "invited-missing");
      throw new Error("Could not find Invited me tab");
    }

    await sleep(1200);
    await saveShot(page, "after-invited");

    // Code input
    const codeBox = page
      .locator('input[placeholder*="order code" i], input[placeholder*="Please enter the order code" i]')
      .first();

    if (!(await codeBox.isVisible().catch(() => false))) {
      await saveShot(page, "code-box-missing");
      throw new Error("Order code input not found");
    }

    await codeBox.click({ timeout: 8000 }).catch(() => null);
    await codeBox.fill(orderCode);
    await sleep(400);

    const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      await saveShot(page, "confirm-missing");
      throw new Error("Confirm button not found");
    }

    await confirmBtn.click({ timeout: 8000 }).catch(() => null);
    await sleep(1500);
    await saveShot(page, "after-confirm");

    // Wait for "Already followed the order"
    let gotAlready = false;
    for (let i = 0; i < 12; i++) {
      if (await visibleText(page, "Already followed the order")) {
        gotAlready = true;
        break;
      }
      await sleep(800);
    }

    if (!gotAlready) {
      await saveShot(page, "no-already-popup");
      throw new Error('Did not see "Already followed the order" popup');
    }

    // Position order tab and Pending
    const positionOrder = page.locator("text=Position order").first();
    if (await positionOrder.isVisible().catch(() => false)) {
      await positionOrder.click({ timeout: 8000 }).catch(() => null);
    } else {
      await saveShot(page, "position-order-missing");
      throw new Error("Position order tab not found");
    }

    await sleep(1200);

    let pendingOk = false;
    for (let i = 0; i < 10; i++) {
      if (await visibleText(page, "Pending")) {
        pendingOk = true;
        break;
      }
      await sleep(700);
    }

    if (!pendingOk) {
      await saveShot(page, "no-pending");
      throw new Error("Did not see Pending after submitting");
    }

    await saveShot(page, "completed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

// Save a screenshot and also copy to a stable last-shot file for easy viewing
async function saveShot(page, tag) {
  try {
    const file = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;

    // Keep stable path too
    try {
      fs.copyFileSync(file, LAST_SHOT_FILE);
      console.log("Saved screenshot:", file, "and updated", LAST_SHOT_FILE);
    } catch {
      console.log("Saved screenshot:", file);
    }
  } catch (e) {
    console.log("Screenshot failed:", e && e.message ? e.message : String(e));
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderRunReport(report, req) {
  const base = cleanBaseUrl(req);
  const lastShotUrl = `${base}/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}&t=${Date.now()}`;
  const permalinkUrl = `${base}/run/${encodeURIComponent(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}`;

  const rows = report.accounts
    .map((a, idx) => {
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(a.username)}</td>
          <td>${a.completed ? "YES" : "NO"}</td>
          <td>${a.siteUsed ? escapeHtml(a.siteUsed) : "--"}</td>
          <td>${a.error ? `<span style="color:red">${escapeHtml(a.error)}</span>` : "--"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <h2>Run Checklist</h2>
    <div><b>Run ID:</b> ${escapeHtml(report.id)}</div>
    <div><b>Started:</b> ${escapeHtml(report.started)}</div>
    <div><b>Code length:</b> ${report.codeLength}</div>
    <hr/>

    <h3>Steps (your exact flow)</h3>
    <ol>
      <li>Open one of the login sites</li>
      <li>Log in with that account username and password</li>
      <li>Click the down arrow next to <b>Futures</b> and click <b>Futures</b></li>
      <li>Click <b>Invited me</b> at the bottom</li>
      <li>Paste the order code into the box that says <b>Please enter the order code</b></li>
      <li>Click <b>Confirm</b></li>
      <li>Confirm 1: pop up <b>Already followed the order</b></li>
      <li>Click <b>Position order</b></li>
      <li>Confirm 2: <b>Pending</b> in red</li>
    </ol>

    <h3>Accounts</h3>
    <table border="1" cellpadding="8" cellspacing="0">
      <thead>
        <tr><th>#</th><th>Username</th><th>Completed</th><th>Site used</th><th>Error</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p><b>Status:</b> ${escapeHtml(report.status)}</p>

    <div>
      <a href="/">Back to home</a>
      | <a href="/health">Health</a>
      | <a href="${lastShotUrl}">Last screenshot</a>
      | <a href="${permalinkUrl}">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
