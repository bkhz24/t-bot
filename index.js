"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "[]";

// Persist a stable last-shot path inside /app so it survives within the running container
const LAST_SHOT_FILE = path.join(process.cwd(), "last-shot.png");

// --------------------
// Helpers
// --------------------
function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authOkFromQuery(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}

function safeParseAccounts() {
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON || "[]");
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "ACCOUNTS_JSON must be a JSON array", accounts: [] };
    }
    const cleaned = parsed.map((a) => ({
      username: String(a.username || "").trim(),
      password: String(a.password || ""),
    }));
    // Allow empty while testing, but show warning in UI
    return { ok: true, error: null, accounts: cleaned };
  } catch (e) {
    return { ok: false, error: `ACCOUNTS_JSON invalid JSON: ${e.message}`, accounts: [] };
  }
}

/**
 * Fix 1: Hard validation so you never get "Invalid URL. It must include https://"
 * Accepts either:
 * - https://bgol.pro/pc/#/login
 * - bgol.pro/pc/#/login   (we will add https://)
 */
function normalizeHttpsUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Missing URL.");

  const withScheme = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw
    : `https://${raw}`;

  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error("Invalid URL. It must be a valid https:// URL.");
  }

  if (u.protocol !== "https:") throw new Error("Invalid URL. It must include https://");

  return u.toString();
}

/**
 * Fix 2: Normalize the login path to the exact route you want.
 * If user passes domain only, or a /pc or /h5 root, force /pc/#/login.
 */
function normalizeLoginUrl(input) {
  const urlStr = normalizeHttpsUrl(input);
  const u = new URL(urlStr);

  // If they give just bgol.pro or bgol.pro/pc, convert to /pc/#/login
  const lowerPath = (u.pathname || "").toLowerCase();

  // If already includes "#/login", keep it
  if ((u.hash || "").toLowerCase().includes("/login")) {
    return u.toString();
  }

  // If they hit /pc or /h5 but no hash route, force login hash
  if (lowerPath.startsWith("/pc")) {
    u.pathname = "/pc/";
    u.hash = "#/login";
    return u.toString();
  }
  if (lowerPath.startsWith("/h5")) {
    u.pathname = "/h5/";
    u.hash = "#/login";
    return u.toString();
  }

  // Default to /pc/#/login
  u.pathname = "/pc/";
  u.hash = "#/login";
  return u.toString();
}

// --------------------
// In-memory run state
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;

let lastRunId = null;
let runReport = null;

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeParseAccounts();
  const pwMissing = !BOT_PASSWORD;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "--"}</div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
      ${!cfg.ok ? escapeHtml(cfg.error) : ""}
      ${lastError ? `<br/>Last error: ${escapeHtml(lastError)}` : ""}
    </div>

    <form method="POST" action="/run" style="margin-top:12px;">
      <div>
        <input name="p" placeholder="Bot password" type="password" required style="width:360px;" />
      </div>
      <br/>
      <div>
        <input name="code" placeholder="Paste order code" required style="width:360px;" />
      </div>
      <br/>
      <div>
        <input name="loginUrl" placeholder="Login URL (optional). Example: https://bgol.pro/pc/#/login" style="width:360px;" />
      </div>
      <br/>
      <button type="submit">Run</button>
    </form>

    <div style="margin-top:12px;">
      <a href="/health">Health</a>
      ${BOT_PASSWORD ? ` | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}">Last screenshot</a>` : ""}
    </div>
  `);
});

app.get("/health", (req, res) => {
  const cfg = safeParseAccounts();
  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    configOk: cfg.ok,
    configError: cfg.error,
  });
});

app.get("/last-shot", (req, res) => {
  if (!authOkFromQuery(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!fs.existsSync(LAST_SHOT_FILE)) return res.send("No screenshot captured yet.");

  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(LAST_SHOT_FILE).pipe(res);
});

app.get("/run/:id", (req, res) => {
  if (!authOkFromQuery(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();
  const loginUrlRaw = (req.body.loginUrl || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  // Fix 1 + 2: Normalize URL if provided, otherwise default.
  let normalizedLoginUrl = "https://bgol.pro/pc/#/login";
  try {
    if (loginUrlRaw) normalizedLoginUrl = normalizeLoginUrl(loginUrlRaw);
  } catch (e) {
    return res.status(400).send(escapeHtml(e.message || String(e)));
  }

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");

  runReport = {
    id: lastRunId,
    started: lastRunAt,
    normalizedUrl: normalizedLoginUrl,
    codeLength: code.length,
    status: "Running now. Refresh this page.",
    steps: [
      "Validate password",
      "Normalize login URL",
      "Record run",
      "Perform run work (placeholder)",
      "Update status",
    ],
  };

  // respond immediately
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

  // run async (placeholder work)
  (async () => {
    try {
      console.log("Bot started");
      console.log("Run ID:", lastRunId);
      console.log("Code received length:", code.length);
      console.log("Normalized URL:", normalizedLoginUrl);

      // Create/overwrite a placeholder “screenshot” so /last-shot works
      // If you have a real screenshot later, just overwrite LAST_SHOT_FILE.
      writePlaceholderPng(LAST_SHOT_FILE);

      console.log("Wrote placeholder last-shot.png");

      runReport.status = "Completed (plumbing check).";
      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      runReport.status = "Run failed: " + msg;
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

function renderRunReport(report) {
  return `
    <h2>Run Started</h2>
    <div><b>Run ID:</b> ${escapeHtml(report.id)}</div>
    <div><b>Started:</b> ${escapeHtml(report.started)}</div>
    <div><b>Normalized URL:</b> ${escapeHtml(report.normalizedUrl)}</div>
    <div><b>Code length:</b> ${report.codeLength}</div>
    <hr/>
    <ol>
      ${report.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
    </ol>
    <p><b>Status:</b> ${escapeHtml(report.status)}</p>
    <div>
      <a href="/">Back to home</a>
      | <a href="/health">Health</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}">Last screenshot</a>
    </div>
  `;
}

/**
 * Writes a tiny valid PNG file so you can confirm /last-shot works end to end.
 * This avoids needing any image libs.
 */
function writePlaceholderPng(filePath) {
  // 1x1 transparent PNG
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax2pQAAAABJRU5ErkJggg==";
  const buf = Buffer.from(pngBase64, "base64");
  fs.writeFileSync(filePath, buf);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
});
