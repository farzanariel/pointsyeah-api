import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Request } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

chromium.use(StealthPlugin());
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_DIR = join(homedir(), ".cache", "pointsyeah");
const TOKEN_PATH = join(TOKEN_DIR, "idToken");
const AUTH_STATE_DIR = "./.auth-state";
const STORAGE_STATE = process.env.POINTSYEAH_AUTH_PATH?.trim() || "./auth.json";
const TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const context: BrowserContext = await chromium.launchPersistentContext(
    AUTH_STATE_DIR,
    { headless: false }
  );

  console.log("");
  console.log("================================================================");
  console.log("  PointsYeah Auth Setup");
  console.log("================================================================");
  console.log("");
  console.log("Sign in with Google in the browser window.");
  console.log("This window will close automatically once you're signed in.");
  console.log("");
  console.log("HINT: After signing in, you may need to actually run a flight");
  console.log("search on the site to trigger an api2.pointsyeah.com call so");
  console.log("we can capture your auth token.");
  console.log("");

  const page = context.pages()[0] ?? (await context.newPage());

  let token: string | undefined;
  let resolveCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    resolveCaptured = resolve;
  });

  const onRequest = (req: Request): void => {
    if (token) return;
    const url = req.url();
    if (!url.startsWith("https://api2.pointsyeah.com/flight/")) return;
    const auth = req.headers()["authorization"];
    if (!auth) return;
    const stripped = auth.replace(/^Bearer\s+/i, "").trim();
    if (!stripped) return;
    token = stripped;
    resolveCaptured();
  };

  context.on("request", onRequest);
  page.on("request", onRequest);

  await page.goto("https://www.pointsyeah.com/");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after 5 minutes waiting for an api2.pointsyeah.com request. Did you sign in and run a search?`
          )
        ),
      TIMEOUT_MS
    )
  );

  try {
    await Promise.race([captured, timeout]);
  } finally {
    // ensure cleanup happens regardless
  }

  if (!token) {
    await context.close();
    throw new Error("No token captured.");
  }

  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });
  console.log(`✓ Saved fresh token to ~/.cache/pointsyeah/idToken`);

  // Export portable storageState (decrypted cookies). This is what the VPS
  // uses — the raw .auth-state/ profile has its cookie values encrypted with
  // the host OS keyring and isn't readable on any other machine.
  const KEEP = ["www.pointsyeah.com", ".pointsyeah.com", "pointsyeah.com"];
  const state = await context.storageState();
  state.cookies = state.cookies.filter((c) => KEEP.includes(c.domain));
  state.origins = state.origins.filter((o) => o.origin.includes("pointsyeah.com"));
  await writeFile(STORAGE_STATE, JSON.stringify(state, null, 2));
  console.log(`✓ Wrote portable auth state to ${STORAGE_STATE} (${state.cookies.length} cookies)`);

  await context.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
