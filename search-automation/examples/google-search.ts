import puppeteer from "puppeteer";
import Humanizer from "../index";

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });
  const page = await browser.newPage();

  const human = new Humanizer(page, {
    visualize: true,
  });

  // Set the viewport size to match the screen dimensions
  await page.setViewport({ width: 1920, height: 1080 });

  await page.goto("https://www.google.com");

  await human.click('textarea[title="Search"]');

  await human.type("how long are dolphins in feet");

  await human.click('input[aria-label="Google Search"]');
})();
