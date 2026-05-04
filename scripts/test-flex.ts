/// One-shot probe: does the API accept a multi-day date range for a "free plan" idToken?
import { search } from "../src/pointsyeah.ts";
import { ensureFreshIdToken } from "../src/auth.ts";

try {
  process.loadEnvFile(".env");
} catch {}

process.env.POINTSYEAH_ID_TOKEN = await ensureFreshIdToken();

const FROM = "JFK";
const TO = "LAX";
const FROM_DATE = "2026-06-09";
const TO_DATE = "2026-06-16"; // 8-day range (inclusive)

console.log(`Probing ${FROM}→${TO} from ${FROM_DATE} to ${TO_DATE}…`);
const t0 = Date.now();
const programs = await search(
  {
    departure: FROM,
    arrival: TO,
    departDate: FROM_DATE,
    departDateTo: TO_DATE,
    cabins: ["Economy"],
  },
  { pollIntervalMs: 50, timeoutMs: 60_000 },
);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

const datesSeen = new Set<string>();
let routeCount = 0;
for (const p of programs) {
  for (const r of p.routes) {
    routeCount++;
    datesSeen.add(r.segments[0].dt.slice(0, 10));
  }
}

console.log(`Programs: ${programs.length}`);
console.log(`Total routes: ${routeCount}`);
console.log(`Distinct departure dates seen: ${[...datesSeen].sort().join(", ") || "(none)"}`);
console.log(
  `\nVerdict: ${
    datesSeen.size > 1
      ? "✅ API accepts multi-day range — feature is unlocked"
      : datesSeen.size === 1
        ? "❌ API only returned the first date — server-side gating"
        : "(no results — token may be expired)"
  }`,
);
