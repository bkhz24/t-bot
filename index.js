"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8080);

const BOT_PASSWORD = (process.env.BOT_PASSWORD || process.env.RUN_PASSWORD || "").toString();
const ACCOUNTS_JSON = (process.env.ACCOUNTS_JSON || "").toString();
const LOGIN_URLS_ENV = (process.env.LOGIN_URLS || "").toString();

const FORCE_MOBILE = envTruthy(process.env.FORCE_MOBILE || "0");
const DEBUG_CAPTURE = envTruthy(process.env.DEBUG_CAPTURE || "0");

// 🔥 NEW: independent capture toggles
const TRACE_CAPTURE = envTruthy(process.env.TRACE_CAPTURE || "1"); // default ON
const HAR_CAPTURE = envTruthy(process.env.HAR_CAPTURE || "1");     // default ON

// API rewrite
const API_REWRITE = envTruthy(process.env.API_REWRITE || "0");
const API_REWRITE_MATCH = (process.env.API_REWRITE_MATCH || "^api\\.").toString();
const API_REWRITE_TARGET = (process.env.API_REWRITE_TARGET || "").toString().trim();

const DEFAULT_TZ = (process.env.TZ || "America/Denver").toString();

function envTruthy(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function nowLocal() {
  try {
    return new Date().toLocaleString("en-US", { timeZone: DEFAULT_TZ, timeZoneName: "short" });
  } catch {
    return new Date().toISOString();
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function sanitizeForFilename(s) {
  return String(s ?? "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
function authOk(req) {
  const p = (req.query.p || "").toString();
  return !!BOT_PASSWORD && p === BOT_PASSWORD;
}
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
function safeListDir(dir) {
  try { return fs.readdirSync(dir).filter((x) => !x.includes("..")); } catch { return []; }
}
function safeJsonParseAccounts() {
  if (!ACCOUNTS_JSON) return { ok: false, accounts: [], error: "ACCOUNTS_JSON not set" };
  try {
    const parsed = JSON.parse(ACCOUNTS_JSON);
    if (!Array.isArray(parsed)) return { ok: false, accounts: [], error: "ACCOUNTS_JSON must be a JSON array" };
    const cleaned = parsed.map((a) => ({ username: String(a?.username || "").trim(), password: String(a?.password || "") }));
    const bad = cleaned.find((a) => !a.username || !a.password);
    if (bad) return { ok: false, accounts: [], error: "Each account must include username + password" };
    return { ok: true, accounts: cleaned, error: null };
  } catch (e) {
    return { ok: false, accounts: [], error: `ACCOUNTS_JSON invalid JSON: ${e?.message || String(e)}` };
  }
}

function parseLoginUrls() {
  const fallback = ["https://dsj12.cc/pc/#/login", "https://dsj877.com/pc/#/login"];
  const raw = (LOGIN_URLS_ENV || "").trim();
  if (!raw) return fallback;
  const list = raw.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length ? list : fallback;
}
let LOGIN_URLS = parseLoginUrls();

function getBaseAndPrefixFromUrl(anyUrl) {
  try {
    const u = new URL(anyUrl);
    const base = `${u.protocol}//${u.host}`;
    if (anyUrl.includes("/h5/#/")) return { base, prefix: "/h5/#/" };
    if (anyUrl.includes("/pc/#/")) return { base, prefix: "/pc/#/" };
    if (anyUrl.includes("/h5/")) return { base, prefix: "/h5/#/" };
    if (anyUrl.includes("/pc/")) return { base, prefix: "/pc/#/" };
    return { base, prefix: "/pc/#/" };
  } catch {
    return null;
  }
}
function futuresUrlFromAnyUrl(anyUrl) {
  const bp = getBaseAndPrefixFromUrl(anyUrl);
  if (!bp) return null;
  return `${bp.base}${bp.prefix}contractTransaction`;
}

function simpleGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`Bad URL: ${url}`)); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      { method: "GET", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
        headers: { "User-Agent": "T-Bot/1.0", Accept: "text/html,application/json;q=0.9,*/*;q=0.8" } },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

let isRunning = false;
let lastRunAt = null;
let lastError = null;
let lastShotPath = null;
let lastRunId = null;
let lastDebugDir = null;

function writePlaceholderLastShot() {
  try {
    const placeholder = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axl1mQAAAAASUVORK5CYII=",
      "base64"
    );
    ensureDir("/app");
    fs.writeFileSync("/app/last-shot.png", placeholder);
  } catch {}
}
async function tryCopyToStableLastShot(srcPath) {
  try { ensureDir("/app"); fs.copyFileSync(srcPath, "/app/last-shot.png"); } catch {}
}
async function saveScreenshot(page, fullPath) {
  try {
    await page.screenshot({ path: fullPath, fullPage: true });
    lastShotPath = fullPath;
    await tryCopyToStableLastShot(fullPath);
    return true;
  } catch (e) {
    console.log("Screenshot failed:", e?.message || String(e));
    return false;
  }
}
async function captureFailureArtifacts(page, tag, extra = {}) {
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag || "failure");
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  let url = "";
  try { url = page?.url?.() || ""; } catch {}
  if (!url) {
    try { url = await page.evaluate(() => location.href).catch(() => ""); } catch {}
  }

  const shotPath = path.join(dir, `${safeTag}-${stamp}.png`);
  const htmlPath = path.join(dir, `${safeTag}-${stamp}.html`);
  const extraPath = path.join(dir, `${safeTag}-${stamp}.extra.json`);

  let savedShot = false;
  let savedHtml = false;

  try { if (page) savedShot = await saveScreenshot(page, shotPath); } catch {}
  try {
    if (page) {
      const html = await page.content().catch(() => "");
      fs.writeFileSync(htmlPath, html || "");
      savedHtml = true;
    }
  } catch {}
  try { fs.writeFileSync(extraPath, JSON.stringify({ ...extra, url }, null, 2)); } catch {}

  console.log("FAILURE URL:", url || "(unknown)");
  console.log("FAILURE screenshot saved:", savedShot ? shotPath : "(screenshot failed)");
  console.log("FAILURE html saved:", savedHtml ? htmlPath : "(html failed)");
  console.log("FAILURE debug dir:", dir);

  return { url, shotPath: savedShot ? shotPath : null, htmlPath: savedHtml ? htmlPath : null, dir };
}
async function dumpDebugStep(page, tag, extra = {}) {
  if (!DEBUG_CAPTURE) return null;
  const stamp = Date.now();
  const safeTag = sanitizeForFilename(tag || "step");
  const dir = lastDebugDir || "/tmp";
  ensureDir(dir);

  const base = path.join(dir, `${safeTag}-${stamp}`);
  try { fs.writeFileSync(`${base}.url.txt`, String(page.url() || "")); } catch {}
  try { fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2)); } catch {}
  try { await saveScreenshot(page, `${base}.png`); } catch {}
  return base;
}

