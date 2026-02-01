"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns").promises;
const https = require("https");
const { chromium } = require("playwright");

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

// Prefer PC first (your screenshots show PC works best)
const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj72.com/pc/#/login",
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/h5/#/login"
];

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

async function visibleText(page, reOrText, timeout = 1500) {
  try {
    const loc =
      reOrText instanceof RegExp
        ? page.getByText(reOrText).first()
        : page.locator(`text=${reOrText}`).first();
    return await loc.isVisible({ timeout });
  } catch {
    return false;
  }
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
// Screenshot storage
// --------------------
let lastShotPath = null;
const LAST_SHOT_PERSIST = "/app/last-shot.png"; // survives inside container while running

async function saveShot(page, tag) {
  try {
    const file = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;

    // also persist a copy at /app/last-shot.png
    try {
      fs.copyFileSync(file, LAST_SHOT_PERSIST);
    } catch {}

    console.log(`Saved screenshot: ${file} and updated ${LAST_SHOT_PERSIST}`);
  } catch (e) {
    console.log("Screenshot failed:", e && e.message ? e.message : String(e));
  }
}

// --------------------
// Run state
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;
let lastRunId = null;
let runReport = null;

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
    <div>Last run: ${lastRunAt ? lastRunAt : "--"}</div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
      ${accountsMissing ? (cfg.error || "ACCOUNTS_JSON not set") : ""}
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
      <a href="/health">Health</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}&t=1">Last screenshot</a>
      | <a href="/sms-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">SMS test</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">DNS test</a>
      | <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">Net test</a>
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
    loginUrls: LOGIN_URLS,
    configOk: cfg.ok,
    configError: cfg.error,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    smsLibraryOk,
    smsLibraryError
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

app.get("/last-shot", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  // Prefer persisted file
  if (fs.existsSync(LAST_SHOT_PERSIST)) {
    res.setHeader("Content-Type", "image/png");
    return fs.createReadStream(LAST_SHOT_PERSIST).pipe(res);
  }

  // Fallback to tmp file
  if (lastShotPath && fs.existsSync(lastShotPath)) {
    res.setHeader("Content-Type", "image/png");
    return fs.createReadStream(lastShotPath).pipe(res);
  }

  res.send("No screenshot captured yet.");
});

// DNS test: shows which hostnames resolve from Railway
app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

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
      out[h] = { ok: false, error: e.message || String(e) };
    }
  }
  res.json(out);
});

// Net test: attempts fetching ping endpoints (HEAD/GET)
app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const urls = [
    "https://bgol.pro/",
    "https://dsj89.com/",
    "https://dsj72.com/",
    "https://api.bgol.pro/api/app/ping",
    "https://api.dsj89.com/api/app/ping",
    "https://api.dsj72.com/api/app/ping",
    "https://api.ddjea.com/api/app/ping"
  ];

  const fetchLite = (url) =>
    new Promise((resolve) => {
      const req = https.request(
        url,
        { method: "GET", timeout: 10000, headers: { "User-Agent": "t-bot-net-test" } },
        (r) => {
          let data = "";
          r.on("data", (c) => (data += c.toString("utf8")));
          r.on("end", () => {
            resolve({
              ok: true,
              status: r.statusCode,
              bodyPreview: data.slice(0, 200)
            });
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (e) => {
        resolve({ ok: false, error: e.message || String(e) });
      });
      req.end();
    });

  const out = {};
  for (const u of urls) out[u] = await fetchLite(u);
  res.json(out);
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
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
      error: null
    })),
    status: "Running now. Refresh this page."
  };

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

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

