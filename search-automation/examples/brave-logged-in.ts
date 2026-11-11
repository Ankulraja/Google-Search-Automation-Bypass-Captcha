import puppeteer from "puppeteer";
import Humanizer from "../index";
import { BROWSERS, copyProfile, notFoundHint } from "../browsers";

// Runs the automation in a COPY of your real Brave profile (logins, cookies, extensions).
// Chromium 136+ refuses remote debugging on the default profile dir, so we clone it.
// Paths are auto-detected on macOS / Windows / Linux (override with BRAVE_PATH, BRAVE_PROFILE_DIR, PROFILE_COPY).
const BRAVE = BROWSERS.brave.exe;
const DEST = BROWSERS.brave.copy;
const PROFILE = process.env.PROFILE || "Default";
const QUERY = process.env.QUERY || "mobile phone";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function syncProfile() {
  console.log(`Copying Brave profile "${PROFILE}" -> ${DEST} ...`);
  const { skipped } = copyProfile("brave", PROFILE);
  if (skipped.length) console.log(`Skipped ${skipped.length} locked file(s). If logins are missing, close Brave and run again.`);
}

(async () => {
  if (!BRAVE) throw new Error(notFoundHint("brave"));
  syncProfile();

  const browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: false,
    defaultViewport: null,
    userDataDir: DEST,
    // Drop puppeteer's flags that disable extensions / mark the browser as automated
    ignoreDefaultArgs: ["--enable-automation", "--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [`--profile-directory=${PROFILE}`, "--window-size=1400,900", "--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage();
  const human = new Humanizer(page, { visualize: true });

  console.log("1. Opening Google...");
  await page.goto("https://www.google.com", { waitUntil: "networkidle2" });
  await sleep(1500);

  console.log(`2. Typing "${QUERY}"...`);
  await human.click('textarea[name="q"]');
  await human.type(QUERY);
  await sleep(500);
  await page.keyboard.press("Enter");
  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2000);

  if (page.url().includes("/sorry/")) {
    console.log("\nGoogle still showed a CAPTCHA.");
  } else {
    const results = await page.$$eval("#search a:has(h3)", (links) =>
      links.map((a) => ({ title: (a.querySelector("h3")?.textContent || "").trim(), url: (a as HTMLAnchorElement).href }))
    );
    console.log(`\nFound ${results.length} results:\n`);
    results.forEach((r, i) => console.log(`${i + 1}. ${r.title}\n   ${r.url}`));
  }

  const holdMs = Number(process.env.HOLD_MS ?? 120000);
  console.log(`\nBrave will stay open for ${holdMs / 1000}s.`);
  await sleep(holdMs);
  await browser.close();
})();
