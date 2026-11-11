import puppeteer from "puppeteer";
import Humanizer from "../index";
import { BROWSERS, notFoundHint } from "../browsers";

const BRAVE = BROWSERS.brave.exe; // auto-detected on macOS / Windows / Linux (override with BRAVE_PATH)
const QUERY = process.env.QUERY || "mobile phone";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!BRAVE) throw new Error(notFoundHint("brave"));
  // Separate temporary profile, so the user's own Brave profile is untouched
  const browser = await puppeteer.launch({
    executablePath: BRAVE,
    headless: false,
    defaultViewport: null,
    args: ["--window-size=1400,900"],
  });
  const page = await browser.newPage();
  const human = new Humanizer(page, { visualize: true });

  console.log("1. Opening Google in Brave...");
  await page.goto("https://www.google.com", { waitUntil: "networkidle2" });
  await sleep(1500);

  console.log(`2. Moving mouse to the search box and typing "${QUERY}"...`);
  await human.click('textarea[name="q"]');
  await human.type(QUERY);
  await sleep(500);
  await page.keyboard.press("Enter");

  console.log("3. Waiting for results...");
  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2000);

  if (page.url().includes("/sorry/")) {
    console.log("\nGoogle showed a CAPTCHA (it flagged this browser as automated).");
  } else {
    const results = await page.$$eval("#search a:has(h3)", (links) =>
      links.map((a) => ({
        title: (a.querySelector("h3")?.textContent || "").trim(),
        url: (a as HTMLAnchorElement).href,
      }))
    );

    console.log(`\nFound ${results.length} results for "${QUERY}":\n`);
    results.forEach((r, i) => console.log(`${i + 1}. ${r.title}\n   ${r.url}`));
  }

  console.log("\nBrave will stay open for 2 minutes.");
  await sleep(120000);
  await browser.close();
})();