async function runAccountOnSite(account, orderCode, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
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
    await sleep(1200);
    await saveShot(page, "after-goto");

    // Find login form fields (on both PC and H5)
    const emailInput = page.locator('input[placeholder*="email" i], input[type="email"], input[type="text"]').first();
    const passInput = page.locator('input[placeholder*="password" i], input[type="password"]').first();

    const hasEmail = await emailInput.isVisible().catch(() => false);
    const hasPass = await passInput.isVisible().catch(() => false);
    if (!hasEmail || !hasPass) {
      await saveShot(page, "login-form-missing");
      throw new Error("Login form not visible");
    }

    // Attempt login a few times
    let loggedIn = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(900);

      await emailInput.waitFor({ timeout: 20000 });
      await emailInput.click({ timeout: 5000 });
      await emailInput.fill(account.username);
      await sleep(200);

      await passInput.waitFor({ timeout: 20000 });
      await passInput.click({ timeout: 5000 });
      await passInput.fill(account.password);
      await sleep(200);

      // Click Login button
      const loginBtn = page.getByRole("button", { name: /login/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 });
      } else {
        await passInput.press("Enter");
      }

      await sleep(1500);
      await saveShot(page, `after-login-attempt-${attempt}`);

      // REAL login detection:
      // 1) login inputs disappear OR 2) URL changes away from /login
      const urlNow = page.url();
      const stillLoginUrl = urlNow.includes("/#/login") || urlNow.includes("/login");

      const emailStillVisible = await emailInput.isVisible().catch(() => false);
      const passStillVisible = await passInput.isVisible().catch(() => false);

      if (!stillLoginUrl && !(emailStillVisible || passStillVisible)) {
        loggedIn = true;
      } else if (!stillLoginUrl) {
        // Some versions keep inputs in DOM but hidden, so also accept if inputs not visible
        if (!emailStillVisible && !passStillVisible) loggedIn = true;
      } else {
        // If we can see something that only appears after login, add it here.
        // If you tell me what appears (avatar, balance, logout), we can make this bulletproof.
      }

      if (loggedIn) break;

      await sleep(1200);
    }

    if (!loggedIn) {
      await saveShot(page, "login-failed");
      throw new Error("Login failed");
    }

    console.log("Login confirmed for", account.username, "on", loginUrl);
    await saveShot(page, "after-login");

    // Go to Futures (click Futures dropdown, then Futures option)
    await goToFutures(page);
    await saveShot(page, "after-futures");

    // Find and click "Invited me"
    await openInvitedMe(page);
    await saveShot(page, "after-invited");

    // Enter order code
    await enterOrderCodeAndConfirm(page, orderCode);
    await saveShot(page, "after-confirm");

    // Validate popups
    const sawAlready = await waitForAnyText(page, [/Already followed the order/i, /Already followed/i], 12000);
    if (!sawAlready) {
      await saveShot(page, "no-already-popup");
      throw new Error('Did not see "Already followed the order" popup');
    }

    // Click Position order
    const pos = page.getByText(/Position order/i).first();
    if (await pos.isVisible().catch(() => false)) {
      await pos.click({ timeout: 8000 }).catch(() => null);
      await sleep(1200);
    }

    const sawPending = await waitForAnyText(page, [/Pending/i], 12000);
    if (!sawPending) {
      await saveShot(page, "no-pending");
      throw new Error("Did not see Pending after submitting");
    }

    await saveShot(page, "completed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function goToFutures(page) {
  // Try multiple strategies because PC and H5 differ
  // Strategy A: click the "Futures" menu item, then click Futures again in dropdown
  const futuresTop = page.getByText(/^Futures$/).first();
  if (await futuresTop.isVisible().catch(() => false)) {
    await futuresTop.click({ timeout: 8000 }).catch(() => null);
    await sleep(800);

    // Dropdown often repeats "Futures"
    const futuresAgain = page.getByText(/^Futures$/).nth(1);
    if (await futuresAgain.isVisible().catch(() => false)) {
      await futuresAgain.click({ timeout: 8000 }).catch(() => null);
      await sleep(1200);
      return;
    }
  }

  // Strategy B: click anything that looks like "Futures" with a down arrow
  const futuresAny = page.locator("text=Futures").first();
  if (await futuresAny.isVisible().catch(() => false)) {
    await futuresAny.click({ timeout: 8000 }).catch(() => null);
    await sleep(1200);
    return;
  }

  await saveShot(page, "futures-not-visible");
  throw new Error("Could not see Futures in the top nav");
}

async function openInvitedMe(page) {
  // "Invited me" is often lower on the page, so scroll first
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(800);

  const candidates = [
    page.getByText(/Invited me/i).first(),
    page.getByText(/Invited/i).first(),
    page.locator("text=Invited me").first(),
    page.locator("text=Invited").first()
  ];

  for (const loc of candidates) {
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 8000 }).catch(() => null);
      await sleep(1200);
      return;
    }
  }

  // Sometimes it is a tab bar at the bottom; try clicking by role/tab if present
  const tab = page.getByRole("tab", { name: /invited/i }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click({ timeout: 8000 }).catch(() => null);
    await sleep(1200);
    return;
  }

  await saveShot(page, "invited-missing");
  throw new Error("Could not find Invited me tab");
}

async function enterOrderCodeAndConfirm(page, orderCode) {
  // Look for an input with placeholder containing "order code"
  const codeBox = page.locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i]').first();

  // If not visible, scroll a bit and retry
  let visible = await codeBox.isVisible().catch(() => false);
  if (!visible) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);
    visible = await codeBox.isVisible().catch(() => false);
  }

  if (!visible) {
    await saveShot(page, "code-box-missing");
    throw new Error("Order code input not found");
  }

  await codeBox.click({ timeout: 8000 });
  await codeBox.fill(orderCode);
  await sleep(400);

  const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click({ timeout: 10000 });
    await sleep(1200);
    return;
  }

  await saveShot(page, "confirm-missing");
  throw new Error("Confirm button not found");
}

async function waitForAnyText(page, regexList, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const re of regexList) {
      if (await visibleText(page, re, 400)) return true;
    }
    await sleep(500);
  }
  return false;
}

function renderRunReport(report) {
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
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}&t=1">Last screenshot</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
