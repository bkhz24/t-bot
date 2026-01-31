"use strict";

const express = require("express");

// Optional SMS via Twilio. If env vars are missing, it will run without SMS.
let twilioClient = null;
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  if (!twilioClient) {
    // Lazy require so the app still runs if twilio is not installed yet.
    const twilio = require("twilio");
    twilioClient = twilio(sid, token);
  }
  return twilioClient;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Railway sets PORT. Locally you can use 3000.
const PORT = Number(process.env.PORT || 3000);

// Config
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || ""; // Your phone number to receive texts, in E.164 format like +18015551234

const LOGIN_URLS = [
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/h5/#/login",
];

function safeParseAccounts() {
  if (!ACCOUNTS_JSON) {
    return { ok: false, error: "ACCOUNTS_JSON not set", accounts: [] };
  }
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "ACCOUNTS_JSON must be an array", accounts: [] };
    }
    const accounts = parsed
      .map((a) => ({
        username: String(a.username || "").trim(),
        password: String(a.password || "").trim(),
      }))
      .filter((a) => a.username.length > 0);

    if (accounts.length === 0) {
      return { ok: false, error: "No accounts found in ACCOUNTS_JSON", accounts: [] };
    }
    return { ok: true, error: null, accounts };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}`, accounts: [] };
  }
}

async function sendSMS(message) {
  const client = getTwilioClient();
  if (!client) {
    console.log("SMS not sent (Twilio not configured):", message);
    return { ok: false, error: "Twilio not configured" };
  }
  if (!TWILIO_FROM || !TWILIO_TO) {
    console.log("SMS not sent (TWILIO_FROM or TWILIO_TO missing):", message);
    return { ok: false, error: "TWILIO_FROM or TWILIO_TO missing" };
  }

  try {
    const res = await client.messages.create({
      from: TWILIO_FROM,
      to: TWILIO_TO,
      body: message,
    });
    console.log("SMS sent:", res.sid);
    return { ok: true, sid: res.sid };
  } catch (e) {
    console.log("SMS failed:", e.message || String(e));
    return { ok: false, error: e.message || String(e) };
  }
}

function nowLocalString() {
  try {
    return new Date().toLocaleString();
  } catch {
    return new Date().toISOString();
  }
}

// In-memory run state (good for Railway single instance)
const state = {
  running: false,
  lastRun: null,
  lastError: null,
  currentRun: null, // { runId, startedAt, codeLen, accounts, completed: boolean[], warned15: boolean, timer: Timeout }
};

function makeRunId() {
  return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function clearCurrentTimer() {
  if (state.currentRun && state.currentRun.timer) {
    clearTimeout(state.currentRun.timer);
    state.currentRun.timer = null;
  }
}

function renderHomePage(statusText) {
  const config = safeParseAccounts();
  const configLine = config.ok
    ? `Accounts loaded: ${config.accounts.length}`
    : `Config error: ${escapeHtml(config.error || "unknown")}`;

  const lastRunLine = state.lastRun
    ? `Last run: ${escapeHtml(String(state.lastRun))}`
    : "Last run: null";

  const lastErrLine = state.lastError
    ? `<div style="color:#b00020;margin-top:10px;">Last error: ${escapeHtml(String(state.lastError))}</div>`
    : "";

  const runningLine = `Running: ${state.running ? "YES" : "NO"}`;

  const hint = statusText
    ? `<div style="margin:10px 0;color:#0b6;">${escapeHtml(statusText)}</div>`
    : "";

  return `
  <html>
    <head><meta charset="utf-8" /><title>T-Bot</title></head>
    <body style="font-family: Arial, sans-serif; padding: 16px;">
      <h2>T-Bot</h2>
      <div>${runningLine}</div>
      <div style="margin-top:6px;">${lastRunLine}</div>
      <div style="margin-top:6px;">${configLine}</div>
      ${lastErrLine}
      ${hint}
      <form method="POST" action="/run" style="margin-top:16px;">
        <div><input name="password" placeholder="Password" type="password" required /></div>
        <div style="margin-top:8px;"><input name="code" placeholder="Paste order code" required /></div>
        <div style="margin-top:10px;"><button type="submit">Run Bot</button></div>
      </form>

      <div style="margin-top:16px; font-size: 13px;">
        Health: <a href="/health">/health</a>
        ${getTwilioClient() ? ` | SMS test: <a href="/sms-test">/sms-test</a>` : ""}
      </div>
    </body>
  </html>
  `;
}

function renderChecklistPage(run) {
  const accountsList = run.accounts
    .map((a, idx) => {
      const done = run.completed[idx] ? "YES" : "NO";
      const button = run.completed[idx]
        ? `<button disabled>Completed</button>`
        : `<form method="POST" action="/complete" style="display:inline;">
             <input type="hidden" name="runId" value="${escapeHtml(run.runId)}" />
             <input type="hidden" name="idx" value="${idx}" />
             <button type="submit">Mark complete</button>
           </form>`;

      return `
        <div style="border:1px solid #ddd; padding:10px; margin:10px 0;">
          <div><b>Account ${idx + 1}</b>: ${escapeHtml(a.username)}</div>
          <div style="margin-top:6px;">Completed: ${done}</div>
          <div style="margin-top:8px;">${button}</div>
        </div>
      `;
    })
    .join("");

  const allDone = run.completed.every(Boolean);

  return `
  <html>
    <head><meta charset="utf-8" /><title>Run Checklist</title></head>
    <body style="font-family: Arial, sans-serif; padding: 16px;">
      <h2>Run Checklist</h2>
      <div><b>Run ID:</b> ${escapeHtml(run.runId)}</div>
      <div style="margin-top:6px;"><b>Started:</b> ${escapeHtml(String(run.startedAt))}</div>
      <div style="margin-top:6px;"><b>Code length:</b> ${run.codeLen}</div>

      <hr style="margin:16px 0;" />

      <h3>Manual steps (do this for each account)</h3>
      <ol>
        <li>Open one of the login sites:
          <ul>
            ${LOGIN_URLS.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}
          </ul>
        </li>
        <li>Log in with that account username and password.</li>
        <li>Click the down arrow next to <b>Futures</b> and click <b>Futures</b>.</li>
        <li>Click <b>Invited me</b> at the bottom.</li>
        <li>Paste the order code into the box that says <b>Please enter the order code</b>.</li>
        <li>Click <b>Confirm</b>.</li>
        <li>Confirm 1: you see the pop up <b>Already followed the order</b>.</li>
        <li>Click <b>Position order</b>.</li>
        <li>Confirm 2: you see <b>Pending</b> in red.</li>
      </ol>

      <hr style="margin:16px 0;" />

      <h3>Accounts</h3>
      ${accountsList}

      <div style="margin-top:16px;">
        <b>Status:</b> ${allDone ? "All accounts completed." : "Not completed yet."}
      </div>

      <div style="margin-top:16px;">
        <a href="/">Back to home</a>
        | <a href="/health">Health</a>
      </div>
    </body>
  </html>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Routes