const USER_SELECTORS = [
  'input[type="email"]','input[type="text"]','input[type="tel"]',
  'input[name*="user" i]','input[name*="email" i]','input[name*="account" i]',
  'input[placeholder*="email" i]','input[placeholder*="mail" i]','input[placeholder*="account" i]',
  'input[placeholder*="phone" i]','input[placeholder*="mobile" i]'
].join(", ");
const PASS_SELECTORS = [
  'input[type="password"]','input[name*="pass" i]','input[placeholder*="password" i]'
].join(", ");

function isCloudflareErrorHtml(html) {
  const s = (html || "").toLowerCase();
  if (!s) return false;
  return (s.includes("cloudflare") && s.includes("cf-error-details")) || s.includes("error 1101") || s.includes("worker threw exception");
}
async function closeOverlays(page) {
  const candidates = [
    page.getByRole("button", { name: /close|cancel|dismiss|i understand|got it|ok|agree/i }),
    page.locator('[aria-label*="close" i]'),
    page.locator(".ant-modal-close")
  ];
  for (const c of candidates) {
    try {
      const btn = c.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1500 }).catch(() => null);
        await sleep(250);
      }
    } catch {}
  }
}
async function isVisibleInAnyFrame(page, selector) {
  for (const f of page.frames()) {
    try {
      const loc = f.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return true;
    } catch {}
  }
  return false;
}
async function findVisibleInAnyFrame(page, selector, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await closeOverlays(page);
    for (const f of page.frames()) {
      try {
        const loc = f.locator(selector).first();
        if (await loc.isVisible().catch(() => false)) return { ok: true, frame: f, locator: loc };
      } catch {}
    }
    await sleep(250);
  }
  return { ok: false, frame: null, locator: null };
}

