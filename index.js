const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
let isRunning = false;

/* ------------------ WEB UI ------------------ */

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
    console.log("✅ All accounts processed");
  } catch (err) {
    console.error("❌ Bot run failed:", err);
  } finally {
    isRunning = false;
  }
});

/* ------------------ BOT LOGIC ------------------ */

async function runAccount(account, orderCode) {
  console.log(`\n🔐 Processing account: ${account.username}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  let loggedIn = false;
  let attempt = 0;

  // Retry login until success
  while (!loggedIn && attempt < 5) {
    attempt++;
    console.log(`Login attempt ${attempt} for ${account.username}`);

    try {
      await page.goto("https://bgol.pro/h5/#/login", { timeout: 60000 });

      await page.fill('input[type="text"]', account.username);
      await page.fill('input[type="password"]', account.password);
      await page.click("button");

      await page.waitForTimeout(5000);
      loggedIn = true;
    } catch (err) {
      console.log("Login failed, retrying...");
    }
  }

  if (!loggedIn) {
    console.log(`❌ Could not log in: ${account.username}`);
    await browser.close();
    return;
  }

  console.log("✅ Logged in");

  // Futures tab
  await page.click("text=Futures");
  await page.waitForTimeout(3000);

  // Invited Me
  await page.click("text=Invited me");
  await page.waitForTimeout(3000);

  // Enter order code
  await page.fill('input', orderCode);
  await page.click("text=Confirm");

  // First confirmation
  await page.waitForSelector("text=Already followed the order", {
    timeout: 15000
  });

  console.log("✅ First confirmation received");

  // Second confirmation (Pending in Position Order)
  await page.click("text=Position order");
  await page.waitForSelector("text=Pending", { timeout: 15000 });

  console.log("✅ Second confirmation (Pending)");

  await browser.close();
}

/* ------------------ START SERVER ------------------ */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
