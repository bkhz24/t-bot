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

// Trim BOT_PASSWORD so trailing spaces in Railway variables do not break auth.
const BOT_PASSWORD = (process.env.BOT_PASSWORD || "").trim();
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

// Twilio optional
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// OPTION A: remove bgol.* completely. Only keep domains that resolve in Railway.
const LOGIN_URLS = [
  "https://dsj89.com/pc/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/pc/#/login",
  "https://dsj72.com/h5/#/login",
];

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
    return await loc.isVisible({ timeout: 1000 });
  } catch {
    return false;
  }
}

function authOk(req) {
  const p = (req.query.p || "").toString().trim();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
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

let lastShotPath = null; // for /last-shot
let lastRunId = null;
let runReport = null;

// keep a stable copy for /last-shot (handy on Railway)
const LAST_SHOT_STABLE = "/app/last-shot.png";

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
    <div>Last run: ${lastRunAt ? lastRunAt : "-"}</div>

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
      Health: <a href="/health">/health</a>
      | Last screenshot: <a href="/last-shot?p=YOUR_BOT_PASSWORD">/last-shot</a>
      | SMS test: <a href="/sms-test?p=YOUR_BOT_PASSWORD">/sms-test</a>
      | DNS test: <a href="/dns-test?p=YOUR_BOT_PASSWORD">/dns-test</a>
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
    loginUrls: LOGIN_URLS,
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

app.get("/last-shot", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  // Prefer the stable path if present
  const p = fs.existsSync(LAST_SHOT_STABLE) ? LAST_SHOT_STABLE : lastShotPath;

  if (!p || !fs.existsSync(p)) return res.send("No screenshot captured yet.");

  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(p).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const hosts = [
    "dsj89.com",
    "dsj72.com",
    "api.ddjea.com",
    "api.bgol.pro",
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

  // quick fetch checks (optional)
  await new Promise((resolve) => {
    const req2 = https.get("https://api.ddjea.com/api/app/ping", { timeout: 8000 }, (r) => {
      out["https://api.ddjea.com/api/app/ping"] = { ok: true, status: r.statusCode };
      r.resume();
      resolve();
    });
    req2.on("error", (e) => {
      out["https://api.ddjea.com/api/app/ping"] = { ok: false, error: e.message || String(e) };
      resolve();
    });
    req2.on("timeout", () => {
      req2.destroy(new Error("timeout"));
    });
  });

  res.json(out);
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString().trim();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  // create run record
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

  // respond immediately
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

  // run async
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

function isMobileUrl(url) {
  return url.includes("/h5/");
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const mobile = isMobileUrl(loginUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Log failures
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

    // Make sure login form exists
    const userField = page
      .locator('input[type="email"], input[type="text"], input[autocomplete="username"]')
      .first();
    const passField = page
      .locator('input[type="password"], input[autocomplete="current-password"]')
      .first();

    const hasUser = await userField.isVisible().catch(() => false);
    const hasPass = await passField.isVisible().catch(() => false);

    if (!hasUser || !hasPass) {
      await saveShot(page, "login-form-missing");
      throw new Error("Login form not visible");
    }

    // Login retries
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

        // Click Login if available, else press Enter
        const loginBtn = page.getByRole("button", { name: /login/i }).first();
        if (await loginBtn.isVisible().catch(() => false)) {
          await loginBtn.click({ timeout: 15000 });
        } else {
          await passField.press("Enter");
        }

        await sleep(2500);
        await saveShot(page, `after-login-attempt-${attempt}`);

        // Stronger success checks: we must NOT be on the login form anymore.
        const passStillVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
        const urlNow = page.url();
        const stillOnLogin = urlNow.includes("/login") || urlNow.includes("#/login");

        // Things that appear only when the app shell loads (your screenshots)
        const sawTopNav =
          (await visibleText(page, "Futures")) ||
          (await visibleText(page, "Markets")) ||
          (await visibleText(page, "Assets")) ||
          (await visibleText(page, "Support center")) ||
          (await visibleText(page, "Announcements"));

        // If we still see the password input, we are not logged in, even if some text exists.
        if (!passStillVisible && !stillOnLogin) {
          loggedIn = true;
          console.log("Login confirmed for", account.username, "on", loginUrl);
          break;
        }

        // If nav is visible and password input is gone, also accept.
        if (sawTopNav && !passStillVisible) {
          loggedIn = true;
          console.log("Login confirmed for", account.username, "on", loginUrl);
          break;
        }
      } catch (e) {
        console.log("Login attempt exception:", e && e.message ? e.message : String(e));
      }

      await sleep(1000);
    }

    if (!loggedIn) {
      await saveShot(page, "login-failed");
      throw new Error("Login failed");
    }

    await saveShot(page, "after-login");

    // --------------------
    // Post-login flow (best-effort)
    // --------------------

    // 1) Click Futures (top nav) then select Futures from dropdown
    // Use a resilient locator: any element containing Futures near the top.
    const futuresTop = page.locator("text=Futures").first();

    // Wait a bit for the header to render
    let futuresVisible = false;
    for (let i = 0; i < 10; i++) {
      futuresVisible = await futuresTop.isVisible().catch(() => false);
      if (futuresVisible) break;
      await sleep(600);
    }

    if (!futuresVisible) {
      await saveShot(page, "futures-not-visible");
      throw new Error("Could not see Futures in the top nav");
    }

    await futuresTop.click().catch(() => null);
    await sleep(800);

    // The dropdown often has a second Futures entry
    const futuresOption = page.locator("text=Futures").nth(1);
    if (await futuresOption.isVisible().catch(() => false)) {
      await futuresOption.click().catch(() => null);
    }

    await sleep(1500);
    await saveShot(page, "after-futures-click");

    // 2) Click Invited me tab (bottom tabs in your screenshots)
    const invited = page.locator("text=Invited me").first();
    const invitedLower = page.locator("text=invited me").first();

    if (await invited.isVisible().catch(() => false)) {
      await invited.click();
    } else if (await invitedLower.isVisible().catch(() => false)) {
      await invitedLower.click();
    } else {
      await saveShot(page, "invited-missing");
      throw new Error("Could not find Invited me tab");
    }

    await sleep(1200);
    await saveShot(page, "after-invited");

    // 3) Enter order code
    const codeBox = page
      .locator('input[placeholder*="order code" i], input[placeholder*="Please enter the order code" i]')
      .first();

    if (!(await codeBox.isVisible().catch(() => false))) {
      await saveShot(page, "code-box-missing");
      throw new Error("Order code input not found");
    }

    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode);
    await sleep(300);

    // 4) Click Confirm
    const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      await saveShot(page, "confirm-missing");
      throw new Error("Confirm button not found");
    }

    await confirmBtn.click().catch(() => null);
    await sleep(1200);
    await saveShot(page, "after-confirm");

    // 5) Popup: Already followed the order
    let gotAlready = false;
    for (let i = 0; i < 10; i++) {
      if (await visibleText(page, "Already followed the order")) {
        gotAlready = true;
        break;
      }
      await sleep(700);
    }

    if (!gotAlready) {
      await saveShot(page, "no-already-popup");
      throw new Error('Did not see "Already followed the order" popup');
    }

    // 6) Position order + Pending
    const positionOrder = page.locator("text=Position order").first();
    if (await positionOrder.isVisible().catch(() => false)) {
      await positionOrder.click().catch(() => null);
    }
    await sleep(1200);
    await saveShot(page, "after-position-order");

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

async function saveShot(page, tag) {
  try {
    const file = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;

    // also copy to stable path for easier viewing
    try {
      fs.copyFileSync(file, LAST_SHOT_STABLE);
    } catch {
      // ignore
    }

    console.log("Saved screenshot:", file, "and updated", LAST_SHOT_STABLE);
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
    <h3>Steps (your exact flow)</h3>
    <ol>
      <li>Open one of the login sites:
        <ul>
          ${LOGIN_URLS.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}
        </ul>
      </li>
      <li>Log in with that account username and password.</li>
      <li>Click the down arrow next to <b>Futures</b> and click <b>Futures</b>.</li>
      <li>Click <b>Invited me</b> at the bottom.</li>
      <li>Paste the order code into the box that says <b>Please enter the order code</b>.</li>
      <li>Click <b>Confirm</b>.</li>
      <li>Confirm 1: pop up <b>Already followed the order</b>.</li>
      <li>Click <b>Position order</b>.</li>
      <li>Confirm 2: <b>Pending</b> in red.</li>
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
      | <a href="/last-shot?p=YOUR_BOT_PASSWORD">Last screenshot</a>
      | <a href="/run/${escapeHtml(report.id)}?p=YOUR_BOT_PASSWORD">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
