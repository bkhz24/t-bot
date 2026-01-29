const express = require("express");
const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Simple auth
const FORM_PASSWORD = process.env.FORM_PASSWORD || "change-me";

// Runtime state
let isRunning = false;
let lastRun = null;
let lastError = null;
let statusByUser = {}; // { username: "IDLE" | "RUNNING" | "SUCCESS" | "FAILED" }

function now() {
  return new Date().toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function humanDelay(min = 700, max = 1600) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

// Health check so Railway always gets a fast response
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    isRunning,
    lastRun,
    lastError,
  });
});

app.get("/", (req, res) => {
  const statusJson = escapeHtml(JSON.stringify(statusByUser, null, 2));
  const err = lastError ? `<p style="color:#b00;">Last error: ${escapeHtml(lastError)}</p>` : "";

  res.send(`
    <h2>Follow Bot</h2>
    <p>Last run: ${escapeHtml(lastRun || "Never")}</p>
    <p>Running: ${isRunning ? "YES" : "NO"}</p>
    ${err}

    <h3>Status</h3>
    <pre>${statusJson}</pre>

    <h3>Run</h3>
    <form method="POST" action="/run">
      <div style="margin-bottom:8px;">
        <input name="password" placeholder="Password" type="password" required />
      </div>
      <div style="margin-bottom:8px;">
        <input name="code" placeholder="Paste order code" required />
      </div>
      <button type="submit">Run Bot</button>
    </form>
  `);
});

app.post("/run", async (req, res) => {
  const password = (req.body.password || "").trim();
  const orderCode = (req.body.code || "").trim();

  if (password !== FORM_PASSWORD) return res.status(401).send("Wrong password.");
  if (!orderCode) return res.status(400).send("No code provided.");
  if (isRunning) return res.status(409).send("Bot is already running. Refresh the page to see status.");

  // Respond immediately so the browser does not hang
  isRunning = true;
  lastRun = now();
  lastError = null;

  statusByUser = {};
  for (const a of accounts) statusByUser[a.username] = "IDLE";

  res.send("Started. Refresh the main page in 10 to 20 seconds. Check Railway logs for details.");

  // Run in background (within this same process) without blocking the HTTP response
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
    } finally {
      isRunning = false;
    }
  })();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Web server listening on port", PORT);
});

async function runAccount(account, orderCode) {
  console.log(`\n=== START ${account.username} ===`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // LOGIN: retry until success (with a cap so it cannot loop forever)
    const maxLoginAttempts = 25;
    let loggedIn = false;

    for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
      try {
        console.log(`Login attempt ${attempt} for ${account.userna
