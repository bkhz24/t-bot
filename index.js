"use strict";

const express = require("express");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");
const { chromium } = require("playwright");

/* ═══════════════════════════════════════════════════════════════════
   CONFIGURATION
   ═══════════════════════════════════════════════════════════════════ */
const PORT              = Number(process.env.PORT) || 8080;
const PASSWORD          = process.env.BOT_PASSWORD || process.env.PASSWORD || "";
const ORDER_CODE        = (process.env.ORDER_CODE || "").trim();
const LOGIN_ATTEMPTS    = Number(process.env.LOGIN_ATTEMPTS) || 8;
const CONFIRM_RETRIES   = Number(process.env.CONFIRM_RETRIES) || 8;
const WAIT_AFTER_LOGIN  = Number(process.env.WAIT_AFTER_LOGIN_MS) || 8000;
const CODE_LENGTH       = Number(process.env.CODE_LENGTH) || 9;
const FORCE_MOBILE      = (process.env.FORCE_MOBILE || "auto").toLowerCase();

const ACCOUNTS = (() => {
  try { return JSON.parse(process.env.ACCOUNTS || "[]"); }
  catch { return []; }
})();

const LOGIN_URLS = (process.env.LOGIN_URLS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* ═══════════════════════════════════════════════════════════════════
   EMAIL
   ═══════════════════════════════════════════════════════════════════ */
let emailSend = null;
try {
  const mod = require("./src/emailer");
  // Handle various export shapes
  if (typeof mod === "function")                emailSend = mod;
  else if (mod && typeof mod.send === "function")      emailSend = mod.send.bind(mod);
  else if (mod && typeof mod.sendEmail === "function")  emailSend = mod.sendEmail.bind(mod);
  else if (mod && typeof mod.default === "function")    emailSend = mod.default;
} catch { /* emailer not available */ }

const emailOk = !!emailSend;

async function notify(subject, body) {
  if (!emailSend) return;
  try {
    await emailSend(subject, body);
    console.log(`Email sent: ${subject.substring(0, 50)}`);
  } catch (e) {
    console.log(`Email error: ${e.message}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   DEBUG STORAGE
   ═══════════════════════════════════════════════════════════════════ */
const DEBUG_DIR = "/tmp/debug";
fs.mkdirSync(DEBUG_DIR, { recursive: true });

function cleanDebug() {
  try {
    for (const f of fs.readdirSync(DEBUG_DIR))
      fs.unlinkSync(path.join(DEBUG_DIR, f));
  } catch {}
}

async function snap(page, label) {
  const name = `${Date.now()}_${label.replace(/[^a-z0-9_-]/gi, "_")}`;
  try {
    await page.screenshot({
      path: path.join(DEBUG_DIR, `${name}.png`),
      fullPage: true,
    });
  } catch {}
  try {
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.html`), await page.content());
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isMobile(url) {
  if (FORCE_MOBILE === "true") return true;
  if (FORCE_MOBILE === "false") return false;
  return url.includes("/h5/");
}

function baseUrl(loginUrl) {
  try { return new URL(loginUrl).origin; }
  catch { return loginUrl.replace(/\/(pc|h5)\/.*/i, ""); }
}

/**
 * Type into a Vue/Element-UI input properly.
 *
 * Playwright's fill() sets the DOM value directly but BYPASSES Vue's
 * v-model event listeners. Vue's internal state stays empty, so any
 * button that reads the reactive data sees nothing.
 *
 * pressSequentially() simulates real keystrokes (keydown → keypress →
 * input → keyup for each character), which correctly triggers Vue
 * reactivity.
 */
async function vueType(page, locator, value, opts = {}) {
  const { delay = 40 } = opts;

  // Focus and clear
  await locator.click();
  await sleep(150);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await sleep(150);

  // Type character-by-character (triggers Vue v-model)
  await locator.pressSequentially(value, { delay });
  await sleep(300);

  // Verify
  const actual = await locator.inputValue().catch(() => "");
  if (actual === value) return true;

  // Fallback: native setter + event dispatch
  console.log(`  vueType verify mismatch ("${actual}" vs "${value}"), using native setter fallback`);
  await page.evaluate((val) => {
    const el = document.querySelector(".follow-input .el-input__inner")
            || document.querySelector('input[placeholder*="order code"]')
            || document.querySelector('input[placeholder*="enter the order"]');
    if (!el) return;
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "value"
    ).set;
    set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: val, inputType: "insertText" })
    );
  }, value);
  await sleep(300);

  return (await locator.inputValue().catch(() => "")) === value;
}

