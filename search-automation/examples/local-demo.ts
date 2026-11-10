import path from "path";
import puppeteer from "puppeteer";
import Humanizer from "../index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--window-size=1400,900"],
  });
  const page = await browser.newPage();

  const human = new Humanizer(page, { visualize: true });

  const file = "file://" + path.join(__dirname, "local-demo.html");
  await page.goto(file);
  await sleep(1000);

  await human.click("#b1");
  await sleep(500);
  await human.click("#b2");
  await sleep(500);
  await human.click("#b3");
  await sleep(500);
  await human.click("#name");
  // Slow (40 words/min) with frequent typos so it is easy to watch
  await human.type("mobile phone under fifteen thousand", { wpm: 40, typoChance: 0.12 });

  const keys: { key: string; gap: number }[] = await page.evaluate(() => (window as any).__keys);
  const gaps = keys.slice(1).map((k) => k.gap);
  const typos = keys.filter((k) => k.key === "Backspace").length;
  console.log("Typed text:", await page.$eval("#name", (el) => (el as HTMLInputElement).value));
  console.log(`Keystrokes: ${keys.length}, typos fixed: ${typos}`);
  console.log(`Gap between keys: min ${Math.min(...gaps)}ms, max ${Math.max(...gaps)}ms, avg ${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)}ms`);
  console.log("Gaps (ms):", gaps.join(" "));

  console.log("Demo finished. Chrome window will stay open for 60 seconds.");
  await sleep(60000);
  await browser.close();
})();
