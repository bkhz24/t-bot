/**
 * T-Bot
 * - Web form (/) posts to /run
 * - Runs Playwright automation for each account
 * - Uses ACCOUNTS_JSON + BOT_PASSWORD from Railway Variables
 * - Sends SMS via Twilio if configured
 *
 * REQUIRED Railway Variables:
 *   BOT_PASSWORD = your form password
 *   ACCOUNTS_JSON = JSON array of { "username": "...", "password": "..." }
 *
 * OPTIONAL Railway Variables:
 *   LOGIN_URLS = comma-separated URLs to try (defaults included below)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_TO
 */

const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright");

let twilioClient = null;
try {
  const twilio = require("twilio");
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  // If twilio isn't installed, we just run without SMS.
  twilioClient = null;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = parseInt(process.env.PORT || "8080", 10);

// State
let isRunning = false;
let lastRun = null;
let lastError = null;

// A simple in-memory run tracker so you can see a checklist page.
const runs = new Map();

function nowStr() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function getAccountsFromEnv() {
  const raw = process.env.ACCOUNTS_JSON;
  if (!raw) return { ok: false, error: "ACCOUNTS_JSON not set" };

  const parsed = safeJsonParse(raw);
  if (!parsed.ok) return { ok: false, error: `ACCOUNTS_JSON invalid JSON: ${parsed.error}` };

  const arr = parsed.value;
  if (!Array.isArray(arr) || arr.length === 0) return { ok: false, error: "ACCOUNTS_JSON must be a non-empty array" };

  for (const a of arr) {
    if (!a || typeof a !== "object") return { ok: false, error: "Each account must be an object" };
    if (!a.username || !a.password) return { ok: false, error: "Each account must have username and password" };
  }

  return { ok: true, accounts: arr };
}

function getLoginUrls() {
  // You can override in Railway Variables with LOGIN_URLS:
  // https://bgol.pro/pc/#/login,https://dsj89.com/pc/#/login,https://dsj72.com/pc/#/login
  const raw = process.env.LOGIN_URLS;

  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Defaults include both pc and h5 routes (some environments behave differently).
  return [
    "https://bgol.pro/pc/#/login",
    "https://dsj89.com/pc/#/login",
    "https://dsj72.com/pc/#/login",
    "https://bgol.pro/h5/#/login",
    "https://dsj89.com/h5/#/login",
    "https://dsj72.com/h5/#/login",
  ];
}

async function sendSms(message) {
  const from = process.env.TWILIO_FROM;
  const to = process.env.TWILIO_TO;

  if (!twilioClient) return { ok: false, skipped: true, reason: "twilio not installed or not configured" };
  if (!from || !to) return { ok: false, skipped: true, reason: "TWILIO_FROM or TWILIO_TO not set" };

  try {
    const res = await twilioClient.messages.create({ body: message, from, to });
    console.log("SMS sent:", res.sid);
    return { ok: true, sid: res.sid };
  } catch (e) {
    console.log("SMS failed:", e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function requireBotPassword(req, res) {
  const expected = process.env.BOT_PASSWORD || "";
  const provided = (req.body && req.body.password) ? String(req.body.password) : "";

  if (!expected) {
    res.status(500).send("BOT_PASSWORD not set in Railway Variables.");
    return false;
  }

  if (provided !== expected) {
    res.status(401).send("Wrong password.");
    return false;
  }

  return true;
}

async function visibleText(page, text) {
  try {
    const loc = page.getByText(text, { exact: false }).first();
    return await loc.isVisible({ timeout: 1500 });
  } catch {
    return false;
  }
}

async function clickByText(page, text) {
  const loc = page.getByText(text, { exact: false }).first();
  await loc.click({ timeout: 15000 });
}

async function screenshotOnFail(page, label) {
  try {
    const path = `/tmp/${label}-${Date.now()}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log("Saved screenshot:", path);
  } catch (e) {
    console.log("Screenshot failed:", e && e.message ? e.message : String(e));
  }
}

/**
 * This performs your exact flow once logged in:
 * - futures dropdown -> Futures
 * - invited me tab
 * - fill order code
 * - confirm
 * - expect toast "Already followed the order"
 * - go Position order and expect "Pending"
 */
async function doFlow(page, orderCode) {
  // Wait until we see top nav or anything that proves we are inside.
  // On some pages, it loads into a trading screen with chart.
  for (let i = 0; i < 30; i++) {
    const ok =
      (await visibleText(page, "Futures")) ||
      (await visibleText(page, "Markets")) ||
      (await visibleText(page, "Assets")) ||
      (await visibleText(page, "Perpetual"));
    if (ok) break;
    await sleep(500);
  }

  // Click dropdown arrow next to Futures, then click Futures
  // We try a few approaches because UI differs between pc and h5.
  try {
    // If a "Futures" menu exists, click it (often opens dropdown).
    await clickByText(page, "Futures");
    await sleep(500);
  } catch {}

  // In dropdown, click "Futures" option (your screenshot shows it)
  // If already on Futures, this should be harmless.
  try {
    await clickByText(page, "Futures");
    await sleep(1000);
  } catch {}

  // Bottom tab: "invited me"
  // Sometimes it’s lowercase in the UI.
  try {
    await clickByText(page, "invited me");
  } catch {
    try {
      await clickByText(page, "Invited me");
    } catch {}
  }
  await sleep(800);

  // Fill order code input by placeholder
  const codeInput = page.locator('input[placeholder*="order code" i], input[placeholder*="Please enter" i], input[type="text"]').first();
  await codeInput.waitFor({ timeout: 20000 });
  await codeInput.click({ timeout: 5000 });
  await codeInput.fill(orderCode);
  await sleep(300);

  // Click Confirm button
  // Prefer exact "Confirm" button if present.
  const confirmBtn = page.getByRole("button", { name: /confirm/i }).first();
  await confirmBtn.click({ timeout: 20000 });
  await sleep(1200);

  // Confirmation 1: toast "Already followed the order"
  let toastOk = false;
  for (let i = 0; i < 20; i++) {
    if (await visibleText(page, "Already followed the order")) {
      toastOk = true;
      break;
    }
    await sleep(250);
  }
  if (!toastOk) {
    throw new Error('Did not see "Already followed the order" confirmation');
  }

  // Go Position order and look for "Pending"
  try {
    await clickByText(page, "Position order");
  } catch {}

  let pendingOk = false;
  for (let i = 0; i < 30; i++) {
    if (await visibleText(page, "Pending")) {
      pendingOk = true;
      break;
    }
    await sleep(300);
  }
  if (!pendingOk) {
    throw new Error('Did not see "Pending" confirmation');
  }

  return true;
}

async function loginAndRunOnSite(account, loginUrl, orderCode) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  let loggedIn = false;

  try {
    for (let attempt = 1; attempt <= 12; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(1200);

        const userField = page.locator(
          'input[type="email"], input[type="text"], input[autocomplete="username"], input[placeholder*="email" i], input[placeholder*="account" i], input[placeholder*="user" i]'
        ).first();

        const passField = page.locator(
          'input[type="password"], input[autocomplete="current-password"], input[placeholder*="password" i]'
        ).first();

        await userField.waitFor({ timeout: 15000 });
        await userField.click({ timeout: 5000 });
        await userField.fill(account.username);
        await sleep(400);

        await passField.waitFor({ timeout: 15000 });
        await passField.click({ timeout: 5000 });
        await passField.fill(account.password);
        await sleep(400);

        // Submit
        await passField.press("Enter");
        await sleep(2500);

        // Success checks
        const urlNow = page.url();
        const stillOnLogin = urlNow.includes("/login") || urlNow.includes("#/login");

        const loginInputsVisible = await page
          .locator('input[type="password"]')
          .first()
          .isVisible()
          .catch(() => false);

        const navVisible =
          (await visibleText(page, "Futures")) ||
          (await visibleText(page, "Markets")) ||
          (await visibleText(page, "Assets")) ||
          (await visibleText(page, "Perpetual"));

        if ((!stillOnLogin && !loginInputsVisible) || navVisible) {
          loggedIn = true;
          console.log("Login succeeded for", account.username, "on", loginUrl);
          break;
        }

        const maybeError =
          (await visibleText(page, "Incorrect")) ||
          (await visibleText(page, "error")) ||
          (await visibleText(page, "failed")) ||
          (await visibleText(page, "invalid"));

        if (maybeError) {
          console.log("Login page shows an error message for", account.username);
        }
      } catch (e) {
        console.log("Login attempt exception:", e && e.message ? e.message : String(e));
      }

      await sleep(2000);
    }

    if (!loggedIn) {
      await screenshotOnFail(page, "login-failed");
      throw new Error("Login failed");
    }

    // Your full flow
    await doFlow(page, orderCode);
    return true;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runAccountAcrossSites(account, orderCode, runId) {
  const loginUrls = getLoginUrls();

  for (const loginUrl of loginUrls) {
    try {
      console.log("Trying site:", loginUrl, "for", account.username);
      await loginAndRunOnSite(account, loginUrl, orderCode);
      return { ok: true, loginUrl };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.log("Site failed:", loginUrl, "for", account.username, "err:", msg);
      // continue to next site
    }
  }

  return { ok: false, error: "All sites failed" };
}

function makeRunId() {
  return crypto.randomBytes(10).toString("base64url");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.get("/", (req, res) => {
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRun ? escapeHtml(lastRun) : "null"}</div>
    <div style="color:#b00000; margin-top:10px;">${lastError ? escapeHtml(lastError) : ""}</div>

    <form method="POST" action="/run" style="margin-top:16px;">
      <input name="password" placeholder="Password" required />
      <br/><br/>
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <p style="margin-top:16px;">
      <a href="/health">Health</a> |
      <a href="/sms-test">SMS test</a>
    </p>
  `);
});

app.get("/health", (req, res) => {
  const accountsParsed = getAccountsFromEnv();
  const smsConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && process.env.TWILIO_TO);

  res.json({
    ok: true,
    running: isRunning,
    lastRun,
    lastError,
    loginUrls: getLoginUrls().slice(0, 10),
    configOk: accountsParsed.ok,
    configError: accountsParsed.ok ? null : accountsParsed.error,
    accountsCount: accountsParsed.ok ? accountsParsed.accounts.length : 0,
    smsConfigured,
    smsLibraryOk: !!twilioClient,
    smsLibraryError: null,
  });
});

app.get("/sms-test", async (req, res) => {
  const r = await sendSms(`T-Bot SMS test at ${nowStr()}`);
  if (r.ok) return res.send("OK: SMS sent");
  if (r.skipped) return res.send(`Skipped: ${r.reason}`);
  return res.status(500).send(`Failed: ${r.error}`);
});

app.get("/run/:runId", (req, res) => {
  const runId = req.params.runId;
  const run = runs.get(runId);
  if (!run) return res.status(404).send("Run not found");

  const accountBlocks = run.accounts.map((a, idx) => {
    return `
      <div style="border:1px solid #ccc; padding:10px; margin:10px 0;">
        <b>Account ${idx + 1}:</b> ${escapeHtml(a.username)}<br/>
        Completed: <b>${a.completed ? "YES" : "NO"}</b><br/>
        Site used: ${a.loginUrl ? escapeHtml(a.loginUrl) : "--"}<br/>
        Error: ${a.error ? `<span style="color:#b00000;">${escapeHtml(a.error)}</span>` : "--"}<br/>
      </div>
    `;
  }).join("\n");

  res.send(`
    <h2>Run Checklist</h2>
    <div><b>Run ID:</b> ${escapeHtml(runId)}</div>
    <div><b>Started:</b> ${escapeHtml(run.started)}</div>
    <div><b>Code length:</b> ${run.codeLength}</div>
    <hr/>

    <h3>Steps (your exact flow)</h3>
    <ol>
      <li>Open one of the login sites:
        <ul>
          ${getLoginUrls().slice(0, 3).map(u => `<li>${escapeHtml(u)}</li>`).join("")}
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
    ${accountBlocks}

    <div style="margin-top:10px;">
      <b>Status:</b> ${run.finished ? "Completed" : "Not completed yet."}
    </div>

    <p style="margin-top:16px;">
      <a href="/">Back to home</a> |
      <a href="/health">Health</a>
    </p>
  `);
});

app.post("/run", async (req, res) => {
  if (!requireBotPassword(req, res)) return;

  if (isRunning) {
    return res.status(409).send("Bot is already running. Please wait.");
  }

  const orderCode = (req.body && req.body.code) ? String(req.body.code).trim() : "";
  if (!orderCode) return res.status(400).send("No code provided.");

  const accountsParsed = getAccountsFromEnv();
  if (!accountsParsed.ok) return res.status(500).send(accountsParsed.error);

  const accounts = accountsParsed.accounts;

  const runId = makeRunId();
  const run = {
    id: runId,
    started: nowStr(),
    codeLength: orderCode.length,
    finished: false,
    accounts: accounts.map((a) => ({
      username: a.username,
      completed: false,
      loginUrl: null,
      error: null,
    })),
  };
  runs.set(runId, run);

  // Respond immediately with checklist page
  res.redirect(`/run/${runId}`);

  // Start run in background
  isRunning = true;
  lastRun = nowStr();
  lastError = null;

  await sendSms(`T-Bot started at ${lastRun}`);

  try {
    console.log("Bot started");
    console.log("Accounts loaded:", accounts.length);
    console.log("Code received length:", orderCode.length);

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const slot = run.accounts[i];

      const result = await runAccountAcrossSites(account, orderCode, runId);

      if (result.ok) {
        slot.completed = true;
        slot.loginUrl = result.loginUrl;
        slot.error = null;
      } else {
        slot.completed = false;
        slot.loginUrl = null;
        slot.error = result.error || "Unknown error";
        // If one account fails, keep going to the next account.
      }
    }

    run.finished = true;

    const failures = run.accounts.filter(a => !a.completed).map(a => a.username);
    if (failures.length === 0) {
      await sendSms(`T-Bot completed OK at ${nowStr()}`);
    } else {
      await sendSms(`T-Bot completed with failures at ${nowStr()}: ${failures.join(", ")}`);
    }

    console.log("Bot completed");
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    lastError = msg;
    run.finished = true;

    await sendSms(`T-Bot failed at ${nowStr()}: ${msg}`);
    console.log("Run failed:", msg);
  } finally {
    isRunning = false;
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