/* ═══════════════════════════════════════════════════════════════════
   LOGIN
   ═══════════════════════════════════════════════════════════════════ */
async function login(page, url, user, pass) {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt++) {
    console.log(`Login attempt ${attempt}/${LOGIN_ATTEMPTS} for ${user} on ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      console.log(`  Nav error: ${e.message}`);
      if (attempt < LOGIN_ATTEMPTS) { await sleep(3000); continue; }
      return false;
    }
    await sleep(3000);

    /* --- Fill credentials (also use pressSequentially for Vue) --- */
    try {
      const userIn = page.locator([
        'input[type="text"]',
        'input[type="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="account" i]',
        'input[placeholder*="phone" i]',
      ].join(", ")).first();
      await userIn.waitFor({ timeout: 10000 });
      await userIn.click({ clickCount: 3 });
      await userIn.pressSequentially(user, { delay: 20 });

      const passIn = page.locator('input[type="password"]').first();
      await passIn.click({ clickCount: 3 });
      await passIn.pressSequentially(pass, { delay: 20 });

      const vu = await userIn.inputValue();
      const pl = (await passIn.inputValue()).length;
      console.log(`  Filled user: "${vu}" (expected: "${user}"), pass length: ${pl}`);
    } catch (e) {
      console.log(`  Fill error: ${e.message}`);
      if (attempt < LOGIN_ATTEMPTS) { await sleep(2000); continue; }
      return false;
    }

    /* --- Click login button --- */
    // The login button is a <div class="login-btn">, NOT a <button>
    try {
      const lb = page.locator(".login-btn").first();
      if (await lb.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("Clicking .login-btn div");
        await lb.click();
      } else {
        // Fallback: try any button with login text
        const btn = page.locator(
          'button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")'
        ).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
        } else {
          await page.keyboard.press("Enter");
        }
      }
    } catch {
      await page.keyboard.press("Enter");
    }

    await sleep(WAIT_AFTER_LOGIN || 8000);

    /* --- Check success --- */
    const cur = page.url();
    const still = await page.locator('input[type="password"]').isVisible().catch(() => false);
    const onLogin = cur.includes("/login");
    console.log(`  After login: url=${cur}, stillHasFields=${still}, onLoginPage=${onLogin}`);

    if (!onLogin && !still) {
      console.log("  ✓ Login SUCCESS");
      return true;
    }

    console.log("  ✗ Login attempt failed");
    await sleep(2000);
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   NAVIGATE TO CONTRACT TRANSACTION PAGE
   ═══════════════════════════════════════════════════════════════════ */
async function goToContractPage(page, loginUrl) {
  const base = baseUrl(loginUrl);
  const mobile = isMobile(loginUrl);

  if (!mobile) {
    /* PC: click Futures in the top nav */
    console.log("PC: Looking for Futures nav item...");
    try {
      // The nav items are spans/divs inside the header with class selectors
      const futuresNav = page.locator(
        '.header span:has-text("Futures"), .header div:has-text("Futures")'
      ).first();
      if (await futuresNav.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log("PC: Clicked Futures nav popover");
        await futuresNav.click();
        await sleep(1500);

        // Click "Futures" in the dropdown popover
        const dd = page.locator(
          '.lang-item:has-text("Futures"), .el-popover .lang-item:has-text("Futures")'
        ).first();
        if (await dd.isVisible({ timeout: 2000 }).catch(() => false)) {
          await dd.click();
          await sleep(2000);
        }
      }
    } catch (e) {
      console.log(`PC Futures nav error: ${e.message}`);
    }

    // Always also direct-navigate to be safe
    const txUrl = `${base}/pc/#/contractTransaction`;
    console.log(`Navigating directly to: ${txUrl}`);
    await page.goto(txUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } else {
    /* Mobile: direct navigate */
    const txUrl = `${base}/h5/#/contractTransaction`;
    console.log(`Navigating directly to: ${txUrl}`);
    await page.goto(txUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  await sleep(4000);
}

/* ═══════════════════════════════════════════════════════════════════
   CLICK "INVITED ME" TAB
   ═══════════════════════════════════════════════════════════════════ */
async function clickInvitedMe(page) {
  const selectors = [
    'div.title:has-text("invited me")',
    'div:text-is(" invited me ")',
    ':text("invited me")',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click();
        console.log("Clicked 'Invited me'");
        await sleep(2000);
        return true;
      }
    } catch {}
  }

  // Last resort: JS click
  const clicked = await page.evaluate(() => {
    const divs = [...document.querySelectorAll("div.title, div")];
    const target = divs.find(
      (d) => d.textContent.trim().toLowerCase() === "invited me"
    );
    if (target) { target.click(); return true; }
    return false;
  });

  if (clicked) {
    console.log("Clicked 'Invited me' (via JS)");
    await sleep(2000);
    return true;
  }

  console.log("WARNING: 'Invited me' tab not found");
  return false;
}

/* ═══════════════════════════════════════════════════════════════════
   FILL CODE & CLICK CONFIRM  —  THE CRITICAL SECTION
   ═══════════════════════════════════════════════════════════════════ */
async function fillCodeAndConfirm(page, code) {
  /* ── 1. Find the order code input ────────────────────────────── */
  const inputSelectors = [
    ".follow-input .el-input__inner",
    'input[placeholder*="order code" i]',
    'input[placeholder*="enter the order" i]',
  ];

  let input = null;
  for (const sel of inputSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      input = loc;
      break;
    }
  }

  if (!input) {
    console.log("ERROR: Order code input not found");
    await snap(page, "no_code_input");
    return { success: false, reason: "input_not_found" };
  }

  /* ── 2. Fill the code using pressSequentially (Vue-compatible) ─ */
  const filled = await vueType(page, input, code);
  const actualVal = await input.inputValue().catch(() => "");
  console.log(`Code filled: "${actualVal}" (expected length ${CODE_LENGTH})`);

  if (!filled && actualVal !== code) {
    console.log("ERROR: Could not fill code into input");
    await snap(page, "fill_failed");
    return { success: false, reason: "fill_failed" };
  }

  /* ── 3. Find the Confirm button ──────────────────────────────── */
  // From the HTML: <button class="el-button el-button--default el-button--mini">
  // inside <div class="el-input-group__append">
  const btnSelectors = [
    ".follow-input .el-input-group__append button",
    ".el-input-group__append .el-button",
    ".el-input-group__append button",
    'button:has-text("Confirm")',
  ];

  let confirmBtn = null;
  let confirmSel = "";
  for (const sel of btnSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      confirmBtn = loc;
      confirmSel = sel;
      break;
    }
  }

  const jsFound = await page.evaluate(() => {
    return !!(
      document.querySelector(".follow-input .el-input-group__append button") ||
      document.querySelector(".el-input-group__append .el-button")
    );
  });

  console.log(`confirmBtn found: ${!!confirmBtn} (sel=${confirmSel || "none"}), jsFound: ${jsFound}`);

  /* ── 4. Click Confirm with retries ───────────────────────────── */
  for (let i = 1; i <= CONFIRM_RETRIES; i++) {
    console.log(`Confirm click attempt ${i}`);

    // Before each click, re-ensure Vue has the value
    // (Vue might have cleared it or an earlier click attempt might have reset state)
    await page.evaluate((val) => {
      const el =
        document.querySelector(".follow-input .el-input__inner") ||
        document.querySelector('input[placeholder*="order code"]');
      if (!el) return;
      if (el.value === val) return; // already good

      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, "value"
      ).set;
      set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, code);

    await sleep(200);

    // Strategy A: Playwright click with force
    if (confirmBtn) {
      try {
        await confirmBtn.click({ force: true, timeout: 1500 });
      } catch {}
    }
    await sleep(300);

    // Strategy B: JavaScript click + MouseEvent dispatch
    await page.evaluate(() => {
      const btn =
        document.querySelector(".follow-input .el-input-group__append button") ||
        document.querySelector(".el-input-group__append .el-button");
      if (btn) {
        btn.click();
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    });
    await sleep(300);

    // Strategy C: Press Enter on the input
    try { await input.press("Enter"); } catch {}

    // Wait for the site to respond
    await sleep(2500);

    // Check for any response (toast, dialog, notification)
    const resp = await detectResponse(page);
    if (resp.found) {
      console.log(`${resp.isSuccess ? "✓" : "✗"} Response: "${resp.text}"`);
      await snap(page, resp.isSuccess ? "success" : "response");
      return { success: resp.isSuccess, reason: resp.text };
    }
  }

  // All retries exhausted
  await snap(page, "verify_failed");
  return {
    success: false,
    reason: "verify_failed",
    toast: "toast_off",
    pending: "pending_off",
  };
}

