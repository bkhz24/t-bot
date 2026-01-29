const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Simple in-memory status
let isRunning = false;
let lastRun = null;
let status = {}; // { username: "IDLE" | "RUNNING" | "SUCCESS" | "FAILED" }

// Small human-like delay
function humanDelay(min = 800, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function now() {
  return new Date().toLocaleString();
}

app.get("/", (req, res) => {
  res.send(`
    <h2>Follow Bot</h2>
    <p>Last run: ${lastRun || "Never"}</p>
    <pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>

    <form method="POST" action="/run">
      <input name="code" placeholder="Paste order code" required />
      <button type="submit">Run Bot</button>
    </form>
  `);
});

app.post("/run", async (req, res) => {
  const orderCode = (req.body.code || "").trim();

  if (!orderCode) return res.status(400).send("No code provided.");
  if (isRunning) return res.status(409).send("Bot is already running. Try again in a minute.");

  // Initialize status
  isRunning = true;
  lastRun = now();
  for (const a of accounts) status[a.username] = "IDLE";

  res.send("Bot started. Refresh the page in 10-20 seconds to see status. Check Railway logs for details.");

  try {
    for (const account of accounts) {
      status[account.username] = "RUNNING";
      await runAccount(account, orderCode);
      status[account.username] = "SUCCESS";
    }
  } catch (err) {
    console.error("RUN FAILED:", err);
    // Mark the current running account as failed if we can infer it
  } finally {
    isRunning = false;
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Web server listening on port", PORT);
});

/* -----------------------
   BOT LOGIC
------------------------ */

async function runAccount(account, orderCode) {
  console.log(`\n=== STARTING ${account.username} ===`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // LOGIN: retry until success (with a safety cap)
    const maxLoginAttempts = 20;
    let loggedIn = false;

    for (let attempt = 1; attempt <= maxLoginAttempts && !loggedIn; attempt++) {
      try {
        console.log(`Login attempt ${attempt} for ${account.username}`);
        await page.goto("https://bgol.pro/h5/#/login", { timeout: 60000 });
        await humanDelay();

        // These selectors may need adjustment based on the exact DOM,
        // but this is a safe starting point.
        await page.fill('input[type="text"]', account.username);
        await humanDelay();
        await page.fill('input[type="password"]', account.password);
        await humanDelay();
        await page.click("button");
        await humanDelay(1500, 3000);

        // Validation: futures button should be visible if logged in
        const futuresVisible = await page.locator("text=Futures").first().isVisible().catch(() => false);
        if (futuresVisible) {
          loggedIn = true;
          console.log(`Login successful for ${account.username}`);
          break;
        }

        console.log("Login not confirmed, retrying...");
      } catch (e) {
        console.log("Login failed, retrying...");
      }

      await humanDelay(2000, 4000);
    }

    if (!loggedIn) {
      throw new Error(`Login failed too many times for ${account.username}`);
    }

    // NAVIGATE: Futures -> Invited Me
    await page.click("text=Futures");
    await humanDelay(1500, 3000);

    await page.click("text=Invited Me");
    await humanDelay(1500, 3000);

    // Enter code and confirm (based on your described flow)
    // We try to find an input and fill it with the order code.
    // If your site has multiple inputs, we may need a more specific selector.
    await page.waitForSelector("input", { timeout: 60000 });
    await page.fill("input", orderCode);
    await humanDelay();

    await page.click("text=Confirm");
    await humanDelay(1500, 3000);

    // First confirmation popup may appear: "Already followed the order"
    // Not required for success, but log it if it appears.
    const popupSeen = await page.locator('text=Already followed the order').first().isVisible().catch(() => false);
    if (popupSeen) {
      console.log(`Popup seen for ${account.username}: Already followed the order`);
    } else {
      console.log(`Popup not seen for ${account.username} (OK)`);
    }

    // Verify success: Position Order shows Pending (red)
    await page.click("text=Position Order");
    await humanDelay(1500, 3000);

    const verifyTimeoutMs = 120000; // 2 minutes
    const start = Date.now();
    let pendingFound = false;

    while (Date.now() - start < verifyTimeoutMs) {
      const pendingCount = await page.locator("text=Pending").count().catch(() => 0);
      if (pendingCount > 0) {
        pendingFound = true;
        console.log(`SUCCESS: ${account.username} shows Pending`);
        break;
      }
      console.log(`Pending not found yet for ${account.username}, refreshing...`);
      await page.reload();
      await humanDelay(2000, 4000);
      // Sometimes you may need to navigate back to Position Order after reload
      const posVisible = await page.locator("text=Position Order").first().isVisible().catch(() => false);
      if (posVisible) {
        await page.click("text=Position Order");
        await humanDelay(1000, 2000);
      }
    }

    if (!pendingFound) {
      throw new Error(`Pending did not appear for ${account.username} within timeout`);
    }

    console.log(`=== DONE ${account.username} ===`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* -----------------------
   HELPERS
------------------------ */

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
