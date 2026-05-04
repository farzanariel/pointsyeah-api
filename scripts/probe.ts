import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());

async function main() {
  const ctx = await chromium.launchPersistentContext("./.auth-state", { headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) console.log("NAV:", f.url());
  });
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("api2.pointsyeah") || u.includes("amazoncognito") || u.includes("accounts.google.com/o/oauth"))
      console.log("REQ:", r.method(), u.slice(0, 120));
  });

  const SEARCH = "https://www.pointsyeah.com/search?cabins=Economy&cabin=Economy&banks=Amex,Bilt,Capital+One,Chase,Citi&airlineProgram=AA&tripType=1&adults=1&children=0&departure=JFK&arrival=LAX&departDate=2026-12-01&departDateSec=2026-12-01&multiday=false";
  await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(20000);
  console.log("FINAL URL:", page.url());
  await ctx.close();
}
main();
