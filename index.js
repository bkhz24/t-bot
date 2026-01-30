"use strict";

const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");

// --------------------
// Config
// --------------------
const PORT = Number(process.env.PORT || 8080);

// Password for the web form
const BOT_PASSWORD = (process.env.BOT_PASSWORD || "").trim();

// Your login URLs (PC first, then mobile variants as fallback)
const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj72.com/pc/#/login",

  // Fallback variants (in case one environment redirects or the PC path changes)
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/h5/#/login",
];

// Twilio optional (safe to leave unset)
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_FROM = (process.env.TWILIO_FROM || "").trim();
const TWILIO_TO = (process.env.TWILIO_TO || "").trim();

// --------------------
// Simple state
// --------------------
let isRunning = false;
let lastRun = null;
let lastError = null;

// --------------------
// Helpers
// --------------------
function nowLocalString() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bodyIncludes(page, text) {
  try {
    const content = await page.content();
    return content && content.toLowerCase().includes(String(text).toLowerCase());
  } catch {
    return false;
  }
}

async function visibleText(page, text) {
  try {
    const loc = page.locator(`text=${text}`).first();
    return await loc.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { __parseError: e.message || String(e) };
  }
}

function loadAccounts() {
  // Prefer Railway Variable
  const env = (process.env.ACCOUNTS_JSON || "").trim();
  if (env) {
    const parsed = safeJsonParse(env);
    if (parsed.__parseError) {
      return { ok: false, error: `ACCOUNTS_JSON parse error: ${parsed.__parseError}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "ACCOUNTS_JSON must be a JSON array of accounts." };
    }
    return { ok: true, accounts: parsed };
  }

  // Fallback to local file (optional)
  if (fs.existsSync("./accounts.json")) {
    const raw = fs.readFileSync("./accounts.json", "utf8");
    const parsed = safeJsonParse(raw);
    if (parsed.__parseError) {
      return { ok: false, error: `accounts.json parse error: ${parsed.__parseError}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "accounts.json must be a JSON array of accounts." };
    }
    return { ok: true, accounts: parsed };
  }

  return { ok: false, error: "ACCOUNTS_JSON not set (and accounts.json not found)." };
}

