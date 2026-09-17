import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
page.on("pageerror", e => errors.push("pageerror: " + String(e.message).slice(0, 160)));
await page.goto(process.argv[2] || "http://127.0.0.1:8100/", { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(1200);
const body = (await page.textContent("body")) || "";
console.log(JSON.stringify({
  errors,
  unreachable: body.includes("unreachable"),
  loading: body.includes("Loading run"),
  rows: (body.match(/quote\(s\)/g) || []).length,
}, null, 1));
await page.screenshot({ path: process.argv[3] || "/tmp/board-check.png" });
await browser.close();
