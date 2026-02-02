"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// NOTE: This file is a diagnostic runner.
// It will open a URL, capture screenshots, and log network failures.
// It does NOT attempt to log in or click through authenticated workflows.
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error("Playwright is not installed. Add playwright to package.json dependencies.");
  process.exit(1);
}

// --------------------
// Config
// --------------------
const PORT = Number(process.env.PORT || 8080);

const BOT_PASSWORD = String(process.env.BOT_PASSWORD || "").trim();

const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
const TWILIO_FROM = String(process.env.TWILIO_FROM || "").trim();
const TWILIO_TO = String(process.env.TWILIO_TO || "").trim();

// This is the file we will always overwrite for easy access in Railway
const LAST_SHOT_PUBLIC_PATH = "/app/last-shot.png";

// Keep a short, safe default list of URLs you can test quickly
const DEFAULT_TEST_URLS = [
  "https://bgol.pro/pc/#/login",
  "https://bgol.pro/h5/#/login",
  "https://dsj89.com/pc/#/login",
  "https://dsj89.com/h5/#/login",
  "https://dsj72.com/pc/#/login",
  "https://dsj72.com/h5/#/login",
];

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const p = String(req.query.p || "");
  return BOT_PASSWORD && p === BOT_PASSWORD;
}

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    // Require protocol
    const u = new URL(raw);
    return u.toString();
  } catch {
    return "";
  }
}

// --------------------
// SMS helper (Twilio)
// --------------------
let twilioClient = null;
let twilioLoadAttempted = false;
let twilioLoadError = null;

function initTwilioOnce() {
  if (twilioLoadAttempted) return;
  twilioLoadAttempted = true;

  try {
    const twilio = require("twilio");
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    }
  } catch (e) {
    twilioLoadError = e && e.message ? e.message : String(e);
  }
}

async function sendSMS(msg) {
  initTwilioOnce();
  const configured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO);
  if (!configured) return null;
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
    console.log("SMS failed:", e && e.message ? e.message : String(e));
    return null;
  }
}

// --------------------
// Run state
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;

