"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns").promises;
const { chromium } = require("playwright");

const PORT = process.env.PORT || 8080;

const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// PC only (mobile/h5 has been flaky for your accounts)
const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj72.com/pc/#/login"
];

// After login, go straight to the Futures trading page (avoids flaky top-nav clicking)
function futuresUrlFromLoginUrl(loginUrl) {
  // loginUrl like https://bgol.pro/pc/#/login -> https://bgol.pro/pc/#/contractTransaction
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

let lastShotPath = null; // most recent saved shot
let lastRunId = null;
let runReport = null;

function writePlaceholderLastShot() {
  try {
    // Always ensure /app/last-shot.png exists so /last-shot never 404s with "No screenshot"
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

    // Copy to /app so the route can always serve a stable file path
    try {
      fs.copyFileSync(file, "/app/last-shot.png");
    } catch {}

    console.log("Saved screenshot:", file, "and updated /app/last-shot.png");
  } catch (e) {
    console.log("Screenshot failed:", e && e.message ? e.message : String(e));
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
    smsLibraryError
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

app.get("/last-shot", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  // Prefer the stable file in /app, fallback to lastShotPath
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

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

// Simple network tests to help debug DNS and upstream blocking
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

// Helpers used inside the Futures page
function codeInputLocator(page) {
  // keep broad: sites vary placeholder text
  return page.locator(
    'input[placeholder*="order code" i], input[placeholder*="enter" i], input[placeholder*="code" i], input[type="text"], input'
  );
}

function confirmButtonLocator(page) {
  // different sites sometimes use different labels
  return page
    .getByRole("button", { name: /confirm|submit|ok|sure/i })
    .first();
}

async function ensureOrderEntryPanel(page) {
  // 1) If the code box is already visible, we're good.
  const direct = codeInputLocator(page).first();
  if (await direct.isVisible().catch(() => false)) return true;

  // 2) Try likely tab labels first (language/label variations)
  const tabTexts = [
    /invited me/i,
    /invited/i,
    /invite/i,
    /follow/i,
    /follow-?up/i,
    /plan/i,
    /orders/i,
    /order/i
  ];

  for (const rx of tabTexts) {
    const t = page.locator(`text=/${rx.source}/${rx.flags}`).first();
    if (await t.isVisible().catch(() => false)) {
      await t.scrollIntoViewIfNeeded().catch(() => null);
      await t.click({ timeout: 8000 }).catch(() => null);
      await sleep(800);
      if (await direct.isVisible().catch(() => false)) return true;
    }
  }

  // 3) Brute-force click visible "nav-ish" items in the bottom half
  // until the code box appears (avoids exact text dependence).
  const candidates = page.locator('button, [role="button"], a, div[tabindex="0"], li');
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 40); i++) {
    const el = candidates.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await el.boundingBox().catch(() => null);
    if (!box) continue;

    // only click things in bottom half of the viewport (likely nav)
    if (box.y < 360) continue;

    await el.click({ timeout: 3000 }).catch(() => null);
    await sleep(700);

    if (await direct.isVisible().catch(() => false)) return true;
  }

  return false;
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US"
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
    await saveShot(page, "after-goto");

    const userField = page.locator('input[type="email"], input[type="text"]').first();
    const passField = page.locator('input[type="password"]').first();

    let loggedIn = false;

    for (let attempt = 1; attempt <= 8; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      // wait each attempt (pages sometimes re-render)
      await userField.waitFor({ timeout: 20000 });
      await passField.waitFor({ timeout: 20000 });

      await userField.fill("").catch(() => null);
      await passField.fill("").catch(() => null);

      await userField.click({ timeout: 5000 }).catch(() => null);
      await userField.fill(account.username).catch(() => null);
      await sleep(250);

      await passField.click({ timeout: 5000 }).catch(() => null);
      await passField.fill(account.password).catch(() => null);
      await sleep(250);

      const loginBtn = page.getByRole("button", { name: /login/i }).first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click({ timeout: 10000 }).catch(() => null);
      } else {
        await passField.press("Enter").catch(() => null);
      }

      await sleep(1800);
      await saveShot(page, `after-login-attempt-${attempt}`);

      const wrongPw =
        (await page.locator("text=/wrong password/i").first().isVisible().catch(() => false)) ||
        (await page.locator("text=/password.*incorrect/i").first().isVisible().catch(() => false));
      if (wrongPw) {
        throw new Error("Wrong password reported by site");
      }

      // Prefer direct Futures URL test (more reliable than checking top nav)
      const fu = futuresUrlFromLoginUrl(loginUrl);
      if (fu) {
        await page.goto(fu, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1500);
        await saveShot(page, "after-futures-direct");

        const hasPositionOrder = await page.locator("text=/Position order/i").first().isVisible().catch(() => false);
        const hasMarkets = await page.locator("text=/Markets/i").first().isVisible().catch(() => false);
        const hasFuturesWord = await page.locator("text=/Futures/i").first().isVisible().catch(() => false);

        if (hasPositionOrder || hasMarkets || hasFuturesWord) {
          loggedIn = true;
          console.log("Login confirmed via Futures page for", account.username, "on", loginUrl);
          break;
        }
      }

      await sleep(800);
    }

    if (!loggedIn) {
      await saveShot(page, "login-failed");
      throw new Error("Login failed");
    }

    await saveShot(page, "after-login");

    // Always go to Futures trading page directly
    const futuresUrl = futuresUrlFromLoginUrl(loginUrl);
    if (!futuresUrl) throw new Error("Could not build Futures URL from login URL");

    await page.goto(futuresUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);
    await saveShot(page, "after-futures");

    // Make sure we can access the order-entry panel (Invited me or equivalent)
    const panelOk = await ensureOrderEntryPanel(page);
    if (!panelOk) {
      await saveShot(page, "order-panel-missing");
      throw new Error("Could not find order entry panel (Invited/Order area)");
    }

    await saveShot(page, "after-invited");

    // Enter code (pick the first visible input that looks writable)
    const inputs = codeInputLocator(page);
    const inputCount = await inputs.count().catch(() => 0);
    let codeBox = null;

    for (let i = 0; i < Math.min(inputCount, 10); i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible().catch(() => false))) continue;
      const disabled = await inp.isDisabled().catch(() => false);
      if (disabled) continue;
      codeBox = inp;
      break;
    }

    if (!codeBox) {
      await saveShot(page, "code-box-missing");
      throw new Error("Order code input not found");
    }

    await codeBox.click().catch(() => null);
    await codeBox.fill(orderCode).catch(() => null);
    await sleep(600);
    await saveShot(page, "after-code");

    // Confirm (support multiple labels)
    const confirmBtn = confirmButtonLocator(page);
    if (!(await confirmBtn.isVisible().catch(() => false))) {
      await saveShot(page, "confirm-missing");
      throw new Error("Confirm button not found");
    }

    await confirmBtn.click({ timeout: 10000 }).catch(() => null);
    await sleep(1500);
    await saveShot(page, "after-confirm");

    // Look for result popup text (success OR known failure variants)
    const successPopup = page.locator("text=/Already followed the order/i").first();
    const paramIncorrect = page.locator("text=/parameter (is )?incorrect/i").first();
    const invalidParam = page.locator("text=/invalid parameter/i").first();
    const codeError = page.locator("text=/code.*(incorrect|error|invalid)/i").first();

    let outcome = null;

    for (let i = 0; i < 10; i++) {
      if (await successPopup.isVisible().catch(() => false)) {
        outcome = "success";
        break;
      }
      if (await paramIncorrect.isVisible().catch(() => false)) {
        outcome = "param_incorrect";
        break;
      }
      if (await invalidParam.isVisible().catch(() => false)) {
        outcome = "invalid_param";
        break;
      }
      if (await codeError.isVisible().catch(() => false)) {
        outcome = "code_error";
        break;
      }
      await sleep(300);
    }

    if (outcome !== "success") {
      await saveShot(page, "confirm-result-not-success");
      if (outcome === "param_incorrect") throw new Error("Site rejected code: parameter incorrect");
      if (outcome === "invalid_param") throw new Error("Site rejected code: invalid parameter");
      if (outcome === "code_error") throw new Error("Site rejected code: code invalid/incorrect");
      throw new Error("No success or known error popup after confirm");
    }

    // Click Position order then check Pending (best-effort, don't fail the whole run if this is flaky)
    const positionOrder = page.locator("text=/Position order/i").first();
    if (await positionOrder.isVisible().catch(() => false)) {
      await positionOrder.click().catch(() => null);
      await sleep(1200);
    }

    const pending = page.locator("text=/Pending/i").first();
    let pendingOk = false;
    for (let i = 0; i < 8; i++) {
      if (await pending.isVisible().catch(() => false)) {
        pendingOk = true;
        break;
      }
      await sleep(800);
    }

    if (!pendingOk) {
      await saveShot(page, "no-pending");
      // Do not hard-fail here since your real-world validation is that the order fulfilled.
      console.log("WARN: Did not see Pending after submitting (continuing).");
    }

    await saveShot(page, "completed");
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
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
