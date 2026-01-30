const express = require("express");
const { chromium } = require("playwright");

let twilioClient = null;
try {
  const twilio = require("twilio");
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch {}

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Password for the web form
const RUN_PASSWORD = process.env.RUN_PASSWORD || "change-me";

// Fallback login URLs (comma-separated)
const LOGIN_URLS = (process.env.LOGIN_URLS ||
  "https://bgol.pro/h5/#/login,https://dsj89.com/h5/#/login,https://dsj72.com/h5/#/login")
  .split(",")
  .map((s) => String(s).trim())
  .filter(Boolean);

let isRunning = false;
let lastRun = null;
let lastError = null;

function nowStr() {
  return new Date().toLocaleString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function loadAccountsFromEnv() {
  const pw = process.env.ACCOUNT_PASSWORD;
  if (!pw) throw new Error("Missing ACCOUNT_PASSWORD in Railway Variables.");

  const users = [];
  for (let i = 1; i <= 20; i++) {
    const u = process.env[`ACCOUNT_${i}_USERNAME`];
    if (u && String(u).trim()) users.push(String(u).trim());
  }

  if (users.length === 0) {
    throw new Error("No accounts found. Add ACCOUNT_1_USERNAME, ACCOUNT_2_USERNAME, etc.");
  }

  return users.map((username) => ({ username, password: pw }));
}

async function sendText(message) {
  if (!twilioClient) return;
  const from = process.env.TWILIO_FROM;
  const to = process.env.TWILIO_TO;
  if (!from || !to) return;

  try {
    await twilioClient.messages.create({ from, to, body: message });
    console.log("SMS sent:", message);
  } catch (e) {
    console.log("SMS send failed:", e && e.message ? e.message : String(e));
  }
}

async function visibleText(page, text) {
  return await page.locator("text=" + text).first().isVisible().catch(() => false);
}

async function clickText(page, text) {
  const loc = page.locator("text=" + text).first();
  const ok = await loc.isVisible().catch(() => false);
  if (!ok) return false;
  await loc.click();
  return true;
}

/* ---------------- WEB ---------------- */

app.get("/", (req, res) => {
  res.status(200).send(
    "<h2>T-Bot</h2>" +
      "<p>Running: " + (isRunning ? "YES" : "NO") + "</p>" +
      "<p>Last run: " + (lastRun || "Never") + "</p>" +
      (lastError ? "<p style='color:#b00;'>Last error: " + escapeHtml(lastError) + "</p>" : "") +
      "<form method='POST' action='/run'>" +
      "<div style='margin-bottom:8px;'><input name='password' type='password' placeholder='Password' required /></div>" +
      "<div style='margin-bottom:8px;'><input name='code' placeholder='Paste order code' required /></div>" +
      "<button type='submit'>Run Bot</button>" +
      "</form>" +
      "<p style='margin-top:12px; font-size:12px; color:#666;'>Health: <a href='/health'>/health</a> | SMS test: <a href='/sms-test'>/sms-test</a></p>"
  );
});

app.get("/health", (req, res) => {
  let accountsCount = 0;
  let configOk = true;
  let configError = null;

  try {
    accountsCount = loadAccountsFromEnv().length;
  } catch (e) {
    configOk = false;
    configError = e && e.message ? e.message : String(e);
  }

  res.status(200).json({
    ok: true,
    running: isRunning,
    lastRun,
    lastError,
    loginUrls: LOGIN_URLS,
    configOk,
    configError,
    accountsCount
  });
});

app.get("/sms-test", async (req, res) => {
  await sendText("T-Bot SMS test OK at " + nowStr());
  res.status(200).send("SMS test attempted. If Twilio is configured, you should receive a text.");
});

app.post("/run", async (req, res) => {
  const password = String(req.body.password || "").trim();
  const code = String(req.body.code || "").trim();

  if (password !== RUN_PASSWORD) return res.status(401).send("Wrong password.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.status(409).send("Already running. Try again soon.");

  let accounts;
  try {
    accounts = loadAccountsFromEnv();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    lastError = msg;
    return res.status(500).send("Config error: " + msg);
  }

  isRunning = true;
  lastRun = nowStr();
  lastError = null;

  res.status(200).send("Started. Check Railway logs. You will get a text when completed or failed.");

  (async () => {
    const startedAt = nowStr();

    try {
      await sendText("T-Bot started at " + startedAt);

      for (const account of accounts) {
        await runAccountAcrossSites(account, code);
      }

      await sendText("T-Bot completed at " + nowStr());
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      console.error("RUN FAILED:", e);
      await sendText("T-Bot FAILED at " + nowStr() + ". Error: " + msg);
    } finally {
      isRunning = false;
    }
  })();
});

/* ---------------- BOT ---------------- */

async function runAccountAcrossSites(account, code) {
  let lastSiteErr = null;

  for (const loginUrl of LOGIN_URLS) {
    try {
      console.log("Trying site:", loginUrl, "for", account.username);
      await runAccountOnSite(account, code, loginUrl);
      return;
    } catch (e) {
      lastSiteErr = e;
      console.log("Site failed:", loginUrl, "for", account.username, "err:", e && e.message ? e.message : String(e));
    }
  }

  throw new Error(
    "All sites failed for " +
      account.username +
      ". Last error: " +
      (lastSiteErr && lastSiteErr.message ? lastSiteErr.message : String(lastSiteErr))
  );
}

async function runAccountOnSite(account, code, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    let loggedIn = false;

    for (let attempt = 1; attempt <= 12; attempt++) {
      console.log("Login attempt", attempt, "for", account.username, "on", loginUrl);

      try {
        await page.goto(loginUrl, { timeout: 60000 });
        await sleep(1500);

        await page.fill('input[type="text"]', account.username);
        await sleep(700);
        await page.fill('input[type="password"]', account.password);
        await sleep(700);

        await page.click("button");
        await sleep(4500);

        if (await visibleText(page, "Futures")) {
          loggedIn = true;
          break;
        }
      } catch {
        await sleep(2500);
      }
    }

    if (!loggedIn) throw new Error("Login failed");

    if (!(await clickText(page, "Futures"))) throw new Error("Could not find Futures");
    await sleep(2000);

    let invitedClicked = await clickText(page, "Invited me");
    if (!invitedClicked) invitedClicked = await clickText(page, "Invited Me");
    if (!invitedClicked) throw new Error("Could not find Invited Me");
    await sleep(2000);

    await page.waitForSelector("input", { timeout: 30000 });
    await page.fill("input", code);
    await sleep(900);

    if (!(await clickText(page, "Confirm"))) throw new Error("Could not find Confirm");
    await sleep(2500);

    const popupSeen = await visibleText(page, "Already followed the order");
    console.log("Popup seen:", popupSeen ? "YES" : "NO");

    let posClicked = await clickText(page, "Position order");
    if (!posClicked) posClicked = await clickText(page, "Position Order");
    if (!posClicked) throw new Error("Could not find Position Order");
    await sleep(2000);

    const start = Date.now();
    const timeoutMs = 120000;

    while (Date.now() - start < timeoutMs) {
      const pendingCount = await page.locator("text=Pending").count().catch(() => 0);
      if (pendingCount > 0) {
        console.log("SUCCESS Pending for", account.username, "on", loginUrl);
        return;
      }

      await page.reload();
      await sleep(2500);

      posClicked = await clickText(page, "Position order");
      if (!posClicked) posClicked = await clickText(page, "Position Order");
      await sleep(1500);
    }

    throw new Error("Pending never appeared");
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* ---------------- START ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