app.get("/", (req, res) => {
  res.status(200).send(renderHomePage(""));
});

app.get("/health", (req, res) => {
  const config = safeParseAccounts();
  res.json({
    ok: true,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    loginUrls: LOGIN_URLS,
    configOk: config.ok,
    configError: config.error,
    accountsCount: config.ok ? config.accounts.length : 0,
    smsConfigured: Boolean(getTwilioClient() && TWILIO_FROM && TWILIO_TO),
  });
});

app.get("/sms-test", async (req, res) => {
  const result = await sendSMS(`T-Bot SMS test at ${nowLocalString()}`);
  res.status(200).send(result.ok ? "OK: SMS sent" : `SMS not sent: ${escapeHtml(result.error || "unknown")}`);
});

app.post("/run", async (req, res) => {
  try {
    if (state.running) {
      return res.status(429).send("Bot is already running. Please wait.");
    }

    const password = String(req.body.password || "");
    const code = String(req.body.code || "").trim();

    if (!BOT_PASSWORD) {
      state.lastError = "BOT_PASSWORD not set";
      return res.status(500).send("Server not configured. BOT_PASSWORD not set.");
    }
    if (password !== BOT_PASSWORD) {
      return res.status(401).send("Wrong password.");
    }
    if (!code) {
      return res.status(400).send("No code provided.");
    }

    const config = safeParseAccounts();
    if (!config.ok) {
      state.lastError = config.error || "Config error";
      return res.status(500).send(`Config error: ${escapeHtml(state.lastError)}`);
    }

    // Start run
    state.running = true;
    state.lastError = null;

    const runId = makeRunId();
    const run = {
      runId,
      startedAt: nowLocalString(),
      codeLen: code.length,
      accounts: config.accounts,
      completed: config.accounts.map(() => false),
      warned15: false,
      timer: null,
    };
    state.currentRun = run;

    console.log("Bot started");
    console.log("Accounts loaded:", run.accounts.length);
    console.log("Code received length:", run.codeLen);

    // SMS started
    await sendSMS(`T-Bot started at ${run.startedAt}. Accounts: ${run.accounts.length}. Code length: ${run.codeLen}.`);

    // 15-minute warning timer
    clearCurrentTimer();
    run.timer = setTimeout(async () => {
      try {
        if (state.currentRun && state.currentRun.runId === runId) {
          const allDone = state.currentRun.completed.every(Boolean);
          if (!allDone) {
            state.currentRun.warned15 = true;
            await sendSMS("T-Bot warning: 15 minutes passed and not all accounts are marked complete yet.");
          }
        }
      } catch (e) {
        console.log("15-min warning SMS failed:", e.message || String(e));
      }
    }, 15 * 60 * 1000);

    // Log the accounts we will do manually
    for (const a of run.accounts) {
      console.log("Would run for:", a.username);
    }

    // Show checklist page
    state.lastRun = nowLocalString();
    res.status(200).send(renderChecklistPage(run));
  } catch (e) {
    state.lastError = e.message || String(e);
    console.log("Run failed:", state.lastError);
    state.running = false;
    res.status(500).send("Run failed.");
  }
});

app.post("/complete", async (req, res) => {
  try {
    const runId = String(req.body.runId || "");
    const idx = Number(req.body.idx);

    if (!state.currentRun || state.currentRun.runId !== runId) {
      return res.status(400).send("Run not found or expired.");
    }
    if (!Number.isFinite(idx) || idx < 0 || idx >= state.currentRun.accounts.length) {
      return res.status(400).send("Invalid account index.");
    }

    state.currentRun.completed[idx] = true;

    const allDone = state.currentRun.completed.every(Boolean);
    if (allDone) {
      const finishedAt = nowLocalString();
      state.lastRun = finishedAt;
      state.running = false;
      clearCurrentTimer();

      await sendSMS(`T-Bot completed at ${finishedAt}. All accounts marked complete.`);
      console.log("Bot completed");
    }

    res.status(200).send(renderChecklistPage(state.currentRun));
  } catch (e) {
    state.lastError = e.message || String(e);
    console.log("Complete failed:", state.lastError);
    res.status(500).send("Complete failed.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