async function sendSMS(message) {
  // Optional: if not configured, just log and continue
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !TWILIO_TO) {
    console.log("SMS not configured. Message would have been:", message);
    return;
  }

  // Tiny Twilio REST call without adding a dependency
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const body = new URLSearchParams();
  body.set("From", TWILIO_FROM);
  body.set("To", TWILIO_TO);
  body.set("Body", message);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Twilio SMS failed: ${res.status} ${txt}`);
  }
}

// --------------------
// Core bot flow
// --------------------
async function runAccountOnSite(account, orderCode, loginUrl) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 }, // desktop layout like your screenshots
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Helpful logging
  page.on("console", (msg) => {
    const t = msg.text();
    if (t) console.log("PAGE:", t.slice(0, 500));
  });

  // --------------------
  // LOGIN loop (12 attempts)
  // --------------------
  let loggedIn = false;

  for (let attempt = 1; attempt <= 12; attempt++) {
    console.log(`Login attempt ${attempt} for ${account.username} on ${loginUrl}`);

    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      // If there is an Email tab/button, click it (PC page has Email/Mobile number)
      const emailTab = page.locator("button:has-text('Email'), div:has-text('Email')").first();
      if (await emailTab.isVisible().catch(() => false)) {
        await emailTab.click({ timeout: 3000 }).catch(() => {});
        await sleep(600);
      }

      // Inputs on the PC page are labeled "Email" and "Password"
      const emailInput = page.locator(
        'input[type="email"], input[placeholder*="Email" i], input[autocomplete="username"], input[type="text"]'
      ).first();

      const passInput = page.locator(
        'input[type="password"], input[placeholder*="Password" i], input[autocomplete="current-password"]'
      ).first();

      await emailInput.waitFor({ timeout: 15000 });
      await emailInput.click({ timeout: 5000 });
      await emailInput.fill("");
      await emailInput.type(String(account.username), { delay: 20 });
      await sleep(300);

      await passInput.waitFor({ timeout: 15000 });
      await passInput.click({ timeout: 5000 });
      await passInput.fill("");
      await passInput.type(String(account.password), { delay: 20 });
      await sleep(400);

      // Click the Login button (yellow)
      const loginBtn = page.locator("button:has-text('Login')").first();
      if (await loginBtn.isVisible().catch(() => false)) {
        await Promise.allSettled([
          page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
          loginBtn.click({ timeout: 8000 }).catch(() => {}),
        ]);
      } else {
        // fallback: press Enter
        await passInput.press("Enter").catch(() => {});
      }

      await sleep(2500);

      // Success checks:
      // - Top nav has Futures / Markets / Assets, OR
      // - not on login anymore, OR
      // - login inputs disappear
      const urlNow = page.url();
      const stillOnLogin = urlNow.includes("#/login") || urlNow.includes("/login");

      const loginInputsStillVisible = await passInput.isVisible().catch(() => false);

      const navLooksRight =
        (await visibleText(page, "Futures")) ||
        (await visibleText(page, "Markets")) ||
        (await visibleText(page, "Assets"));

      if ((!stillOnLogin && !loginInputsStillVisible) || navLooksRight) {
        loggedIn = true;
        console.log(`Login succeeded for ${account.username} on ${loginUrl}`);
        break;
      }

      // If there is an on-screen error message, log it
      const errHints = ["Incorrect", "invalid", "failed", "error", "password"];
      for (const hint of errHints) {
        if (await bodyIncludes(page, hint)) {
          console.log(`Login page may show an error hint: "${hint}" for ${account.username}`);
          break;
        }
      }
    } catch (e) {
      console.log("Login attempt exception:", e && e.message ? e.message : String(e));
    }

    await sleep(1500);
  }

  if (!loggedIn) {
    await browser.close().catch(() => {});
    throw new Error("Login failed");
  }

  // --------------------
  // Navigate: Futures dropdown -> Futures
  // --------------------
  // The top nav has "Futures" with a small arrow. Clicking "Futures" opens dropdown.
  // Then click the dropdown item "Futures".
  const futuresNav = page.locator("text=Futures").first();
  await futuresNav.waitFor({ timeout: 20000 });

  await futuresNav.click({ timeout: 8000 }).catch(() => {});
  await sleep(900);

  // Dropdown item also says Futures
  // If the first click already took you to Futures, this is harmless.
  const futuresItem = page.locator("div:has-text('Futures'), li:has-text('Futures')").first();
  if (await futuresItem.isVisible().catch(() => false)) {
    await futuresItem.click({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
  } else {
    // Sometimes the click already navigated
    await sleep(1500);
  }

  // --------------------
  // Click "invited me" tab (bottom section)
  // --------------------
  const invitedTab = page.locator("text=invited me").first();
  await invitedTab.waitFor({ timeout: 20000 });
  await invitedTab.click({ timeout: 8000 });
  await sleep(1000);

  // --------------------
  // Enter order code + Confirm
  // --------------------
  const codeInput = page.locator('input[placeholder*="order code" i], input').first();
  await codeInput.waitFor({ timeout: 20000 });
  await codeInput.click({ timeout: 5000 });
  await codeInput.fill("");
  await codeInput.type(String(orderCode), { delay: 20 });

  const confirmBtn = page.locator("button:has-text('Confirm')").first();
  await confirmBtn.waitFor({ timeout: 15000 });
  await confirmBtn.click({ timeout: 8000 });
  await sleep(1800);

  // Confirmation 1: popup "Already followed the order"
  const alreadyFollowed =
    (await visibleText(page, "Already followed the order")) ||
    (await bodyIncludes(page, "Already followed the order"));

  if (!alreadyFollowed) {
    // Not fatal, but helpful. Some sites display it slightly differently.
    console.log("Did not detect 'Already followed the order' popup text.");
  } else {
    console.log("Confirmed popup: Already followed the order");
  }

  // --------------------
  // Confirmation 2: Position order shows "Pending" in red
  // --------------------
  const positionTab = page.locator("text=Position order").first();
  await positionTab.click({ timeout: 8000 }).catch(() => {});
  await sleep(1500);

  const pendingSeen =
    (await visibleText(page, "Pending")) || (await bodyIncludes(page, "Pending"));

  if (!pendingSeen) {
    console.log("Did not detect Pending after submission (may still be OK).");
  } else {
    console.log("Confirmed Position order shows Pending.");
  }

  await browser.close().catch(() => {});

  return {
    site: loginUrl,
    popupConfirmed: !!alreadyFollowed,
    pendingConfirmed: !!pendingSeen,
  };
}

async function runOneAccount(account, orderCode) {
  let lastErr = null;

  for (const loginUrl of LOGIN_URLS) {
    console.log(`Trying site: ${loginUrl} for ${account.username}`);
    try {
      const result = await runAccountOnSite(account, orderCode, loginUrl);
      return { ok: true, result };
    } catch (e) {
      lastErr = e;
      console.log(`Site failed: ${loginUrl} for ${account.username} err:`, e && e.message ? e.message : String(e));
      await sleep(800);
    }
  }

  return { ok: false, error: lastErr ? (lastErr.message || String(lastErr)) : "Unknown error" };
}

// --------------------
// Web server
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  const loaded = loadAccounts();
  res.json({
    ok: true,
    running: isRunning,
    lastRun,
    lastError,
    loginUrls: LOGIN_URLS,
    configOk: loaded.ok,
    configError: loaded.ok ? null : loaded.error,
    accountsCount: loaded.ok ? loaded.accounts.length : 0,
  });
});

app.get("/sms-test", async (req, res) => {
  try {
    await sendSMS(`T-Bot SMS test at ${nowLocalString()}`);
    res.send("OK (SMS sent or SMS not configured)");
  } catch (e) {
    res.status(500).send(e && e.message ? e.message : String(e));
  }
});

app.get("/", (req, res) => {
  const loaded = loadAccounts();

  const statusLines = [];
  statusLines.push(`<div><b>T-Bot</b></div>`);
  statusLines.push(`<div style="margin-top:10px;">Running: <b>${isRunning ? "YES" : "NO"}</b></div>`);
  statusLines.push(`<div>Last run: ${lastRun ? lastRun : "null"}</div>`);
  if (lastError) {
    statusLines.push(`<div style="color:#b00020;margin-top:10px;"><b>Last error:</b> ${escapeHtml(String(lastError).slice(0, 1500))}</div>`);
  }

  if (!BOT_PASSWORD) {
    statusLines.push(`<div style="color:#b00020;margin-top:10px;"><b>BOT_PASSWORD not set</b></div>`);
  }

  if (!loaded.ok) {
    statusLines.push(`<div style="color:#b00020;margin-top:10px;"><b>${escapeHtml(loaded.error)}</b></div>`);
  }

  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 24px;">
        ${statusLines.join("\n")}
        <div style="margin-top:18px;">
          <form method="POST">
            <div><input name="password" placeholder="Password" type="password" required /></div>
            <div style="margin-top:8px;"><input name="code" placeholder="Paste order code" required /></div>
            <div style="margin-top:10px;"><button type="submit">Run Bot</button></div>
          </form>
        </div>
        <div style="margin-top:14px;">
          Health: <a href="/health">/health</a> |
          SMS test: <a href="/sms-test">/sms-test</a>
        </div>
      </body>
    </html>
  `);
});

