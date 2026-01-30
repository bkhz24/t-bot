"use strict";

/* ========= ENV / PLAYWRIGHT ========= */
process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";

const express = require("express");
const { chromium } = require("playwright");

/* ========= TWILIO (OPTIONAL) ========= */
let twilioClient = null;
try {
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM &&
    process.env.TWILIO_TO
  ) {
    const twilio = require("twilio");
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
} catch {
  twilioClient = null;
}

/* ========= APP ========= */
const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const RUN_PASSWORD = process.env.RUN_PASSWORD || "";

/* ========= CONFIG ========= */
const DEFAULT_LOGIN_URLS = [
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/h5/#/login",
];

function getLoginUrls() {
  const raw = (process.env.LOGIN_URLS || "").trim();
  if (!raw) return DEFAULT_LOGIN_URLS;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function loadAccounts() {
  const raw = (process.env.ACCOUNTS_JSON || "").trim();
  if (!raw) throw new Error("ACCOUNTS_JSON not set");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("ACCOUNTS_JSON must be a non-empty array");
  }
  return parsed;
}

/* ========= HELPERS ========= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendSms(msg) {
  if (!twilioClient) return console.log("SMS:", msg);
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM,
      to: process.env.TWILIO_TO,
      body: msg,
    });
    console.log("SMS sent:", msg);
  } catch (e) {
    console.log("SMS error:", e.message);
  }
}

async function visibleText(page, text) {
  try {
    return await page.getByText(text, { exact: false })
      .first()
      .isVisible({ timeout: 1500 });
  } catch {
    return false;
  }
}

/* ========= CORE BOT ========= */
async function runAccountOnSite(account, loginUrl, orderCode) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  try {
    /* ----- LOGIN ----- */
    let loggedIn = false;

    for (let attempt = 1; attempt <= 12; attempt++) {
      console.log(`Login attempt ${attempt} for ${account.username}`);

      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1500);

      const user = page.locator(
        'input[type="email"],input[type="text"],input[placeholder*="email" i]'
      ).first();

      const pass = page.locator(
        'input[type="password"],input[placeholder*="password" i]'
      ).first();

      await user.waitFor({ timeout: 15000 });
      await user.fill(account.username);
      await sleep(500);

      await pass.waitFor({ timeout: 15000 });
      await pass.fill(account.password);
      await sleep(500);

      await pass.press("Enter");
      await sleep(3500);

      if (
        !(page.url().includes("login")) &&
        (await visibleText(page, "Futures") ||
          await visibleText(page, "Markets") ||
          await visibleText(page, "Assets"))
      ) {
        loggedIn = true;
        console.log("Login successful");
        break;
      }
    }

    if (!loggedIn) throw new Error("Login failed");

    /* ----- FUTURES ----- */
    await page.getByText("Futures", { exact: false }).first().click();
    await sleep(2000);

    /* ----- INVITED ME ----- */
    await page.getByText("Invited me", { exact: false }).first().click();
    await sleep(1500);

    /* ----- ORDER CODE ----- */
    await page.locator("input").first().fill(orderCode);
    await sleep(600);

    await page.getByText("Confirm", { exact: false }).first().click();
    await sleep(2500);

    /* ----- FOLLOW ----- */
    if (await visibleText(page, "Follow")) {
      await page.getByText("Follow", { exact: false }).first().click();
      await sleep(1500);
      if (await visibleText(page, "Confirm")) {
        await page.getByText("Confirm", { exact: false }).first().click();
      }
    }

    /* ----- VERIFY ----- */
    if (await visibleText(page, "Already followed")) {
      console.log("Popup confirmed");
    }

    if (await visibleText(page, "Position order")) {
      await page.getByText("Position order", { exact: false }).first().click();
      await sleep(1500);
    }

    if (!(await visibleText(page, "Pending"))) {
      console.log("Pending not detected (may still be OK)");
    }

    return true;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runAcrossSites(account, code) {
  let lastErr = null;
  for (const url of getLoginUrls()) {
    try {
      await runAccountOnSite(account, url, code);
      return;
    } catch (e) {
      lastErr = e;
      console.log("Site failed:", url, e.message);
    }
  }
  throw lastErr;
}

/* ========= STATE ========= */
let running = false;
let lastRun = null;
let lastError = null;

/* ========= ROUTES ========= */
app.get("/", (req, res) => {
  res.send(`
    <h2>T-Bot</h2>
    <p>Running: ${running ? "YES" : "NO"}</p>
    <p>Last run: ${lastRun || "never"}</p>
    ${lastError ? `<p style="color:red;">${lastError}</p>` : ""}
    <form method="POST" action="/run">
      <input name="password" placeholder="Password" type="password" required /><br/><br/>
      <input name="code" placeholder="Paste order code" required /><br/><br/>
      <button>Run Bot</button>
    </form>
    <p><a href="/health">/health</a> | <a href="/sms-test">/sms-test</a></p>
  `);
});

app.post("/run", async (req, res) => {
  if (req.body.password !== RUN_PASSWORD)
    return res.status(401).send("Wrong password");

  if (running) return res.send("Already running");

  running = true;
  lastRun = new Date().toLocaleString();
  lastError = null;

  res.send("Bot started");

  (async () => {
    await sendSms(`T-Bot started at ${lastRun}`);
    try {
      for (const acc of loadAccounts()) {
        await runAcrossSites(acc, req.body.code);
      }
      await sendSms("T-Bot completed successfully");
    } catch (e) {
      lastError = e.message;
      await sendSms(`T-Bot FAILED: ${e.message}`);
    } finally {
      running = false;
    }
  })();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    running,
    lastRun,
    lastError,
    accounts: loadAccounts().length,
    loginUrls: getLoginUrls(),
  });
});

app.get("/sms-test", async (req, res) => {
  await sendSms("T-Bot SMS test OK");
  res.send("SMS sent");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
