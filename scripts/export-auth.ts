// Reads cookies from the persistent ./.auth-state/ profile (which only the
// machine that ran auth-setup can decrypt) and writes them to auth.json
// in plaintext-portable form. That JSON is what the VPS will consume.
// Output path is configurable via POINTSYEAH_AUTH_PATH (default ./auth.json).

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile } from "node:fs/promises";

chromium.use(StealthPlugin());

const STORAGE_STATE = process.env.POINTSYEAH_AUTH_PATH?.trim() || "./auth.json";

async function main(): Promise<void> {
  const ctx = await chromium.launchPersistentContext("./.auth-state", {
    headless: true,
  });
  const state = await ctx.storageState();
  // storageState returns ALL origins; trim to the ones we actually need
  // so auth.json stays small and we don't leak Google session cookies.
  const KEEP_HOSTS = [
    "www.pointsyeah.com",
    ".pointsyeah.com",
    "pointsyeah.com",
  ];
  state.cookies = state.cookies.filter((c) =>
    KEEP_HOSTS.some((h) => c.domain === h),
  );
  state.origins = state.origins.filter((o) =>
    o.origin.includes("pointsyeah.com"),
  );
  await writeFile(STORAGE_STATE, JSON.stringify(state, null, 2));
  console.log(
    `Exported ${state.cookies.length} cookies, ${state.origins.length} origins to ${STORAGE_STATE}`,
  );
  await ctx.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
