const { chromium } = require("playwright");
const accounts = require("./accounts.json");

const LOGIN_URL = "https://YOUR_PLATFORM_LOGIN_URL";
const FUTURES_URL = "https://YOUR_PLATFORM_FUTURES_URL";

async function runAccount(account) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let loggedIn = false;

  while (!loggedIn) {
    try {
      await page.goto(LOGIN_URL, { timeout: 60000 });

      await page.fill('input[type="text"]', account.username);
      await page.fill('input[type="password"]', account.password);
      await page.click('button:has-text("Login")');

      await page.waitForTimeout(5000);
      loggedIn = true;
    } catch {
      console.log("Login failed, retrying...");
    }
  }

  await page.goto(FUTURES_URL);
  await page.click('text=Invited Me');

  await page.waitForSelector('text=Follow', { timeout: 60000 });
  await page.click('text=Follow');
  await page.click('text=Confirm');

  // Ignore popup if it appears
  await page.waitForTimeout(3000);

  // Go to Position Order
  await page.click('text=Position Order');

  let success = false;
  const start = Date.now();

  while (!success && Date.now() - start < 120000) {
    const pending = await page.locator('text=Pending').count();
    if (pending > 0) {
      success = true;
      console.log(`SUCCESS: ${account.username}`);
    } else {
      await page.reload();
      await page.waitForTimeout(3000);
    }
  }

  await browser.close();
}

(async () => {
  for (const account of accounts) {
    await runAccount(account);
  }
})();