let lastShotPath = null; // most recent /tmp screenshot path
let lastRunId = null;
let runReport = null;

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot Diagnostic Runner</h2>

    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt || "N/A"}</div>
    <div style="color:red; margin-top:10px;">
      ${!BOT_PASSWORD ? "BOT_PASSWORD is not set in Railway Variables.<br/>" : ""}
      ${lastError ? `Last error: ${escapeHtml(lastError)}` : ""}
    </div>

    <p style="margin-top:10px;">
      This tool only opens a URL and captures screenshots + network failures.
      It does not log in or click through authenticated pages.
    </p>

    <form method="POST" action="/run" style="margin-top:12px;">
      <input name="p" placeholder="Password" type="password" required />
      <br/><br/>
      <input name="url" placeholder="Paste a URL to test" style="width:420px;" required />
      <br/><br/>
      <button type="submit">Run Diagnostic</button>
    </form>

    <div style="margin-top:14px;">
      <div><b>Quick test links</b> (paste one into the form):</div>
      <ul>
        ${DEFAULT_TEST_URLS.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}
      </ul>
    </div>

    <div style="margin-top:14px;">
      Health: <a href="/health">/health</a>
      | Last screenshot: <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/last-shot</a>
      | SMS test: <a href="/sms-test?p=${encodeURIComponent(BOT_PASSWORD || "YOUR_PASSWORD")}">/sms-test</a>
    </div>
  `);
});

app.get("/health", (req, res) => {
  initTwilioOnce();
  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    port: PORT,
    botPasswordSet: !!BOT_PASSWORD,
    smsConfigured: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && TWILIO_TO),
    twilioLoaded: !!twilioClient,
    twilioLoadError,
    lastShotExists: fs.existsSync(LAST_SHOT_PUBLIC_PATH),
    lastShotPath,
  });
});

app.get("/sms-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  await sendSMS(`T-Bot SMS test at ${nowLocal()}`);
  res.send("OK: SMS sent (or SMS not configured).");
});

app.get("/last-shot", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");

  if (fs.existsSync(LAST_SHOT_PUBLIC_PATH)) {
    res.setHeader("Content-Type", "image/png");
    fs.createReadStream(LAST_SHOT_PUBLIC_PATH).pipe(res);
    return;
  }
  res.send("No screenshot captured yet.");
});

app.get("/run/:id", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD to view.");
  if (!runReport || req.params.id !== lastRunId) return res.status(404).send("Run not found.");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));
});

app.post("/run", async (req, res) => {
  const p = String(req.body.p || "");
  const url = normalizeUrl(req.body.url);

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway Variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
  if (!url) return res.status(400).send("Invalid URL. It must include https://");

  if (isRunning) return res.send("Diagnostic is already running. Please wait.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");

  runReport = {
    id: lastRunId,
    started: lastRunAt,
    url,
    status: "Running now. Refresh this page.",
    networkFailures: [],
    consoleErrors: [],
    pageErrors: [],
    screenshots: [],
  };

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderRunReport(runReport));

  (async () => {
    try {
      console.log("Bot started");
      console.log("Testing URL:", url);

      await sendSMS(`T-Bot started at ${lastRunAt}`);

      await runDiagnostic(url, runReport);

      runReport.status = "Completed. Review screenshots and logs.";
      await sendSMS(`T-Bot completed at ${nowLocal()}`);
      console.log("Bot completed");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      lastError = msg;
      runReport.status = "Failed: " + msg;
      await sendSMS(`T-Bot failed at ${nowLocal()}: ${msg}`);
      console.log("Run failed:", msg);
    } finally {
      isRunning = false;
    }
  })();
});

// --------------------
// Diagnostic runner
// --------------------
async function runDiagnostic(url, report) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "en-US",
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  page.on("requestfailed", (req) => {
    const f = req.failure();
    const errText = f && f.errorText ? f.errorText : "unknown";
    const line = `REQUEST FAILED: ${req.url()} => ${errText}`;
    console.log(line);
    if (report.networkFailures.length < 80) report.networkFailures.push(line);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const line = `PAGE CONSOLE: ${msg.text()}`;
      console.log(line);
      if (report.consoleErrors.length < 80) report.consoleErrors.push(line);
    }
  });

  page.on("pageerror", (err) => {
    const line = `PAGE ERROR: ${err && err.message ? err.message : String(err)}`;
    console.log(line);
    if (report.pageErrors.length < 80) report.pageErrors.push(line);
  });

  try {
    // Step 1: initial navigation
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await saveShot(page, report, "after-goto");

    // Step 2: give scripts time to load
    await sleep(2500);
    await saveShot(page, report, "after-wait-2s");

    // Step 3: try a longer wait for SPA pages
    await sleep(5000);
    await saveShot(page, report, "after-wait-7s");

    // Step 4: record basic page facts
    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    report.pageTitle = title;
    report.finalUrl = finalUrl;

    // If page is basically blank, capture a hint
    const bodyText = await page.locator("body").innerText().catch(() => "");
    report.bodyTextSample = (bodyText || "").slice(0, 400);

    // If there are name resolution failures, call it out clearly
    const hasDnsFailure = report.networkFailures.some((l) => l.includes("ERR_NAME_NOT_RESOLVED"));
    if (hasDnsFailure) {
      report.diagnosis =
        "The page is failing to load key resources due to DNS errors (ERR_NAME_NOT_RESOLVED) from inside Railway.";
    } else {
      report.diagnosis =
        "No DNS failure detected in requestfailed logs. If the page still looks wrong, it may be blocking headless browsers or requiring interactive gestures.";
    }
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

async function saveShot(page, report, tag) {
  const file = `/tmp/${tag}-${Date.now()}.png`;
  try {
    await page.screenshot({ path: file, fullPage: true });
    lastShotPath = file;

    // Also copy to a stable path so /last-shot always works
    try {
      fs.copyFileSync(file, LAST_SHOT_PUBLIC_PATH);
    } catch (e) {
      // If copy fails, keep the /tmp path
    }

    const msg = `Saved screenshot: ${file} (and updated ${LAST_SHOT_PUBLIC_PATH})`;
    console.log(msg);

    report.screenshots.push({
      tag,
      file,
      lastShotPath: LAST_SHOT_PUBLIC_PATH,
      at: nowLocal(),
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log("Screenshot failed:", msg);
  }
}

function renderRunReport(report) {
  const shots = (report.screenshots || [])
    .map((s) => `<li><b>${escapeHtml(s.tag)}</b> at ${escapeHtml(s.at)} (saved)</li>`)
    .join("");

  const nf = (report.networkFailures || []).map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const ce = (report.consoleErrors || []).map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const pe = (report.pageErrors || []).map((l) => `<li>${escapeHtml(l)}</li>`).join("");

  return `
    <h2>Diagnostic Run</h2>
    <div><b>Run ID:</b> ${escapeHtml(report.id)}</div>
    <div><b>Started:</b> ${escapeHtml(report.started)}</div>
    <div><b>URL:</b> ${escapeHtml(report.url)}</div>
    <hr/>

    <div><b>Status:</b> ${escapeHtml(report.status)}</div>

    <div style="margin-top:10px;">
      <b>Diagnosis:</b> ${escapeHtml(report.diagnosis || "N/A")}
    </div>

    <div style="margin-top:10px;">
      <b>Final URL:</b> ${escapeHtml(report.finalUrl || "N/A")}<br/>
      <b>Title:</b> ${escapeHtml(report.pageTitle || "N/A")}<br/>
      <b>Body sample:</b><pre style="white-space:pre-wrap;">${escapeHtml(report.bodyTextSample || "")}</pre>
    </div>

    <h3>Screenshots captured</h3>
    <ul>${shots || "<li>None yet</li>"}</ul>

    <div style="margin:10px 0;">
      <a href="/last-shot?p=${encodeURIComponent(BOT_PASSWORD)}">Open /last-shot</a>
    </div>

    <h3>Network failures</h3>
    <ul>${nf || "<li>None</li>"}</ul>

    <h3>Console errors</h3>
    <ul>${ce || "<li>None</li>"}</ul>

    <h3>Page errors</h3>
    <ul>${pe || "<li>None</li>"}</ul>

    <hr/>
    <div>
      <a href="/?p=${encodeURIComponent(BOT_PASSWORD)}">Back to home</a>
      | <a href="/health">Health</a>
      | <a href="/run/${escapeHtml(report.id)}?p=${encodeURIComponent(BOT_PASSWORD)}">Permalink</a>
    </div>
  `;
}

// --------------------
// Start server
// --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
