// Open pointsyeah.com in a headed Chromium with the saved profile, intercept
// every create_task POST, decrypt the `data` field, and print the plaintext.
// You drive the UI: select multiple airports / a metro option / multi-city,
// hit search, and the script prints what the frontend actually sends.
//
// Press Ctrl-C to exit (or just close the window).

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Request } from "playwright";
import { createDecipheriv } from "node:crypto";

chromium.use(StealthPlugin());

const KEY_PREFIX = "LefjQ2pEXmiy/nNZvhJ43i8";
const KEY_SUFFIX = "YHYbn1hOuAgA=";
const DEFAULT_KEY_SECTION = "hJuaknzb"; // logged-out section; `data` field always uses this
const STATIC_IV = Buffer.from("1020304050607080", "utf8");

function decrypt(b64: string, section = DEFAULT_KEY_SECTION): string {
  const key = Buffer.from(KEY_PREFIX + section + KEY_SUFFIX, "base64");
  const d = createDecipheriv("aes-256-cbc", key, STATIC_IV);
  const buf = Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]);
  return buf.toString("utf8");
}

const AUTH_STATE_DIR = "./.auth-state";

const context: BrowserContext = await chromium.launchPersistentContext(AUTH_STATE_DIR, {
  headless: false,
});

console.log("");
console.log("================================================================");
console.log("  Multi-airport UI probe");
console.log("================================================================");
console.log("Drive the UI in the browser:");
console.log("  1. Try typing 'NYC' in the departure box — see if a metro");
console.log("     option appears.");
console.log("  2. Try selecting multiple airports (JFK + EWR + LGA) if the");
console.log("     UI allows.");
console.log("  3. Hit Search.");
console.log("");
console.log("Each create_task request will be decrypted and printed below.");
console.log("Press Ctrl-C when done.");
console.log("");

let count = 0;
const onRequest = async (req: Request): Promise<void> => {
  const url = req.url();
  if (!url.includes("/flight/search/create_task")) return;
  if (req.method() !== "POST") return;

  count += 1;
  const body = req.postData();
  if (!body) {
    console.log(`[#${count}] (no body)`);
    return;
  }
  try {
    const parsed = JSON.parse(body) as { data?: string; encrypted?: string };
    if (!parsed.data) {
      console.log(`[#${count}] body has no 'data' field: ${body.slice(0, 200)}`);
      return;
    }
    const plaintext = decrypt(parsed.data);
    let pretty = plaintext;
    try {
      pretty = JSON.stringify(JSON.parse(plaintext), null, 2);
    } catch {
      /* leave as-is */
    }
    console.log(`\n[#${count}] create_task plaintext:`);
    console.log(pretty);
    console.log("");
  } catch (e) {
    console.log(`[#${count}] decrypt fail: ${(e as Error).message}`);
  }
};

context.on("request", onRequest);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.pointsyeah.com/");

await new Promise<void>(() => {
  /* hold open until user closes window or Ctrl-C */
});
