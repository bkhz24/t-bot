const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";

let accounts = [];
let configError = null;

try {
  if (!process.env.ACCOUNTS_JSON) throw new Error("ACCOUNTS_JSON not set");
  accounts = JSON.parse(process.env.ACCOUNTS_JSON);
  if (!Array.isArray(accounts)) throw new Error("ACCOUNTS_JSON must be an array");
} catch (e) {
  configError = e.message;
}

let running = false;
let lastRun = null;
let lastError = null;

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h1>T-Bot</h1>

    <p><strong>Running:</strong> ${running ? "YES" : "NO"}</p>
    <p><strong>Last run:</strong> ${lastRun || "-"}</p>
    ${lastError ? `<p style="color:red"><strong>Last error:</strong> ${escapeHtml(lastError)}</p>` : ""}
    ${configError ? `<p style="color:red"><strong>${escapeHtml(configError)}</strong></p>` : ""}

    <form method="POST" action="/run">
      <input type="password" name="password" placeholder="Password" required /><br/><br/>
      <input type="text" name="code" placeholder="Paste order code" required /><br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <p>
      Health: <a href="/health">/health</a>
      &nbsp;|&nbsp;
      Route test: <a href="/run">/run</a>
    </p>
  `);
});

/**
 * This exists ONLY to prove routing is live.
 * If you can load /run in a browser, Railway is running this exact file.
 */
app.get("/run", (req, res) => {
  res.status(200).send("OK: /run route exists. Submit the form on / to POST to /run.");
});

app.post("/run", async (req, res) => {
  if (running) return res.status(429).send("Bot already running.");

  if (req.body.password !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const code = (req.body.code || "").trim();
  if (!code) return res.status(400).send("No order code provided.");

  if (configError) return res.status(500).send("Config error: " + configError);

  running = true;
  lastRun = new Date().toLocaleString();
  lastError = null;

  res.status(200).send("Bot started. Check Railway logs.");

  try {
    console.log("Bot started");
    console.log("Accounts loaded:", accounts.length);
    console.log("Code received length:", code.length);

    // Safe stub. No automation here.
    for (const acct of accounts) {
      console.log("Would run for:", acct.username);
    }

    console.log("Bot completed");
  } catch (e) {
    lastError = e && e.message ? e.message : String(e);
    console.error("Bot failed:", lastError);
  } finally {
    running = false;
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    running,
    lastRun,
    lastError,
    configOk: !configError,
    configError,
    accountsCount: accounts.length,
    port: PORT
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