/* ═══════════════════════════════════════════════════════════════════
   DETECT RESPONSE (toast / dialog / notification)

   The site uses a custom ".successDialog-page" that shows/hides.
   It also might use Element UI's el-message or el-notification.
   ═══════════════════════════════════════════════════════════════════ */
async function detectResponse(page) {
  // 1. Check the site's custom success/error dialog
  //    HTML: <div class="successDialog-page" style="display: none;">
  //          becomes visible when the API responds
  const dialogInfo = await page.evaluate(() => {
    const d = document.querySelector(".successDialog-page");
    if (!d) return { visible: false, text: "" };

    const style = window.getComputedStyle(d);
    if (style.display === "none" || style.visibility === "hidden") {
      return { visible: false, text: "" };
    }

    const txt = (d.querySelector(".content-text")?.textContent || "").trim();
    return { visible: true, text: txt };
  });

  if (dialogInfo.visible && dialogInfo.text) {
    const t = dialogInfo.text.toLowerCase();
    return {
      found: true,
      text: dialogInfo.text,
      isSuccess:
        t.includes("success") ||
        t.includes("follow") ||
        t.includes("已跟单") ||
        (!t.includes("invalid") && !t.includes("error") && !t.includes("fail")),
    };
  }

  // If dialog is visible but no text, still count it (e.g. "Invalid parameter")
  if (dialogInfo.visible) {
    // Try to get ALL text from the dialog
    const allText = await page
      .locator(".successDialog-page")
      .textContent()
      .catch(() => "");
    if (allText.trim()) {
      const t = allText.trim().toLowerCase();
      return {
        found: true,
        text: allText.trim(),
        isSuccess: t.includes("success") || t.includes("follow"),
      };
    }
    // Dialog visible but truly empty — might still be a response
    return { found: true, text: "(dialog shown, no text)", isSuccess: false };
  }

  // 2. Check Element UI messages / notifications
  for (const sel of [".el-message", ".el-notification", ".el-message-box__wrapper"]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        const text = (await el.textContent().catch(() => "")).trim();
        if (text) {
          const t = text.toLowerCase();
          return {
            found: true,
            text,
            isSuccess: t.includes("success") || t.includes("follow"),
          };
        }
      }
    } catch {}
  }

  // 3. Check for any visible el-dialog that wasn't there before
  const dialogText = await page.evaluate(() => {
    const wrappers = document.querySelectorAll(".el-dialog__wrapper");
    for (const w of wrappers) {
      if (w.style.display === "none") continue;
      const dlg = w.querySelector(".el-dialog");
      if (!dlg) continue;
      // Check if it has non-trivial visible content
      const rect = dlg.getBoundingClientRect();
      if (rect.height < 10) continue;
      const txt = dlg.textContent?.trim() || "";
      // Filter out the always-present dialogs (rules, covering positions, etc.)
      if (txt && txt.length > 2 && txt.length < 500) {
        if (
          txt.toLowerCase().includes("invalid") ||
          txt.toLowerCase().includes("success") ||
          txt.toLowerCase().includes("follow") ||
          txt.toLowerCase().includes("error") ||
          txt.toLowerCase().includes("parameter") ||
          txt.toLowerCase().includes("已跟")
        ) {
          return txt;
        }
      }
    }
    return null;
  });

  if (dialogText) {
    const t = dialogText.toLowerCase();
    return {
      found: true,
      text: dialogText.substring(0, 200),
      isSuccess: t.includes("success") || t.includes("follow") || t.includes("已跟"),
    };
  }

  return { found: false };
}

