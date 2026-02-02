"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// --------------------
// Config
// --------------------
const PORT = process.env.PORT || 8080;

const BOT_PASSWORD = process.env.BOT_PASSWORD || "";

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

// FIX 1: Accept URLs even if user pastes without https://
function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) return "";

  // If they paste "bgol.pro/pc/#/login", add https://
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  try {
    const u = new URL(raw);
    return u.toString();
  } catch {
    return "";
  }
}

// --------------------
// App state (simple)
// --------------------
let isRunning = false;
let lastRunAt = null;
let lastError = null;
let lastRunId = null;

// --------------------
// Express app
// --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  const pwMissing = !BOT_PASSWORD;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
    <h2>T-Bot</h2>
    <div>Running: <b>${isRunning ? "YES" : "NO"}</b></div>
    <div>Last run: ${lastRunAt ? escapeHtml(lastRunAt) : "-"}</div>

    <div style="color:red; margin-top:10px;">
      ${pwMissing ? "BOT_PASSWORD not set<br/>" : ""}
      ${lastError ? `<br/>Last error: ${escapeHtml(lastError)}` : ""}
    </div>

    <form method="POST" action="/run" style="margin-top:12px;">
      <input name="p" placeholder="Password" type="password" required />
      <br/><br/>

      <!-- FIX 2: make sure the field name is url -->
      <input
        name="url"
        placeholder="Paste a URL (example: https://bgol.pro/pc/#/login)"
        style="width:420px;"
        required
      />
      <br/><br/>

      <button type="submit">Run Diagnostic</button>
    </form>

    <div style="margin-top:12px;">
      Health: <a href="/health">/health</a>
    </div>
  `);
});

// Fix 3 (optional but helpful): if someone visits /run directly, redirect
app.get("/run", (req, res) => res.redirect("/"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    hasBotPassword: !!BOT_PASSWORD,
  });
});

// POST /run expects p + url
app.post("/run", async (req, res) => {
  try {
    const p = (req.body.p || "").toString();
    const urlRaw = (req.body.url || "").toString();

    if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD not set in Railway variables.");
    if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");

    const url = normalizeUrl(urlRaw);
    if (!url) return res.status(400).send("Invalid URL. It must include https:// (or paste without and we will add it).");

    if (isRunning) return res.send("Already running. Please wait.");

    isRunning = true;
    lastError = null;
    lastRunAt = nowLocal();
    lastRunId = crypto.randomBytes(6).toString("hex");

    // For now this is just a diagnostic response.
    // Plug your bot run logic back in here later.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <h2>Run Started</h2>
      <div><b>Run ID:</b> ${escapeHtml(lastRunId)}</div>
      <div><b>Started:</b> ${escapeHtml(lastRunAt)}</div>
      <div><b>Normalized URL:</b> ${escapeHtml(url)}</div>
      <hr/>
      <div>Go back: <a href="/">Home</a></div>
    `);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    lastError = msg;
    res.status(500).send("Run failed: " + escapeHtml(msg));
  } finally {
    isRunning = false;
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
