import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fails = [];
page.on("requestfailed", r => fails.push(r.url() + " " + (r.failure()?.errorText || "")));
page.on("response", r => { if (r.status() >= 400) fails.push(r.url() + " HTTP " + r.status()); });
await page.goto(process.argv[2], { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(1500);
const state = await page.evaluate(() => {
  const m = document.getElementById("main");
  return { text: (m?.textContent || "").slice(0, 160), apiCalls: performance.getEntriesByType("resource").filter(r => r.name.includes("/api/")).map(r => r.name) };
});
console.log(JSON.stringify({ fails, ...state }, null, 1));
await browser.close();
