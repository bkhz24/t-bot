"use strict";

const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

// Config
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON || "";

// Twilio env vars
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";
const TWILIO_TO = process.env.TWILIO_TO || "";

// Sites you mentioned
const LOGIN_URLS = [
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/h5/#/login"
];

// In-memory state
const state = {
  running: false,
  lastRun: null,
  lastError: null,
  currentRun: null // { runId, startedAt, codeLen, accounts, completed: boolean[], timer }
};

function nowLocalString() {
  try {
    return new Date().toLocaleString();
  } catch {
    return new Date().toISOString();
  }
}

function makeRunId() {
  return Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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
        password: String(a.password || "").trim()
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

function twilioConfigured() {
  return Boolean(
    TWILIO_ACCOUNT_SID &&
      TWILIO_AUTH_TOKEN &&
      TWILIO_FROM &&
      TWILIO_TO
  );
}

function getTwilioClientSafe() {
  if (!twilioConfigured()) return { ok: false, client: null, error: "Twilio env vars not set" };

  try {
    const twilio = require("twilio");
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    return { ok: true, client, error: null };
  } catch (e) {
    return { ok: false, client: null, error: `Twilio library not installed: ${e.message}` };
  }
}

async function sendSMS(message) {
  const t = getTwilioClientSafe();
  if (!t.ok || !t.client) {
    console.log("SMS not sent:", t.error);
    return { ok: false, error: t.error };
  }

  try {
    const res = await t.client.messages.create({
      from: TWILIO_FROM,
      to: TWILIO_TO,
      body: message
    });
    console.log("SMS sent:", res.sid);
    return { ok: true, sid: res.sid };
  } catch (e) {
    console.log("SMS failed:", e.message || String(e));
    return { ok: false, error: e.message || String(e) };
  }
}

function clearRunTimer() {
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

  const lastRunLine = state.lastRun ? `Last run: ${escapeHtml(String(state.lastRun))}` : "Last run: null";
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
        ${twilioConfigured() ? ` | SMS test: <a href="/sms-test">/sms-test</a>` : ""}
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

      <h3>Steps (your exact flow)</h3>
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
        <li>Confirm 1: pop up <b>Already followed the order</b>.</li>
        <li>Click <b>Position order</b>.</li>
        <li>Confirm 2: <b>Pending</b> in red.</li>
      </ol>

      <hr style="margin:16px 0;" />

      <h3>Accounts</h3>
      ${accountsList}

      <div style="margin-top:16px;">
        <b>Status:</b> ${allDone ? "All accounts completed." : "Not completed yet."}
      </div>

      <div style="margin-top:16px;">
        <a href="/">Back to home</a> | <a href="/health">Health</a>
      </div>
    </body>
  </html>
  `;
}

// Routes
app.get("/", (req, res) => {
  res.status(200).send(renderHomePage(""));
});

app.get("/health", (req, res) => {
  const config = safeParseAccounts();
  const tw = getTwilioClientSafe();
  res.json({
    ok: true,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    loginUrls: LOGIN_URLS,
    configOk: config.ok,
    configError: config.error,
    accountsCount: config.ok ? config.accounts.length : 0,
    smsConfigured: twilioConfigured(),
    smsLibraryOk: tw.ok,
    smsLibraryError: tw.ok ? null : tw.error
  });
});

app.get("/sms-test", async (req, res) => {
  const result = await sendSMS(`T-Bot SMS test at ${nowLocalString()}`);
  res.status(200).send(result.ok ? "OK: SMS sent" : `SMS not sent: ${escapeHtml(result.error || "unknown")}`);
});

app.post("/run", async (req, res) => {
  try {
    if (state.running) return res.status(429).send("Bot is already running. Please wait.");

    const password = String(req.body.password || "");
    const code = String(req.body.code || "").trim();

    if (!BOT_PASSWORD) {
      state.lastError = "BOT_PASSWORD not set";
      return res.status(500).send("BOT_PASSWORD not set");
    }
    if (password !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
    if (!code) return res.status(400).send("No code provided.");

    const config = safeParseAccounts();
    if (!config.ok) {
      state.lastError = config.error || "Config error";
      return res.status(500).send(`Config error: ${escapeHtml(state.lastError)}`);
    }

    state.running = true;
    state.lastError = null;

    const runId = makeRunId();
    const run = {
      runId,
      startedAt: nowLocalString(),
      codeLen: code.length,
      accounts: config.accounts,
      completed: config.accounts.map(() => false),
      timer: null
    };
    state.currentRun = run;

    console.log("Bot started");
    console.log("Accounts loaded:", run.accounts.length);
    console.log("Code received length:", run.codeLen);

    // Send Started SMS (if configured)
    const startedMsg = `T-Bot started at ${run.startedAt}. Accounts: ${run.accounts.length}. Code length: ${run.codeLen}.`;
    const smsStart = await sendSMS(startedMsg);
    if (!smsStart.ok) console.log("Start SMS not sent:", smsStart.error);

    // 15-minute warning SMS if not completed
    clearRunTimer();
    run.timer = setTimeout(async () => {
      try {
        if (state.currentRun && state.currentRun.runId === runId) {
          const allDone = state.currentRun.completed.every(Boolean);
          if (!allDone) {
            const warn = await sendSMS("T-Bot warning: 15 minutes passed and not all accounts are marked complete yet.");
            if (!warn.ok) console.log("Warning SMS not sent:", warn.error);
          }
        }
      } catch (e) {
        console.log("15-min warning SMS exception:", e.message || String(e));
      }
    }, 15 * 60 * 1000);

    // Log what it would do
    for (const a of run.accounts) console.log("Would run for:", a.username);

    state.lastRun = nowLocalString();
    return res.status(200).send(renderChecklistPage(run));
  } catch (e) {
    state.lastError = e.message || String(e);
    console.log("Run failed:", state.lastError);
    state.running = false;
    return res.status(500).send("Run failed.");
  }
});

app.post("/complete", async (req, res) => {
  try {
    const runId = String(req.body.runId || "");
    const idx = Number(req.body.idx);

    if (!state.currentRun || state.currentRun.runId !== runId) return res.status(400).send("Run not found or expired.");
    if (!Number.isFinite(idx) || idx < 0 || idx >= state.currentRun.accounts.length) return res.status(400).send("Invalid account index.");

    state.currentRun.completed[idx] = true;

    const allDone = state.currentRun.completed.every(Boolean);
    if (allDone) {
      const finishedAt = nowLocalString();
      state.lastRun = finishedAt;
      state.running = false;
      clearRunTimer();

      const done = await sendSMS(`T-Bot completed at ${finishedAt}. All accounts marked complete.`);
      if (!done.ok) console.log("Complete SMS not sent:", done.error);

      console.log("Bot completed");
    }

    return res.status(200).send(renderChecklistPage(state.currentRun));
  } catch (e) {
    state.lastError = e.message || String(e);
    console.log("Complete failed:", state.lastError);
    return res.status(500).send("Complete failed.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