async function clickLogin(page) {
  const candidates = [
    page.getByRole("button", { name: /login|sign in/i }).first(),
    page.getByText(/^login$/i).first(),
    page.locator('button:has-text("Login")').first(),
    page.locator('div:has-text("Login")').first(),
    page.locator('span:has-text("Login")').first()
  ];
  for (const c of candidates) {
    try {
      if (await c.isVisible().catch(() => false)) {
        await c.scrollIntoViewIfNeeded().catch(() => null);
        await c.click({ timeout: 12000 }).catch(() => null);
        return { ok: true };
      }
    } catch {}
  }
  return { ok: false };
}

async function logAfterLoginClick(page) {
  const url = page.url();
  const userVisible = await isVisibleInAnyFrame(page, USER_SELECTORS);
  const passVisible = await isVisibleInAnyFrame(page, PASS_SELECTORS);
  const loginFormVisible = userVisible && passVisible;

  console.log("AFTER LOGIN CLICK | url:", url, "| loginFormVisible:", loginFormVisible, "| userVisible:", userVisible, "| passVisible:", passVisible);
  return { url, loginFormVisible, userVisible, passVisible };
}
async function waitForLoginToSettle(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await closeOverlays(page);
    const url = page.url();
    const userVisible = await isVisibleInAnyFrame(page, USER_SELECTORS);
    const passVisible = await isVisibleInAnyFrame(page, PASS_SELECTORS);
    const loginFormVisible = userVisible && passVisible;

    if (!/\/login\b|#\/login\b/i.test(url) && !loginFormVisible) return { ok: true, url, reason: "url_changed_and_fields_gone" };
    if (!loginFormVisible) return { ok: true, url, reason: "login_fields_hidden" };

    const bad = await page.getByText(/incorrect|invalid|error|failed/i).first().isVisible().catch(() => false);
    if (bad) {
      const txt = (await page.getByText(/incorrect|invalid|error|failed/i).first().textContent().catch(() => "")) || "";
      return { ok: false, url, reason: "error_text_visible", detail: txt.trim().slice(0, 180) };
    }

    await sleep(350);
  }
  return { ok: false, url: page.url(), reason: "timeout" };
}

function shouldUseMobileContext(loginUrl) {
  if (FORCE_MOBILE) return true;
  const u = (loginUrl || "").toLowerCase();
  return u.includes("/h5/#/") || u.includes("/h5/");
}

async function attachApiRewrite(page) {
  if (!API_REWRITE || !API_REWRITE_TARGET) return;
  let re;
  try { re = new RegExp(API_REWRITE_MATCH); } catch { re = /^api\./; }

  await page.route("**/*", async (route) => {
    const req = route.request();
    const urlStr = req.url();
    let u;
    try { u = new URL(urlStr); } catch { return route.continue(); }

    if (re.test(u.hostname)) {
      const origHost = u.hostname;
      u.hostname = API_REWRITE_TARGET;
      const newUrl = u.toString();
      if (/login|ping|\/api\//i.test(urlStr)) {
        console.log("API_REWRITE:", origHost, "=>", API_REWRITE_TARGET, "|", u.pathname);
      }
      return route.continue({ url: newUrl });
    }
    return route.continue();
  });
}

const app = express();
app.use(express.urlencoded({ extended: true }));

function startupConfigErrors() {
  const errs = [];
  if (!BOT_PASSWORD) errs.push("BOT_PASSWORD or RUN_PASSWORD is not set.");
  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) errs.push(cfg.error || "ACCOUNTS_JSON is missing/invalid.");
  if (API_REWRITE && !API_REWRITE_TARGET) errs.push("API_REWRITE=1 but API_REWRITE_TARGET is empty.");
  return errs;
}

