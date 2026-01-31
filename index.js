"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns").promises;
const https = require("https");

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 8080;

const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// Keep your URLs for display/diagnostics only
const LOGIN_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/pc/#/login",
  "https://dsj72.com/h5/#/login",
];

// --------------------
// Helpers
// --------------------
function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}

function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) {
    return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  }
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) {
      return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    }
    const cleaned = parsed.map((a) => ({
      username: (a.username || "").trim(),
      password: String(a.password || ""),
    }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) return { ok: false, accounts: [], error: "Each account must have username + password" };
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e.message}` };
  }
}

// --------------------
// Twilio (optional)
// --------------------
let twilioClient = null;
let smsLibraryOk = false;
let smsLibraryError = null;

function initTwilioOnce() {
  if (twilioClient || smsLibraryOk || smsLibraryError) return;
  try {
    const twilio = require("twilio");
    smsLibraryOk = true;
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }
  } catch (e) {
    smsLibraryOk = false;
    smsLibraryError = e.message || String(e);
  }
}

async function sendSMS(msg) {
  initTwilioOnce();
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !TWILIO_TO) return null;
  if (!twilioClient) return null;

  try {
    const res = await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: TWILIO_TO,
      body: msg,
    });
    console.log("SMS sent:", res.sid);
    return res.sid;
  } catch (e) {
    console.log("SMS failed:", e.message || String(e));
    return null;
  }
}

// --------------------
// Run state
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;

let lastShotPath = null; // you can still store any png you want here
let lastRunId = null;
let runReport = null;

// --------------------
// Minimal network diagnostics
// --------------------
function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "T-Bot/1.0",
          Accept: "application/json,text/plain,*/*",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString("utf8")));
        res.on("end", () => resolve({ ok: true, status: res.statusCode, body: data.slice(0, 500) }));
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", (e) => resolve({ ok: false, error: e.message || String(e) }));
  });
}

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const cfg = safeJsonParseAccounts();
  const pwMissing = !BOT_PASSWORD;
  const accountsMissing = !cfg.ok;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>

    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
      ${accountsMissing ? escapeHtml(cfg.error || "ACCOUNTS_JSON not set") : ""}
      ${lastError ? `<br/>Last error: ${escapeHtml(lastError)}` : ""}
    </div>

    <form method="POST" action="/run" style="margin-top:12px;">
      <input name="p" placeholder="Password" type="password" required />
      <br/><br/>
      <input name="code" placeholder="Paste order code" required />
      <br/><br/>
      <button type="submit">Run Bot</button>
    </form>

    <div style="margin-top:12px;">
      <a href="/health">/health</a>
      | <a href="/run?p=${encodeURIComponent(BOT_PASSWORD || "")}">/run</a>
      | <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "")}">/last-shot</a>
      | <a href="/sms-test?p=${encodeURIComponent(BOT_PASSWORD || "")}">/sms-test</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD || "")}">/dns-test</a>
      | <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD || "")}">/net-test</a>
    </div>
  `);
});

app.get("/health", (req, res) => {
  const cfg = safeJsonParseAccounts();
  initTwilioOnce();

  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError: lastError,
    loginUrls: LOGIN_URLS.slice(0, 3),
    configOk: cfg.ok,
    configError: cfg.error,
    accountsCount: cfg.ok ? cfg.accounts.length : 0,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    smsLibraryOk,
    smsLibraryError,
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

app.get("/last-shot", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!lastShotPath || !fs.existsSync(lastShotPath)) return res.send("No screenshot captured yet.");
  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(lastShotPath).pipe(res);
});

// GET /run renders a page you can visit directly
app.get("/run", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Wrong password.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>Run</h2>
    <form method="POST" action="/run">
      <input type="hidden" name="p" value="${escapeHtml(req.query.p)}" />
      <div>Order code:</div>
      <input name="code" required />
      <br/><br/>
      <button type="submit">Start</button>
    </form>
    <p><a href="/">Back</a></p>
  `);
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");

  runReport = {
    id: lastRunId,
    started: lastRunAt,
    codeLength: code.length,
    accounts: cfg.accounts.map((a) => ({
      username: a.username,
      completed: false,
      error: null,
    })),
    status: "Running now. Refresh this page.",
  };

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

  (async () => {
    try {
      console.log("Bot started");
      console.log("Accounts loaded:", cfg.accounts.length);
      console.log("Code received length:", code.length);

      await sendSMS(`T-Bot started at ${lastRunAt}`);

      // This is intentionally a “dry run” server.
      // If you want a production action, use official APIs or manual steps.
      for (let i = 0; i < cfg.accounts.length; i++) {
        console.log("Would run for:", cfg.accounts[i].username);
        runReport.accounts[i].completed = true;
      }

      runReport.status = "Completed (dry run).";
      await sendSMS(`T-Bot completed at ${nowLocal()}`);
      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      runReport.status = "Run failed: " + msg;
      await sendSMS(`T-Bot failed at ${nowLocal()}: ${msg}`);
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

// DNS test (proves Railway can resolve the domains)
app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const targets = ["api.bgol.pro", "api.ddjea.com", "bgol.pro", "dsj89.com", "dsj72.com"];
  const out = {};

  for (const t of targets) {
    try {
      const addrs = await dns.lookup(t, { all: true });
      out[t] = { ok: true, addrs };
    } catch (e) {
      out[t] = { ok: false, error: e.code ? `${e.code} ${e.message}` : (e.message || String(e)) };
    }
  }

  res.json(out);
});

// Net test (proves HTTP reachability from Railway)
app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  const tests = [
    "https://api.bgol.pro/api/app/ping",
    "https://api.ddjea.com/api/app/ping",
  ];

  const out = {};
  for (const u of tests) {
    out[u] = await httpsGet(u);
  }

  res.json(out);
});

function renderRunReport(report) {
  const rows = report.accounts
    .map((a, idx) => {
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(a.username)}</td>
          <td>${a.completed ? "YES" : "NO"}</td>
          <td>${a.error ? `<span style="color:red">${escapeHtml(a.error)}</span>` : "--"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <h2>Run Checklist</h2>
    <div><b>Run ID:</b> ${escapeHtml(report.id)}</div>
    <div><b>Started:</b> ${escapeHtml(report.started)}</div>
    <div><b>Code length:</b> ${report.codeLength}</div>
    <hr/>
    <h3>Accounts</h3>
    <table border="1" cellpadding="8" cellspacing="0">
      <thead>
        <tr><th>#</th><th>Username</th><th>Completed</th><th>Error</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p><b>Status:</b> ${escapeHtml(report.status)}</p>

    <div>
      <a href="/">Back to home</a>
      | <a href="/health">Health</a>
      | <a href="/dns-test?p=${encodeURIComponent(BOT_PASSWORD)}">DNS test</a>
      | <a href="/net-test?p=${encodeURIComponent(BOT_PASSWORD)}">Net test</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
    </div>
  `;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
