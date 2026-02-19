"use strict";

function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function emailConfigured(env) {
  if (!envTruthy(env.EMAIL_ENABLED ?? "1")) return false;
  const provider = (env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();
  if (provider !== "sendgrid") return false;

  const key = (env.SENDGRID_API_KEY || "").toString().trim();
  const from = (env.EMAIL_FROM || "").toString().trim();
  const to = (env.EMAIL_TO || "").toString().trim();

  return !!(key && from && to);
}

async function sendEmail(env, subject, text) {
  const enabled = envTruthy(env.EMAIL_ENABLED ?? "1");
  const provider = (env.EMAIL_PROVIDER || "sendgrid").toString().trim().toLowerCase();

  if (!enabled) {
    console.log("Email disabled. Skipping:", subject);
    return { ok: false, skipped: true, error: "EMAIL_ENABLED is off" };
  }
  if (provider !== "sendgrid") {
    console.log("Unsupported email provider. Skipping:", subject, provider);
    return { ok: false, skipped: true, error: `Unsupported provider: ${provider}` };
  }
  if (!emailConfigured(env)) {
    console.log("Email not configured. Skipping:", subject);
    return { ok: false, skipped: true, error: "Email not configured" };
  }

  const SENDGRID_API_KEY = (env.SENDGRID_API_KEY || "").toString().trim();
  const EMAIL_FROM = (env.EMAIL_FROM || "").toString().trim();
  const EMAIL_FROM_NAME = (env.EMAIL_FROM_NAME || "T-Bot").toString().trim();
  const EMAIL_TO = (env.EMAIL_TO || "").toString().trim();

  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(SENDGRID_API_KEY);

    const to = EMAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);

    const msg = {
      to,
      from: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      subject,
      text,
    };

    const [res] = await sgMail.send(msg);

    const status = res && res.statusCode ? res.statusCode : null;
    const msgId =
      (res && res.headers && (res.headers["x-message-id"] || res.headers["X-Message-Id"])) || null;

    console.log("Email sent:", { status, msgId, to });

    return { ok: true, skipped: false, status, msgId, to };
  } catch (e) {
    const body = e && e.response && e.response.body ? e.response.body : null;
    const errText = body ? JSON.stringify(body) : (e && e.message ? e.message : String(e));
    console.log("Email failed:", errText, "|", subject);
    return { ok: false, skipped: false, error: errText };
  }
}

function stripUrls(s) {
  if (!s) return "";
  return String(s).replace(/https?:\/\/\S+/gi, "").trim();
}

function summarizeCounts(perAccount) {
  const queued = perAccount.filter((x) => x.state === "queued").length;
  const ok = perAccount.filter((x) => x.state === "success").length;
  const fail = perAccount.filter((x) => x.state === "fail").length;

  const parts = [];
  if (ok) parts.push(`${ok} success`);
  if (fail) parts.push(`${fail} failed`);
  if (queued) parts.push(`${queued} queued`);

  return parts.length ? parts.join(", ") : "0";
}

function buildRunEmailText({
  phase,
  runId,
  startedAt,
  finishedAt,
  chosenSites,
  perAccount,
  headerNote,
}) {
  // perAccount: [{ username, state: "queued"|"success"|"fail", detail }]
  const lines = [];

  lines.push(`T-Bot ${phase}`);
  lines.push("");

  if (headerNote) {
    lines.push(String(headerNote));
    lines.push("");
  }

  if (startedAt) lines.push(`Started: ${startedAt}`);
  if (finishedAt) lines.push(`Finished: ${finishedAt}`);
  if (runId) lines.push(`Run: ${runId}`);
  if (chosenSites && chosenSites.length) lines.push(`Sites: ${chosenSites.join(", ")}`);
  lines.push("");

  if (perAccount && perAccount.length) {
    lines.push(`Summary: ${summarizeCounts(perAccount)}`);
    lines.push("");
    lines.push("Per-account status:");

    for (const a of perAccount) {
      const detail = stripUrls(a.detail || "");

      if (a.state === "queued") {
        // Exactly what you asked: email then " - Queued", no QUEUED: prefix
        lines.push(`${a.username}${detail ? ` - ${detail}` : ""}`);
        continue;
      }

      const status = a.state === "success" ? "SUCCESS" : "FAIL";
      lines.push(`${status}: ${a.username}${detail ? ` - ${detail}` : ""}`);
    }
  }

  lines.push("");
  lines.push("Notes:");
  lines.push("- If a site is flaky (HTTP 500 / DNS), preflight will skip it automatically.");
  lines.push("- This email strips URLs so it stays readable.");

  return lines.join("\n");
}

module.exports = {
  envTruthy,
  emailConfigured,
  sendEmail,
  stripUrls,
  buildRunEmailText,
};