app.post("/", async (req, res) => {
  const password = String(req.body.password || "");
  const orderCode = String(req.body.code || "").trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set");
  if (password !== BOT_PASSWORD) return res.status(401).send("Wrong password");
  if (!orderCode) return res.status(400).send("No code provided");
  if (isRunning) return res.status(409).send("Bot is already running. Please wait.");

  const loaded = loadAccounts();
  if (!loaded.ok) return res.status(500).send(loaded.error);

  isRunning = true;
  lastRun = nowLocalString();
  lastError = null;

  res.send("Bot started. Check Railway logs for progress.");

  // Run in background
  (async () => {
    try {
      await sendSMS(`T-Bot started at ${lastRun}`);

      const accounts = loaded.accounts;

      for (const acct of accounts) {
        if (!acct || !acct.username || !acct.password) {
          throw new Error("Account entry missing username or password");
        }

        // normalize
        acct.username = String(acct.username).trim().toLowerCase();
        acct.password = String(acct.password);

        const result = await runOneAccount(acct, orderCode);

        if (!result.ok) {
          throw new Error(`All sites failed for ${acct.username}. Last error: ${result.error}`);
        }

        console.log(`Account success: ${acct.username} on ${result.result.site} (popup=${result.result.popupConfirmed}, pending=${result.result.pendingConfirmed})`);
        await sleep(800);
      }

      await sendSMS(`T-Bot completed OK at ${nowLocalString()}`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      console.log("RUN FAILED:", msg);
      try {
        await sendSMS(`T-Bot FAILED at ${nowLocalString()}: ${msg.slice(0, 120)}`);
      } catch (smsErr) {
        console.log("SMS failure:", smsErr && smsErr.message ? smsErr.message : String(smsErr));
      }
    } finally {
      isRunning = false;
    }
  })();
});

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
