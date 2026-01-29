const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
let isRunning = false;

/* ---------------- WEB UI ---------------- */

app.get("/", (req, res) => {
  res.send(`
    <h2>T-Bot</h2>
    <form method="POST">
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>
    <p>Status: ${isRunning ? "RUNNING" : "IDLE"}</p>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, running: isRunning });
});

app.post("/", async (req, res) => {
  if (isRunning) {
    return res.send("Bot already running. Please wait.");
  }

  const orderCode = (req.body.code || "").trim();
  if (!orderCode) {
    return res.send("No code provided.");
  }

  isRunning = true;
  res.send("Bot started. Check Railway logs.");

  (async () => {
    try {
      for (const account of accounts) {
        await runAccount(account, orderCode);
      }
      console.log("All accounts completed successfully");
    } catch (err) {
      console.error("Run failed:", err);
    } finally {
      isRunning = false;
    }
  })(
