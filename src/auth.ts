import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshIdToken } from "../scripts/auth-refresh.ts";

const TOKEN_PATH = join(homedir(), ".cache", "pointsyeah", "idToken");
const SETUP_MSG = "Auth not set up. Run: npm run auth-setup";

function decodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  const payload = JSON.parse(json) as { exp?: number };
  return typeof payload.exp === "number" ? payload.exp : null;
}

export async function ensureFreshIdToken(): Promise<string> {
  let cached: string | null = null;
  try {
    cached = (await readFile(TOKEN_PATH, "utf8")).trim();
  } catch {
    cached = null;
  }

  if (cached) {
    const exp = decodeExp(cached);
    const now = Math.floor(Date.now() / 1000);
    if (exp !== null && exp - now > 300) {
      return cached;
    }
  }

  try {
    return await refreshIdToken();
  } catch (err) {
    if (err instanceof Error && err.message === SETUP_MSG) {
      throw err;
    }
    throw err;
  }
}