app.get("/health", (req, res) => {
  const cfg = safeJsonParseAccounts();
  res.json({
    ok: true,
    running: isRunning,
    lastRun: lastRunAt,
    lastError,
    config: {
      debugCapture: DEBUG_CAPTURE,
      traceCapture: TRACE_CAPTURE,
      harCapture: HAR_CAPTURE,
      forceMobile: FORCE_MOBILE,
      loginUrls: LOGIN_URLS
    },
    rewrite: { enabled: API_REWRITE, match: API_REWRITE_MATCH, target: API_REWRITE_TARGET || null },
    debug: { lastRunId, lastDebugDir, lastShotPath, stableShotPath: "/app/last-shot.png" }
  });
});

app.get("/debug", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!lastDebugDir) return res.send(`<h3>Debug</h3><div>No debug directory yet. Run the bot once.</div>`);
  const files = safeListDir(lastDebugDir);
  const links = files.map((f) => `<li><a href="/debug/files?p=${encodeURIComponent(BOT_PASSWORD)}&f=${encodeURIComponent(f)}">${escapeHtml(f)}</a></li>`).join("");
  res.send(`<h3>Debug</h3><div>Last run ID: <code>${escapeHtml(lastRunId || "-")}</code></div><div>Dir: <code>${escapeHtml(lastDebugDir)}</code></div><hr/><ul>${links}</ul>`);
});

app.get("/debug/files", (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const f = (req.query.f || "").toString();
  if (!lastDebugDir) return res.status(404).send("No debug dir.");
  if (!f) return res.status(400).send("Missing f=");
  if (f.includes("..") || f.includes("/") || f.includes("\\")) return res.status(400).send("Bad filename.");

  const full = path.resolve(lastDebugDir, f);
  const base = path.resolve(lastDebugDir);
  if (!full.startsWith(base)) return res.status(400).send("Bad path.");
  if (!fs.existsSync(full)) return res.status(404).send("Not found.");

  if (/\.(html|txt|json)$/i.test(full)) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  else if (/\.png$/i.test(full)) res.setHeader("Content-Type", "image/png");
  else if (/\.har$/i.test(full)) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (/\.zip$/i.test(full)) res.setHeader("Content-Type", "application/zip");
  else res.setHeader("Content-Type", "application/octet-stream");

  fs.createReadStream(full).pipe(res);
});

app.get("/dns-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const hosts = ["dsj12.cc", "dsj877.com", "api.dsj12.cc", "api.dsj877.com", API_REWRITE_TARGET || "api.ddjea.com"].filter(Boolean);
  const out = {};
  for (const h of hosts) {
    try { out[h] = { ok: true, addrs: await dns.lookup(h, { all: true }) }; }
    catch (e) { out[h] = { ok: false, error: e?.message || String(e) }; }
  }
  res.json(out);
});

app.get("/net-test", async (req, res) => {
  if (!authOk(req)) return res.status(401).send("Unauthorized. Add ?p=YOUR_PASSWORD");
  const urls = ["https://dsj12.cc/", "https://dsj877.com/", API_REWRITE_TARGET ? `https://${API_REWRITE_TARGET}/` : "https://api.ddjea.com/"];
  const results = {};
  for (const u of urls) {
    try { results[u] = { ok: true, ...(await simpleGet(u, 15000)) }; }
    catch (e) { results[u] = { ok: false, error: e?.message || String(e) }; }
  }
  res.json(results);
});

app.post("/run", async (req, res) => {
  const p = (req.body.p || "").toString();
  const code = (req.body.code || "").toString().trim();

  if (!BOT_PASSWORD) return res.status(500).send("BOT_PASSWORD or RUN_PASSWORD not set in Railway variables.");
  if (p !== BOT_PASSWORD) return res.status(401).send("Wrong password.");
  if (!code) return res.status(400).send("No code provided.");
  if (isRunning) return res.send("Bot is already running. Please wait.");

  const cfg = safeJsonParseAccounts();
  if (!cfg.ok) return res.status(500).send(cfg.error || "ACCOUNTS_JSON not set/invalid.");

  isRunning = true;
  lastError = null;
  lastRunAt = nowLocal();
  lastRunId = crypto.randomBytes(6).toString("hex");
  lastDebugDir = `/tmp/debug-${lastRunId}`;
  ensureDir(lastDebugDir);
  writePlaceholderLastShot();

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("Run started. Check logs, /health, and /debug.");

  (async () => {
    try {
      for (const account of cfg.accounts) {
        await runAccountOnFirstSite(account, code);
      }
    } catch (e) {
      lastError = e?.message || String(e);
      console.log("Run failed:", lastError);
    } finally {
      isRunning = false;
    }
  })();
});

