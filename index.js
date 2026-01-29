const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
let isRunning = false;

/* -----------------------
   SIMPLE WEB FORM
------------------------ */
app.get("/", (req, res) => {
  res.send(`
    <h2>Follow Bot</h2>
    <form method="POST">
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>
  `);
});

/* -----------------------
   FORM SUBMIT HANDLER
------------------------ */
app.post("/", async (req, res) => {
  if (isRunning) {
    return res.send("Bot is already running. Please wait.");
  }

  const orderCode = req.body.code;
  if (!orderCode) {
    return res.send("No code provided.");
  }

  isRunning = true;
  res.send("Bot started. Check Railway logs for progress.");

  try {
    for (const account of accounts) {
      await runAccount(account, orderCode);
    }
  } catch (err) {
    console.error("Run failed:", err);
  } finally {
    isRunning = false;
  }
});

/* -----------------------
   BOT LOGIC
------------------------ */
async function runAccount(account, orderCode) {
  console.log(`\n=== STARTING ${account.username} ===`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  /* LOGIN (RETRY UNTIL SUCCESS) */
  let loggedIn = false;
  while (!loggedIn) {
    try {
      console.log("Attempting login...");
      await page.goto("https://bgol.pro/h5/#/login", { timeout: 60000 });

      await page.fill('input[type="text"]', account.username);
      await page.fill('input[type="password"]', account.password);
      await page.click("button");

      await page.waitForTimeout(5000);
      loggedIn = true;
      console.log("Login successful");
    } catch (e) {
      console.log("Login failed, retrying...");
      await page.waitForTimeout(3000);
    }
  }

  /* NAVIGATE */
  await page.click("text=Futures");
  await page.waitForTimeout(2000);
  await page.click("text=Invited Me");

  /* WAIT FOR FOLLOW ORDER */
  await page.waitForSelector("text=Follow", { timeout: 60000 });

  /* FOLLOW + CONFIRM */
  await page.click("text=Follow");
  await page.waitForTimeout(1000);
  await page.click("text=Confirm");

  console.log("Follow clicked");

  /* IGNORE POPUP IF IT APPEARS */
  await page.waitForTimeout(3000);

  /* VERIFY SUCCESS: PENDING (RED) */
  await page.click("text=Position Order");

  let success = false;
  const start = Date.now();

  while (!success && Date.now() - start < 120000) {
    const pendingCount = await page.locator("text=Pending").count();
    if (pendingCount > 0) {
      success = true;
      console.log(`SUCCESS: ${account.username} is Pending`);
    } else {
      console.log("Pending not found yet, retrying...");
      await page.reload();
      await page.waitForTimeout(3000);
    }
  }

  if (!success) {
    console.log(`FAILED: ${account.username} did not reach Pending`);
  }

  await browser.close();
}

/* -----------------------
   START WEB SERVER
------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log("Web server listening on port", PORT);
});
