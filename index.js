const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";

let accounts = [];
let configError = null;

// Load accounts safely
try {
  if (!process.env.ACCOUNTS_JSON) {
    throw new Error("ACCOUNTS_JSON not set");
  }
  accounts = JSON.parse(process.env.ACCOUNTS_JSON);
  if (!Array.isArray(accounts)) {
    throw new Error("ACCOUNTS_JSON must be an array");
  }
} catch (e) {
  configError = e.message;
}

let running = false;
let lastRun = null;
let lastError = null;

/* -------------------- UI -------------------- */
app.get("/", (req, res) => {
  res.send(`
    <h1>T-Bot</h1>
    <p><strong>Running:</strong> ${running ? "YES" : "NO"}</p>
    <p><strong>Last run:</strong> ${lastRun || "—"}</p>
    ${lastError ? `<p style="color:red"><strong>Last error:</strong> ${lastError}</p>` : ""}
    ${configError ? `<p style="color:red"><strong>${configError}</strong></p>` : ""}

    <form method="POST" action="/run">
      <input type="password" name="password" placeholder="Password" required /><br/><br/>
      <input type="text" name="code" placeholder="Paste order code" required /><br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <br/>
    <a href="/health">/health</a>
  `);
});

/* -------------------- RUN -------------------- */
app.post("/run", async (req, res) => {
  if (running) {
    return res.send("Bot already running.");
  }

  if (req.body.password !== BOT_PASSWORD) {
    return res.send("Wrong password.");
  }

  const code = req.body.code;
  if (!code) {
    return res.send("No order code provided.");
  }

  if (configError) {
    return res.send("Configuration error: " + configError);
  }

  running = true;
  lastRun = new Date().toLocaleString();
  lastError = null;

  res.send("Bot started. Check logs.");

  try {
    console.log("Bot started with code:", code);
    console.log("Accounts loaded:", accounts.length);

    /*
      =====================================================
      PLACEHOLDER FOR AUTOMATION LOGIC
      =====================================================

      This is intentionally left as a stub.

      You would loop accounts here and perform actions,
      but no automation is included in this file.
    */

    for (const acct of accounts) {
      console.log("Would run for:", acct.username);
    }

    console.log("Bot completed successfully");
  } catch (err) {
    lastError = err.message || String(err);
    console.error("Bot failed:", lastError);
  } finally {
    running = false;
  }
});

/* -------------------- HEALTH -------------------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    running,
    lastRun,
    lastError,
    configOk: !configError,
    accountsCount: accounts.length
  });
});

/* -------------------- START -------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
