const express = require("express");
const { chromium } = require("playwright");
const nodemailer = require("nodemailer");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
let isRunning = false;

/* ------------------ EMAIL ------------------ */

const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

function hasEmailConfig() {
  return (
    EMAIL_TO &&
    EMAIL_FROM &&
    SMTP_HOST &&
    SMTP_PORT &&
    SMTP_USER &&
    SMTP_PASS
  );
}

const transporter = hasEmailConfig()
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendEmail(subject, text) {
  if (!transporter) {
    console.log("Email not configured. Skipping email:", subject);
    return;
  }
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text,
  });
}

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

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, isRunning });
});

app.post("/", async (req, res) => {
  if (isRunning) return res.send("Bot is already running. Please wait.");

  const orderCode = (req.body.code || "").trim();
  if (!orderCode) return res.send("No code provided.");

  isRunning = true;

  // Respond immediately so the browser does not hang
  res.send("Bot started. Check Railway logs for progress.");

  // Run in the background
  (async () => {
    const startedAt = new Date();
    const results = [];

    try {
      await sendEmail(
        "T-Bot started",
        "Started at: " +
          startedAt.toLocaleString() +
          "\nAccounts: " +
          accounts.map((a) => a.username).join(", ")
      );

      for (const account of accounts) {
        try {
          await runAccount(account, orderCode);
          results.push({ username: account.username, ok: true });
          await sendEmail(
            "T-Bot success: " + account.username,
            "Account finished successfully.\nTime: " + new Date().toLocaleString()
          );
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          results.push({ username: account.username, ok: false, error: msg });
          await sendEmail(
            "T-Bot FAILED: " + account.username,
            "Account failed.\nError: " + msg + "\nTime: " + new Date().toLocaleString()
          );
        }
      }

      const endedAt = new Date();
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;

      const summaryLines = results.map((r) => {
        if (r.ok) return "OK: " + r.username;
        return "FAIL: " + r.username + " | " + r.error;
      });

      await sendEmail(
        "T-Bot finished (OK " + okCount + ", FAIL " + failCount + ")",
        "Started: " +
          startedAt.toLocaleString() +
          "\nEnded: " +
          endedAt.toLocaleString() +
          "\n\nResults:\n" +
          summaryLines.join("\n")
      );

      console.log("All accounts processed");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("Bot run failed:", err);
      try {
        await sendEmail("T-Bot crashed", "Error: " + msg);
      } catch {}
    } finally {
      isRunning = false;
    }
  })();
});

/* ------------------ BOT LOGIC ------------------ */

async function runAccount(account, orderCode) {
  console.log("Processing account:", account.username);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Retry login until success
    let loggedIn = false;
    let attempt = 0;

    while (!loggedIn && attempt < 10) {
      attempt++;
      console.log("Login attempt", attempt, "for", account.username);

      try {
        await page.goto("https://bgol.pro/h5/#/login", { timeout: 60000 });

        await page.fill('input[type="text"]', account.username);
        await page.fill('input[type="password"]', account.password);
        await page.click("button");

        await page.waitForTimeout(5000);

        const futuresVisible = await page.locator("text=Futures").first().isVisible().catch(() => false);
        if (futuresVisible) loggedIn = true;
      } catch {
        await page.waitForTimeout(2500);
      }
    }

    if (!loggedIn) throw new Error("Could not log in");

    // Futures
    await page.click("text=Futures");
    await page.waitForTimeout(2500);

    // Invited Me
    await page.click("text=Invited me");
    await page.waitForTimeout(2500);

    // Enter code
    await page.waitForSelector("input", { timeout: 60000 });
    await page.fill("input", orderCode);

    // Confirm
    await page.click("text=Confirm");

    // Confirmation popup
    await page.waitForTimeout(2000);

    // Verify Pending in Position order
    await page.click("text=Position order");
    await page.waitForSelector("text=Pending", { timeout: 20000 });

    console.log("Success for", account.username);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* ------------------ START SERVER ------------------ */

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