/* ═══════════════════════════════════════════════════════════════════
   RUN ONE ACCOUNT
   ═══════════════════════════════════════════════════════════════════ */
async function runAccount(browser, user, pass, code) {
  for (const loginUrl of LOGIN_URLS) {
    console.log(`--- Trying ${loginUrl} for ${user} ---`);

    const mobile = isMobile(loginUrl);
    const ctx = await browser.newContext({
      viewport: mobile
        ? { width: 375, height: 812 }
        : { width: 1440, height: 900 },
      userAgent: mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await ctx.newPage();

    // Log network/page errors for debugging
    page.on("pageerror", (e) => console.log(`PAGE ERROR: ${e.message}`));
    page.on("requestfailed", (r) => {
      const u = r.url();
      if (!u.includes("favicon") && !u.includes("beacon"))
        console.log(`REQ FAILED: ${u} => ${r.failure()?.errorText || "unknown"}`);
    });

    try {
      /* ── Login ──────────────────────────────────────────────── */
      const loggedIn = await login(page, loginUrl, user, pass);
      if (!loggedIn) {
        await snap(page, `login_fail_${user.split("@")[0]}`);
        await ctx.close();
        continue; // try next URL
      }

      /* ── Navigate to contract page ─────────────────────────── */
      console.log(`runFlow: mobile=${mobile}, loginUrl=${loginUrl}`);
      await goToContractPage(page, loginUrl);

      /* ── Click "Invited me" ────────────────────────────────── */
      await clickInvitedMe(page);

      /* ── Fill code & confirm ───────────────────────────────── */
      const result = await fillCodeAndConfirm(page, code);

      await ctx.close();

      if (result.success) {
        return { user, url: loginUrl, success: true, reason: result.reason };
      }

      // Log failure details
      const failMsg = `Flow failed: ${result.reason} | toast=${result.toast || "n/a"}, pending=${result.pending || "n/a"}`;
      console.log(`✗ FAILED: ${loginUrl} for ${user}: ${failMsg}`);
      console.log(`FAIL: ${failMsg} | URL: ${loginUrl}`);

      // Don't try other URLs — the flow got far enough that login works,
      // the issue is the code/confirm, which will be the same on any URL
      return { user, success: false, reason: failMsg };
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      await snap(page, `error_${user.split("@")[0]}`);
      await ctx.close();
    }
  }

  return { user, success: false, reason: "all_urls_failed" };
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN BOT RUN
   ═══════════════════════════════════════════════════════════════════ */
let running = false;

async function runBot(code) {
  if (running) {
    console.log("Already running, skipping");
    return { error: "already_running" };
  }
  running = true;

  const runId = crypto.randomBytes(6).toString("hex");
  const ts = new Date().toISOString();

  console.log(`====== BOT RUN ${runId} ======`);
  console.log(`Started: ${ts}`);
  console.log(`Accounts: ${ACCOUNTS.length}`);
  console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
  console.log(`Force mobile: ${FORCE_MOBILE}`);
  console.log(`Code length: ${CODE_LENGTH}`);

  cleanDebug();
  await notify(
    `T-Bot | Run ${runId} started`,
    `${ts}\nAccounts: ${ACCOUNTS.length}\nCode length: ${code.length}`
  );

  const results = [];
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    for (const { user, pass } of ACCOUNTS) {
      console.log(`\n====== Account: ${user} ======`);
      const r = await runAccount(browser, user, pass, code);
      results.push(r);
      if (r.success) {
        console.log(`✓ SUCCESS: ${r.url} for ${user}: ${r.reason}`);
      }
    }
  } finally {
    await browser.close();
    running = false;
  }

  const okCount   = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;
  console.log(`\n====== RUN ${runId} COMPLETE: ${okCount} ok, ${failCount} fail ======`);

  const summary = results
    .map((r) => `${r.user}: ${r.success ? "✓" : "✗"} ${r.reason || ""}`)
    .join("\n");

  await notify(
    `T-Bot | Run ${runId} ${failCount ? `✗ ${failCount} failed` : "✓ ALL OK"}`,
    summary
  );

  return { runId, results, okCount, failCount };
}

/* ═══════════════════════════════════════════════════════════════════
   EXPRESS SERVER
   ═══════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json());

function auth(req) {
  if (!PASSWORD) return true;
  return (req.query.p || req.body?.p || "") === PASSWORD;
}

/* Health check */
app.get("/", (_req, res) => {
  res.json({ status: "ok", accounts: ACCOUNTS.length, urls: LOGIN_URLS.length });
});

/* Trigger a bot run */
app.all("/run", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: "unauthorized" });

  const code = req.query.code || req.body?.code || ORDER_CODE;
  if (!code) return res.status(400).json({ error: "no code — set ORDER_CODE env var or pass ?code=XXX" });

  const rid = crypto.randomBytes(6).toString("hex");
  res.json({ status: "started", runId: rid, codeLength: code.length });

  // Run in background so the HTTP response returns immediately
  runBot(code).catch((e) => console.error("Run error:", e));
});

