import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.screenshot({ path: process.argv[3], fullPage: false });
await browser.close();
