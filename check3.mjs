import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const fails = [];
page.on("pageerror", e => fails.push("js: " + e.message.slice(0, 120)));
page.on("response", r => { if (r.status() >= 400) fails.push(r.url().split("8100")[1] + " " + r.status()); });
await page.goto(process.argv[2], { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("tbody tr")];
  const head = [...document.querySelectorAll("thead th")].map(th => th.textContent.trim());
  const first = rows[0] ? [...rows[0].querySelectorAll("td")].map(td => (td.textContent || "").trim().slice(0, 40)) : [];
  return {
    rows: rows.length,
    noun: (document.querySelector(".section-title") || {}).textContent || "",
    headline: (document.querySelector(".stats") || {}).textContent?.slice(0, 90) || "",
    columns: head.slice(0, 8),
    firstRow: first.slice(0, 5),
  };
});
console.log(JSON.stringify({ url: process.argv[2].split("run=")[1], fails, ...out }, null, 1));
await page.screenshot({ path: (process.argv[3] || "/tmp/lane.png") });
await browser.close();
