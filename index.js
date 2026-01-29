const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Password for the form (set this in Railway Variables)
const FORM_PASSWORD = process.env.FORM_PASSWORD || "change-me";

// Runtime state
let isRunning = false;
let lastRun = null;
let lastError = null;
let statusByUser = {}; // username -> IDLE | RUNNING | SUCCESS | FAILED

function now() {
  return new Date().toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}

// Always-responding endpoints
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    isRunning,
    lastRun,
    lastError,
    statusByUser
  });
});

app.get("/", (req, res) => {
  const statusJson = escapeHtml(JSON.stringify(statusByUser, null, 2));
  const errHtml = lastError ? '<p style="color:#b00;">Last error: ' + escapeHtml(lastError) + "</p>" : "";

  res.send(
    "<h2>Follow Bot</h2>" +
      "<p>Last run: " + escapeHtml(lastRun || "Never") + "</p>" +
      "<p>Running: " + (isRunning ? "YES" : "NO") + "</p>" +
      errHtml +
      "<h3>Status</h3>" +
      "<pre>" + statusJson + "</pre>" +
      "<h3>Run</h3>" +
      '<form method="POST" action="/run">' +
      '<div style="margin-bottom:8px;"><input name="password" placeholder="Password" type="password" required /></div>' +
      '<div style="margin-bottom:8px;"><input name="code" placeholder="Paste order code" required /></div>' +
      "<button type=\"submit\">Run Bot</button>" +
      "</form>"
  );
});

app.post("/run", async (req, res) => {
  const password = String(req.body.password || "").trim();
  const orderCode = String(req.body.code || "").trim();

  if (password !== FORM_PASSWORD) return res.status(401).send("Wrong password.");
  if (!orderCode) return res.status(400).send("No code provided.");
  if (isRunning) return res.status(409).send("Bot is already running. Refresh the page to see status.");

  isRunning = true;
  lastRun = now();
  lastError = null;

  statusByUser = {};
  for (const a of accounts) statusByUser[a.username] = "IDLE";

  res.send("Started. Refresh the main page in 10 to 20 seconds. Check Railway logs for details.");

  // Background run
  (async () => {
    try {
      for (const account of accounts) {
        statusByUser[account.username] = "RUNNING";
        await runAccount(account, orderCode);
        statusByUser[account.username] = "SUCCESS";
      }
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      console.error("RUN FAILED:", e);
      // mark any RUNNING as FAILED
      for (const k of Object.keys(statusByUser)) {
        if (statusByUser[k] === "RUNNING") statusByUser[k] = "FAILED";
      }
    } finally {
      isRunning = false;
    }
  })();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Web server listening on port", PORT);
});

async function runAccount(account, orderCode) {
  console.log("\n=== START " + account.username + " ===");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // LOGIN retry (cap so it can't loop forever)
    const maxLoginAttempts = 25;
    let loggedIn = false;

    for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
      try {
        console.log("Login attempt " + attempt + " for " + account.username);

        await page.goto("https://bgol.pro/h5/#/login", { timeout: 60000 });
        await humanDelay(700, 1400);

        await page.fill('input[type="text"]', account.username);
        await humanDelay(500, 1200);

        await page.fill('input[type="password"]', account.password);
        await humanDelay(500, 1200);

        await page.click("button");
        await humanDelay(1500, 2800);

        const futuresVisible = await page
          .locator("text=Futures")
          .first()
          .isVisible()
          .catch(() => false);

        if (futuresVisible) {
          loggedIn = true;
          console.log("Login confirmed for " + account.username);
          break;
        }

        console.log("Login not confirmed yet, retrying...");
      } catch (e) {
        console.log("Login attempt failed for " + account.username);
      }

      await humanDelay(2000, 4000);
    }

    if (!loggedIn) {
      throw new Error("Login failed too many times for " + account.username);
    }

    // NAVIGATE
    await page.click("text=Futures");
    await humanDelay(1200, 2500);

    await page.click("text=Invited Me");
    await humanDelay(1200, 2500);

    // Fill code + confirm
    await page.waitForSelector("input", { timeout: 60000 });
    await page.fill("input", orderCode);
    await humanDelay(700, 1400);

    await page.click("text=Confirm");
    await humanDelay(1500, 3000);

    // Popup optional
    const popupSeen = await page
      .locator("text=Already followed the order")
      .first()
      .isVisible()
      .catch(() => false);

    console.log("Popup seen for " + account.username + ": " + (popupSeen ? "YES" : "NO"));

    // Verify Pending
    await page.click("text=Position Order");
    await humanDelay(1200, 2500);

    const verifyTimeoutMs = 120000;
    const start = Date.now();

    while (Date.now() - start < verifyTimeoutMs) {
      const pendingCount = await page.locator("text=Pending").count().catch(() => 0);
      if (pendingCount > 0) {
        console.log("SUCCESS Pending for " + account.username);
        return;
      }

      console.log("Pending not found yet for " + account.username + ", retrying...");
      await page.reload();
      await humanDelay(2000, 3500);

      const posVisible = await page
        .locator("text=Position Order")
        .first()
        .isVisible()
        .catch(() => false);

      if (posVisible) {
        await page.click("text=Position Order");
        await humanDelay(900, 1600);
      }
    }

    throw new Error("Pending did not appear for " + account.username + " within timeout");
  } finally {
    await browser.close().catch(() => {});
    console.log("=== END " + account.username + " ===");
  }
}
