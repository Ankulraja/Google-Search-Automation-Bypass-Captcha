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

  await page.goto("https://www.amazon.com/");

  await page.waitForSelector("#twotabsearchtextbox");

  await human.click("#twotabsearchtextbox");

  await human.type("ysl myself largest most expensive bottle");

  await human.click("#nav-search-submit-button");

  await page.waitForNavigation();

  for (let i = 1; i <= 5; i++) {
    await human.click(`#a-autoid-${i}-announce`);
  }
})();
