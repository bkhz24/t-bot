"use strict";

const express = require("express");
const crypto = require("crypto");
const sgMail = require("@sendgrid/mail");

const PORT = process.env.PORT || 8080;

// Required
const BOT_PASSWORD = process.env.BOT_PASSWORD || "";

// SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const EMAIL_TO = process.env.EMAIL_TO || "";
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || "1").trim() !== "0";

function nowLocal() {
  return new Date().toLocaleString("en-US", { timeZoneName: "short" });
}

function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}

function emailConfigured() {
  return !!(EMAIL_ENABLED && SENDGRID_API_KEY && EMAIL_FROM && EMAIL_TO);
}

function initSendGrid() {
  if (!SENDGRID_API_KEY) return;
  sgMail.setApiKey(SENDGRID_API_KEY);
}

async function sendEmail(subject, text) {
  if (!EMAIL_ENABLED)
    return { ok: false, skipped: true, error: "EMAIL_ENABLED is off" };

  if (!emailConfigured())
    return { ok: false, skipped: true, error: "Email not configured" };

  initSendGrid();

  try {
    const msg = {
      to: EMAIL_TO,
      from: EMAIL_FROM,
      subject,
      text
    };

    await sgMail.send(msg);

    console.log("Email sent:", subject);
    return { ok: true, skipped: false, error: null };
  } catch (e) {
    const err =
      e && e.response && e.response.body
        ? JSON.stringify(e.response.body)
        : e && e.message
        ? e.message
        : String(e);

    console.log("Email failed:", err, "|", subject);

    return { ok: false, skipped: false, error: err };
  }
}

const app = express();

app.get("/", (req, res) => {
  res.send("T-Bot is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    emailConfigured: emailConfigured(),
    emailEnabled: EMAIL_ENABLED,
    emailFrom: EMAIL_FROM ? "set" : "missing",
    emailTo: EMAIL_TO ? "set" : "missing",
    sendgridKey: SENDGRID_API_KEY ? "set" : "missing"
  });
});

app.get("/email-test", async (req, res) => {
  if (!authOk(req))
    return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const runId = crypto.randomBytes(6).toString("hex");
  const subject = `T-Bot Email Test ${runId}`;
  const text = `SendGrid email test at ${nowLocal()}\nRun ID: ${runId}\n`;

  const result = await sendEmail(subject, text);

  res.json({
    ok: true,
    attempted: true,
    result
  });
});

app.get("/run-test", async (req, res) => {
  if (!authOk(req))
    return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");

  const runId = crypto.randomBytes(6).toString("hex");
  const started = nowLocal();

  console.log("Bot started");
  console.log("Run ID:", runId);

  console.log("About to send START email...");
  const startResult = await sendEmail(
    `T-Bot Run ${runId} started`,
    `T-Bot started at ${started}\nRun ID: ${runId}\n`
  );
  console.log("START email result:", startResult);

  // Simulate bot work
  await new Promise(r => setTimeout(r, 3000));

  const finished = nowLocal();

  console.log("About to send FINISH email...");
  const finishResult = await sendEmail(
    `T-Bot Run ${runId} completed`,
    `T-Bot finished at ${finished}\nRun ID: ${runId}\n`
  );
  console.log("FINISH email result:", finishResult);

  res.json({
    ok: true,
    runId,
    startResult,
    finishResult
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("Email configured:", emailConfigured());
});
