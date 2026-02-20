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

    // Only log safe fields (no tracking URLs)
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

function safeSitesLine(chosenSites) {
  // Do not include clickable URLs in emails. SendGrid will wrap them.
  // We only include host + pc/h5 label.
  if (!chosenSites || !chosenSites.length) return "";
  const labels = [];
  const seen = new Set();

  for (const u of chosenSites) {
    try {
      const url = new URL(u);
      const host = url.host;
      const flavor = u.includes("/h5/#/") ? "h5" : "pc";
      const label = `${host} (${flavor})`;
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    } catch {
      // ignore
    }
  }

  return labels.length ? `Sites: ${labels.join(", ")}` : "";
}

function statusLabel(a) {
  // a.status can be "QUEUED", "SUCCESS", "FAIL"
  // If missing, infer from a.ok boolean when appropriate
  if (a && a.status) return String(a.status).toUpperCase();
  if (a && a.ok === true) return "SUCCESS";
  if (a && a.ok === false) return "FAIL";
  return "INFO";
}

function buildRunEmailText({ phase, runId, startedAt, finishedAt, chosenSites, perAccount, extraLines }) {
  const lines = [];

  lines.push(`T-Bot ${phase}`);
  lines.push("");

  if (startedAt) lines.push(`Started: ${startedAt}`);
  if (finishedAt) lines.push(`Finished: ${finishedAt}`);
  if (runId) lines.push(`Run: ${runId}`);

  const sitesLine = safeSitesLine(chosenSites);
  if (sitesLine) lines.push(sitesLine);

  lines.push("");

  if (perAccount && perAccount.length) {
    const okCount = perAccount.filter((x) => x.ok === true).length;
    const failCount = perAccount.filter((x) => x.ok === false).length;
    const queuedCount = perAccount.filter((x) => statusLabel(x) === "QUEUED").length;

    // Started email: show queued count only
    if (phase.toLowerCase() === "started") {
      lines.push(`Summary: ${queuedCount || perAccount.length} queued`);
    } else {
      lines.push(`Summary: ${okCount} success, ${failCount} failed`);
    }

    lines.push("");
    lines.push("Per-account status:");

    for (const a of perAccount) {
      const st = statusLabel(a);
      const detail = stripUrls(a.detail || "");
      // No "QUEUED:" prefix duplication. Format exactly: email - Queued
      if (st === "QUEUED") {
        lines.push(`${a.username}${detail ? ` - ${detail}` : " - Queued"}`);
      } else if (st === "SUCCESS") {
        lines.push(`SUCCESS: ${a.username}${detail ? ` - ${detail}` : ""}`);
      } else if (st === "FAIL") {
        lines.push(`FAIL: ${a.username}${detail ? ` - ${detail}` : ""}`);
      } else {
        lines.push(`${a.username}${detail ? ` - ${detail}` : ""}`);
      }
    }
  }

  if (extraLines && Array.isArray(extraLines) && extraLines.length) {
    lines.push("");
    for (const l of extraLines) lines.push(String(l));
  }

  lines.push("");
  lines.push("Notes:");
  lines.push("- This email avoids clickable site URLs so it stays readable.");
  lines.push("- If a site is flaky (HTTP 500 / DNS / Cloudflare), fallback paths may be used.");

  return lines.join("\n");
}

module.exports = {
  envTruthy,
  emailConfigured,
  sendEmail,
  stripUrls,
  buildRunEmailText,
};
