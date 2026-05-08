import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Request } from "playwright";
import { mkdir, writeFile, access } from "node:fs/promises";

chromium.use(StealthPlugin());
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_DIR = join(homedir(), ".cache", "pointsyeah");
const TOKEN_PATH = join(TOKEN_DIR, "idToken");
const STORAGE_STATE = process.env.POINTSYEAH_AUTH_PATH?.trim() || "./auth.json";
const TIMEOUT_MS = 60 * 1000;

const SEARCH_URL =
  "https://www.pointsyeah.com/search?cabins=Economy&cabin=Economy&banks=Amex,Bilt,Capital+One,Chase,Citi&airlineProgram=AA&tripType=1&adults=1&children=0&departure=JFK&arrival=LAX&departDate=2026-12-01&departDateSec=2026-12-01&multiday=false";

export async function refreshIdToken(): Promise<string> {
  try {
    await access(STORAGE_STATE);
  } catch {
    throw new Error("Auth not set up. Run: npm run auth-setup");
  }

  // Optional proxy via POINTSYEAH_PROXY=http://user:pass@host:port
  const proxyUrl = process.env.POINTSYEAH_PROXY?.trim();
  let proxy: { server: string; username?: string; password?: string } | undefined;
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    proxy = {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
    };
  }

  // Use launch + storageState (portable JSON) instead of launchPersistentContext.
  // The persistent profile encrypts cookie values with the host OS keyring,
  // so its cookies are unreadable on any other machine. storageState gives
  // us decrypted, portable cookies.
  const browser = await chromium.launch({ headless: true, proxy });
  const context = await browser.newContext({ storageState: STORAGE_STATE });

  let token: string | undefined;
  let resolveCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    resolveCaptured = resolve;
  });

  const onRequest = (req: Request): void => {
    if (token) return;
    const url = req.url();
    if (!url.startsWith("https://api2.pointsyeah.com/")) return;
    const auth = req.headers()["authorization"];
    if (!auth) return;
    const stripped = auth.replace(/^Bearer\s+/i, "").trim();
    if (!stripped) return;
    token = stripped;
    resolveCaptured();
  };

  context.on("request", onRequest);
  const page = await context.newPage();
  page.on("request", onRequest);

  try {
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "Timed out after 60 seconds waiting for an api2.pointsyeah.com request."
            )
          ),
        TIMEOUT_MS
      )
    );

    await Promise.race([captured, timeout]);

    // Save the (potentially rotated) cookie state so the next refresh has
    // the latest refreshToken. Cognito sometimes rotates them.
    try {
      const fresh = await context.storageState();
      const KEEP = ["www.pointsyeah.com", ".pointsyeah.com", "pointsyeah.com"];
      fresh.cookies = fresh.cookies.filter((c) => KEEP.includes(c.domain));
      fresh.origins = fresh.origins.filter((o) => o.origin.includes("pointsyeah.com"));
      await writeFile(STORAGE_STATE, JSON.stringify(fresh, null, 2));
    } catch {
      // not fatal — token was captured
    }
  } finally {
    await browser.close();
  }

  if (!token) {
    throw new Error("No token captured.");
  }

  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });

  return token;
}

function decodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  const payload = JSON.parse(json) as { exp?: number };
  return typeof payload.exp === "number" ? payload.exp : null;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("auth-refresh.ts");

if (isMain) {
  refreshIdToken().then(
    (tok) => {
      const exp = decodeExp(tok);
      if (exp !== null) {
        const expDate = new Date(exp * 1000).toISOString();
        console.log(`Token exp: ${exp} (${expDate})`);
      } else {
        console.log("Token captured (could not decode exp).");
      }
      process.exit(0);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}