/* Debug file list */
app.get("/debug", (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: "unauthorized" });

  const files = fs.readdirSync(DEBUG_DIR).sort().reverse();
  const p = req.query.p ? `?p=${encodeURIComponent(req.query.p)}` : "";
  res.send(`<!DOCTYPE html>
<html><body style="background:#111;color:#eee;font-family:monospace;padding:20px">
<h2>Debug (${files.length} files)</h2>
${files
  .map(
    (f) =>
      `<a href="/debug/${f}${p}" style="color:#4fc3f7;display:block;margin:5px 0">${f}</a>`
  )
  .join("")}
${files.length === 0 ? "<p>No debug files yet. Run the bot first.</p>" : ""}
</body></html>`);
});

/* Debug serve individual file */
app.get("/debug/:file", (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: "unauthorized" });

  const fp = path.join(DEBUG_DIR, path.basename(req.params.file));
  if (!fs.existsSync(fp)) return res.status(404).send("Not found");

  if (fp.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (fp.endsWith(".html")) res.setHeader("Content-Type", "text/html");
  else res.setHeader("Content-Type", "text/plain");

  res.sendFile(fp);
});

/* Last screenshot shortcut */
app.get("/last-shot", (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: "unauthorized" });

  const pngs = fs
    .readdirSync(DEBUG_DIR)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .reverse();

  if (!pngs.length) return res.status(404).send("No screenshots yet");
  res.setHeader("Content-Type", "image/png");
  res.sendFile(path.join(DEBUG_DIR, pngs[0]));
});

/* ═══════════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════════ */
console.log(`Force mobile: ${FORCE_MOBILE}`);
console.log(`Email configured: ${emailOk}`);

app.listen(PORT, () => {
  console.log(`T-Bot listening on port ${PORT}`);
  console.log(`Login URLs: ${LOGIN_URLS.join(", ")}`);
});