async function runAccountOnFirstSite(account, orderCode) {
  const loginUrl = LOGIN_URLS[0];
  return await runAccountOnSite(account, orderCode, loginUrl);
}

async function runAccountOnSite(account, orderCode, loginUrl) {
  const mobile = shouldUseMobileContext(loginUrl);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  const harPath =
    HAR_CAPTURE && lastDebugDir
      ? path.join(lastDebugDir, `har-${sanitizeForFilename(account.username)}-${Date.now()}.har`)
      : null;

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    recordHar: harPath ? { path: harPath, content: "embed" } : undefined,
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // ✅ Trace capture: start early
  let tracePath = null;
  if (TRACE_CAPTURE && lastDebugDir) {
    tracePath = path.join(lastDebugDir, `trace-${sanitizeForFilename(account.username)}-${Date.now()}.zip`);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => null);
  }

  await attachApiRewrite(page);

  // ✅ Key logging we need
  page.on("request", (req) => {
    const u = req.url();
    if (/login|ping|\/api\//i.test(u)) console.log("REQ:", req.method(), u);
  });
  page.on("response", async (resp) => {
    const u = resp.url();
    if (/login|ping|\/api\//i.test(u)) console.log("RES:", resp.status(), u);
  });
  page.on("requestfailed", (req) => {
    const f = req.failure();
    const u = req.url();
    if (/login|ping|\/api\//i.test(u)) console.log("REQ FAILED:", u, "=>", f?.errorText || "unknown");
  });

  async function fail(tag, message, extra = {}) {
    await captureFailureArtifacts(page, `${sanitizeForFilename(account.username)}-${tag}`, { loginUrl, ...extra });
    throw new Error(message);
  }

  try {
    const resp = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1000);

    const status = resp ? resp.status() : null;
    const html0 = await page.content().catch(() => "");
    if (isCloudflareErrorHtml(html0)) await fail("cloudflare", "Cloudflare error page on login", { status });

    const userRes = await findVisibleInAnyFrame(page, USER_SELECTORS, 25000);
    const passRes = await findVisibleInAnyFrame(page, PASS_SELECTORS, 25000);
    if (!userRes.ok || !passRes.ok) await fail("login-fields-missing", "Login fields not found", { userFound: userRes.ok, passFound: passRes.ok });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const userField = userRes.locator;
      const passField = passRes.locator;

      await userField.fill(account.username).catch(() => null);
      await passField.fill(account.password).catch(() => null);

      const clickRes = await clickLogin(page);
      if (!clickRes.ok) await passField.press("Enter").catch(() => null);

      await sleep(450);
      const lastAfterClick = await logAfterLoginClick(page);
      const settled = await waitForLoginToSettle(page, 30000);

      await dumpDebugStep(page, `after-login-attempt-${attempt}`, { attempt, lastAfterClick, settled, clickRes });

      if (settled.ok) break;
      if (attempt === 3) await fail("login-failed", "Login failed (stayed on login)", { attempt, lastAfterClick, settled });
    }

    // If we got here, login moved or fields disappeared — good.
    return true;
  } finally {
    // ✅ stop trace on exit (success OR fail)
    if (TRACE_CAPTURE && tracePath) {
      await context.tracing.stop({ path: tracePath }).catch(() => null);
      console.log("TRACE SAVED:", tracePath);
    }
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  const errs = startupConfigErrors();
  console.log("Starting Container");
  console.log("Listening on", PORT);
  console.log("DEBUG_CAPTURE:", DEBUG_CAPTURE);
  console.log("TRACE_CAPTURE:", TRACE_CAPTURE);
  console.log("HAR_CAPTURE:", HAR_CAPTURE);
  console.log("FORCE_MOBILE:", FORCE_MOBILE);
  console.log("LOGIN_URLS:", LOGIN_URLS.join(", "));
  console.log("API_REWRITE:", API_REWRITE, "match:", API_REWRITE_MATCH, "target:", API_REWRITE_TARGET || "(none)");
  if (errs.length) console.log("CONFIG ERRORS:", errs);
  writePlaceholderLastShot();
});
