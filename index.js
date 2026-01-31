"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns").promises;
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

const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/pc/#/login",
  "https://dsj72.com/h5/#/login",
];

const API_HOSTS_TO_TEST = ["api.bgol.pro", "api.ddjea.com"];

// Fixed filename so /last-shot works even if memory resets
const LAST_SHOT_FILE = "/app/last-shot.png";

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPcUrl(url) {
  return url.includes("/pc/");
}

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
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

let lastShotPath = null;
let lastRunId = null;
let runReport = null;

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "None"}</div>

    <div style="color:red; margin-top:10px;">
      ${!BOT_PASSWORD ? "BOT_PASSWORD not set<br/>" : ""}
      ${!cfg.ok ? escapeHtml(cfg.error || "ACCOUNTS_JSON not set") : ""}
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
      | DNS test: <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/dns-test</a>
      | Last screenshot: <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
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
    lastError: lastError,
    loginUrls: LOGIN_URLS.slice(0, 3),
    configOk: cfg.ok,
    configError: cfg.error,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    smsLibraryOk,
    smsLibraryError,
    lastShotFileExists: fs.existsSync(LAST_SHOT_FILE),
  });
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  const out = {};
  for (const host of API_HOSTS_TO_TEST) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      out[host] = { ok: true, addrs };
    } catch (e) {
      out[host] = { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  res.json(out);
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

app.get("/last-shot", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  // Prefer the fixed file, fallback to lastShotPath
  const file = fs.existsSync(LAST_SHOT_FILE)
    ? LAST_SHOT_FILE
    : (lastShotPath && fs.existsSync(lastShotPath) ? lastShotPath : null);

  if (!file) return res.send("No screenshot captured yet.");

  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(file).pipe(res);
});

app.get("/run", (req, res) => {
  res.status(200).send("OK: /run route exists. Submit the form on / to POST to /run.");
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
    steps: [
      "Open one of the login sites",
      "Log in with username/password",
      "Open Futures dropdown and click Futures",
      "Click Invited me",
      "Enter order code + Confirm",
      "Confirm 1: Already followed the order",
      "Confirm 2: Pending in red (Position order)",
    ],
    accounts: cfg.accounts.map((a) => ({
      username: a.username,
      completed: false,
      siteUsed: null,
      error: null,
    })),
    status: "Running now. Refresh this page.",
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
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const pc = isPcUrl(loginUrl);

  const context = await browser.newContext({
    viewport: pc ? { width: 1280, height: 720 } : { width: 390, height: 844 },
    userAgent: pc
      ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
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
    await sleep(1500);

    // Always capture at least one shot so /last-shot is useful
    await saveShot(page, "after-goto");

    if (!(await loginFormVisible(page))) {
      await saveShot(page, "login-form-not-visible");
      const u = page.url();
      const title = await page.title().catch(() => "");
      throw new Error(`Login form not visible. Current URL: ${u}. Title: ${title}`);
    }

    const ok = await performLoginStrict(page, account, loginUrl);
    if (!ok) {
      await saveShot(page, "login-failed");
      throw new Error("Login failed (still appears logged out)");
    }

    await saveShot(page, "after-login");
    await sleep(1200);

    await clickFuturesDropdownThenFutures(page);
    await saveShot(page, "after-futures-click");

    await clickInvitedMe(page);
    await saveShot(page, "after-invited-click");

    await enterOrderCodeAndConfirm(page, orderCode);
    await saveShot(page, "after-confirm-click");

    const alreadyOk = await waitForAnyText(page, ["Already followed the order"], 15000);
    if (!alreadyOk) {
      await saveShot(page, "no-already-popup");
      throw new Error('Did not see "Already followed the order" popup');
    }

    await clickPositionOrder(page);

    const pendingOk = await waitForAnyText(page, ["Pending"], 15000);
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

async function loginFormVisible(page) {
  const userField = page.locator('input[type="email"], input[type="text"]').first();
  const passField = page.locator('input[type="password"]').first();
  const userOk = await userField.isVisible().catch(() => false);
  const passOk = await passField.isVisible().catch(() => false);
  return userOk && passOk;
}

async function performLoginStrict(page, account, loginUrl) {
  const userField = page.locator('input[type="email"], input[type="text"]').first();
  const passField = page.locator('input[type="password"]').first();

  for (let attempt = 1; attempt <= 12; attempt++) {
    console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      if (!(await loginFormVisible(page))) {
        await saveShot(page, "login-form-disappeared");
        throw new Error("Login form not visible during attempt");
      }

      await userField.waitFor({ timeout: 20000 });
      await passField.waitFor({ timeout: 20000 });

      await userField.click({ timeout: 5000 });
      await userField.fill("");
      await userField.fill(account.username);
      await sleep(250);

      await passField.click({ timeout: 5000 });
      await passField.fill("");
      await passField.fill(account.password);
      await sleep(250);

      const loginBtn = page.getByRole("button", { name: /^login$/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 15000 });
      } else {
        await passField.press("Enter").catch(() => null);
      }

      await sleep(3000);
      await saveShot(page, `after-login-attempt-${attempt}`);

      // Real confirmation: top nav appears, or we see Account, or invited page artifacts
      const loginLinkVisible =
        (await page.getByRole("link", { name: /login/i }).first().isVisible().catch(() => false)) ||
        (await page.locator("text=Login").first().isVisible().catch(() => false));

      const accountVisible =
        (await page.locator("text=Account").first().isVisible().catch(() => false)) ||
        (await page.getByRole("link", { name: /account/i }).first().isVisible().catch(() => false));

      const navVisible =
        (await page.locator("header, nav").first().isVisible().catch(() => false)) &&
        ((await visibleText(page, "Futures")) || (await visibleText(page, "Markets")) || (await visibleText(page, "Assets")));

      const inApp =
        (await visibleText(page, "Invited me")) ||
        (await visibleText(page, "Position order")) ||
        (await visibleText(page, "Please enter the order code"));

      if (!loginLinkVisible && (accountVisible || navVisible || inApp)) {
        console.log("Login confirmed for", account.username, "on", loginUrl);
        return true;
      }
    } catch (e) {
      console.log("Login attempt exception:", e && e.message ? e.message : String(e));
    }

    await sleep(1200);
  }

  return false;
}

async function clickFuturesDropdownThenFutures(page) {
  // Wait for header/nav
  await page.locator("header, nav").first().waitFor({ timeout: 20000 }).catch(() => null);

  // Find Futures in header/nav
  const futuresInHeader = page.locator("header, nav").locator("text=Futures").first();
  const futuresRoleLink = page.getByRole("link", { name: /^Futures$/i }).first();
  const futuresRoleButton = page.getByRole("button", { name: /^Futures$/i }).first();

  const futuresVisible =
    (await futuresInHeader.isVisible().catch(() => false)) ||
    (await futuresRoleLink.isVisible().catch(() => false)) ||
    (await futuresRoleButton.isVisible().catch(() => false));

  if (!futuresVisible) {
    await saveShot(page, "futures-not-visible");
    throw new Error("Could not see Futures in the top nav");
  }

  // Try hover, then click
  if (await futuresInHeader.isVisible().catch(() => false)) {
    await futuresInHeader.hover({ timeout: 5000 }).catch(() => null);
    await sleep(500);
  }

  let clicked = false;
  if (await futuresRoleButton.isVisible().catch(() => false)) {
    await futuresRoleButton.click({ timeout: 8000 }).catch(() => null);
    clicked = true;
  } else if (await futuresRoleLink.isVisible().catch(() => false)) {
    await futuresRoleLink.click({ timeout: 8000 }).catch(() => null);
    clicked = true;
  } else if (await futuresInHeader.isVisible().catch(() => false)) {
    await futuresInHeader.click({ timeout: 8000 }).catch(() => null);
    clicked = true;
  }

  await sleep(800);
  await saveShot(page, "after-futures-open-attempt");

  // Dropdown usually contains Perpetual and Convert
  const menuHasPerpetual = await page.locator("text=Perpetual").first().isVisible().catch(() => false);
  const menuHasConvert = await page.locator("text=Convert").first().isVisible().catch(() => false);

  if (!menuHasPerpetual && !menuHasConvert) {
    // Try clicking caret near Futures if the menu is controlled by caret
    if (clicked && (await futuresInHeader.isVisible().catch(() => false))) {
      const caret = futuresInHeader.locator("xpath=..").locator("svg, i").first();
      if (await caret.isVisible().catch(() => false)) {
        await caret.click({ timeout: 8000 }).catch(() => null);
        await sleep(800);
      }
    }
  }

  await saveShot(page, "after-futures-caret-attempt");

  // Click the Futures option inside the dropdown
  // We try the menu container that contains Perpetual or Convert
  let menuContainer = null;
  if (await page.locator("text=Perpetual").first().isVisible().catch(() => false)) {
    menuContainer = page.locator("text=Perpetual").first().locator("xpath=ancestor-or-self::*[self::div or self::ul][1]");
  } else if (await page.locator("text=Convert").first().isVisible().catch(() => false)) {
    menuContainer = page.locator("text=Convert").first().locator("xpath=ancestor-or-self::*[self::div or self::ul][1]");
  }

  if (menuContainer) {
    const futuresInMenu = menuContainer.locator("text=Futures").first();
    if (await futuresInMenu.isVisible().catch(() => false)) {
      await futuresInMenu.click({ timeout: 8000 }).catch(() => null);
      await sleep(1200);
      return;
    }
  }

  // Fallback: click any visible Futures that is not in header
  const anyFutures = page.locator("text=Futures");
  const count = await anyFutures.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = anyFutures.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const inHeader = await el.locator("xpath=ancestor-or-self::header|ancestor-or-self::nav").count().catch(() => 0);
    if (inHeader > 0) continue;

    await el.click({ timeout: 8000 }).catch(() => null);
    await sleep(1200);
    return;
  }

  await saveShot(page, "futures-dropdown-missing");
  throw new Error("Could not open Futures dropdown or click Futures inside it");
}

async function clickInvitedMe(page) {
  const invitedLower = page.locator("text=invited me").first();
  const invitedCap = page.locator("text=Invited me").first();

  if (await invitedLower.isVisible().catch(() => false)) {
    await invitedLower.click();
    await sleep(1200);
    return;
  }
  if (await invitedCap.isVisible().catch(() => false)) {
    await invitedCap.click();
    await sleep(1200);
    return;
  }

  await saveShot(page, "invited-missing");
  throw new Error('Could not find "Invited me" tab');
}

async function enterOrderCodeAndConfirm(page, orderCode) {
  const codeBox = page
    .locator('input[placeholder*="Please enter the order code" i], input[placeholder*="order code" i]')
    .first();

  if (!(await codeBox.isVisible().catch(() => false))) {
    await saveShot(page, "code-box-missing");
    throw new Error("Order code input not found");
  }

  await codeBox.click().catch(() => null);
  await codeBox.fill("").catch(() => null);
  await codeBox.fill(orderCode);
  await sleep(400);

  const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click().catch(() => null);
    await sleep(1200);
    return;
  }

  const confirmTextBtn = page.locator("text=Confirm").first();
  if (await confirmTextBtn.isVisible().catch(() => false)) {
    await confirmTextBtn.click().catch(() => null);
    await sleep(1200);
    return;
  }

  await saveShot(page, "confirm-missing");
  throw new Error("Confirm button not found");
}

async function clickPositionOrder(page) {
  const pos = page.locator("text=Position order").first();
  if (await pos.isVisible().catch(() => false)) {
    await pos.click().catch(() => null);
    await sleep(1200);
    return;
  }
  await saveShot(page, "position-order-missing");
  throw new Error('Could not find "Position order" tab');
}

async function waitForAnyText(page, texts, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const t of texts) {
      if (await visibleText(page, t)) return true;
    }
    await sleep(500);
  }
  return false;
}

async function saveShot(page, tag) {
  try {
    const fileTmp = `/tmp/${tag}-${Date.now()}.png`;
    await page.screenshot({ path: fileTmp, fullPage: true });

    // Also write to a fixed file so /last-shot always has something
    await page.screenshot({ path: LAST_SHOT_FILE, fullPage: true });

    lastShotPath = fileTmp;
    console.log("Saved screenshot:", fileTmp, "and updated", LAST_SHOT_FILE);
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
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD)}">DNS test</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}">Last screenshot</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
